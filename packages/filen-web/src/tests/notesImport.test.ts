// @vitest-environment jsdom
//
// import.ts pulls in import.logic.ts -> sanitizeRichText.ts, which registers a DOMPurify hook at module
// load time and needs a real window/document to do so — same rationale as notesExportLogic.test.ts and
// notesImportLogic.test.ts's own pragma for the sibling "rich" branch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { mockNote } from "@/tests/fixtures/notes"

// Mock boundary matching notesActions.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const { createNoteOp, setNoteTypeOp, trashNoteOp, deleteNoteOp } = vi.hoisted(() => ({
	createNoteOp: vi.fn(),
	setNoteTypeOp: vi.fn(),
	trashNoteOp: vi.fn(),
	deleteNoteOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { createNote: createNoteOp, setNoteType: setNoteTypeOp, trashNote: trashNoteOp, deleteNote: deleteNoteOp }
}))

// The legacy encoding detector (wasm): Windows-1252 for bytes that are not Unicode, or a failed load.
const detector = vi.hoisted(() => ({ failLoad: false }))

vi.mock("@filen/encoding-detect", () => ({
	EncodingDetector: {
		instantiate: () => Promise.resolve({ guess: () => "windows-1252" })
	}
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

// The outbox itself is a heavy, fully independent module (secure-store, BroadcastChannel coordination,
// online detection, ...) — mocked the same way notesHistory.test.ts mocks it, so this file only asserts
// import.ts's OWN wiring: which uuid/content it hands to enqueue, and that a flush is attempted.
const { enqueueMock, executeNowMock } = vi.hoisted(() => ({
	enqueueMock: vi.fn().mockResolvedValue(true),
	executeNowMock: vi.fn()
}))

vi.mock("@/features/notes/lib/sync", () => ({ sync: { enqueue: enqueueMock, executeNow: executeNowMock } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { NOTES_QUERY_KEY, notesQueryGet } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { importNoteFromFile } from "@/features/notes/lib/import"
import { MAX_NOTE_SIZE } from "@/features/notes/hooks/useNoteEditor.logic"
import { runPreviewDisposers } from "@/lib/workers/previewDisposers"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
	detector.failLoad = false
	vi.stubGlobal("fetch", () => Promise.resolve(new Response()))
	vi.stubGlobal("WebAssembly", {
		...WebAssembly,
		compileStreaming: () => (detector.failLoad ? Promise.reject(new Error("offline")) : Promise.resolve({}))
	})
})

afterEach(() => {
	// Drops the detector loaded by a test, so the next one loads (or fails to load) its own.
	runPreviewDisposers()
	vi.unstubAllGlobals()
})

function mockFile(name: string, content: string | Uint8Array<ArrayBuffer>): File {
	return new File([content], name, { type: "text/plain" })
}

// A file whose size is real but whose bytes are never read: an oversize pick must be rejected from its size alone.
function unreadFile(name: string, size: number): { file: File; text: ReturnType<typeof vi.fn>; arrayBuffer: ReturnType<typeof vi.fn> } {
	const file = mockFile(name, "")
	const text = vi.fn()
	const arrayBuffer = vi.fn()

	Object.defineProperties(file, { size: { value: size }, text: { value: text }, arrayBuffer: { value: arrayBuffer } })

	return { file, text, arrayBuffer }
}

describe("importNoteFromFile", () => {
	it("rejects an unrecognized extension WITHOUT ever calling the SDK", async () => {
		const outcome = await importNoteFromFile(mockFile("archive.zip", "binary"))

		expect(outcome.status).toBe("error")
		expect(createNoteOp).not.toHaveBeenCalled()
	})

	it("rejects content past the note size cap WITHOUT creating a note or queueing it", async () => {
		const outcome = await importNoteFromFile(mockFile("huge.txt", "x".repeat(MAX_NOTE_SIZE + 1)))

		expect(outcome.status).toBe("error")
		expect(createNoteOp).not.toHaveBeenCalled()
		expect(enqueueMock).not.toHaveBeenCalled()
	})

	it("creates the note titled from the file name (extension stripped)", async () => {
		const created = mockNote({ title: "Groceries" })
		createNoteOp.mockResolvedValueOnce(created)

		const outcome = await importNoteFromFile(mockFile("Groceries.txt", "milk\neggs"))

		expect(createNoteOp).toHaveBeenCalledExactlyOnceWith("Groceries")
		expect(outcome).toEqual({ status: "success", item: created })
	})

	it("flips the type to the detected type when the SDK's own default (text) differs", async () => {
		const created = mockNote({ noteType: "text" })
		const retyped = mockNote({ noteType: "md" })
		createNoteOp.mockResolvedValueOnce(created)
		setNoteTypeOp.mockResolvedValueOnce(retyped)

		await importNoteFromFile(mockFile("notes.md", "# hi"))

		expect(setNoteTypeOp).toHaveBeenCalledExactlyOnceWith(created, "md", "")
	})

	it("skips the setNoteType round trip when the SDK already created the right type", async () => {
		const created = mockNote({ noteType: "text" })
		createNoteOp.mockResolvedValueOnce(created)

		await importNoteFromFile(mockFile("plain.txt", "hello"))

		expect(setNoteTypeOp).not.toHaveBeenCalled()
	})

	it("enqueues the (sanitized) content through the fault-tolerant outbox and flushes, seeding the content cache", async () => {
		const created = mockNote({ noteType: "text" })
		createNoteOp.mockResolvedValueOnce(created)

		await importNoteFromFile(mockFile("plain.txt", "hello world"))

		expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(created, "hello world")
		expect(executeNowMock).toHaveBeenCalledTimes(1)
		expect(testQueryClient.getQueryData(noteContentQueryKey(created.uuid))).toBe("hello world")
	})

	it("upserts the new note into the notes list cache", async () => {
		const created = mockNote({ uuid: "new-0000-0000-0000-000000000000" })
		createNoteOp.mockResolvedValueOnce(created)
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [])

		await importNoteFromFile(mockFile("plain.txt", "hello"))

		expect(notesQueryGet()).toEqual([created])
	})

	it("returns an error outcome (no cache mutation) when the file read itself rejects", async () => {
		const brokenFile = mockFile("plain.txt", "hello")
		vi.spyOn(brokenFile, "arrayBuffer").mockRejectedValueOnce(new Error("read failed"))

		const outcome = await importNoteFromFile(brokenFile)

		expect(outcome.status).toBe("error")
		expect(createNoteOp).not.toHaveBeenCalled()
	})

	it("returns an error outcome when createNote itself rejects", async () => {
		createNoteOp.mockRejectedValueOnce(new Error("network"))

		const outcome = await importNoteFromFile(mockFile("plain.txt", "hello"))

		expect(outcome.status).toBe("error")
		expect(enqueueMock).not.toHaveBeenCalled()
	})

	it.each(["huge.txt", "huge.md", "huge.json"])("rejects an oversize %s from its size, never reading it", async name => {
		const { file, text, arrayBuffer } = unreadFile(name, 600 * 1024 * 1024)

		const outcome = await importNoteFromFile(file)

		expect(outcome.status).toBe("error")
		expect(text).not.toHaveBeenCalled()
		expect(arrayBuffer).not.toHaveBeenCalled()
		expect(createNoteOp).not.toHaveBeenCalled()
	})

	it("rejects an html file past the parse ceiling from its size, never reading it", async () => {
		const { file, text, arrayBuffer } = unreadFile("page.html", 1536 * 1024 * 1024)

		const outcome = await importNoteFromFile(file)

		expect(outcome.status).toBe("error")
		expect(text).not.toHaveBeenCalled()
		expect(arrayBuffer).not.toHaveBeenCalled()
	})

	it("imports a multi-MiB html page that sanitizes under the cap", async () => {
		const created = mockNote({ noteType: "text" })
		const retyped = mockNote({ noteType: "rich" })
		createNoteOp.mockResolvedValueOnce(created)
		setNoteTypeOp.mockResolvedValueOnce(retyped)
		const page = `<html><head><style>${"a{}".repeat(1024 * 1024)}</style></head><body><p>kept</p></body></html>`

		expect(page.length).toBeGreaterThan(MAX_NOTE_SIZE * 2)

		const outcome = await importNoteFromFile(mockFile("page.html", page))

		expect(outcome).toEqual({ status: "success", item: retyped })
		expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(retyped, expect.stringContaining("kept"))
	})

	it("imports a UTF-16 text file whose decoded text fits, though the file is larger than the cap", async () => {
		createNoteOp.mockResolvedValueOnce(mockNote({ noteType: "text" }))
		const text = "x".repeat(MAX_NOTE_SIZE - 10)
		const bytes = new Uint8Array(2 + text.length * 2)

		bytes.set([0xff, 0xfe])
		for (let index = 0; index < text.length; index++) {
			bytes[2 + index * 2] = 0x78
		}

		expect(bytes.length).toBeGreaterThan(MAX_NOTE_SIZE)

		const outcome = await importNoteFromFile(mockFile("wide.txt", bytes))

		expect(outcome.status).toBe("success")
		expect(enqueueMock.mock.calls[0]?.[1]).toBe(text)
	})

	it("imports a UTF-32 text file whose decoded text fits, though the file is over twice the cap", async () => {
		createNoteOp.mockResolvedValueOnce(mockNote({ noteType: "text" }))
		const text = "x".repeat(MAX_NOTE_SIZE - 10)
		const bytes = new Uint8Array(4 + text.length * 4)

		bytes.set([0xff, 0xfe, 0x00, 0x00])
		for (let index = 0; index < text.length; index++) {
			bytes[4 + index * 4] = 0x78
		}

		expect(bytes.length).toBeGreaterThan(MAX_NOTE_SIZE * 2 + 2)

		const outcome = await importNoteFromFile(mockFile("wider.txt", bytes))

		expect(outcome.status).toBe("success")
		expect(enqueueMock.mock.calls[0]?.[1]).toBe(text)
	})

	it("reads a Windows-1252 file in its own encoding", async () => {
		const created = mockNote({ noteType: "text" })
		createNoteOp.mockResolvedValueOnce(created)

		// "Café à 5" in Windows-1252.
		await importNoteFromFile(mockFile("ansi.txt", Uint8Array.of(0x43, 0x61, 0x66, 0xe9, 0x20, 0xe0, 0x20, 0x35)))

		expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(created, "Café à 5")
	})

	it("reads a UTF-16LE file in its own encoding", async () => {
		const created = mockNote({ noteType: "text" })
		createNoteOp.mockResolvedValueOnce(created)
		const text = "Grüße, 日本"
		const bytes = new Uint8Array(2 + text.length * 2)
		const view = new DataView(bytes.buffer)

		bytes.set([0xff, 0xfe])
		for (let index = 0; index < text.length; index++) {
			view.setUint16(2 + index * 2, text.charCodeAt(index), true)
		}

		await importNoteFromFile(mockFile("wide.txt", bytes))

		expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(created, text)
	})

	it("imports a UTF-8 file byte for byte, keeping its line endings and dropping only its mark", async () => {
		const created = mockNote({ noteType: "code" })
		createNoteOp.mockResolvedValueOnce(created)
		const text = "a\r\nb\rc\nZürich ✓\r\n"

		await importNoteFromFile(mockFile("script.js", new TextEncoder().encode("\ufeff" + text)))

		expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(created, text)
	})

	it("still imports a legacy file when the encoding detector cannot load", async () => {
		const created = mockNote({ noteType: "text" })
		createNoteOp.mockResolvedValueOnce(created)
		detector.failLoad = true

		const outcome = await importNoteFromFile(mockFile("ansi.txt", Uint8Array.of(0x43, 0x61, 0x66, 0xe9)))

		expect(outcome.status).toBe("success")
		expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(created, "Café")
	})

	it("removes the created note when the retype fails, returning the error and queueing nothing", async () => {
		const created = mockNote({ noteType: "text" })
		const trashed = mockNote({ uuid: created.uuid, trash: true })
		createNoteOp.mockResolvedValueOnce(created)
		setNoteTypeOp.mockRejectedValueOnce(new Error("network"))
		trashNoteOp.mockResolvedValueOnce(trashed)
		deleteNoteOp.mockResolvedValueOnce(undefined)
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [])

		const outcome = await importNoteFromFile(mockFile("notes.md", "# hi"))

		expect(outcome.status).toBe("error")
		expect(trashNoteOp).toHaveBeenCalledExactlyOnceWith(created)
		expect(deleteNoteOp).toHaveBeenCalledExactlyOnceWith(trashed)
		expect(notesQueryGet()).toEqual([])
		expect(enqueueMock).not.toHaveBeenCalled()
		expect(executeNowMock).not.toHaveBeenCalled()
	})

	it("lists the created note when the retype fails and it cannot be removed either", async () => {
		const created = mockNote({ uuid: "new-0000-0000-0000-000000000000", noteType: "text" })
		createNoteOp.mockResolvedValueOnce(created)
		setNoteTypeOp.mockRejectedValueOnce(new Error("network"))
		trashNoteOp.mockRejectedValueOnce(new Error("network"))
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [])

		const outcome = await importNoteFromFile(mockFile("notes.md", "# hi"))

		expect(outcome.status).toBe("error")
		expect(notesQueryGet()).toEqual([created])
		expect(enqueueMock).not.toHaveBeenCalled()
	})
})

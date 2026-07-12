// @vitest-environment jsdom
//
// import.ts pulls in import.logic.ts -> sanitizeRichText.ts, which registers a DOMPurify hook at module
// load time and needs a real window/document to do so — same rationale as notesExportLogic.test.ts and
// notesImportLogic.test.ts's own pragma for the sibling "rich" branch.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"

// Mock boundary matching notesActions.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const { createNoteOp, setNoteTypeOp } = vi.hoisted(() => ({
	createNoteOp: vi.fn(),
	setNoteTypeOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { createNote: createNoteOp, setNoteType: setNoteTypeOp }
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

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "note-0000-0000-0000-000000000000",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "Untitled",
		preview: "",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

function mockFile(name: string, content: string): File {
	return new File([content], name, { type: "text/plain" })
}

describe("importNoteFromFile", () => {
	it("rejects an unrecognized extension WITHOUT ever calling the SDK", async () => {
		const outcome = await importNoteFromFile(mockFile("archive.zip", "binary"))

		expect(outcome.status).toBe("error")
		expect(createNoteOp).not.toHaveBeenCalled()
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

		expect(setNoteTypeOp).toHaveBeenCalledExactlyOnceWith(created, "md")
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
		vi.spyOn(brokenFile, "text").mockRejectedValueOnce(new Error("read failed"))

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
})

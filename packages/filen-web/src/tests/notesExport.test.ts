// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, UuidStr } from "@filen/sdk-rs"

// Same worker-free seams as the other notes suites: the sdk client imports a Vite `?worker`, and the
// real query client owns the OPFS persistence pipeline neither is wanted here.
const { getNoteContent } = vi.hoisted(() => ({ getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getNoteContent } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn<(filename: string, blob: Blob) => void>() }))

vi.mock("@/lib/downloadBlob", () => ({ downloadBlob }))

// A fake archive recording exactly what entered it, so the assertions are on the zip's contents
// rather than on generateAsync's opaque output.
const { zipEntries } = vi.hoisted(() => ({ zipEntries: [] as { name: string; content: string }[] }))

vi.mock("jszip", () => ({
	default: class {
		public file(name: string, content: string): void {
			zipEntries.push({ name, content })
		}

		public generateAsync(): Promise<Blob> {
			return Promise.resolve(new Blob(["zip"]))
		}
	}
}))

import { queryClient as testQueryClient } from "@/queries/client"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { exportNote, exportAllNotes } from "@/features/notes/lib/export"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "key",
		title: "note title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

// The SDK leaves encryptionKey absent (never `= undefined`) on a metadata-undecryptable note —
// exactOptionalPropertyTypes models that as a missing property.
function undecryptableNote(overrides: Partial<Note> = {}): Note {
	const note: Note = { ...mockNote(overrides) }

	delete note.encryptionKey

	return note
}

beforeEach(() => {
	vi.clearAllMocks()
	zipEntries.length = 0
	testQueryClient.clear()
})

describe("exportNote", () => {
	it("downloads a decryptable note under its type-faithful filename", async () => {
		const note = mockNote({ title: "recipe", noteType: "md" })
		getNoteContent.mockResolvedValueOnce("# body")

		await expect(exportNote(note)).resolves.toStrictEqual({ status: "success" })
		expect(downloadBlob).toHaveBeenCalledTimes(1)
		expect(downloadBlob.mock.calls[0]?.[0]).toBe("recipe.md")
	})

	it("reports an error and downloads nothing when the content never decrypted", async () => {
		getNoteContent.mockResolvedValueOnce(undefined)

		const outcome = await exportNote(mockNote())

		expect(outcome.status).toBe("error")
		expect(downloadBlob).not.toHaveBeenCalled()
	})

	it("exports an EMPTY note as a real empty file (empty is not undecryptable)", async () => {
		getNoteContent.mockResolvedValueOnce("")

		await expect(exportNote(mockNote())).resolves.toStrictEqual({ status: "success" })
		expect(downloadBlob).toHaveBeenCalledTimes(1)
	})
})

describe("exportAllNotes", () => {
	it("skips a note whose content never decrypted and zips only the readable ones", async () => {
		const readable = mockNote({ uuid: testUuid("a"), title: "readable" })
		const unreadable = mockNote({ uuid: testUuid("b"), title: "unreadable" })

		getNoteContent.mockImplementation(note => Promise.resolve(note.uuid === readable.uuid ? "body" : undefined))

		await expect(exportAllNotes([readable, unreadable])).resolves.toStrictEqual({ status: "success", skipped: 1 })
		expect(zipEntries.map(entry => entry.name)).toStrictEqual(["readable.txt"])
		expect(downloadBlob).toHaveBeenCalledTimes(1)
	})

	it("skips a metadata-undecryptable note without ever fetching its content", async () => {
		const readable = mockNote({ uuid: testUuid("a"), title: "readable" })
		const ghost = undecryptableNote({ uuid: testUuid("b") })

		getNoteContent.mockResolvedValue("body")

		await expect(exportAllNotes([readable, ghost])).resolves.toStrictEqual({ status: "success", skipped: 1 })
		expect(zipEntries.map(entry => entry.name)).toStrictEqual(["readable.txt"])
		expect(getNoteContent).toHaveBeenCalledExactlyOnceWith(readable)
	})

	it("produces no archive at all when every exportable note is skipped", async () => {
		getNoteContent.mockResolvedValue(undefined)

		await expect(exportAllNotes([mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b") })])).resolves.toStrictEqual({
			status: "success",
			skipped: 2
		})
		expect(zipEntries).toHaveLength(0)
		expect(downloadBlob).not.toHaveBeenCalled()
	})

	it("excludes trashed notes from both the archive and the skip count", async () => {
		const active = mockNote({ uuid: testUuid("a"), title: "active" })
		const trashed = mockNote({ uuid: testUuid("b"), title: "trashed", trash: true })

		getNoteContent.mockResolvedValue("body")

		await expect(exportAllNotes([active, trashed])).resolves.toStrictEqual({ status: "success", skipped: 0 })
		expect(zipEntries.map(entry => entry.name)).toStrictEqual(["active.txt"])
	})

	it("fetches sequentially, never as a parallel burst", async () => {
		const first = mockNote({ uuid: testUuid("a"), title: "first" })
		const second = mockNote({ uuid: testUuid("b"), title: "second" })
		let inFlight = 0
		let maxInFlight = 0

		getNoteContent.mockImplementation(async () => {
			inFlight += 1
			maxInFlight = Math.max(maxInFlight, inFlight)

			await Promise.resolve()

			inFlight -= 1

			return "body"
		})

		await exportAllNotes([first, second])

		expect(maxInFlight).toBe(1)
		expect(getNoteContent.mock.calls.map(call => call[0])).toStrictEqual([first, second])
	})

	it("reads a warm content cache instead of round-tripping to the SDK", async () => {
		const note = mockNote({ uuid: testUuid("a"), title: "warm" })
		testQueryClient.setQueryData(noteContentQueryKey(note.uuid), "cached body")

		await exportAllNotes([note])

		expect(getNoteContent).not.toHaveBeenCalled()
		expect(zipEntries).toStrictEqual([{ name: "warm.txt", content: "cached body" }])
	})
})

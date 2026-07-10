import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, NoteHistory, NoteTag, UuidStr } from "@filen/sdk-rs"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// label the same way drive.test.ts's testUuid does.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching contacts.test.ts/drive.test.ts: the real sdk client module imports a Vite
// `?worker`, unresolvable under node vitest.
const { listNotes, getNoteContent, getNoteHistory, listNoteTags } = vi.hoisted(() => ({
	listNotes: vi.fn<() => Promise<Note[]>>(),
	getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>(),
	getNoteHistory: vi.fn<(note: Note) => Promise<NoteHistory[]>>(),
	listNoteTags: vi.fn<() => Promise<NoteTag[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { listNotes, getNoteContent, getNoteHistory, listNoteTags }
}))

// Same rationale as drive.test.ts's useItemInfoQuery coverage: only intercepts useQuery itself
// (real internals never exercised) so the `enabled`/`queryFn` wiring this module owns is directly
// assertable.
const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }))

vi.mock("@tanstack/react-query", async importOriginal => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>()
	return { ...actual, useQuery }
})

// A bare, unconfigured QueryClient stands in for the real singleton — the patchers only need
// genuine setQueryData/getQueryData/cancelQueries cache mechanics, never the production client's
// OPFS-backed persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import {
	fetchNotes,
	NOTES_QUERY_KEY,
	notesQueryGet,
	notesQueryRemove,
	notesQueryReplaceAll,
	notesQueryUpdate,
	notesQueryUpsert,
	useNotes
} from "@/features/notes/queries/notes"
import { fetchNoteContent, noteContentQueryKey, useNoteContentQuery } from "@/features/notes/queries/noteContent"
import { fetchNoteHistory, noteHistoryQueryKey, useNoteHistoryQuery } from "@/features/notes/queries/noteHistory"
import {
	fetchNoteTags,
	NOTE_TAGS_QUERY_KEY,
	noteTagsQueryGet,
	noteTagsQueryRemove,
	noteTagsQueryUpdate,
	noteTagsQueryUpsert,
	useNoteTags
} from "@/features/notes/queries/noteTags"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "note title",
		preview: "note preview",
		trash: false,
		archive: false,
		createdTimestamp: 1_700_000_000_000n,
		editedTimestamp: 1_700_000_000_000n,
		participants: [],
		...overrides
	}
}

function mockNoteTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: "22222222-2222-2222-2222-222222222222",
		name: "tag",
		favorite: false,
		editedTimestamp: 1_700_000_000_000n,
		createdTimestamp: 1_700_000_000_000n,
		...overrides
	}
}

describe("fetchNotes", () => {
	it("passes through sdkApi.listNotes unchanged", async () => {
		const notes = [mockNote()]
		listNotes.mockResolvedValueOnce(notes)

		await expect(fetchNotes()).resolves.toBe(notes)
		expect(listNotes).toHaveBeenCalledExactlyOnceWith()
	})

	it("propagates a rejection from sdkApi.listNotes unchanged", async () => {
		const error = new Error("no authenticated client")
		listNotes.mockRejectedValueOnce(error)

		await expect(fetchNotes()).rejects.toBe(error)
	})
})

describe("useNotes", () => {
	it("queries under the [notes, list] key", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useNotes()

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ queryKey: NOTES_QUERY_KEY }))
	})
})

describe("notesQueryUpdate / notesQueryGet", () => {
	it("defaults an uncached list to [] before applying the updater", () => {
		const note = mockNote()

		notesQueryUpdate(prev => [...prev, note])

		expect(notesQueryGet()).toEqual([note])
	})

	it("passes the previously cached array through to the updater unchanged", () => {
		const first = mockNote({ uuid: testUuid("a") })
		const second = mockNote({ uuid: testUuid("b") })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [first])

		notesQueryUpdate(prev => [...prev, second])

		expect(notesQueryGet()).toEqual([first, second])
	})

	it("cancels an in-flight fetch only when the query already holds cached data", () => {
		const cancelSpy = vi.spyOn(testQueryClient, "cancelQueries")

		// No cached data yet — the initial-fetch carve-out must NOT cancel.
		notesQueryUpdate(prev => prev)
		expect(cancelSpy).not.toHaveBeenCalled()

		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote()])
		cancelSpy.mockClear()

		// Cached data exists now — a patch must abort any in-flight refetch first.
		notesQueryUpdate(prev => prev)
		expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: NOTES_QUERY_KEY })
	})
})

describe("notesQueryUpsert", () => {
	it("appends a note not already present", () => {
		const note = mockNote()

		notesQueryUpsert(note)

		expect(notesQueryGet()).toEqual([note])
	})

	it("replaces an existing note in place, preserving position", () => {
		const first = mockNote({ uuid: testUuid("a") })
		const second = mockNote({ uuid: testUuid("b") })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [first, second])

		const updatedFirst = { ...first, pinned: true }
		notesQueryUpsert(updatedFirst)

		expect(notesQueryGet()).toEqual([updatedFirst, second])
	})
})

describe("notesQueryRemove", () => {
	it("removes a note by uuid, leaving the rest untouched", () => {
		const first = mockNote({ uuid: testUuid("a") })
		const second = mockNote({ uuid: testUuid("b") })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [first, second])

		notesQueryRemove(testUuid("a"))

		expect(notesQueryGet()).toEqual([second])
	})
})

describe("notesQueryReplaceAll", () => {
	it("replaces the whole cached list", () => {
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote({ uuid: testUuid("a") })])
		const next = [mockNote({ uuid: testUuid("b") }), mockNote({ uuid: testUuid("c") })]

		notesQueryReplaceAll(next)

		expect(notesQueryGet()).toEqual(next)
	})
})

describe("noteContentQueryKey", () => {
	it("builds the [notes, content, {uuid}] tuple", () => {
		expect(noteContentQueryKey("abc")).toEqual(["notes", "content", { uuid: "abc" }])
	})
})

describe("fetchNoteContent", () => {
	it("passes the note through to sdkApi.getNoteContent unchanged", async () => {
		const note = mockNote()
		getNoteContent.mockResolvedValueOnce("content")

		await expect(fetchNoteContent(note)).resolves.toBe("content")
		expect(getNoteContent).toHaveBeenCalledExactlyOnceWith(note)
	})
})

describe("useNoteContentQuery", () => {
	it("disables the query when note is undefined regardless of the enabled option", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useNoteContentQuery(undefined, { enabled: true })

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
	})

	it("defaults enabled to true once a note is given", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useNoteContentQuery(mockNote())

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: true, staleTime: Infinity }))
	})

	it("respects an explicit enabled: false even with a note given", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useNoteContentQuery(mockNote(), { enabled: false })

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
	})
})

describe("noteHistoryQueryKey", () => {
	it("builds the [notes, history, {uuid}] tuple", () => {
		expect(noteHistoryQueryKey("abc")).toEqual(["notes", "history", { uuid: "abc" }])
	})
})

describe("fetchNoteHistory", () => {
	it("passes the note through to sdkApi.getNoteHistory unchanged", async () => {
		const note = mockNote()
		getNoteHistory.mockResolvedValueOnce([])

		await expect(fetchNoteHistory(note)).resolves.toEqual([])
		expect(getNoteHistory).toHaveBeenCalledExactlyOnceWith(note)
	})
})

describe("useNoteHistoryQuery", () => {
	it("disables the query when note is undefined", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useNoteHistoryQuery(undefined)

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
	})
})

describe("fetchNoteTags", () => {
	it("passes through sdkApi.listNoteTags unchanged", async () => {
		const tags = [mockNoteTag()]
		listNoteTags.mockResolvedValueOnce(tags)

		await expect(fetchNoteTags()).resolves.toBe(tags)
	})
})

describe("useNoteTags", () => {
	it("queries under the [notes, tags] key", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useNoteTags()

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ queryKey: NOTE_TAGS_QUERY_KEY }))
	})
})

describe("noteTagsQueryUpdate / noteTagsQueryGet", () => {
	it("defaults an uncached list to [] before applying the updater", () => {
		const tag = mockNoteTag()

		noteTagsQueryUpdate(prev => [...prev, tag])

		expect(noteTagsQueryGet()).toEqual([tag])
	})
})

describe("noteTagsQueryUpsert", () => {
	it("replaces an existing tag in place, preserving position", () => {
		const first = mockNoteTag({ uuid: testUuid("a") })
		const second = mockNoteTag({ uuid: testUuid("b") })
		testQueryClient.setQueryData(NOTE_TAGS_QUERY_KEY, [first, second])

		const updatedFirst = { ...first, favorite: true }
		noteTagsQueryUpsert(updatedFirst)

		expect(noteTagsQueryGet()).toEqual([updatedFirst, second])
	})

	it("appends a tag not already present", () => {
		const tag = mockNoteTag()

		noteTagsQueryUpsert(tag)

		expect(noteTagsQueryGet()).toEqual([tag])
	})
})

describe("noteTagsQueryRemove", () => {
	it("removes a tag by uuid, leaving the rest untouched", () => {
		const first = mockNoteTag({ uuid: testUuid("a") })
		const second = mockNoteTag({ uuid: testUuid("b") })
		testQueryClient.setQueryData(NOTE_TAGS_QUERY_KEY, [first, second])

		noteTagsQueryRemove(testUuid("a"))

		expect(noteTagsQueryGet()).toEqual([second])
	})
})

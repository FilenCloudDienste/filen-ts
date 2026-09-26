import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
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

// useNoteContentQuery now consults the sync-outbox store (the disabled-while-editing gate). Mock the
// reactive selector to a controllable flag so these node-env tests exercise the `enabled` wiring
// without a React render — the store's own edge logic is covered by notesOutbox.test.ts's
// `describe("editing sessions")` block.
const { useNoteEditing } = vi.hoisted(() => ({ useNoteEditing: vi.fn(() => false) }))

vi.mock("@/features/notes/store/useNotesInflight", () => ({ useNoteEditing }))

// A bare, unconfigured QueryClient stands in for the real singleton — the patchers only need
// genuine setQueryData/getQueryData/cancelQueries cache mechanics, never the production client's
// OPFS-backed persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import {
	fetchNotes,
	NOTES_QUERY_KEY,
	notesQueryGet,
	notesQueryRefetch,
	notesQueryRemove,
	notesQueryUpdate,
	notesQueryUpsert,
	useNotes
} from "@/features/notes/queries/notes"
import {
	fetchNoteContent,
	fetchNoteContentOrThrow,
	isUndecryptableContentError,
	noteContentQueryKey,
	readNoteContent,
	useNoteContentQuery
} from "@/features/notes/queries/noteContent"
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

	it("leaves the query alone when no read is in flight", () => {
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote()])
		const cancelSpy = vi.spyOn(testQueryClient, "cancelQueries")
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")

		notesQueryUpdate(prev => prev)

		expect(cancelSpy).not.toHaveBeenCalled()
		expect(invalidateSpy).not.toHaveBeenCalled()
	})
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

// Queued answers for listNotes, handed out in call order, so a test can resolve an early read AFTER a
// later one and see which of them the cache keeps.
function queueListNotes(count: number): { resolve: (index: number, notes: Note[]) => Promise<void> } {
	const reads = Array.from({ length: count }, () => deferred<Note[]>())
	let next = 0

	listNotes.mockImplementation(() => {
		const read = reads[next]
		next++

		if (read === undefined) {
			throw new Error(`unexpected listNotes call #${String(next)}`)
		}

		return read.promise
	})

	return {
		resolve: async (index, notes) => {
			reads[index]?.resolve(notes)
			await settle()
		}
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

const unmounts: (() => void)[] = []

// A mounted notes list without React: an observer is what makes the query active, and staleTime
// Infinity keeps a cache the test seeded from being re-read on mount, so every read is one the code
// under test asked for.
function mountList(options: { refetchOnMount?: boolean } = {}): void {
	const observer = new QueryObserver<Note[]>(testQueryClient, {
		queryKey: NOTES_QUERY_KEY,
		queryFn: fetchNotes,
		staleTime: options.refetchOnMount === true ? 0 : Infinity,
		retry: false
	})

	unmounts.push(observer.subscribe(() => undefined))
}

afterEach(() => {
	for (const unmount of unmounts.splice(0)) {
		unmount()
	}
})

describe("notesQueryUpdate — a read in flight", () => {
	it("aborts a refetch that predates the patch and reads again, so the list ends on the later read", async () => {
		const reads = queueListNotes(2)
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote({ uuid: testUuid("a"), noteType: "text" })])
		// The mount read of a list a socket patch seeded while nobody had it open.
		mountList({ refetchOnMount: true })
		await vi.waitFor(() => {
			expect(listNotes).toHaveBeenCalledTimes(1)
		})

		notesQueryUpdate(prev => prev.map(n => ({ ...n, title: "patched" })))

		expect(notesQueryGet()?.[0]?.title).toBe("patched")
		expect(listNotes).toHaveBeenCalledTimes(2)

		await reads.resolve(1, [mockNote({ uuid: testUuid("a"), noteType: "md", title: "patched" })])
		// The aborted read answers last, with the server's state from before the patch.
		await reads.resolve(0, [mockNote({ uuid: testUuid("a"), noteType: "text", title: "stale" })])

		expect(notesQueryGet()).toEqual([mockNote({ uuid: testUuid("a"), noteType: "md", title: "patched" })])
		expect(listNotes).toHaveBeenCalledTimes(2)
	})

	it("replaces an initial fetch with a read that starts after the patch", async () => {
		const reads = queueListNotes(2)
		mountList()
		await vi.waitFor(() => {
			expect(listNotes).toHaveBeenCalledTimes(1)
		})

		notesQueryUpdate(prev => [...prev, mockNote({ uuid: testUuid("b") })])

		expect(listNotes).toHaveBeenCalledTimes(2)

		await reads.resolve(0, [mockNote({ uuid: testUuid("a") })])
		await reads.resolve(1, [mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b") })])

		expect(notesQueryGet()?.map(n => n.uuid)).toEqual([testUuid("a"), testUuid("b")])
	})

	it("keeps the patch over a read that no mounted list will repeat, leaving the query stale for its next mount", async () => {
		const reads = queueListNotes(1)
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote({ uuid: testUuid("a"), title: "old" })])
		// An unobserved read: whoever started it gets the patched cache back, never a refetch.
		const unobserved = testQueryClient.query({ queryKey: NOTES_QUERY_KEY, queryFn: fetchNotes, staleTime: 0 }).catch(() => undefined)
		await vi.waitFor(() => {
			expect(listNotes).toHaveBeenCalledTimes(1)
		})

		notesQueryUpdate(prev => prev.map(n => ({ ...n, title: "patched" })))
		await reads.resolve(0, [mockNote({ uuid: testUuid("a"), title: "stale" })])

		expect(notesQueryGet()?.[0]?.title).toBe("patched")
		expect(listNotes).toHaveBeenCalledTimes(1)
		expect(testQueryClient.getQueryState(NOTES_QUERY_KEY)?.isInvalidated).toBe(true)
		await expect(unobserved).resolves.toEqual([mockNote({ uuid: testUuid("a"), title: "patched" })])
	})
})

describe("notesQueryRefetch", () => {
	it("reads nothing for a list that was never read — its first mount reads fresher", () => {
		notesQueryRefetch()

		expect(listNotes).not.toHaveBeenCalled()
		expect(notesQueryGet()).toBeUndefined()
	})

	it("reads a mounted list again and replaces it", async () => {
		const reads = queueListNotes(1)
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote({ uuid: testUuid("a"), pinned: false })])
		mountList()

		notesQueryRefetch()
		await reads.resolve(0, [mockNote({ uuid: testUuid("a"), pinned: true }), mockNote({ uuid: testUuid("b") })])

		expect(notesQueryGet()).toEqual([mockNote({ uuid: testUuid("a"), pinned: true }), mockNote({ uuid: testUuid("b") })])
	})

	it("only marks an unmounted list stale — its next mount reads", () => {
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote()])

		notesQueryRefetch()

		expect(listNotes).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryState(NOTES_QUERY_KEY)?.isInvalidated).toBe(true)
	})

	it("replaces a read in flight, which may predate the change", async () => {
		const reads = queueListNotes(2)
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote({ uuid: testUuid("a") })])
		mountList()
		notesQueryRefetch()

		notesQueryRefetch()

		expect(listNotes).toHaveBeenCalledTimes(2)

		await reads.resolve(1, [mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b") })])
		await reads.resolve(0, [mockNote({ uuid: testUuid("a") })])

		expect(notesQueryGet()?.map(n => n.uuid)).toEqual([testUuid("a"), testUuid("b")])
	})

	it("follows an initial fetch with one read, shared by every change queued while it was in flight", async () => {
		const reads = queueListNotes(2)
		mountList()
		await vi.waitFor(() => {
			expect(listNotes).toHaveBeenCalledTimes(1)
		})

		notesQueryRefetch()
		notesQueryRefetch({ onlyIfFetching: true })

		expect(listNotes).toHaveBeenCalledTimes(1)

		await reads.resolve(0, [mockNote({ uuid: testUuid("a") })])

		expect(listNotes).toHaveBeenCalledTimes(2)

		await reads.resolve(1, [mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b") })])

		expect(notesQueryGet()?.map(n => n.uuid)).toEqual([testUuid("a"), testUuid("b")])
		expect(listNotes).toHaveBeenCalledTimes(2)
	})

	it("with onlyIfFetching, leaves an idle list alone", () => {
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [mockNote()])
		mountList()

		notesQueryRefetch({ onlyIfFetching: true })

		expect(listNotes).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryState(NOTES_QUERY_KEY)?.isInvalidated).toBe(false)
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

describe("readNoteContent", () => {
	it("classifies a resolved undefined as undecryptable content", async () => {
		getNoteContent.mockResolvedValueOnce(undefined)

		await expect(readNoteContent(mockNote())).resolves.toEqual({ status: "undecryptable" })
	})

	it("classifies a resolved empty string as readable content — an EMPTY note is not undecryptable", async () => {
		getNoteContent.mockResolvedValueOnce("")

		await expect(readNoteContent(mockNote())).resolves.toEqual({ status: "ok", content: "" })
	})

	it("passes a resolved body straight through", async () => {
		getNoteContent.mockResolvedValueOnce("body")

		await expect(readNoteContent(mockNote())).resolves.toEqual({ status: "ok", content: "body" })
	})

	it("lets an SDK rejection propagate rather than swallowing it into undecryptable", async () => {
		getNoteContent.mockRejectedValueOnce(new Error("network"))

		await expect(readNoteContent(mockNote())).rejects.toThrow("network")
	})
})

describe("fetchNoteContentOrThrow", () => {
	it("resolves the string for a decryptable note", async () => {
		getNoteContent.mockResolvedValueOnce("body")

		await expect(fetchNoteContentOrThrow(mockNote())).resolves.toBe("body")
	})

	it("rejects with the identity-checked sentinel for an undecryptable note", async () => {
		getNoteContent.mockResolvedValueOnce(undefined)

		await expect(
			fetchNoteContentOrThrow(mockNote()).then(
				() => "resolved",
				(e: unknown) => isUndecryptableContentError(e)
			)
		).resolves.toBe(true)
	})

	it("isUndecryptableContentError is identity-based, not duck-typed", () => {
		expect(isUndecryptableContentError(new Error("boom"))).toBe(false)
		expect(isUndecryptableContentError(undefined)).toBe(false)
		expect(isUndecryptableContentError(Symbol("note-content-undecryptable"))).toBe(false)
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

	it("disables the query while the user is editing the note (remount-key freeze gate)", () => {
		useQuery.mockReturnValue({ status: "pending" })
		useNoteEditing.mockReturnValueOnce(true)

		useNoteContentQuery(mockNote())

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
	})

	it("wires a queryFn that rejects the undecryptable sentinel instead of resolving undefined", async () => {
		useQuery.mockReturnValue({ status: "pending" })
		getNoteContent.mockResolvedValueOnce(undefined)

		useNoteContentQuery(mockNote())

		const options = useQuery.mock.calls[0]?.[0] as { queryFn: () => Promise<string> } | undefined

		if (options === undefined) {
			throw new Error("useQuery was not called with options")
		}

		await expect(
			options.queryFn().then(
				() => "resolved",
				(e: unknown) => isUndecryptableContentError(e)
			)
		).resolves.toBe(true)
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

import { describe, expect, it } from "vitest"
import type { Note, NoteHistory, NoteTag, UuidStr } from "@filen/sdk-rs"
import {
	DEFAULT_NOTE_TAGS_SORT_BY,
	filterNotesBySearch,
	filterNoteTagsBySearch,
	isNoteUndecryptable,
	isTagUndecryptable,
	noteDisplayTitle,
	noteTitleMatchesSearch,
	sortAndFilterNotes,
	sortNotes,
	sortNoteHistory,
	sortNoteTags,
	tagDisplayName,
	tagLastActivity
} from "@/features/notes/lib/sort"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a
// short label the same way drive.test.ts's testUuid does.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "00000000-0000-0000-0000-000000000000",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

function mockNoteTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: "00000000-0000-0000-0000-000000000000",
		name: "tag",
		favorite: false,
		editedTimestamp: 0n,
		createdTimestamp: 0n,
		...overrides
	}
}

// exactOptionalPropertyTypes distinguishes "key absent" (valid for an optional field) from "key
// present with value undefined" (rejected) — these two builders construct an undecryptable-style
// Note/NoteTag (title/name genuinely absent, matching what the wasm surface returns for a note the
// client can't decrypt) by simply never including the key, rather than assigning it undefined.
function mockNoteWithoutTitle(overrides: Omit<Partial<Note>, "title"> = {}): Note {
	return {
		uuid: "00000000-0000-0000-0000-000000000000",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

function mockNoteWithoutPreview(overrides: Omit<Partial<Note>, "preview"> = {}): Note {
	return {
		uuid: "00000000-0000-0000-0000-000000000000",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "title",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

function mockNoteTagWithoutName(overrides: Omit<Partial<NoteTag>, "name"> = {}): NoteTag {
	return {
		uuid: "00000000-0000-0000-0000-000000000000",
		favorite: false,
		editedTimestamp: 0n,
		createdTimestamp: 0n,
		...overrides
	}
}

describe("sortNotes — bucket rules", () => {
	it("puts a pinned note before an unpinned one regardless of edited time", () => {
		const pinned = mockNote({ uuid: testUuid("pinned"), pinned: true, editedTimestamp: 1n })
		const unpinned = mockNote({ uuid: testUuid("unpinned"), pinned: false, editedTimestamp: 100n })

		expect(sortNotes([unpinned, pinned])).toEqual([pinned, unpinned])
	})

	it("orders active before archived before trashed within the same pinned state", () => {
		const active = mockNote({ uuid: testUuid("active") })
		const archived = mockNote({ uuid: testUuid("archived"), archive: true })
		const trashed = mockNote({ uuid: testUuid("trashed"), trash: true })

		expect(sortNotes([trashed, archived, active])).toEqual([active, archived, trashed])
	})

	it("a trashed AND archived note sorts as trashed (trash tier wins the fold)", () => {
		const archivedOnly = mockNote({ uuid: testUuid("archived"), archive: true })
		const both = mockNote({ uuid: testUuid("both"), archive: true, trash: true })

		expect(sortNotes([both, archivedOnly])).toEqual([archivedOnly, both])
	})

	it("a pinned-and-trashed note still sorts ahead of every unpinned note", () => {
		const pinnedTrashed = mockNote({ uuid: testUuid("pinnedTrashed"), pinned: true, trash: true })
		const unpinnedActive = mockNote({ uuid: testUuid("unpinnedActive") })

		expect(sortNotes([unpinnedActive, pinnedTrashed])).toEqual([pinnedTrashed, unpinnedActive])
	})

	it("orders by editedTimestamp descending within the same bucket", () => {
		const older = mockNote({ uuid: testUuid("older"), editedTimestamp: 100n })
		const newer = mockNote({ uuid: testUuid("newer"), editedTimestamp: 200n })

		expect(sortNotes([older, newer])).toEqual([newer, older])
	})

	it("handles bigint timestamps that exceed Number.MAX_SAFE_INTEGER without truncation", () => {
		const huge = mockNote({ uuid: testUuid("huge"), editedTimestamp: 9_007_199_254_740_993n })
		const hugePlusOne = mockNote({ uuid: testUuid("hugePlusOne"), editedTimestamp: 9_007_199_254_740_994n })

		// A Number() conversion would collapse these two distinct bigints to the same double and lose
		// the ordering — asserting the exact order here catches any accidental Number() reintroduction.
		expect(sortNotes([huge, hugePlusOne])).toEqual([hugePlusOne, huge])
	})

	it("treats editedTimestamp 0n as a real, valid timestamp (not a falsy 'missing' sentinel)", () => {
		const zero = mockNote({ uuid: testUuid("zero"), editedTimestamp: 0n })
		const positive = mockNote({ uuid: testUuid("positive"), editedTimestamp: 1n })

		expect(sortNotes([zero, positive])).toEqual([positive, zero])
	})

	it("falls back to a deterministic uuid tiebreak for equal bucket + timestamp", () => {
		const a = mockNote({ uuid: testUuid("aaa"), editedTimestamp: 5n })
		const b = mockNote({ uuid: testUuid("bbb"), editedTimestamp: 5n })

		expect(sortNotes([b, a])).toEqual([a, b])
		// Stable regardless of input order.
		expect(sortNotes([a, b])).toEqual([a, b])
	})

	it("does not mutate the input array", () => {
		const input = [mockNote({ uuid: testUuid("b"), editedTimestamp: 1n }), mockNote({ uuid: testUuid("a"), editedTimestamp: 2n })]
		const snapshot = [...input]

		sortNotes(input)

		expect(input).toEqual(snapshot)
	})
})

describe("noteDisplayTitle / tagDisplayName", () => {
	it("falls back to uuid when title is undefined", () => {
		const uuid = testUuid("fallback")
		expect(noteDisplayTitle(mockNoteWithoutTitle({ uuid }))).toBe(uuid)
	})

	it("falls back to uuid when tag name is undefined", () => {
		const uuid = testUuid("fallback")
		expect(tagDisplayName(mockNoteTagWithoutName({ uuid }))).toBe(uuid)
	})
})

describe("isNoteUndecryptable / isTagUndecryptable", () => {
	it("a note is undecryptable exactly when it carries no encryptionKey", () => {
		expect(isNoteUndecryptable(mockNote({ encryptionKey: "note-key" }))).toBe(false)
		expect(isNoteUndecryptable(mockNoteWithoutTitle())).toBe(true)
	})

	it("a tag is undecryptable exactly when it carries no name", () => {
		expect(isTagUndecryptable(mockNoteTag())).toBe(false)
		expect(isTagUndecryptable(mockNoteTagWithoutName())).toBe(true)
	})
})

describe("filterNotesBySearch", () => {
	const notes = [
		mockNote({ uuid: testUuid("a"), title: "Groceries", preview: "milk, eggs" }),
		mockNoteWithoutPreview({ uuid: testUuid("b"), title: "Untitled" }),
		mockNote({ uuid: testUuid("c"), title: "Work notes", preview: "quarterly plan" })
	]

	it("returns every note unchanged for an empty/whitespace query", () => {
		expect(filterNotesBySearch(notes, "")).toEqual(notes)
		expect(filterNotesBySearch(notes, "   ")).toEqual(notes)
	})

	it("matches case-insensitively against the title", () => {
		expect(filterNotesBySearch(notes, "groceries").map(n => n.title)).toEqual(["Groceries"])
	})

	it("matches against the preview when the title doesn't match", () => {
		expect(filterNotesBySearch(notes, "quarterly").map(n => n.title)).toEqual(["Work notes"])
	})

	it("never throws on a note with an undefined preview", () => {
		expect(() => filterNotesBySearch(notes, "untitled")).not.toThrow()
		expect(filterNotesBySearch(notes, "untitled").map(n => n.title)).toEqual(["Untitled"])
	})

	it("excludes notes matching neither title nor preview", () => {
		expect(filterNotesBySearch(notes, "nonexistent")).toEqual([])
	})

	// Full-body search — a `bodies` map, when supplied, wins over the SDK preview snippet.
	it("matches against the eagerly-fetched full body when supplied, even when it differs from the preview", () => {
		const bodies = new Map([[testUuid("c"), "the quarterly plan mentions a deep-dive on onboarding metrics"]])

		expect(filterNotesBySearch(notes, "onboarding metrics", bodies).map(n => n.title)).toEqual(["Work notes"])
	})

	it("falls back to the preview for a note absent from the bodies map (still in flight)", () => {
		const bodies = new Map([[testUuid("a"), "unrelated body text"]])

		expect(filterNotesBySearch(notes, "quarterly", bodies).map(n => n.title)).toEqual(["Work notes"])
	})

	it("never checks the body at all for a note whose title already matches", () => {
		const bodies = new Map([[testUuid("a"), "this body text never gets read"]])

		expect(filterNotesBySearch(notes, "groceries", bodies).map(n => n.title)).toEqual(["Groceries"])
	})
})

describe("noteTitleMatchesSearch", () => {
	it("matches case-insensitively", () => {
		const note = mockNote({ title: "Quarterly Report" })

		expect(noteTitleMatchesSearch(note, "quarterly")).toBe(true)
	})

	it("does not match a substring absent from the title", () => {
		const note = mockNote({ title: "Quarterly Report" })

		expect(noteTitleMatchesSearch(note, "zzz")).toBe(false)
	})

	it("falls back to matching the uuid text for a title-less (undecryptable) note", () => {
		const uuid = testUuid("titleless-match")
		const note = mockNoteWithoutTitle({ uuid })

		expect(noteTitleMatchesSearch(note, "titleless-match")).toBe(true)
	})
})

describe("sortAndFilterNotes", () => {
	it("filters before sorting, then applies the bucket + timestamp order to the narrowed set", () => {
		const pinnedMatch = mockNote({ uuid: testUuid("pinned"), pinned: true, title: "task", editedTimestamp: 1n })
		const unpinnedMatch = mockNote({ uuid: testUuid("unpinned"), title: "task list", editedTimestamp: 100n })
		const nonMatch = mockNote({ uuid: testUuid("excluded"), title: "unrelated", editedTimestamp: 200n })

		expect(sortAndFilterNotes([nonMatch, unpinnedMatch, pinnedMatch], "task").map(n => n.title)).toEqual(["task", "task list"])
	})

	it("defaults to no filtering when search is omitted", () => {
		const a = mockNote({ uuid: testUuid("a"), title: "a", editedTimestamp: 2n })
		const b = mockNote({ uuid: testUuid("b"), title: "b", editedTimestamp: 1n })

		expect(sortAndFilterNotes([b, a]).map(n => n.title)).toEqual(["a", "b"])
	})
})

describe("filterNoteTagsBySearch", () => {
	const tags = [mockNoteTag({ uuid: testUuid("a"), name: "Personal" }), mockNoteTag({ uuid: testUuid("b"), name: "Work" })]

	it("returns every tag unchanged for an empty query", () => {
		expect(filterNoteTagsBySearch(tags, "")).toEqual(tags)
	})

	it("matches case-insensitively against the tag name", () => {
		expect(filterNoteTagsBySearch(tags, "work").map(t => t.name)).toEqual(["Work"])
	})
})

describe("tagLastActivity", () => {
	it("falls back to the tag's own editedTimestamp when it has no notes", () => {
		const tag = mockNoteTag({ editedTimestamp: 42n })

		expect(tagLastActivity(tag, [])).toBe(42)
	})

	it("returns the most recently edited note's timestamp among its notes", () => {
		const tag = mockNoteTag({ editedTimestamp: 1n })
		const notes = [mockNote({ editedTimestamp: 10n }), mockNote({ editedTimestamp: 30n }), mockNote({ editedTimestamp: 20n })]

		expect(tagLastActivity(tag, notes)).toBe(30)
	})
})

describe("sortNoteTags", () => {
	const workTag = mockNoteTag({ uuid: testUuid("work"), name: "Work", editedTimestamp: 5n })
	const personalTag = mockNoteTag({ uuid: testUuid("personal"), name: "Personal", editedTimestamp: 15n })
	const tags = [workTag, personalTag]

	it("defaults to lastActivityDesc semantics for an unrecognized sortBy value", () => {
		const notesByTag = { [workTag.uuid]: [], [personalTag.uuid]: [] }

		expect(sortNoteTags(tags, "not-a-real-mode" as unknown as typeof DEFAULT_NOTE_TAGS_SORT_BY, notesByTag).map(t => t.name)).toEqual([
			"Personal",
			"Work"
		])
	})

	it("sorts nameAsc/nameDesc via locale compare", () => {
		expect(sortNoteTags(tags, "nameAsc", {}).map(t => t.name)).toEqual(["Personal", "Work"])
		expect(sortNoteTags(tags, "nameDesc", {}).map(t => t.name)).toEqual(["Work", "Personal"])
	})

	it("sorts by note count when notesByTag differs from tag edited time", () => {
		const notesByTag = {
			[workTag.uuid]: [mockNote(), mockNote(), mockNote()],
			[personalTag.uuid]: [mockNote()]
		}

		expect(sortNoteTags(tags, "notesCountDesc", notesByTag).map(t => t.name)).toEqual(["Work", "Personal"])
		expect(sortNoteTags(tags, "notesCountAsc", notesByTag).map(t => t.name)).toEqual(["Personal", "Work"])
	})

	it("breaks activity/count ties by name", () => {
		const tied = [
			mockNoteTag({ uuid: testUuid("b"), name: "Bravo", editedTimestamp: 1n }),
			mockNoteTag({ uuid: testUuid("a"), name: "Alpha", editedTimestamp: 1n })
		]

		expect(sortNoteTags(tied, "lastActivityDesc", {}).map(t => t.name)).toEqual(["Alpha", "Bravo"])
	})

	it("does not mutate the input array", () => {
		const input = [...tags]
		const snapshot = [...input]

		sortNoteTags(input, "nameAsc", {})

		expect(input).toEqual(snapshot)
	})
})

function mockHistory(overrides: Partial<NoteHistory> = {}): NoteHistory {
	return {
		id: 1n,
		editedTimestamp: 0n,
		editorId: 1n,
		noteType: "text",
		...overrides
	}
}

describe("sortNoteHistory", () => {
	it("sorts newest-first by editedTimestamp, staying in bigint (never Number())", () => {
		const oldest = mockHistory({ id: 1n, editedTimestamp: 1_700_000_000_000n })
		const newest = mockHistory({ id: 2n, editedTimestamp: 1_800_000_000_000n })
		const middle = mockHistory({ id: 3n, editedTimestamp: 1_750_000_000_000n })

		expect(sortNoteHistory([oldest, newest, middle]).map(h => h.id)).toEqual([2n, 3n, 1n])
	})

	it("breaks a timestamp tie by the higher (later) id", () => {
		const lowerId = mockHistory({ id: 1n, editedTimestamp: 5n })
		const higherId = mockHistory({ id: 2n, editedTimestamp: 5n })

		expect(sortNoteHistory([lowerId, higherId]).map(h => h.id)).toEqual([2n, 1n])
	})

	it("does not mutate the input array", () => {
		const input = [mockHistory({ id: 1n }), mockHistory({ id: 2n, editedTimestamp: 1n })]
		const snapshot = [...input]

		sortNoteHistory(input)

		expect(input).toEqual(snapshot)
	})
})

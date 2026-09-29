import { describe, expect, it } from "vitest"
import {
	filterNotesBySearch,
	isNoteOwner,
	isNoteUndecryptable,
	isTagUndecryptable,
	hasNoteWriteAccess,
	noteDisplayTitle,
	noteTitleMatchesSearch,
	sortAndFilterNotes,
	sortNotes,
	sortNoteHistory,
	tagDisplayName
} from "@/features/notes/lib/sort"
import { testUuid } from "@/tests/support/uuid"
import {
	mockNote,
	mockNoteHistory,
	mockNoteParticipant,
	mockNoteTag,
	noteWithoutPreview,
	tagWithoutName,
	undecryptableNote
} from "@/tests/fixtures/notes"

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
		expect(noteDisplayTitle(undecryptableNote({ uuid }))).toBe(uuid)
	})

	it("falls back to uuid when tag name is undefined", () => {
		const uuid = testUuid("fallback")
		expect(tagDisplayName(tagWithoutName({ uuid }))).toBe(uuid)
	})
})

describe("isNoteUndecryptable / isTagUndecryptable", () => {
	it("a note is undecryptable exactly when it carries no encryptionKey", () => {
		expect(isNoteUndecryptable(mockNote({ encryptionKey: "note-key" }))).toBe(false)
		expect(isNoteUndecryptable(undecryptableNote())).toBe(true)
	})

	it("a tag is undecryptable exactly when it carries no name", () => {
		expect(isTagUndecryptable(mockNoteTag())).toBe(false)
		expect(isTagUndecryptable(tagWithoutName())).toBe(true)
	})
})

describe("isNoteOwner", () => {
	it("is true when the given userId matches the note's ownerId", () => {
		expect(isNoteOwner(mockNote({ ownerId: 5n }), 5n)).toBe(true)
	})

	it("is false when the given userId does not match", () => {
		expect(isNoteOwner(mockNote({ ownerId: 5n }), 6n)).toBe(false)
	})

	it("is false when userId is undefined (no resolved account yet)", () => {
		expect(isNoteOwner(mockNote({ ownerId: 5n }), undefined)).toBe(false)
	})
})

describe("hasNoteWriteAccess", () => {
	it("is true for the owner, with no participant row of their own", () => {
		expect(hasNoteWriteAccess(mockNote({ ownerId: 5n }), 5n)).toBe(true)
	})

	it("is true for a participant carrying permissionsWrite", () => {
		const note = mockNote({ ownerId: 5n, participants: [mockNoteParticipant({ userId: 7n, permissionsWrite: true })] })

		expect(hasNoteWriteAccess(note, 7n)).toBe(true)
	})

	it("is false for a participant without permissionsWrite", () => {
		const note = mockNote({ ownerId: 5n, participants: [mockNoteParticipant({ userId: 7n, permissionsWrite: false })] })

		expect(hasNoteWriteAccess(note, 7n)).toBe(false)
	})

	it("is false for a user who is neither owner nor participant, and for an unresolved id", () => {
		const note = mockNote({ ownerId: 5n, participants: [mockNoteParticipant({ userId: 7n, permissionsWrite: true })] })

		expect(hasNoteWriteAccess(note, 9n)).toBe(false)
		expect(hasNoteWriteAccess(note, undefined)).toBe(false)
	})
})

describe("filterNotesBySearch", () => {
	const notes = [
		mockNote({ uuid: testUuid("a"), title: "Groceries", preview: "milk, eggs" }),
		noteWithoutPreview({ uuid: testUuid("b"), title: "Untitled" }),
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
		const note = undecryptableNote({ uuid })

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

	it("narrows by full body via the bodies map when neither title nor preview matches", () => {
		const note = mockNote({ uuid: testUuid("body-only"), title: "gamma", preview: "preview" })
		const bodies = new Map([[note.uuid, "a term buried deep in the note body"]])

		expect(sortAndFilterNotes([note], "buried", bodies).map(n => n.uuid)).toStrictEqual([note.uuid])
		expect(sortAndFilterNotes([note], "buried")).toHaveLength(0)
	})
})

describe("sortNoteHistory", () => {
	it("sorts newest-first by editedTimestamp, staying in bigint (never Number())", () => {
		const oldest = mockNoteHistory({ id: 1n, editedTimestamp: 1_700_000_000_000n })
		const newest = mockNoteHistory({ id: 2n, editedTimestamp: 1_800_000_000_000n })
		const middle = mockNoteHistory({ id: 3n, editedTimestamp: 1_750_000_000_000n })

		expect(sortNoteHistory([oldest, newest, middle]).map(h => h.id)).toEqual([2n, 3n, 1n])
	})

	it("breaks a timestamp tie by the higher (later) id", () => {
		const lowerId = mockNoteHistory({ id: 1n, editedTimestamp: 5n })
		const higherId = mockNoteHistory({ id: 2n, editedTimestamp: 5n })

		expect(sortNoteHistory([lowerId, higherId]).map(h => h.id)).toEqual([2n, 1n])
	})

	it("does not mutate the input array", () => {
		const input = [mockNoteHistory({ id: 1n, editedTimestamp: 0n }), mockNoteHistory({ id: 2n, editedTimestamp: 1n })]
		const snapshot = [...input]

		sortNoteHistory(input)

		expect(input).toEqual(snapshot)
	})
})

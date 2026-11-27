import { describe, expect, it } from "vitest"
import { noteSearchHits } from "@/tests/support/noteSearchHits"
import {
	filterNotesBySearch,
	isNoteUndecryptable,
	isTagUndecryptable,
	noteTitleMatchesSearch,
	sortAndFilterNotes,
	sortNotes,
	tagDisplayName
} from "@/features/notes/lib/sort"
import { testUuid } from "@/tests/support/uuid"
import { mockNote, mockNoteTag, noteWithoutPreview, tagWithoutName, undecryptableNote } from "@/tests/fixtures/notes"

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

describe("tagDisplayName", () => {
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

	// Full-body search: the index's verdict wins over the SDK preview snippet.
	it("matches a note the index matched, even when its preview does not", () => {
		expect(filterNotesBySearch(notes, "onboarding metrics", noteSearchHits([testUuid("c")])).map(n => n.title)).toEqual(["Work notes"])
	})

	it("does not fall back to the preview of a note the index holds text for", () => {
		expect(filterNotesBySearch(notes, "quarterly", noteSearchHits([], [testUuid("c")]))).toEqual([])
	})

	it("falls back to the preview for a note the index holds no text for (still being read)", () => {
		expect(filterNotesBySearch(notes, "quarterly", noteSearchHits([], [testUuid("a")])).map(n => n.title)).toEqual(["Work notes"])
	})

	it("keeps a title match whatever the index says", () => {
		expect(filterNotesBySearch(notes, "groceries", noteSearchHits([], [testUuid("a")])).map(n => n.title)).toEqual(["Groceries"])
	})

	it("matches a mixed-case query against an index hit and a mixed-case preview", () => {
		const bodyNote = mockNote({ uuid: testUuid("d"), title: "delta", preview: "" })
		const previewNote = mockNote({ uuid: testUuid("e"), title: "echo", preview: "Launch Checklist" })

		expect(
			filterNotesBySearch([bodyNote, previewNote], "  LAUNCH Checklist ", noteSearchHits([bodyNote.uuid])).map(n => n.title)
		).toEqual(["delta", "echo"])
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

	it("never substring-matches the hidden uuid of an undecryptable note", () => {
		const note = undecryptableNote({ uuid: "a4c1e2f0-0000-4000-8000-000000000000" })

		expect(noteTitleMatchesSearch(note, "a")).toBe(false)
		expect(noteTitleMatchesSearch(note, "4")).toBe(false)
		expect(noteTitleMatchesSearch(note, "-")).toBe(false)
		expect(filterNotesBySearch([note], "a")).toEqual([])
		expect(filterNotesBySearch([note], "-")).toEqual([])
	})

	it("matches an undecryptable note on its full uuid", () => {
		const note = undecryptableNote({ uuid: "a4c1e2f0-0000-4000-8000-000000000000" })

		expect(noteTitleMatchesSearch(note, note.uuid)).toBe(true)
		expect(filterNotesBySearch([note], ` ${note.uuid.toUpperCase()} `)).toEqual([note])
	})

	it("still matches a titled note by title substring", () => {
		const note = mockNote({ uuid: testUuid("titled"), title: "A-4 checklist" })

		expect(noteTitleMatchesSearch(note, "a")).toBe(true)
		expect(noteTitleMatchesSearch(note, "-4")).toBe(true)
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

	it("narrows by the index's body match when neither title nor preview matches", () => {
		const note = mockNote({ uuid: testUuid("body-only"), title: "gamma", preview: "preview" })

		expect(sortAndFilterNotes([note], "buried", noteSearchHits([note.uuid])).map(n => n.uuid)).toStrictEqual([note.uuid])
		expect(sortAndFilterNotes([note], "buried")).toHaveLength(0)
	})
})

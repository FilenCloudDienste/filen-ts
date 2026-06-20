import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/secureStore", () => ({
	useSecureStore: vi.fn()
}))

vi.mock("@/lib/decryption", () => ({
	tagDisplayName: (tag: { name?: string }) => tag.name ?? ""
}))

vi.mock("@filen/utils", () => ({
	fastLocaleCompare: (a: string, b: string) => a.localeCompare(b)
}))

import {
	tagLastActivity,
	sortNoteTags,
	DEFAULT_NOTES_TAGS_SORT_BY,
	type NotesTagsSortBy
} from "@/features/notes/notesTagsSortPreference"
import { type Note, type NoteTag } from "@/types"

function tag(uuid: string, name: string, editedTimestamp: number): NoteTag {
	return { uuid, name, favorite: false, editedTimestamp, createdTimestamp: editedTimestamp } as unknown as NoteTag
}

function note(uuid: string, editedTimestamp: number | undefined, createdTimestamp: number): Note {
	return { uuid, editedTimestamp, createdTimestamp } as unknown as Note
}

describe("notesTagsSortPreference — tagLastActivity", () => {
	it("falls back to the tag's own edited time when it has no notes", () => {
		expect(tagLastActivity(tag("t1", "a", 500), [])).toBe(500)
	})

	it("returns the most recent note edited time when the tag has notes", () => {
		const notes = [note("n1", 100, 50), note("n2", 300, 50), note("n3", 200, 50)]

		expect(tagLastActivity(tag("t1", "a", 999), notes)).toBe(300)
	})

	it("uses createdTimestamp when a note has no editedTimestamp", () => {
		const notes = [note("n1", undefined, 700)]

		expect(tagLastActivity(tag("t1", "a", 100), notes)).toBe(700)
	})
})

describe("notesTagsSortPreference — sortNoteTags", () => {
	const tagA = tag("a", "Alpha", 100)
	const tagB = tag("b", "Bravo", 100)
	const tagC = tag("c", "Charlie", 100)
	const tags = [tagB, tagC, tagA]

	// Activity: A oldest (100, no notes), B newest (note 900), C middle (note 500).
	const notesByTag: Record<string, Note[]> = {
		a: [],
		b: [note("nb", 900, 1)],
		c: [note("nc", 500, 1)]
	}

	it("lastActivityDesc orders newest activity first (name tiebreak)", () => {
		const result = sortNoteTags(tags, "lastActivityDesc", notesByTag).map(x => x.uuid)

		expect(result).toEqual(["b", "c", "a"])
	})

	it("lastActivityAsc orders oldest activity first", () => {
		const result = sortNoteTags(tags, "lastActivityAsc", notesByTag).map(x => x.uuid)

		expect(result).toEqual(["a", "c", "b"])
	})

	it("nameAsc orders A→Z", () => {
		expect(sortNoteTags(tags, "nameAsc", notesByTag).map(x => x.uuid)).toEqual(["a", "b", "c"])
	})

	it("nameDesc orders Z→A", () => {
		expect(sortNoteTags(tags, "nameDesc", notesByTag).map(x => x.uuid)).toEqual(["c", "b", "a"])
	})

	it("notesCountDesc orders most-notes first (name tiebreak for equal counts)", () => {
		// counts: a=0, b=1, c=1 → b,c (alpha tiebreak) then a
		expect(sortNoteTags(tags, "notesCountDesc", notesByTag).map(x => x.uuid)).toEqual(["b", "c", "a"])
	})

	it("notesCountAsc orders fewest-notes first", () => {
		expect(sortNoteTags(tags, "notesCountAsc", notesByTag).map(x => x.uuid)).toEqual(["a", "b", "c"])
	})

	it("falls back to lastActivityDesc for an unknown sort value", () => {
		const result = sortNoteTags(tags, "bogus" as NotesTagsSortBy, notesByTag).map(x => x.uuid)

		expect(result).toEqual(["b", "c", "a"])
	})

	it("does not mutate the input array", () => {
		const input = [...tags]

		sortNoteTags(input, "nameAsc", notesByTag)

		expect(input).toEqual(tags)
	})

	it("default sort is lastActivityDesc", () => {
		expect(DEFAULT_NOTES_TAGS_SORT_BY).toBe("lastActivityDesc")
	})
})

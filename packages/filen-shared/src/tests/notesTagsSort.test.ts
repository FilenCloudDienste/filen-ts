import { describe, it, expect } from "vitest"
import { NOTE_TAGS_SORT_OPTIONS, DEFAULT_NOTE_TAGS_SORT_BY, tagLastActivity, sortNoteTags, type NoteTagsSortBy } from "@filen/shared"

type TestTag = { uuid: string; name: string; editedTimestamp: bigint }
type TestNote = { uuid: string; editedTimestamp: bigint }

function tag(uuid: string, name: string, editedTimestamp: bigint): TestTag {
	return { uuid, name, editedTimestamp }
}

function note(uuid: string, editedTimestamp: bigint): TestNote {
	return { uuid, editedTimestamp }
}

// Plain name-based display, standing in for either app's real (platform-specific) placeholder logic.
const byName = (t: TestTag): string => t.name

describe("NOTE_TAGS_SORT_OPTIONS / DEFAULT_NOTE_TAGS_SORT_BY", () => {
	it("carries the six-option vocabulary", () => {
		expect(NOTE_TAGS_SORT_OPTIONS).toEqual([
			"lastActivityDesc",
			"lastActivityAsc",
			"nameAsc",
			"nameDesc",
			"notesCountDesc",
			"notesCountAsc"
		])
	})

	it("defaults to lastActivityDesc", () => {
		expect(DEFAULT_NOTE_TAGS_SORT_BY).toBe("lastActivityDesc")
	})
})

describe("tagLastActivity", () => {
	it("falls back to the tag's own editedTimestamp when it has no notes", () => {
		expect(tagLastActivity(tag("t1", "a", 500n), [])).toBe(500)
	})

	it("returns the most recently edited note's timestamp among its notes", () => {
		const notes = [note("n1", 100n), note("n2", 300n), note("n3", 200n)]

		expect(tagLastActivity(tag("t1", "a", 999n), notes)).toBe(300)
	})

	it("stays correct for a single note", () => {
		expect(tagLastActivity(tag("t1", "a", 1n), [note("n1", 42n)])).toBe(42)
	})
})

describe("sortNoteTags", () => {
	const tagA = tag("a", "Alpha", 100n)
	const tagB = tag("b", "Bravo", 100n)
	const tagC = tag("c", "Charlie", 100n)
	const tags = [tagB, tagC, tagA]

	// Activity: A oldest (100, no notes), B newest (note 900), C middle (note 500).
	const notesByTag: Record<string, readonly TestNote[]> = {
		a: [],
		b: [note("nb", 900n)],
		c: [note("nc", 500n)]
	}

	it("lastActivityDesc orders newest activity first (name tiebreak)", () => {
		expect(sortNoteTags(tags, "lastActivityDesc", notesByTag, byName).map(t => t.uuid)).toEqual(["b", "c", "a"])
	})

	it("lastActivityAsc orders oldest activity first", () => {
		expect(sortNoteTags(tags, "lastActivityAsc", notesByTag, byName).map(t => t.uuid)).toEqual(["a", "c", "b"])
	})

	it("nameAsc orders A -> Z", () => {
		expect(sortNoteTags(tags, "nameAsc", notesByTag, byName).map(t => t.uuid)).toEqual(["a", "b", "c"])
	})

	it("nameDesc orders Z -> A", () => {
		expect(sortNoteTags(tags, "nameDesc", notesByTag, byName).map(t => t.uuid)).toEqual(["c", "b", "a"])
	})

	it("notesCountDesc orders most-notes first (name tiebreak for equal counts)", () => {
		// counts: a=0, b=1, c=1 -> b,c (alpha tiebreak) then a
		expect(sortNoteTags(tags, "notesCountDesc", notesByTag, byName).map(t => t.uuid)).toEqual(["b", "c", "a"])
	})

	it("notesCountAsc orders fewest-notes first", () => {
		expect(sortNoteTags(tags, "notesCountAsc", notesByTag, byName).map(t => t.uuid)).toEqual(["a", "b", "c"])
	})

	it("falls back to lastActivityDesc semantics for an unrecognized sortBy value", () => {
		expect(sortNoteTags(tags, "bogus" as unknown as NoteTagsSortBy, notesByTag, byName).map(t => t.uuid)).toEqual(["b", "c", "a"])
	})

	it("does not mutate the input array", () => {
		const input = [...tags]

		sortNoteTags(input, "nameAsc", notesByTag, byName)

		expect(input).toEqual(tags)
	})

	it("breaks activity ties by the injected display name, not a fixed field", () => {
		const tied = [tag("x", "Zeta", 1n), tag("y", "Alpha", 1n)]

		// Reversed display name -> reversed tiebreak order, proving the sort reads the injected
		// function rather than a hardcoded name field.
		const reversed = (t: TestTag): string => (t.name === "Zeta" ? "Alpha" : "Zeta")

		expect(sortNoteTags(tied, "lastActivityDesc", {}, byName).map(t => t.uuid)).toEqual(["y", "x"])
		expect(sortNoteTags(tied, "lastActivityDesc", {}, reversed).map(t => t.uuid)).toEqual(["x", "y"])
	})
})

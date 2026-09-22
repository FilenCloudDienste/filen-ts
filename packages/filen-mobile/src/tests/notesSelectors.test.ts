import { describe, it, expect } from "vitest"
import { aggregateNoteTagSelectionFlags, EMPTY_NOTE_TAG_FLAGS } from "@/features/notes/notesSelectors"
import { type NoteTag } from "@/types"

function tag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: "t",
		name: "tag",
		favorite: false,
		undecryptable: false,
		...overrides
	} as NoteTag
}

describe("aggregateNoteTagSelectionFlags", () => {
	it("returns EMPTY_NOTE_TAG_FLAGS on empty selection", () => {
		expect(aggregateNoteTagSelectionFlags([])).toBe(EMPTY_NOTE_TAG_FLAGS)
	})

	it("EMPTY_NOTE_TAG_FLAGS is frozen", () => {
		expect(Object.isFrozen(EMPTY_NOTE_TAG_FLAGS)).toBe(true)
	})

	it("counts tags and detects any-favorited", () => {
		expect(aggregateNoteTagSelectionFlags([tag(), tag({ favorite: true })])).toEqual({
			count: 2,
			includesFavorited: true
		})
	})

	it("includesFavorited false when none favorited", () => {
		expect(aggregateNoteTagSelectionFlags([tag(), tag()]).includesFavorited).toBe(false)
	})

	it("single tag with favorite:true yields count 1 and includesFavorited true", () => {
		const result = aggregateNoteTagSelectionFlags([tag({ favorite: true })])

		expect(result.count).toBe(1)
		expect(result.includesFavorited).toBe(true)
	})
})

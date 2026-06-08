import { describe, it, expect, vi } from "vitest"

// utils.ts imports the NoteType enum (a runtime value) from @filen/sdk-rs; mock it
// with the real ordinal values. Note/NoteTag are type-only imports (erased at runtime).
vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: 0,
		Md: 1,
		Code: 2,
		Rich: 3,
		Checklist: 4
	}
}))

import { NoteType } from "@filen/sdk-rs"
import { type Note, type NoteTag } from "@/types"
import {
	noteTypeToEditorType,
	computeTagState,
	filterNoteListItemsBySearchQuery,
	filterNoteTagsBySearchQuery
} from "@/features/notes/utils"
import { type ListItem as NoteListItem } from "@/features/notes/components/note"

function makeTag(uuid: string): NoteTag {
	return { uuid } as unknown as NoteTag
}

function makeNote(tagUuids: string[]): Note {
	return {
		tags: tagUuids.map(uuid => ({ uuid }))
	} as unknown as Note
}

function makeNamedTag(uuid: string, name: string): NoteTag {
	return { uuid, name, undecryptable: false } as unknown as NoteTag
}

function makeListNote(uuid: string, title: string, content?: string): NoteListItem {
	return {
		type: "note",
		uuid,
		title,
		content,
		undecryptable: false
	} as unknown as NoteListItem
}

function makeListHeader(id: string): NoteListItem {
	return {
		type: "header",
		id,
		title: id
	} as unknown as NoteListItem
}

describe("noteTypeToEditorType", () => {
	it("maps Code -> code", () => {
		expect(noteTypeToEditorType(NoteType.Code)).toBe("code")
	})

	it("maps Md -> markdown", () => {
		expect(noteTypeToEditorType(NoteType.Md)).toBe("markdown")
	})

	it("maps Rich -> richtext", () => {
		expect(noteTypeToEditorType(NoteType.Rich)).toBe("richtext")
	})

	it("maps Text -> text", () => {
		expect(noteTypeToEditorType(NoteType.Text)).toBe("text")
	})

	it("falls back to text for Checklist (never rendered through TextEditor)", () => {
		expect(noteTypeToEditorType(NoteType.Checklist)).toBe("text")
	})
})

describe("computeTagState", () => {
	const tag = makeTag("tag-1")

	it("returns 'none' for an empty note set", () => {
		expect(computeTagState({ notes: [], tag })).toBe("none")
	})

	it("returns 'none' when no note carries the tag", () => {
		const notes = [makeNote(["other"]), makeNote([])]

		expect(computeTagState({ notes, tag })).toBe("none")
	})

	it("returns 'all' when every note carries the tag", () => {
		const notes = [makeNote(["tag-1"]), makeNote(["tag-1", "other"])]

		expect(computeTagState({ notes, tag })).toBe("all")
	})

	it("returns 'some' when only a subset carries the tag", () => {
		const notes = [makeNote(["tag-1"]), makeNote(["other"])]

		expect(computeTagState({ notes, tag })).toBe("some")
	})

	it("returns 'all' for a single tagged note", () => {
		expect(computeTagState({ notes: [makeNote(["tag-1"])], tag })).toBe("all")
	})
})

describe("filterNoteListItemsBySearchQuery", () => {
	const apple = makeListNote("n1", "Apple pie")
	const banana = makeListNote("n2", "Banana bread")
	const header = makeListHeader("favorited")
	const list: NoteListItem[] = [header, apple, banana]

	it("returns the list unchanged for an empty query (headers preserved)", () => {
		const result = filterNoteListItemsBySearchQuery(list, "")

		expect(result).toBe(list)
	})

	it("returns the list unchanged for a whitespace-only query", () => {
		const result = filterNoteListItemsBySearchQuery(list, "   ")

		expect(result).toBe(list)
	})

	it("drops section headers when a query is active", () => {
		const result = filterNoteListItemsBySearchQuery(list, "a")

		expect(result.some(item => item.type === "header")).toBe(false)
	})

	it("matches case-insensitively against the title", () => {
		const result = filterNoteListItemsBySearchQuery(list, "APPLE")

		expect(result).toHaveLength(1)
		expect(result[0]?.type === "note" ? result[0].uuid : null).toBe("n1")
	})

	it("matches against note content", () => {
		const withContent = makeListNote("n3", "Untitled", "secret recipe")
		const result = filterNoteListItemsBySearchQuery([withContent], "recipe")

		expect(result).toHaveLength(1)
		expect(result[0]?.type === "note" ? result[0].uuid : null).toBe("n3")
	})

	it("returns the matching subset only", () => {
		const result = filterNoteListItemsBySearchQuery(list, "banana")

		expect(result.map(item => (item.type === "note" ? item.uuid : item.id))).toEqual(["n2"])
	})

	it("returns an empty array when nothing matches", () => {
		expect(filterNoteListItemsBySearchQuery(list, "zzz")).toEqual([])
	})

	it("matches the cannot_decrypt placeholder for undecryptable notes", () => {
		const undec = { type: "note", uuid: "abc", undecryptable: true } as unknown as NoteListItem
		const result = filterNoteListItemsBySearchQuery([undec], "cannot_decrypt_abc")

		expect(result).toHaveLength(1)
	})
})

describe("filterNoteTagsBySearchQuery", () => {
	const work = makeNamedTag("t1", "work")
	const home = makeNamedTag("t2", "home")
	const tags: NoteTag[] = [work, home]

	it("returns the list unchanged for an empty query", () => {
		expect(filterNoteTagsBySearchQuery(tags, "")).toBe(tags)
	})

	it("returns the list unchanged for a whitespace-only query", () => {
		expect(filterNoteTagsBySearchQuery(tags, "  ")).toBe(tags)
	})

	it("matches case-insensitively against the tag name", () => {
		const result = filterNoteTagsBySearchQuery(tags, "WORK")

		expect(result).toEqual([work])
	})

	it("returns an empty array when nothing matches", () => {
		expect(filterNoteTagsBySearchQuery(tags, "zzz")).toEqual([])
	})
})

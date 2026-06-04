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
import { noteTypeToEditorType, computeTagState } from "@/features/notes/utils"

function makeTag(uuid: string): NoteTag {
	return { uuid } as unknown as NoteTag
}

function makeNote(tagUuids: string[]): Note {
	return {
		tags: tagUuids.map(uuid => ({ uuid }))
	} as unknown as Note
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

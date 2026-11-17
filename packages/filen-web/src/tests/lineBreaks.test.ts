import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { joinLines, lineBreaksField, otherLineBreaks } from "@/features/preview/lib/lineBreaks"

// A file with mixed line endings saves back with each untouched line's own ending; only edited breaks change.

const MIXED = "a\r\nb\nc\r\nd\re"

function editor(text: string) {
	const breaks = otherLineBreaks(text, "\r\n")
	const { field, extension } = lineBreaksField(breaks)
	let state = EditorState.create({ doc: text, extensions: extension })

	return {
		edit(changes: { from: number; to?: number; insert?: string }) {
			state = state.update({ changes }).state
		},
		saved: () => joinLines(state.doc, "\r\n", state.field(field))
	}
}

describe("line breaks", () => {
	it("saves every untouched break as it was", () => {
		expect(editor(MIXED).saved()).toBe(MIXED)
	})

	it("keeps a line's break through an edit on it, before it and after it", () => {
		const file = editor(MIXED)

		// "b|" — the end of the line its LF ends.
		file.edit({ from: 3, insert: "X" })
		// The start of the next line.
		file.edit({ from: 5, insert: "Y" })
		// A line before.
		file.edit({ from: 0, insert: "Z" })

		expect(file.saved()).toBe("Za\r\nbX\nYc\r\nd\re")
	})

	it("drops a break an edit deletes, and gives a new one the file's ending", () => {
		const file = editor(MIXED)

		// Joins b and c.
		file.edit({ from: 3, to: 4 })
		// Splits a.
		file.edit({ from: 1, insert: "\n" })

		expect(file.saved()).toBe("a\r\n\r\nbc\r\nd\re")
	})

	it("finds none in a file with one ending", () => {
		expect(otherLineBreaks("a\r\nb\r\n", "\r\n").size).toBe(0)
	})
})

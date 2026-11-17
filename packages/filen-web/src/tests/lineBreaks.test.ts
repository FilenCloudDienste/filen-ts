import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { history, redo, undo } from "@codemirror/commands"
import { joinLines, lineBreaksField, otherLineBreaks } from "@/features/preview/lib/lineBreaks"

// A file with mixed line endings saves back with each untouched line's own ending; only edited breaks change.

const MIXED = "a\r\nb\nc\r\nd\re"

function editor(text: string) {
	const breaks = otherLineBreaks(text, "\r\n")
	const { field, extension } = lineBreaksField(breaks)
	let state = EditorState.create({ doc: text, extensions: [extension, history()] })
	const run = (command: typeof undo): void => {
		command({
			state,
			dispatch: transaction => {
				state = transaction.state
			}
		})
	}

	return {
		edit(changes: { from: number; to?: number; insert?: string }) {
			state = state.update({ changes, userEvent: "input" }).state
		},
		undo: () => {
			run(undo)
		},
		redo: () => {
			run(redo)
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

	// The break returns with its own ending, not the file's.
	it("restores a deleted break's ending when the edit is undone, and drops it again on redo", () => {
		const file = editor(MIXED)

		// Deletes b's LF and the CR after d, then puts both back.
		file.edit({ from: 3, to: 4 })
		file.edit({ from: 6, to: 7 })
		file.undo()
		file.undo()

		expect(file.saved()).toBe(MIXED)

		file.redo()

		expect(file.saved()).toBe("a\r\nbc\r\nd\re")
	})
})

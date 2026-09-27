import { describe, expect, it } from "vitest"
import { EditorSelection, EditorState, type StateCommand, type Transaction } from "@codemirror/state"
import { insertLink, toggleInlineMarker } from "@/features/preview/lib/markdownCommands"
import { codeMirrorKeys } from "@/features/preview/lib/editorKeys.logic"

// Runs a command on `doc` with `[from, to]` selected; returns the new document and selection.
function run(command: StateCommand, doc: string, from: number, to = from, readOnly = false) {
	let state = EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: EditorState.readOnly.of(readOnly) })
	const handled = command({
		state,
		dispatch: (transaction: Transaction) => {
			state = transaction.state
		}
	})
	const range = state.selection.main

	return { handled, doc: state.doc.toString(), selected: state.sliceDoc(range.from, range.to), cursor: range.head }
}

describe("toggleInlineMarker", () => {
	const bold = toggleInlineMarker("**")

	it("wraps the selection and keeps it selected", () => {
		expect(run(bold, "a word here", 2, 6)).toMatchObject({ doc: "a **word** here", selected: "word" })
	})

	it("unwraps a selection with the markers just outside it", () => {
		expect(run(bold, "a **word** here", 4, 8)).toMatchObject({ doc: "a word here", selected: "word" })
	})

	it("unwraps a selection that includes the markers", () => {
		expect(run(bold, "a **word** here", 2, 10)).toMatchObject({ doc: "a word here", selected: "word" })
	})

	it("inserts an empty pair with the cursor inside, and takes it out again", () => {
		const inserted = run(bold, "ab", 1)

		expect(inserted).toMatchObject({ doc: "a****b", cursor: 3 })
		expect(run(bold, inserted.doc, inserted.cursor)).toMatchObject({ doc: "ab", cursor: 1 })
	})

	it("does nothing in a read-only editor", () => {
		expect(run(bold, "word", 0, 4, true)).toMatchObject({ handled: false, doc: "word" })
	})
})

describe("insertLink", () => {
	it("makes the selection the label and selects the url placeholder", () => {
		expect(run(insertLink, "see docs now", 4, 8)).toMatchObject({ doc: "see [docs](url) now", selected: "url" })
	})

	it("makes a selected url the target, with the cursor in the empty label", () => {
		expect(run(insertLink, "https://filen.io", 0, 16)).toMatchObject({ doc: "[](https://filen.io)", cursor: 1 })
	})

	it("inserts an empty link with nothing selected", () => {
		expect(run(insertLink, "", 0)).toMatchObject({ doc: "[](url)", cursor: 1 })
	})
})

describe("codeMirrorKeys", () => {
	it("maps the app's combos to CodeMirror's notation, alternatives and all", () => {
		expect(codeMirrorKeys("mod+shift+x")).toEqual(["Mod-Shift-x"])
		expect(codeMirrorKeys("mod+alt+f")).toEqual(["Mod-Alt-f"])
		expect(codeMirrorKeys("delete,backspace")).toEqual(["Delete", "Backspace"])
		expect(codeMirrorKeys("ctrl+slash")).toEqual(["Ctrl-/"])
		expect(codeMirrorKeys("")).toEqual([])
	})
})

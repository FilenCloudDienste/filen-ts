import { describe, expect, it } from "vitest"
import { EditorSelection, EditorState, type StateCommand, type Transaction } from "@codemirror/state"
import { insertLink, toggleInlineMarker, toggleItalic } from "@/features/preview/lib/markdownCommands"
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

describe("toggleItalic", () => {
	it("uses _ between word boundaries", () => {
		expect(run(toggleItalic, "a word here", 2, 6)).toMatchObject({ doc: "a _word_ here", selected: "word" })
	})

	it("uses * mid-word, where _ would not render", () => {
		expect(run(toggleItalic, "unbelievable", 2, 8)).toMatchObject({ doc: "un*believ*able", selected: "believ" })
		expect(run(toggleItalic, "word here", 0, 2)).toMatchObject({ doc: "*wo*rd here" })
		expect(run(toggleItalic, "ab", 1)).toMatchObject({ doc: "a**b", cursor: 2 })
	})

	it("takes either marker off", () => {
		expect(run(toggleItalic, "a _word_ here", 3, 7)).toMatchObject({ doc: "a word here", selected: "word" })
		expect(run(toggleItalic, "un*believ*able", 3, 9)).toMatchObject({ doc: "unbelievable", selected: "believ" })
		expect(run(toggleItalic, "a *word* here", 2, 8)).toMatchObject({ doc: "a word here", selected: "word" })
	})

	it("never reads half of a bold pair as italic", () => {
		expect(run(toggleItalic, "a **word** here", 4, 8)).toMatchObject({ doc: "a **_word_** here", selected: "word" })
		expect(run(toggleItalic, "a **word** here", 2, 10)).toMatchObject({ doc: "a _**word**_ here", selected: "**word**" })
	})

	it("does nothing in a read-only editor", () => {
		expect(run(toggleItalic, "word", 0, 4, true)).toMatchObject({ handled: false, doc: "word" })
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

	it("maps the recorder's event.code tokens to KeyboardEvent.key names", () => {
		const tokens = [
			["arrowup", "ArrowUp"],
			["arrowdown", "ArrowDown"],
			["arrowleft", "ArrowLeft"],
			["arrowright", "ArrowRight"],
			["pageup", "PageUp"],
			["pagedown", "PageDown"],
			["home", "Home"],
			["end", "End"],
			["bracketleft", "["],
			["bracketright", "]"],
			["minus", "-"],
			["equal", "="],
			["semicolon", ";"],
			["quote", "'"],
			["backquote", "`"],
			["backslash", "\\"],
			["comma", ","],
			["period", "."],
			["slash", "/"],
			["space", "Space"],
			["enter", "Enter"],
			["escape", "Escape"],
			["tab", "Tab"],
			["backspace", "Backspace"],
			["delete", "Delete"],
			["f1", "F1"],
			["f12", "F12"],
			["1", "1"],
			["a", "a"]
		] as const

		for (const [token, key] of tokens) {
			expect(codeMirrorKeys(`mod+${token}`), token).toEqual([`Mod-${key}`])
		}
	})

	it("maps react-hotkeys-hook's aliases and the numpad operators", () => {
		expect(codeMirrorKeys("esc,return,up,shift+down,mod+add,mod+subtract")).toEqual([
			"Escape",
			"Enter",
			"ArrowUp",
			"Shift-ArrowDown",
			"Mod-+",
			"Mod--"
		])
	})
})

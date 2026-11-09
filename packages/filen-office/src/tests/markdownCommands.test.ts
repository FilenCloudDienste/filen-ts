import { describe, expect, it } from "vitest"
import { EditorSelection, EditorState, type StateCommand, type Transaction } from "@codemirror/state"
import { insertLink, toggleInlineMarker, toggleItalic } from "../core/markdown/index"

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

	it("wraps a triple-clicked line without its line break, and toggles it back off", () => {
		const wrapped = run(bold, "line\nnext", 0, 5)

		expect(wrapped).toMatchObject({ doc: "**line**\nnext", selected: "**line**\n" })
		expect(run(bold, wrapped.doc, 0, wrapped.selected.length)).toMatchObject({ doc: "line\nnext", selected: "line\n" })
	})

	it("keeps surrounding whitespace outside the markers", () => {
		const wrapped = run(bold, "a word here", 2, 7)

		expect(wrapped).toMatchObject({ doc: "a **word** here", selected: "**word** " })
		expect(run(bold, wrapped.doc, 2, 11)).toMatchObject({ doc: "a word here", selected: "word " })
		expect(run(toggleInlineMarker("~~"), "  word  ", 0, 8)).toMatchObject({ doc: "  ~~word~~  " })
	})

	it("wraps each line of a multi-paragraph selection", () => {
		const wrapped = run(bold, "p1\n\np2", 0, 6)

		expect(wrapped).toMatchObject({ doc: "**p1**\n\n**p2**", selected: "**p1**\n\n**p2**" })
		expect(run(bold, wrapped.doc, 0, wrapped.doc.length)).toMatchObject({ doc: "p1\n\np2", selected: "p1\n\np2" })
	})

	it("wraps only the unwrapped lines of a partly formatted selection", () => {
		expect(run(bold, "**a**\nb", 0, 7)).toMatchObject({ doc: "**a**\n**b**" })
	})

	it("inserts an empty pair at the cursor for an all-whitespace selection", () => {
		expect(run(bold, "a  b", 1, 3)).toMatchObject({ doc: "a  ****b", cursor: 5 })
	})
})

describe("inline code", () => {
	const code = toggleInlineMarker("`")

	it("wraps and unwraps a plain selection with one backtick", () => {
		const wrapped = run(code, "a word here", 2, 6)

		expect(wrapped).toMatchObject({ doc: "a `word` here", selected: "word" })
		expect(run(code, wrapped.doc, 3, 7)).toMatchObject({ doc: "a word here", selected: "word" })
	})

	it("uses a longer fence around content with a backtick, and toggles back", () => {
		const wrapped = run(code, "a`b", 0, 3)

		expect(wrapped).toMatchObject({ doc: "``a`b``", selected: "a`b" })
		expect(run(code, wrapped.doc, 2, 5)).toMatchObject({ doc: "a`b", selected: "a`b" })
		expect(run(code, wrapped.doc, 0, 7)).toMatchObject({ doc: "a`b", selected: "a`b" })
	})

	it("pads content that starts or ends with a backtick, and toggles back", () => {
		const wrapped = run(code, "`x", 0, 2)

		expect(wrapped).toMatchObject({ doc: "`` `x ``", selected: "`x" })
		expect(run(code, wrapped.doc, 3, 5)).toMatchObject({ doc: "`x", selected: "`x" })
		expect(run(code, wrapped.doc, 0, 8)).toMatchObject({ doc: "`x", selected: "`x" })
	})

	it("does not read two code spans as one", () => {
		expect(run(code, "`a` and `b`", 0, 11)).toMatchObject({ doc: "`` `a` and `b` ``" })
	})

	it("keeps a soft line break inside one span but splits at blank lines", () => {
		expect(run(code, "a\nb\n\nc", 0, 6)).toMatchObject({ doc: "`a\nb`\n\n`c`" })
	})

	it("inserts an empty pair at the cursor, and takes it out again", () => {
		const inserted = run(code, "ab", 1)

		expect(inserted).toMatchObject({ doc: "a``b", cursor: 2 })
		expect(run(code, inserted.doc, inserted.cursor)).toMatchObject({ doc: "ab", cursor: 1 })
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

	it("trims whitespace and line breaks, choosing the marker from each line's trimmed bounds", () => {
		const wrapped = run(toggleItalic, "a word\nnext", 2, 7)

		expect(wrapped).toMatchObject({ doc: "a _word_\nnext", selected: "_word_\n" })
		expect(run(toggleItalic, wrapped.doc, 2, 9)).toMatchObject({ doc: "a word\nnext", selected: "word\n" })
		expect(run(toggleItalic, "x one\ntwo", 2, 9)).toMatchObject({ doc: "x _one_\n_two_" })
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

// @vitest-environment happy-dom
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { turnedArrow } from "../react/docx/edit/sink"
import { buildDocx } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// Arrow keys in sideways table cells move as the text is drawn (Word): along bottom to top text Up goes on and Down
// back, across it Right goes to the next line; top to bottom text the other way round.

const SECTION =
	'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
const TEXT = "alpha bravo charlie delta echo foxtrot golf hotel"

function p(text: string): string {
	return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

async function editorFor(direction: string): Promise<PagedEditor> {
	const { editor } = await pagedEditor(
		buildDocx({
			body:
				'<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>' +
				`<w:tr><w:trPr><w:trHeight w:val="1200" w:hRule="exact"/></w:trPr><w:tc><w:tcPr><w:textDirection w:val="${direction}"/></w:tcPr>${p(TEXT)}</w:tc>` +
				`<w:tc>${p("beside")}</w:tc></w:tr></w:tbl>${p("after")}${SECTION}`
		})
	)

	return editor
}

function find(doc: Node, text: string): number {
	let found = -1

	doc.descendants((node, pos) => {
		if (found >= 0) return false

		const at = node.isText ? (node.text ?? "").indexOf(text) : -1

		if (at >= 0) found = pos + at

		return found < 0
	})

	return found
}

function put(editor: PagedEditor, pos: number): void {
	editor.session.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

describe("arrow keys in sideways cells", () => {
	it("moves along bottom to top text with Up and Down", async () => {
		const editor = await editorFor("btLr")
		const start = find(editor.state.doc, "bravo")

		put(editor, start)
		expect(editor.caretTurn()).toBe(270)

		expect(turnedArrow(editor, "ArrowUp", 270, false)).toBe(true)
		expect(editor.state.selection.head).toBe(start + 1)

		turnedArrow(editor, "ArrowDown", 270, false)
		turnedArrow(editor, "ArrowDown", 270, false)
		expect(editor.state.selection.head).toBe(start - 1)

		// Shift extends.
		turnedArrow(editor, "ArrowUp", 270, true)
		expect(editor.state.selection.from).toBe(start - 1)
		expect(editor.state.selection.to).toBe(start)
	})

	it("moves along top to bottom text with Down and Up", async () => {
		const editor = await editorFor("tbRl")
		const start = find(editor.state.doc, "bravo")

		put(editor, start)
		expect(editor.caretTurn()).toBe(90)

		turnedArrow(editor, "ArrowDown", 90, false)
		expect(editor.state.selection.head).toBe(start + 1)
	})

	it("moves to the next line across the text with Right in bottom to top text, Left in top to bottom", async () => {
		for (const [direction, turn, key] of [
			["btLr", 270, "ArrowRight"],
			["tbRl", 90, "ArrowLeft"]
		] as const) {
			const editor = await editorFor(direction)
			const first = find(editor.state.doc, "alpha")

			put(editor, first)

			const line = editor.caret()?.line ?? -1

			turnedArrow(editor, key, turn, false)

			const caret = editor.caret()

			expect(caret?.line).not.toBe(line)
			expect(caret?.turn).toBe(turn)
			expect(editor.state.selection.head).toBeGreaterThan(first)
		}
	})

	it("leaves upright text to the keys' usual moves", async () => {
		const editor = await editorFor("lrTb")

		put(editor, find(editor.state.doc, "bravo"))

		expect(editor.caretTurn()).toBe(0)
	})
})

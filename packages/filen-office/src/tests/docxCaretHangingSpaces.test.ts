import { TextSelection } from "prosemirror-state"
import { expect, it } from "vitest"
import { insertTab } from "../core/docx/paged/keys"
import { buildDocx } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

const PAGE =
	'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

// Spaces typed at a line's end hang past it (no width for alignment), yet the caret moves on through them as Word's
// does, and a tab after them still reaches its stop.
it("moves the caret through spaces typed at a paragraph's end, and on to a tab's stop after them", async () => {
	const { editor } = await pagedEditor(
		buildDocx({
			body: `<w:p><w:r><w:t xml:space="preserve">Hello world</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>${PAGE}`
		})
	)
	const session = editor.body.session
	const caretX = async (): Promise<number> => {
		await settleAll(editor)

		return editor.caret()?.x ?? Number.NaN
	}

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1 + "Hello world".length)))

	const end = await caretX()

	session.dispatch(session.state.tr.insertText(" "))

	const one = await caretX()

	session.dispatch(session.state.tr.insertText(" "))

	const two = await caretX()

	expect(one).toBeGreaterThan(end)
	expect(two - one).toBeCloseTo(one - end, 3)

	// A letter after them stands where they ended.
	session.dispatch(session.state.tr.insertText("x"))

	const letter = await caretX()

	session.dispatch(session.state.tr.delete(session.state.selection.from - 1, session.state.selection.from))
	expect(await caretX()).toBeCloseTo(two, 3)
	expect(letter).toBeGreaterThan(two)

	// A tab after the spaces goes to the next default stop (half an inch, 48 px, from the 96 px margin).
	session.dispatch(insertTab(session.state) ?? session.state.tr)

	const tab = await caretX()

	expect(tab).toBeGreaterThan(two)
	expect((tab - 96) % 48).toBeCloseTo(0, 3)
	editor.dispose()
})

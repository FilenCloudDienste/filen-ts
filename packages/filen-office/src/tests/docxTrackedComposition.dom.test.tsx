// @vitest-environment happy-dom
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { afterEach, describe, expect, it } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { EditSink } from "@filen/office/react/docx/editor"
import { ReflowView } from "../react/docx/reflow/view"
import { buildDocx, p } from "./docxSynthetic"
import { emptyDocxDocument } from "./docxDocumentStubs.dom"
import { pagedEditor } from "./pagedDomFixtures"

// An IME composition with track changes on, read as ProseMirror reads one (each step replaces the composed text
// node whole, the text before the caret too; the commit read after compositionend): the committed text alone is
// one tracked insertion, nothing of the steps is left, and no text around it is recorded as deleted.

const DOCUMENT = emptyDocxDocument()

const cleanups: (() => void)[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

const SURFACES: readonly { readonly name: string; open(editor: PagedEditor): EditorView }[] = [
	{
		name: "the pages' input view",
		open(editor) {
			const host = document.createElement("div")

			document.body.appendChild(host)

			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

			cleanups.push(() => {
				sink.destroy()
				host.remove()
			})

			return sink.view
		}
	},
	{
		name: "Mobile view",
		open(editor) {
			const scroller = document.createElement("div")

			document.body.appendChild(scroller)
			editor.suspend()

			const reflow = new ReflowView(editor, scroller, {
				label: "Document",
				readOnly: false,
				apple: false,
				onFind: undefined,
				marks: [],
				interactions: undefined,
				document: DOCUMENT
			})

			cleanups.push(() => {
				reflow.destroy()
				scroller.remove()
				editor.resume()
			})

			return reflow.main.view
		}
	}
]

// The text of `doc`, inserted text in [], deleted in {}.
function marked(doc: Node): string {
	let out = ""

	doc.descendants(node => {
		if (node.isText) {
			const names = node.marks.map(mark => mark.type.name)

			out += names.includes("insertion")
				? `[${node.text ?? ""}]`
				: names.includes("deletion")
					? `{${node.text ?? ""}}`
					: (node.text ?? "")
		} else if (node.isTextblock && out !== "") out += "|"

		return true
	})

	return out
}

const cell = (text: string): string => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
const DOC = buildDocx({
	body:
		p("Body text") +
		`<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${cell("A1")}${cell("B1")}</w:tr></w:tbl>` +
		p("After")
})

for (const surface of SURFACES) {
	describe(`A tracked IME composition in ${surface.name}`, () => {
		for (const where of ["Body text", "B1"]) {
			it(`leaves the committed text alone, one insertion, after "${where}"`, async () => {
				const { editor } = await pagedEditor(DOC)
				const session = editor.body.session

				session.context.review.tracking = true
				session.context.identity.author = "Ann"

				const view = surface.open(editor)
				let start = -1

				session.state.doc.descendants((node, pos) => {
					if (start < 0 && node.isTextblock && node.textContent === where) start = pos + 1

					return start < 0
				})

				const end = start + where.length

				session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, end)))

				// Each step as ProseMirror reads it: the text node replaced whole.
				const step = (text: string): void => {
					const $end = view.state.doc.resolve(view.state.selection.head)
					const tr = view.state.tr.insertText(`${where}${text}`, start, $end.end()).setMeta("composition", 1)

					view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + where.length + text.length)))
				}

				editor.setComposition({ from: end, to: end })

				for (const text of ["ひ", "ひょ", "ひょう"]) {
					step(text)
					editor.setComposition({ from: end, to: end + text.length })
				}

				// The browser has committed its text when compositionend comes, before ProseMirror reads it: ending the
				// composition (marking what it typed, drawing it anew) must not come first.
				const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT)

				for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
					const text = node.textContent ?? ""

					if (text.endsWith("ひょう")) node.textContent = `${text.slice(0, -3)}表`
				}

				view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "表", bubbles: true }))
				await new Promise(resolve => setTimeout(resolve, 20))

				const expected = where === "B1" ? "Body text|A1|B1[表]|After" : "Body text[表]|A1|B1|After"

				expect(marked(session.state.doc)).toBe(expected)
			})
		}
	})
}

// @vitest-environment happy-dom
import type { Node } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import { describe, expect, it } from "vitest"
import { docxSchema } from "../core/docx/edit/index"
import { clipboardSerializer, plainText } from "../react/docx/edit/clipboard"
import { NODE_VIEWS } from "../react/docx/edit/sink"
import { reflowNodeViews } from "../react/docx/reflow/nodes"
import { ReflowView } from "../react/docx/reflow/view"
import { emptyDocxDocument } from "./docxDocumentStubs.dom"
import { buildDocx } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

const field = (instruction: string, result: string | undefined): string =>
	'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
	`<w:r><w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>` +
	(result === undefined ? "" : `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${result}</w:t></w:r>`) +
	'<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

describe("MACROBUTTON fields in Mobile view, the input view and a copy", () => {
	it("show their display text where they have no result, their result where they have one", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					field(' MACROBUTTON  synchronize "Sync contents" ', "*") + field(" MACROBUTTON  synchronize Without result ", undefined)
			})
		)
		const scroller = document.createElement("div")

		document.body.appendChild(scroller)

		const reflow = new ReflowView(editor, scroller, {
			label: "Document",
			readOnly: false,
			apple: false,
			onFind: undefined,
			marks: [],
			interactions: undefined,
			document: emptyDocxDocument()
		})
		const session = editor.body.session
		const doc = session.state.doc
		const fields: Node[] = []

		doc.descendants(node => {
			if (node.type === docxSchema.nodes.field) fields.push(node)

			return true
		})

		const reflowViews = reflowNodeViews(reflow, session)
		const view = {} as EditorView
		const shown = (views: typeof NODE_VIEWS): string[] =>
			fields.map(node => {
				const made = views["field"]?.(node, view, () => 0, [], undefined as never)

				return (made?.dom as HTMLElement | undefined)?.textContent ?? ""
			})

		expect(shown(reflowViews)).toEqual(["*", "Without result"])
		expect(shown(NODE_VIEWS)).toEqual(["*", "Without result"])
		expect(plainText(doc, 0, doc.content.size, () => "")).toBe("*\nWithout result")

		const html = document.createElement("div")

		html.appendChild(clipboardSerializer().serializeFragment(doc.content))
		expect(html.textContent).toBe("*Without result")
		reflow.destroy()
		scroller.remove()
		editor.dispose()
	})
})

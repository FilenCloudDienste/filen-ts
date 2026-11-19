// @vitest-environment happy-dom
import { AllSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { RevisionView } from "../core/docx/model/kinds"
import { ReflowView } from "../react/docx/reflow/view"
import { buildDocx, p } from "./docxSynthetic"
import { emptyDocxDocument } from "./docxDocumentStubs.dom"
import { pagedEditor } from "./pagedDomFixtures"

// A drag out of Mobile view writes what the revision view shows, as a copy does: No Markup (Final) leaves deleted
// text out, Original inserted text; Markup drags the tracked changes as they are. (The pages' input view is
// never seen, so never dragged.)

const DOCUMENT = emptyDocxDocument()

const BY = 'w:author="Ann" w:date="2024-01-01T00:00:00Z"'
const DOC = buildDocx({
	body:
		`<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" ${BY}><w:r><w:t xml:space="preserve">added </w:t></w:r></w:ins>` +
		`<w:del w:id="2" ${BY}><w:r><w:delText xml:space="preserve">removed </w:delText></w:r></w:del><w:r><w:t>end</w:t></w:r></w:p>` +
		p("Second")
})

function dragOut(dom: Element): Map<string, string> {
	const data = new Map<string, string>()
	const event = new Event("dragstart", { bubbles: true, cancelable: true })

	Object.defineProperty(event, "dataTransfer", {
		value: {
			files: [],
			clearData: () => {
				data.clear()
			},
			setData: (type: string, value: string) => data.set(type, value),
			effectAllowed: ""
		}
	})
	Object.defineProperty(event, "clientX", { value: 0 })
	Object.defineProperty(event, "clientY", { value: 0 })
	dom.dispatchEvent(event)

	return data
}

describe("Drag in Mobile view", () => {
	it("writes the text and HTML the revision view shows", async () => {
		const { editor } = await pagedEditor(DOC)
		const scroller = document.createElement("div")

		document.body.appendChild(scroller)

		const reflow = new ReflowView(editor, scroller, {
			label: "Document",
			readOnly: false,
			apple: false,
			onFind: undefined,
			marks: [],
			interactions: undefined,
			document: DOCUMENT
		})
		const session = editor.body.session
		const dom = scroller.querySelector("[role='textbox']")

		try {
			if (dom === null) throw new Error("no view")

			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))

			const dragged = (view: RevisionView): Map<string, string> => {
				editor.setView(view)

				return dragOut(dom)
			}
			const markup = dragged(RevisionView.Markup)

			expect(markup.get("text/html")).toContain("removed")
			expect(markup.get("text/html")).toContain("added")

			const final = dragged(RevisionView.Final)

			expect(final.get("text/html")).not.toContain("removed")
			expect(final.get("text/html")).toContain("added")
			expect(final.get("text/plain")).toBe("Kept added end\nSecond")

			const original = dragged(RevisionView.Original)

			expect(original.get("text/html")).not.toContain("added")
			expect(original.get("text/plain")).toBe("Kept removed end\nSecond")
		} finally {
			reflow.destroy()
			scroller.remove()
		}
	})
})

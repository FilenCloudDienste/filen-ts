// @vitest-environment happy-dom
import { TextSelection, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { EditSink } from "@filen/office/react/docx/editor"
import { ReflowView } from "../react/docx/reflow/view"
import { buildDocx, p } from "./docxSynthetic"
import { emptyDocxDocument } from "./docxDocumentStubs.dom"
import { pagedEditor } from "./pagedDomFixtures"

// The pages' input view and Mobile view share one input pipeline (edit/storyInput): a cut event behaves alike.

const DOC = buildDocx({ body: p("Alpha beta gamma") + p("Second paragraph") })

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

			const reflow = new ReflowView(editor, scroller, {
				label: "Document",
				readOnly: false,
				apple: false,
				onFind: undefined,
				marks: [],
				interactions: undefined,
				document: emptyDocxDocument()
			})

			cleanups.push(() => {
				reflow.destroy()
				scroller.remove()
			})

			const view = reflow.viewOf(editor.body.session.story.story.index)

			if (view === undefined) throw new Error("no body view")

			return view
		}
	}
]

function cutEvent(): { event: Event; data: Map<string, string> } {
	const data = new Map<string, string>()
	const event = new Event("cut", { bubbles: true, cancelable: true })

	Object.defineProperty(event, "clipboardData", {
		value: {
			clearData: () => data.clear(),
			setData: (type: string, value: string) => data.set(type, value),
			getData: (type: string) => data.get(type) ?? ""
		}
	})

	return { event, data }
}

for (const surface of SURFACES) {
	describe(`A cut in ${surface.name}`, () => {
		it("writes the selection, deletes it as a cut and scrolls it into view", async () => {
			const { editor } = await pagedEditor(DOC)
			const view = surface.open(editor)
			const session = editor.body.session
			const dispatched: Transaction[] = []
			const dispatch = session.dispatch.bind(session)

			vi.spyOn(session, "dispatch").mockImplementation(tr => {
				dispatched.push(tr)

				return dispatch(tr)
			})
			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1, 7)))

			const { event, data } = cutEvent()

			view.dom.dispatchEvent(event)

			expect(data.get("text/plain")).toBe("Alpha ")
			expect(session.state.doc.child(0).textContent).toBe("beta gamma")

			const cut = dispatched.find(tr => tr.getMeta("uiEvent") === "cut")

			expect(cut?.scrolledIntoView).toBe(true)
		})
	})
}

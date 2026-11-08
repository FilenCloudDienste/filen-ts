// @vitest-environment happy-dom
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { afterEach, describe, expect, it } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxSessionApi } from "@filen/office/dom/docx"
import { DocxMediaCache, type DocxDocument } from "@filen/office/react/docx"
import { EditSink } from "@filen/office/react/docx/editor"
import { ReflowView } from "../react/docx/reflow/view"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// Space, Tab, Enter and Shift+Enter after a typed web address make it a link in both editing surfaces, as Word's
// AutoFormat As You Type does; one undo right after the key takes back only the link.

const SESSION: DocxSessionApi = {
	objects: () => Promise.resolve([]),
	media: () => Promise.resolve(null),
	locate: () => Promise.resolve(null),
	find: () => Promise.resolve(new Int32Array(0)),
	annotations: () => Promise.resolve(null),
	close: () => undefined
}

const DOCUMENT: DocxDocument = {
	status: "ready",
	info: undefined,
	pages: [],
	pageCount: 0,
	tables: { styles: [], decorations: [], links: [] },
	session: SESSION,
	media: new DocxMediaCache(SESSION, undefined, { create: () => "blob:picture", revoke: () => undefined }),
	error: undefined
}

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

const DOC = buildDocx({ body: p("Visit www.filen.io") })

function links(doc: Node): string[] {
	const out: string[] = []

	doc.descendants(node => {
		const link = node.marks.find(mark => mark.type.name === "link")

		if (node.isText && link !== undefined) out.push(`${node.text ?? ""}>${String(link.attrs["target"])}`)

		return true
	})

	return out
}

async function open(surface: (typeof SURFACES)[number]): Promise<{ editor: PagedEditor; view: EditorView }> {
	const { editor } = await pagedEditor(DOC)
	const session = editor.body.session
	const end = session.state.doc.child(0).nodeSize - 1
	const view = surface.open(editor)

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, end)))

	return { editor, view }
}

function key(view: EditorView, name: string, shiftKey = false): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })

	view.dom.dispatchEvent(event)

	return event
}

function input(view: EditorView, data: string): InputEvent {
	const event = new InputEvent("beforeinput", { inputType: "insertText", data, bubbles: true, cancelable: true })

	view.dom.dispatchEvent(event)

	return event
}

for (const surface of SURFACES) {
	describe(`Links as you type in ${surface.name}`, () => {
		it("Space links the address before it; one undo takes back only the link", async () => {
			const { editor, view } = await open(surface)
			const session = editor.body.session

			expect(input(view, " ").defaultPrevented).toBe(true)
			expect(session.state.doc.textContent).toBe("Visit www.filen.io ")
			expect(links(session.state.doc)).toEqual(["www.filen.io>http://www.filen.io"])

			await editor.execute({ type: "history.undo" })

			expect(links(session.state.doc)).toEqual([])
			expect(session.state.doc.textContent).toBe("Visit www.filen.io ")
		})

		for (const [name, shift, text] of [
			["Enter", false, "Visit www.filen.io"],
			["Enter", true, "Visit www.filen.io"],
			["Tab", false, "Visit www.filen.io"]
		] as const) {
			it(`${shift ? "Shift+" : ""}${name} links the address before it`, async () => {
				const { editor, view } = await open(surface)
				const session = editor.body.session

				expect(key(view, name, shift).defaultPrevented).toBe(true)
				expect(session.state.doc.child(0).textContent).toBe(text)
				expect(links(session.state.doc)).toEqual(["www.filen.io>http://www.filen.io"])
			})
		}

		it("leaves a Space after other text to the browser", async () => {
			const { editor, view } = await open(surface)
			const session = editor.body.session

			session.dispatch(session.state.tr.insertText(" today"))

			expect(input(view, " ").defaultPrevented).toBe(false)
			expect(links(session.state.doc)).toEqual([])
		})
	})
}

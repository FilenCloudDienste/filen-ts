// @vitest-environment happy-dom
import type { EditorView } from "prosemirror-view"
import { afterEach, describe, expect, it, vi } from "vitest"
import { selectAll, type PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxSessionApi } from "@filen/office/dom/docx"
import { DocxMediaCache, type DocxDocument } from "@filen/office/react/docx"
import { EditSink } from "@filen/office/react/docx/editor"
import { ReflowView } from "../react/docx/reflow/view"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// Word's find keys (Ctrl+H is Find and Replace) and the view's shortcuts in a read-only document, in the paged
// editor's input view and in Mobile view alike.

const SESSION: DocxSessionApi = {
	objects: () => Promise.resolve([]),
	media: () => Promise.resolve(null),
	locate: () => Promise.resolve(null),
	find: () => Promise.resolve(new Int32Array(0)),
	annotations: () => Promise.resolve(null),
	close: () => undefined
}

function documentOf(): DocxDocument {
	return {
		status: "ready",
		info: undefined,
		pages: [],
		pageCount: 0,
		tables: { styles: [], decorations: [], links: [] },
		session: SESSION,
		media: new DocxMediaCache(SESSION, undefined, { create: () => "blob:picture", revoke: () => undefined }),
		error: undefined
	}
}

interface SurfaceOptions {
	readonly readOnly?: boolean
	readonly apple?: boolean
	readonly onFind?: (replace: boolean) => void
}

const cleanups: (() => void)[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

const SURFACES: readonly { readonly name: string; open(editor: PagedEditor, options?: SurfaceOptions): EditorView }[] = [
	{
		name: "the pages' input view",
		open(editor, options = {}) {
			const host = document.createElement("div")

			document.body.appendChild(host)

			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined, ...options })

			cleanups.push(() => {
				sink.destroy()
				host.remove()
			})

			return sink.view
		}
	},
	{
		name: "Mobile view",
		open(editor, options = {}) {
			const scroller = document.createElement("div")

			scroller.className = "fo-docx-reflow"
			document.body.appendChild(scroller)

			const reflow = new ReflowView(editor, scroller, {
				label: "Document",
				readOnly: options.readOnly === true,
				apple: options.apple === true,
				onFind: options.onFind,
				marks: [],
				interactions: undefined,
				document: documentOf()
			})

			cleanups.push(() => {
				reflow.destroy()
				scroller.remove()
			})

			return reflow.main.view
		}
	}
]

// Presses a key in the view: whether it was taken (its default prevented). happy-dom reports AltGraph for
// any Alt; a browser does only for AltGr.
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })

	Object.defineProperty(event, "getModifierState", { value: (name: string) => name === "Alt" && event.altKey })
	view.dom.dispatchEvent(event)

	return event.defaultPrevented
}

const DOC = buildDocx({ body: p("Some text") })

for (const surface of SURFACES) {
	describe(`find keys in ${surface.name}`, () => {
		it("opens Find and Replace on Ctrl+H, find on Ctrl+F and Ctrl+G (Windows)", async () => {
			const { editor } = await pagedEditor(DOC)
			const onFind = vi.fn<(replace: boolean) => void>()
			const view = surface.open(editor, { onFind })

			expect(press(view, "h", { ctrlKey: true, code: "KeyH" })).toBe(true)
			expect(press(view, "f", { ctrlKey: true, code: "KeyF" })).toBe(true)
			expect(press(view, "g", { ctrlKey: true, code: "KeyG" })).toBe(true)
			expect(onFind.mock.calls).toEqual([[true], [false], [false]])
		})

		it("opens Find and Replace on Control+H and Cmd+Shift+H, never on Cmd+H (Apple)", async () => {
			const { editor } = await pagedEditor(DOC)
			const onFind = vi.fn<(replace: boolean) => void>()
			const view = surface.open(editor, { apple: true, onFind })

			expect(press(view, "h", { ctrlKey: true, code: "KeyH" })).toBe(true)
			expect(press(view, "H", { metaKey: true, shiftKey: true, code: "KeyH" })).toBe(true)
			expect(press(view, "f", { metaKey: true, code: "KeyF" })).toBe(true)
			expect(onFind.mock.calls).toEqual([[true], [true], [false]])

			press(view, "h", { metaKey: true, code: "KeyH" })
			expect(onFind).toHaveBeenCalledTimes(3)
		})

		it("opens Find and Replace in a read-only document too", async () => {
			const { editor } = await pagedEditor(DOC)
			const onFind = vi.fn<(replace: boolean) => void>()
			const view = surface.open(editor, { readOnly: true, onFind })

			expect(press(view, "h", { ctrlKey: true, code: "KeyH" })).toBe(true)
			expect(onFind.mock.calls).toEqual([[true]])
		})
	})

	describe(`read-only shortcuts in ${surface.name}`, () => {
		it("switches field codes (Alt+F9) but makes no edit (Ctrl+B)", async () => {
			const { editor } = await pagedEditor(DOC)
			const view = surface.open(editor, { readOnly: true })
			const doc = editor.body.session.state.doc

			expect(editor.fieldCodes).toBe(false)
			expect(press(view, "F9", { altKey: true, code: "F9" })).toBe(true)
			expect(editor.fieldCodes).toBe(true)
			expect(press(view, "F9", { altKey: true, code: "F9" })).toBe(true)
			expect(editor.fieldCodes).toBe(false)

			editor.dispatch(selectAll(editor.state))
			expect(press(view, "b", { ctrlKey: true, code: "KeyB" })).toBe(false)
			expect(press(view, "z", { ctrlKey: true, code: "KeyZ" })).toBe(false)
			expect(editor.body.session.state.doc).toBe(doc)
		})
	})
}

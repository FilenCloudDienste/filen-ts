// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TextSelection } from "prosemirror-state"
import { undoDepth } from "prosemirror-history"
import type { Node } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RevisionView } from "../core/docx/model/kinds"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import type { DocxSessionApi } from "@filen/office/dom/docx"
import { DocxMediaCache, type DocxDocument } from "@filen/office/react/docx"
import {
	DocxEditor,
	DocxReflow,
	EditSink,
	type DocxEditorHandle,
	type DocxEditorInteractions,
	type DocxObjectPress
} from "@filen/office/react/docx/editor"
import { equationTree } from "@filen/office/core/docx/edit"
import type { MathElement } from "@filen/office/core/math"
import { modelAuthors } from "../core/docx/layout/styles"
import { docxSchema } from "../core/docx/edit/index"
import { paragraphCss, runCss } from "../core/docx/reflow/css"
import { clipboardSerializer } from "../react/docx/edit/clipboard"
import { NODE_VIEWS as SINK_NODE_VIEWS } from "../react/docx/edit/sink"
import { reflowNodeViews } from "../react/docx/reflow/nodes"
import { InternTable } from "../react/docx/reflow/decorate"
import { docxComments } from "../core/docx/review/comments"
import { BlockHeights, estimateHeight } from "../react/docx/reflow/heights"
import { ReflowView, type ReflowViewOptions } from "../react/docx/reflow/view"
import { LiveStarts } from "../react/docx/edit/window"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

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

function optionsOf(overrides: Partial<ReflowViewOptions> = {}): ReflowViewOptions {
	return {
		label: "Document",
		readOnly: false,
		apple: false,
		onFind: undefined,
		marks: [],
		interactions: undefined,
		document: documentOf(),
		...overrides
	}
}

const LONG = buildDocx({
	body: Array.from({ length: 300 }, (_, k) => p(`Paragraph ${String(k)} ${"lorem ipsum dolor sit amet ".repeat(6)}`)).join("")
})

const SEPARATORS =
	'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
	'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'

function paragraphPos(editor: PagedEditor, index: number): number {
	let found = -1

	editor.body.session.state.doc.forEach((_node, offset, k) => {
		if (k === index) found = offset
	})

	return found
}

function key(view: EditorView, name: string, init: KeyboardEventInit = {}): void {
	view.dom.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: name,
			code: name.length === 1 ? `Key${name.toUpperCase()}` : name,
			bubbles: true,
			cancelable: true,
			...init
		})
	)
}

describe("node views", () => {
	it("draws every node of the editing schema in both views and in what a copy writes", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Text") }))
		const scroller = document.createElement("div")

		document.body.appendChild(scroller)

		const reflow = new ReflowView(editor, scroller, optionsOf())
		const reflowViews = reflowNodeViews(reflow, editor.body.session)
		const serializer = clipboardSerializer()
		const missing = Object.keys(docxSchema.nodes)
			.filter(name => name !== "doc" && name !== "text")
			.filter(name => !(name in SINK_NODE_VIEWS) || !(name in reflowViews) || !(name in serializer.nodes))

		reflow.destroy()
		scroller.remove()
		expect(missing).toEqual([])
	})

	it("opens the input view over a field spanning paragraphs (a table of contents)", async () => {
		const toc =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Heading one</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>Heading two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const { editor } = await pagedEditor(buildDocx({ body: toc + p("After") }))
		const host = document.createElement("div")

		document.body.appendChild(host)

		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

		expect(host.textContent).toContain("Heading two")
		sink.destroy()
		host.remove()
	})
})

describe("reflow CSS", () => {
	it("maps resolved paragraph and run properties, the same string for equal properties", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					'<w:p><w:pPr><w:jc w:val="center"/><w:ind w:left="720" w:hanging="360"/><w:spacing w:before="240" w:after="120" w:line="480" w:lineRule="auto"/></w:pPr>' +
					'<w:r><w:rPr><w:b/><w:i/><w:color w:val="FF0000"/><w:sz w:val="28"/><w:u w:val="double"/></w:rPr><w:t>Styled</w:t></w:r></w:p>' +
					'<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/><w:highlight w:val="yellow"/></w:rPr><w:t>Up</w:t></w:r></w:p>'
			})
		)
		const session = editor.body.session
		const formats = session.formats
		const first = session.state.doc.child(0)
		const second = session.state.doc.child(1)
		const format = formats.paragraph(first)
		const css = paragraphCss(format)

		expect(css).toContain("text-align: center")
		// Indents never more than a share of the box (a narrow table cell): the text stays in it. The hang comes
		// out of the start indent, a marker's room is its share of the paragraph's box.
		expect(css).toContain("padding-inline-start: calc(min(24px, 30%) + min(24px, 30%))")
		expect(css).toContain("text-indent: calc(-1 * min(24px, 30%))")
		expect(css).toContain("--fo-reflow-hang: min(24px, 30%)")
		expect(paragraphCss(formats.paragraph(second))).not.toContain("text-indent")
		expect(css).toContain("padding-top: 16px")
		expect(css).toContain("padding-bottom: 8px")
		expect(css).toContain("line-height: 2.3")
		expect(paragraphCss(formats.paragraph(second))).toContain("direction: rtl")

		const run = formats.resolvedRun(format, first.child(0).marks)
		const look = runCss(run)

		expect(look).toContain("font-weight: 700")
		expect(look).toContain("font-style: italic")
		expect(look).toContain("color: #FF0000")
		expect(look).toContain("font-size: 14pt")
		expect(look).toContain("text-decoration-line: underline")
		expect(look).toContain("text-decoration-style: double")
		// Interned: the same string for the same properties, and named faces used where the document has them.
		expect(runCss(formats.resolvedRun(format, first.child(0).marks))).toBe(look)
		expect(runCss(run, family => (family.length > 0 ? '"fo-face"' : undefined))).toContain('font-family: "fo-face"')

		const up = runCss(formats.resolvedRun(formats.paragraph(second), second.child(0).marks))

		expect(up).toContain("vertical-align: super")
		expect(up).toContain("background-color: #FFFF00")
	})
})

describe("reflow CSS, indents", () => {
	it("starts a capped hanging first line in its box: the hang takes no more than the start indent", async () => {
		const css = async (ind: string): Promise<string> => {
			const { editor } = await pagedEditor(buildDocx({ body: `<w:p><w:pPr><w:ind ${ind}/></w:pPr><w:r><w:t>Text</w:t></w:r></w:p>` }))
			const session = editor.body.session

			return paragraphCss(session.formats.paragraph(session.state.doc.child(0)))
		}
		// A list's usual indent: all of it hangs, the first line at the box's start.
		const list = await css('w:left="720" w:hanging="720"')

		expect(list).toContain("padding-inline-start: min(48px, 30%)")
		expect(list).toContain("text-indent: calc(-1 * min(48px, 30%))")
		expect(list).toContain("--fo-reflow-hang: min(48px, 30%)")

		// A hang past the start indent: the first line at the box's start, the others at the start indent.
		const past = await css('w:left="360" w:hanging="720"')

		expect(past).toContain("padding-inline-start: min(24px, 30%)")
		expect(past).toContain("text-indent: calc(-1 * min(24px, 30%))")

		// No start indent: nothing hangs out of the box.
		expect(await css('w:hanging="360"')).not.toContain("text-indent")

		// A first-line indent is the first line's own.
		const first = await css('w:left="720" w:firstLine="360"')

		expect(first).toContain("padding-inline-start: min(48px, 30%)")
		expect(first).toContain("text-indent: min(24px, 30%)")
		expect(first).not.toContain("--fo-reflow-hang")
	})
})

describe("live block starts", () => {
	it("follows a story's edits, reading only the blocks they change, as starts counted anew", async () => {
		const { editor } = await pagedEditor(LONG)
		const session = editor.body.session
		const starts = new LiveStarts(session.state.doc)
		const stop = session.onApplied(transactions => starts.applyAll(transactions))
		const counted = (): number[] => {
			const out: number[] = []

			session.state.doc.forEach((_node, offset) => out.push(offset))

			return out
		}
		let seed = 7
		const random = (): number => {
			seed = (seed * 16807) % 2147483647

			return seed / 2147483647
		}

		for (let step = 0; step < 200; step++) {
			const doc = session.state.doc
			const pos = 1 + Math.floor(random() * (doc.content.size - 2))
			const $pos = doc.resolve(pos)
			const tr = session.state.tr

			if (!$pos.parent.isTextblock) continue

			const roll = random()

			if (roll < 0.5) tr.insertText("ab", pos)
			else if (roll < 0.7) tr.split(pos)
			else if (roll < 0.9) tr.delete(pos, Math.min(doc.content.size - 1, pos + Math.floor(random() * 400)))
			else tr.insertText("x", 1).insertText("y", doc.content.size - 2)

			session.dispatch(tr)
			expect(starts.document).toBe(session.state.doc)
			expect([...starts.starts]).toEqual(counted())
		}

		const middle = counted()[150] ?? 0

		expect(starts.entryAt(middle)).toBe(150)
		expect(starts.entryAt(middle + 1)).toBe(150)
		stop()
	})
})

describe("PagedEditor while the pages rest", () => {
	it("leaves layout's view of the stories behind until resumed or a revision view asks, and no header commands meanwhile", async () => {
		const DOC = buildDocx({
			body:
				p("Body text") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
			headers: { rIdH: p("Header text") }
		})
		const { editor } = await pagedEditor(DOC)
		const session = editor.body.session
		const type = (text: string): void => {
			session.dispatch(session.state.tr.insertText(text, 1))
		}

		editor.suspend()

		const applied = vi.spyOn(editor.body.edits, "applyPending")

		type("One ")
		type("Two ")
		expect(applied).not.toHaveBeenCalled()
		expect(editor.body.edits.document).not.toBe(session.state.doc)
		// Headers are not edited while their pages rest (their caret page would be stale).
		expect(editor.snapshot().enabled["header.edit"]).toBe(false)
		expect(editor.snapshot().enabled["header.remove"]).toBe(false)

		// Another revision view reads the stories again: they catch up first (the edits as one change).
		editor.setView(RevisionView.Final)
		expect(applied).toHaveBeenCalledTimes(1)
		expect(editor.body.edits.document).toBe(session.state.doc)

		type("Three ")
		editor.resume()
		expect(editor.body.edits.document).toBe(session.state.doc)
		expect(editor.snapshot().enabled["header.edit"]).toBe(true)
		applied.mockRestore()
		expect(session.state.doc.textContent).toBe("Three Two One Body text")
	})
})

describe("block heights", () => {
	it("sums, finds and splices block heights, keeping what was measured of a block edited in place", async () => {
		const { editor } = await pagedEditor(LONG)
		const doc = editor.body.session.state.doc
		const heights = new BlockHeights()

		heights.reset(doc, 400)

		expect(heights.count).toBe(300)
		expect(heights.top(0)).toBe(0)
		expect(heights.top(2)).toBeCloseTo(estimateHeight(doc.child(0), 400) + estimateHeight(doc.child(1), 400))
		expect(heights.indexAt(heights.top(10) + 1)).toBe(10)
		expect(heights.indexAt(-5)).toBe(0)
		expect(heights.indexAt(heights.total + 100)).toBe(299)

		expect(heights.set(3, 500)).toBe(true)
		expect(heights.set(3, 500.2)).toBe(false)
		expect(heights.top(4) - heights.top(3)).toBe(500)

		// Block 3 split in two (an Enter): the first half keeps what was measured, the second is estimated.
		heights.splice(3, 1, [doc.child(3), doc.child(3)], 400)

		expect(heights.count).toBe(301)
		expect(heights.height(3)).toBe(500)
		expect(heights.isMeasured(3)).toBe(true)
		expect(heights.isMeasured(4)).toBe(false)
		expect(heights.height(4)).toBe(estimateHeight(doc.child(3), 400))

		heights.splice(3, 2, [], 400)

		expect(heights.count).toBe(299)
		expect(heights.total).toBeCloseTo(heights.top(299))
	})
})

describe("ReflowView", () => {
	let scroller: HTMLDivElement
	let views: ReflowView[]

	const open = (editor: PagedEditor, overrides: Partial<ReflowViewOptions> = {}): ReflowView => {
		const view = new ReflowView(editor, scroller, optionsOf(overrides))

		views.push(view)

		return view
	}

	beforeEach(() => {
		scroller = document.createElement("div")
		scroller.className = "fo-docx-reflow"
		document.body.appendChild(scroller)
		views = []
	})

	afterEach(() => {
		for (const view of views) view.destroy()

		scroller.remove()
	})

	it("holds the blocks on screen and around the selection, the others as gaps of their height", async () => {
		const { editor } = await pagedEditor(LONG)
		const reflow = open(editor)
		const shown = scroller.querySelectorAll(".fo-docx-reflow-p")
		const gaps = scroller.querySelectorAll<HTMLElement>(".fo-docx-reflow-gap")

		expect(shown.length).toBeGreaterThan(5)
		expect(shown.length).toBeLessThan(80)
		expect(gaps.length).toBe(1)
		expect(Number.parseFloat(gaps[0]?.style.height ?? "0")).toBeGreaterThan(1000)
		expect(shown[0]?.textContent).toContain("Paragraph 0 ")
		// Positions are the document's: the view's document has the body's size.
		expect(reflow.main.view.state.doc.content.size).toBe(editor.body.session.state.doc.content.size)
		expect(scroller.querySelector(".fo-docx-reflow-doc")?.getAttribute("spellcheck")).toBe("false")

		// The caret at the document's end: the view holds the last blocks (and still the screen's), drawn as the
		// first ones are.
		const last = paragraphPos(editor, 299) + 1

		reflow.update(optionsOf({ marks: [{ from: last, to: last + 9, kind: "spelling" }] }))
		act(() => {
			editor.moveDocumentBoundary(1, false)
		})

		expect(scroller.querySelector('.fo-docx-reflow-mark[data-fo-mark="spelling"]')?.textContent).toBe("Paragraph")

		expect(scroller.textContent).toContain("Paragraph 299 ")
		expect(scroller.textContent).toContain("Paragraph 0 ")
		expect(scroller.querySelectorAll(".fo-docx-reflow-p").length).toBeLessThan(100)
	})

	it("moves to the line's start or end on Home and End, as the pages do on every browser", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("First line") + p("Second line") }))
		const reflow = open(editor)
		const selection = document.getSelection()
		const modify = vi.fn()

		expect(selection).not.toBeNull()
		Object.defineProperty(selection, "modify", { value: modify, configurable: true })

		const press = (name: string, init: KeyboardEventInit = {}): boolean => {
			const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })

			reflow.main.view.dom.dispatchEvent(event)

			return event.defaultPrevented
		}

		expect(press("End")).toBe(true)
		expect(press("Home", { shiftKey: true })).toBe(true)
		expect(modify.mock.calls).toEqual([
			["move", "forward", "lineboundary"],
			["extend", "backward", "lineboundary"]
		])

		// With the modifier: the document's end, the editor's own move.
		expect(press("End", { ctrlKey: true })).toBe(true)
		expect(modify).toHaveBeenCalledTimes(2)
		expect(editor.body.session.state.selection.from).toBe(editor.body.session.state.doc.content.size - 1)
		Reflect.deleteProperty(selection ?? {}, "modify")
	})

	it("goes to the start of the line End went to the end of on Home, where the line wraps", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("First line wrapping here") }))
		const reflow = open(editor)
		const view = reflow.main.view
		const selection = document.getSelection()
		// The browser's moves: End to where the line wraps (also where the next line starts), Home to the line's start.
		const wrap = 1 + "First line ".length
		const calls: string[][] = []
		const modify = (alter: string, direction: string, granularity: string): void => {
			calls.push([alter, direction, granularity])

			const head = view.state.selection.head
			const to = granularity === "character" ? head - 1 : direction === "forward" ? wrap : head < wrap ? 1 : wrap

			view.dispatch(
				view.state.tr.setSelection(
					alter === "extend"
						? TextSelection.create(view.state.doc, view.state.selection.anchor, to)
						: TextSelection.create(view.state.doc, to)
				)
			)
		}

		Object.defineProperty(selection, "modify", { value: modify, configurable: true })
		// The line wraps at `wrap`: a position there is drawn at the first line's end and the second line's start.
		vi.spyOn(view, "coordsAtPos").mockImplementation((pos, side = 1) => {
			const top = pos < wrap || (pos === wrap && side < 0) ? 0 : 20

			return { left: 0, right: 0, top, bottom: top + 16 }
		})

		const press = (name: string, init: KeyboardEventInit = {}): void => {
			view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }))
		}

		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
		press("End")
		expect(editor.body.session.state.selection.head).toBe(wrap)
		// End again: the same line's end (the browser's own move would take the next line's).
		press("End")
		expect(calls.slice(1)).toEqual([
			["move", "backward", "character"],
			["move", "forward", "lineboundary"]
		])
		expect(editor.body.session.state.selection.head).toBe(wrap)

		press("Home")
		expect(calls.slice(3)).toEqual([
			["move", "backward", "character"],
			["move", "backward", "lineboundary"]
		])
		expect(editor.body.session.state.selection.head).toBe(1)

		// Text typed where the line wraps: the caret ends the line it was typed on. Typed elsewhere (no line wraps at
		// the caret), Home is the browser's own move.
		calls.length = 0
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, wrap - 1)))
		view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "!", bubbles: true, cancelable: true }))
		view.dispatch(view.state.tr.insertText("!"))
		expect(editor.body.session.state.selection.head).toBe(wrap)
		press("Home")
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)))
		view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "!", bubbles: true, cancelable: true }))
		view.dispatch(view.state.tr.insertText("!"))
		press("Home")
		expect(calls).toEqual([
			["move", "backward", "character"],
			["move", "backward", "lineboundary"],
			["move", "backward", "lineboundary"]
		])
		view.dispatch(view.state.tr.delete(4, 5).delete(wrap - 1, wrap))
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))

		// Extending too (Shift pressed alone first changes nothing); after another key, Home is the browser's own move.
		calls.length = 0
		press("End", { shiftKey: true })
		press("Shift", { shiftKey: true })
		press("Home", { shiftKey: true })
		expect(calls).toEqual([
			["extend", "forward", "lineboundary"],
			["extend", "backward", "character"],
			["extend", "backward", "lineboundary"]
		])

		calls.length = 0
		press("End")
		press("ArrowLeft")
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, wrap)))
		press("Home")
		expect(calls).toEqual([
			["move", "forward", "lineboundary"],
			["move", "backward", "lineboundary"]
		])
		Reflect.deleteProperty(selection ?? {}, "modify")
	})

	it("keeps a caret move the view has not read yet when its marks are drawn anew", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("First line") + p("Second line") }))
		const reflow = open(editor)
		const view = reflow.main.view
		const end = paragraphPos(editor, 0) + 1 + "First line".length
		// The browser's selectionchange still queued: ProseMirror has not read the move.
		const hold = (event: Event): void => {
			event.stopImmediatePropagation()
		}

		view.focus()
		act(() => {
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)))
		})
		expect(editor.body.session.state.selection.head).toBe(end)

		const undoable = undoDepth(editor.body.session.state)

		window.addEventListener("selectionchange", hold, true)

		try {
			// Home, as the browser moves it: the line's start.
			const text = view.domAtPos(end).node

			document.getSelection()?.collapse(text.nodeType === 3 ? text : (text.firstChild ?? text), 0)
			reflow.update(optionsOf({ marks: [{ from: end - 4, to: end, kind: "spelling" }] }))
		} finally {
			window.removeEventListener("selectionchange", hold, true)
		}

		expect(editor.body.session.state.selection.head).toBe(paragraphPos(editor, 0) + 1)
		expect(view.state.selection.head).toBe(paragraphPos(editor, 0) + 1)
		expect(document.getSelection()?.anchorOffset).toBe(0)
		// A selection, no edit to undo.
		expect(undoDepth(editor.body.session.state)).toBe(undoable)
	})

	it("takes the line's start on Home at once, before the browser's selectionchange", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("First line") + p("Second line") }))
		const reflow = open(editor)
		const view = reflow.main.view
		const start = paragraphPos(editor, 0) + 1
		const selection = document.getSelection()
		const modify = vi.fn(() => {
			const { node } = view.domAtPos(start)

			selection?.collapse(node.nodeType === 3 ? node : (node.firstChild ?? node), 0)
		})
		const hold = (event: Event): void => {
			event.stopImmediatePropagation()
		}

		view.focus()
		act(() => {
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + "First line".length)))
		})
		Object.defineProperty(selection, "modify", { value: modify, configurable: true })
		window.addEventListener("selectionchange", hold, true)

		try {
			const event = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })

			view.dom.dispatchEvent(event)
			expect(event.defaultPrevented).toBe(true)
		} finally {
			window.removeEventListener("selectionchange", hold, true)
			Reflect.deleteProperty(selection ?? {}, "modify")
		}

		// ProseMirror's own check after focus finds nothing to put back.
		expect(editor.body.session.state.selection.head).toBe(start)
		expect(view.state.selection.head).toBe(start)
	})

	it("edits the body like the paged editor's input view: the same document saved", async () => {
		const reflowed = await pagedEditor(LONG)
		const paged = await pagedEditor(LONG)
		const reflow = open(reflowed.editor)
		const host = document.createElement("div")

		document.body.appendChild(host)

		const sink = new EditSink(paged.editor, host, { label: "Document", caretClientRect: () => undefined })
		const edits = [
			(view: EditorView, editor: PagedEditor) => {
				const at = paragraphPos(editor, 2) + 5

				view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
			},
			(view: EditorView) => view.dispatch(view.state.tr.insertText("typed ")),
			(view: EditorView) => key(view, "Enter"),
			(view: EditorView) => view.dispatch(view.state.tr.insertText("new paragraph")),
			// Mod+Enter: a page break.
			(view: EditorView) => key(view, "Enter", { ctrlKey: true }),
			(view: EditorView) => key(view, "Backspace"),
			(view: EditorView, editor: PagedEditor) => {
				const at = paragraphPos(editor, 1) + 1

				view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + 9)))
			},
			(_view: EditorView, editor: PagedEditor) => void editor.execute({ type: "format.bold" }),
			(view: EditorView) => key(view, "Delete")
		]

		for (const edit of edits) {
			act(() => edit(reflow.main.view, reflowed.editor))
			edit(sink.view, paged.editor)
		}

		expect(reflowed.editor.body.session.state.doc.toJSON()).toEqual(paged.editor.body.session.state.doc.toJSON())

		let pageBreaks = 0

		reflowed.editor.body.session.state.doc.descendants(node => {
			if (node.type.name === "break" && node.attrs["type"] === "page") pageBreaks++
		})
		expect(pageBreaks).toBe(1)

		const [a, b] = await Promise.all(
			[reflowed, paged].map(
				async opened => (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).bytes
			)
		)

		expect(a).toEqual(b)
		sink.destroy()
		host.remove()
	})

	it("numbers a list, again after an edit", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("One") + p("Two") + p("Three") }))
		const reflow = open(editor)
		const markers = (): string[] => [...scroller.querySelectorAll(".fo-docx-reflow-marker")].map(marker => marker.textContent)

		act(() => {
			reflow.selectAll()
			void editor.execute({ type: "list.numbered" })
		})

		expect(markers()).toEqual(["1.", "2.", "3."])
		// A copy writes the numbers as text, as Word does.
		expect(reflow.clipboardContent()?.text).toBe("1.\tOne\n2.\tTwo\n3.\tThree")

		act(() => {
			const view = reflow.main.view

			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, paragraphPos(editor, 1) + 4)))
			key(view, "Enter")
		})

		expect(markers()).toEqual(["1.", "2.", "3.", "4."])
		expect(editor.body.session.state.doc.childCount).toBe(4)
	})

	it("shows tracked changes per revision view and comments as highlights that open their thread", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					'<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" w:author="Ann"><w:r><w:t>added</w:t></w:r></w:ins>' +
					'<w:del w:id="2" w:author="Ann"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>' +
					'<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Commented</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>',
				comments: '<w:comment w:id="7" w:author="Ann"><w:p><w:r><w:t>Look</w:t></w:r></w:p></w:comment>'
			})
		)
		const presses: DocxObjectPress[] = []
		const interactions: DocxEditorInteractions = {
			commentMarker: press => {
				presses.push(press)

				return true
			}
		}

		open(editor, { interactions })

		expect(scroller.querySelector("ins.fo-docx-reflow-ins")?.textContent).toBe("added")
		expect(scroller.querySelector("del.fo-docx-reflow-del")?.textContent).toBe("gone")
		expect(scroller.dataset["foRevisions"]).toBe("final")

		act(() => {
			editor.setView(RevisionView.Markup)
		})

		expect(scroller.dataset["foRevisions"]).toBe("markup")

		const highlights = [...scroller.querySelectorAll<HTMLElement>('.fo-docx-reflow-comment[data-fo-comment="7"]')]
		const highlight = highlights.find(element => element.textContent === "Commented")

		expect(highlights.map(element => element.textContent).join("")).toBe("Commented")
		expect(scroller.querySelector('.fo-docx-reflow-comment-ref[data-fo-comment="7"]')).not.toBeNull()

		const event = new PointerEvent("pointerdown", {
			bubbles: true,
			cancelable: true,
			button: 0,
			pointerType: "mouse",
			clientX: 5,
			clientY: 6
		})

		highlight?.dispatchEvent(event)

		expect(event.defaultPrevented).toBe(true)
		expect(presses).toHaveLength(1)
		expect(presses[0]?.hit).toMatchObject({ kind: "commentMarker", part: "7", story: editor.body.session.story.story.index })
		expect(presses[0]?.page).toBe(-1)
		expect(presses[0]?.hit.pos).toBe(paragraphPos(editor, 1) + 1)
	})

	it("shows a note at its reference as an editable view of the note's story", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body: '<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>',
				footnotes:
					SEPARATORS +
					'<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note text</w:t></w:r></w:p></w:footnote>'
			})
		)
		const reflow = open(editor)
		const reference = scroller.querySelector<HTMLElement>(".fo-docx-reflow-note-ref")

		expect(reference?.dataset["foNote"]).toBe("1")
		expect(reference?.querySelector(".fo-docx-reflow-note .fo-docx-reflow-doc")?.textContent).toContain("Note text")

		const story = editor.edits.model.footnotes.get("1")?.index ?? -1

		// Shown without an editing session (none is made for a note only scrolled past), labelled for assistive
		// technology and reachable from the keyboard.
		expect(reflow.viewOf(story)).toBeUndefined()
		expect(editor.sessions.map(session => session.story.story.kind)).toEqual(["body"])

		const mount = reference?.querySelector<HTMLElement>(".fo-docx-reflow-note")

		expect(mount?.tabIndex).toBe(0)

		// A press on it makes it editable.
		act(() => {
			mount?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }))
		})

		const nested = reflow.viewOf(story)

		if (nested === undefined) throw new Error("no note view")

		act(() => {
			nested.dispatch(nested.state.tr.insertText("!", nested.state.doc.content.size - 1))
		})

		expect(editor.activeStory).toBe(story)
		expect(editor.storySession(story)?.state.doc.textContent).toContain("Note text!")
		expect(reference?.textContent).toContain("Note text!")

		// The note is edited beside the body: a click (focus) in the body goes back to it, as on the pages.
		act(() => {
			reflow.main.view.dom.dispatchEvent(new FocusEvent("focus"))
		})
		expect(editor.activeStory).toBe(editor.body.session.story.story.index)
	})

	it("draws the app's marks and a picture inserted since the document opened", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Speling here") + p("") }))
		const start = paragraphPos(editor, 0) + 1
		const reflow = open(editor, { marks: [{ from: start, to: start + 7, kind: "spelling" }] })

		expect(scroller.querySelector('.fo-docx-reflow-mark[data-fo-mark="spelling"]')?.textContent).toBe("Speling")

		reflow.update(optionsOf({ marks: [{ from: start + 8, to: start + 12, kind: "find" }] }))

		expect(scroller.querySelector('.fo-docx-reflow-mark[data-fo-mark="spelling"]')).toBeNull()
		expect(scroller.querySelector('.fo-docx-reflow-mark[data-fo-mark="find"]')?.textContent).toBe("here")

		const png = Uint8Array.from(
			atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
			c => c.charCodeAt(0)
		)
		const media = editor.addMedia(png, { contentType: "image/png" })

		if (media === undefined) throw new Error("no media")

		act(() => {
			const view = reflow.main.view

			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, paragraphPos(editor, 1) + 1)))
			void editor.execute({ type: "image.insert", media })
		})

		expect(scroller.querySelector(".fo-docx-reflow-drawing img")?.getAttribute("src")).toBe("blob:picture")
	})
})

describe("ReflowView, as the pages resolve it", () => {
	let scroller: HTMLDivElement
	let views: ReflowView[]

	const open = (editor: PagedEditor): ReflowView => {
		const view = new ReflowView(editor, scroller, optionsOf())

		views.push(view)

		return view
	}

	beforeEach(() => {
		scroller = document.createElement("div")
		scroller.className = "fo-docx-reflow"
		document.body.appendChild(scroller)
		views = []
	})

	afterEach(() => {
		for (const view of views) view.destroy()

		scroller.remove()
	})

	const styles = (inner: string) => ({
		parts: [
			{
				name: "word/styles.xml",
				contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:styles>`
			}
		],
		relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }]
	})
	const cell = (text: string, tcPr = ""): string =>
		`<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`

	it("draws table borders, shading and cell margins from the table style and the cells' own", async () => {
		const grid =
			'<w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/><w:tblPr><w:tblBorders>' +
			'<w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="8" w:space="0" w:color="000000"/>' +
			'<w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="8" w:space="0" w:color="000000"/>' +
			'<w:insideH w:val="dashed" w:sz="8" w:space="0" w:color="00FF00"/><w:insideV w:val="dotted" w:sz="8" w:space="0" w:color="00FF00"/>' +
			'</w:tblBorders><w:tblCellMar><w:left w:w="150" w:type="dxa"/><w:right w:w="150" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
		const table =
			'<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
			`<w:tr>${cell("A1", '<w:tcBorders><w:bottom w:val="double" w:sz="12" w:space="0" w:color="0000FF"/></w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="FF0000"/>')}${cell("B1")}</w:tr>` +
			`<w:tr>${cell("A2")}${cell("B2")}</w:tr></w:tbl>`
		const { editor } = await pagedEditor(buildDocx({ body: table + p("After"), ...styles(grid) }))
		const reflow = open(editor)
		const cells = (): CSSStyleDeclaration[] => [...scroller.querySelectorAll("td")].map(td => td.style)
		const edge = (style: CSSStyleDeclaration | undefined, side: "top" | "bottom" | "inline-start" | "inline-end"): string =>
			side === "top" || side === "bottom"
				? [
						style?.getPropertyValue(`border-${side}-width`),
						style?.getPropertyValue(`border-${side}-style`),
						style?.getPropertyValue(`border-${side}-color`)
					]
						.filter(value => value !== undefined && value !== "")
						.join(" ")
				: (style?.getPropertyValue(`border-${side}`) ?? "")
		const check = (): void => {
			const [a1, b1, a2, b2] = cells()

			expect(edge(a1, "top")).toBe("1.33px solid #000000")
			expect(edge(a1, "inline-start")).toBe("1.33px solid #000000")
			// Its own bottom, heavier than the inside border below it.
			expect(edge(a1, "bottom")).toBe("6px double #0000FF")
			expect(a1?.getPropertyValue("background-color")).toBe("#FF0000")
			expect(a1?.getPropertyValue("padding-left")).toBe("10px")
			// Inside borders between cells, drawn once by the cell after.
			expect(edge(b1, "inline-start")).toBe("1.33px dotted #00FF00")
			expect(edge(b1, "inline-end")).toBe("1.33px solid #000000")
			expect(edge(a1, "inline-end")).toBe("none")
			expect(edge(b1, "bottom")).toBe("1.33px dashed #00FF00")
			expect(edge(a2, "top")).toMatch(/none/)
			expect(edge(b2, "bottom")).toBe("1.33px solid #000000")
		}

		check()

		// Edited, the table is laid out from what the edit wrote: the same look.
		act(() => {
			const view = reflow.main.view
			let pos = -1

			view.state.doc.descendants((node, offset) => {
				if (node.isText && node.text === "A2") pos = offset + 2

				return pos < 0
			})
			view.dispatch(view.state.tr.insertText("x", pos))
		})

		expect(scroller.textContent).toContain("A2x")
		check()
	})

	it("bands rows and finds the last row among the rows the revision view shows, as the pages do", async () => {
		const banded =
			'<w:style w:type="table" w:styleId="Banded"><w:name w:val="Banded"/><w:tblPr><w:tblStyleRowBandSize w:val="1"/></w:tblPr>' +
			'<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="DDDDDD"/></w:tcPr></w:tblStylePr>' +
			'<w:tblStylePr w:type="lastRow"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="00FF00"/></w:tcPr></w:tblStylePr></w:style>'
		const del = '<w:trPr><w:del w:id="1" w:author="Ann" w:date="2024-01-01T00:00:00Z"/></w:trPr>'
		const row = (text: string, trPr = ""): string => `<w:tr>${trPr}${cell(text)}${cell(`${text}b`)}</w:tr>`
		const xml =
			'<w:tbl><w:tblPr><w:tblStyle w:val="Banded"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:firstRow="0" w:lastRow="1" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>' +
			'<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
			row("R0") +
			row("R1", del) +
			row("R2") +
			row("R3") +
			row("R4", del) +
			"</w:tbl>"
		const { editor } = await pagedEditor(buildDocx({ body: xml + p("After"), ...styles(banded) }))

		open(editor)

		const fills = (): string[] =>
			[...scroller.querySelectorAll("tr")].map(tr => tr.querySelector("td")?.style.getPropertyValue("background-color") ?? "")
		const revisions = (): string[] => [...scroller.querySelectorAll("tr")].map(tr => tr.getAttribute("data-fo-revision") ?? "")

		act(() => {
			editor.setView(RevisionView.Markup)
		})
		// Every row counts: R4 is the last, R0 R2 the odd bands.
		expect(fills()).toEqual(["#DDDDDD", "", "#DDDDDD", "", "#00FF00"])
		expect(revisions()).toEqual(["", "del", "", "", "del"])

		act(() => {
			editor.setView(RevisionView.Final)
		})
		// R1 and R4 are not shown (the stylesheet hides them): R0 R3 the odd bands, R3 the last row.
		expect(scroller.dataset["foRevisions"]).toBe("final")
		expect(fills()[0]).toBe("#DDDDDD")
		expect(fills()[2]).toBe("")
		expect(fills()[3]).toBe("#00FF00")

		act(() => {
			editor.setView(RevisionView.Original)
		})
		expect(fills()).toEqual(["#DDDDDD", "", "#DDDDDD", "", "#00FF00"])
	})

	it("hides the rows and cells the revision view hides, as the pages do: one inserted and deleted is in neither", async () => {
		const by = 'w:author="Ann" w:date="2024-01-01T00:00:00Z"'
		const both = `<w:trPr><w:ins w:id="1" ${by}/><w:del w:id="2" ${by}/></w:trPr>`
		const xml =
			'<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
			`<w:tr>${cell("A1")}${cell("B1", `<w:cellDel w:id="3" ${by}/>`)}</w:tr>` +
			`<w:tr>${both}${cell("A2")}${cell("B2")}</w:tr>` +
			`<w:tr>${cell("A3")}${cell("B3", `<w:cellIns w:id="4" ${by}/>`)}</w:tr></w:tbl>`
		const { editor } = await pagedEditor(buildDocx({ body: xml + p("After") }))

		open(editor)

		// The stylesheet hides a row or cell by its tokens per revision view (docxReflow.test.ts reads the rule).
		const RULES: Readonly<Record<string, string>> = {
			markup: ":not(*)",
			final: '[data-fo-revision~="del"]',
			original: '[data-fo-revision~="ins"]'
		}
		const hidden = (): string[] =>
			[...scroller.querySelectorAll("tr, td")]
				.filter(element => element.matches(RULES[scroller.dataset["foRevisions"] ?? ""] ?? ":not(*)"))
				.map(element => element.textContent)

		expect([...scroller.querySelectorAll("tr, td")].map(element => element.getAttribute("data-fo-revision") ?? "")).toEqual([
			"",
			"",
			"del",
			"ins del",
			"",
			"",
			"",
			"",
			"ins"
		])

		act(() => {
			editor.setView(RevisionView.Markup)
		})
		expect(hidden()).toEqual([])
		act(() => {
			editor.setView(RevisionView.Final)
		})
		expect(hidden()).toEqual(["B1", "A2B2"])
		act(() => {
			editor.setView(RevisionView.Original)
		})
		expect(hidden()).toEqual(["A2B2", "B3"])
	})

	it("keeps a table's look while the pages rest, catching layout's view up only when its rows change", async () => {
		const grid =
			'<w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/><w:tblPr><w:tblBorders>' +
			'<w:insideH w:val="dashed" w:sz="8" w:space="0" w:color="00FF00"/></w:tblBorders></w:tblPr></w:style>'
		const table =
			'<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
			`<w:tr>${cell("A1")}${cell("B1")}</w:tr><w:tr>${cell("A2")}${cell("B2")}</w:tr></w:tbl>`
		const { editor } = await pagedEditor(buildDocx({ body: p("Before") + table + p("After"), ...styles(grid) }))

		editor.suspend()

		const reflow = open(editor)
		const view = reflow.main.view
		const applied = vi.spyOn(editor.body.edits, "applyPending")
		const bottoms = (): string[] => [...scroller.querySelectorAll("td")].map(td => td.style.getPropertyValue("border-bottom-style"))
		const at = (text: string): number => {
			let pos = -1

			view.state.doc.descendants((node, offset) => {
				if (pos < 0 && node.isText && node.text?.startsWith(text) === true) pos = offset + text.length

				return pos < 0
			})

			return pos
		}

		expect(bottoms()).toEqual(["dashed", "dashed", "none", "none"])

		// Text typed in a cell: the look as it was, layout's view left behind.
		act(() => {
			view.dispatch(view.state.tr.insertText("x", at("A1")))
		})
		expect(scroller.textContent).toContain("A1x")
		expect(bottoms()).toEqual(["dashed", "dashed", "none", "none"])
		expect(applied).not.toHaveBeenCalled()

		// A row added: layout's view catches up, the new row looks as the table's last.
		act(() => {
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at("B2"))))
			void editor.execute({ type: "table.row.insertBelow" })
		})
		expect(applied).toHaveBeenCalled()
		expect(bottoms()).toEqual(["dashed", "dashed", "dashed", "dashed", "none", "none"])
		expect(editor.body.edits.document).toBe(editor.body.session.state.doc)
		applied.mockRestore()
		editor.resume()
	})

	it("reads tables' and cells' properties for their look only: tracked edits of them leave the store flat", async () => {
		const table =
			'<w:tbl><w:tblPr><w:tblBorders><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
			`<w:tr>${cell("A1")}${cell("B1")}</w:tr><w:tr>${cell("A2")}${cell("B2")}</w:tr></w:tbl>`
		const { editor } = await pagedEditor(buildDocx({ body: p("Before") + table + p("After") }))
		const session = editor.body.session
		const store = session.context.store

		session.context.review.tracking = true
		session.context.identity.author = "Ann"
		editor.suspend()
		open(editor)

		const at = (text: string): number => {
			let pos = -1

			session.state.doc.descendants((node, offset) => {
				if (pos < 0 && node.isText && node.text === text) pos = offset + 1

				return pos < 0
			})

			return pos
		}
		const counts = (): number[] => {
			const stats = store.stats()

			return [stats.tables, stats.cells]
		}
		const before = counts()

		// Each a tracked change of its own (a w:tcPrChange with an id of its own): drawn, none is interned whole.
		for (const [k, text] of ["A1", "B1", "A2", "B2", "A1"].entries()) {
			act(() => {
				session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, at(text))))
				void editor.execute({ type: "table.cell.shading", fill: k % 2 === 0 ? "FF0000" : "00FF00" })
			})
		}

		expect(scroller.querySelectorAll("td")[0]?.style.getPropertyValue("background-color")).toBe("#FF0000")
		expect(counts()).toEqual(before)
		editor.resume()
	})

	it("drops the spacing between paragraphs of one style that have contextual spacing", async () => {
		const item =
			'<w:style w:type="paragraph" w:styleId="Item"><w:name w:val="Item"/><w:pPr><w:contextualSpacing/><w:spacing w:before="120" w:after="200"/></w:pPr></w:style>'
		const styled = (text: string): string => `<w:p><w:pPr><w:pStyle w:val="Item"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
		const { editor } = await pagedEditor(
			buildDocx({ body: styled("One") + styled("Two") + p("Plain") + styled("Three"), ...styles(item) })
		)

		open(editor)

		const paragraphs = [...scroller.querySelectorAll<HTMLElement>(".fo-docx-reflow-p")]

		expect(paragraphs.map(paragraph => paragraph.dataset["foContextual"] ?? "")).toEqual(["bottom", "top", "", ""])
		expect(paragraphs[0]?.getAttribute("style")).toContain("padding-bottom: 13.33px")
	})

	it("shows fields as their codes while the editor does, as the pages show them", async () => {
		const toc =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Entry one</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>Entry two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const { editor } = await pagedEditor(
			buildDocx({ body: '<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>' + toc + p("After") })
		)

		open(editor)

		const codes = (): string =>
			[...scroller.querySelectorAll<HTMLElement>("[data-fo-code]")].map(element => element.dataset["foCode"] ?? "").join("")
		const hidden = (): string =>
			[...scroller.querySelectorAll(".fo-docx-reflow-code-result")].map(element => element.textContent).join("")

		expect(codes()).toBe("")

		act(() => {
			editor.setFieldCodes(true)
		})

		expect(codes()).toMatch(/^\{ PAGE \}\{\s*TOC \\o "1-3"\s*\}$/)
		expect(hidden()).toBe("Entry oneEntry two")
		expect(scroller.textContent).toContain("After")

		act(() => {
			editor.setFieldCodes(false)
		})

		expect(codes()).toBe("")
		expect(hidden()).toBe("")
	})

	it("paints equations from their OMML, an equation inserted in Mobile view too", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body: '<w:p><w:r><w:t xml:space="preserve">Area </w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>' + p("")
			})
		)

		editor.suspend()

		const reflow = open(editor)

		expect(scroller.querySelector(".fo-docx-reflow-math math")?.textContent).toBe("x")

		act(() => {
			const view = reflow.main.view

			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, paragraphPos(editor, 1) + 1)))
			void editor.execute({ type: "equation.insert", latex: "y^2", display: false })
		})

		const painted = [...scroller.querySelectorAll(".fo-docx-reflow-math")]

		expect(painted).toHaveLength(2)
		expect(painted[1]?.querySelector("msup")?.textContent).toBe("y2")
		expect(scroller.querySelector(".fo-docx-reflow-math.fo-docx-placeholder")).toBeNull()
		editor.resume()
	})

	it("paints a tracked equation per revision view, each author in the pages' colour", async () => {
		const font = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'
		const run = (text: string): string => `<m:r>${font}<m:t>${text}</m:t></m:r>`
		const bob = 'w:author="Bob" w:date="2026-02-02T11:00:00Z"'
		// Ada changed the text first (she is the first reviewer), then Bob changed x squared to x cubed.
		const body =
			'<w:p><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T10:00:00Z"><w:r><w:t xml:space="preserve">Edited </w:t></w:r></w:ins>' +
			`<m:oMath><m:sSup><m:sSupPr><m:ctrlPr>${font}</m:ctrlPr></m:sSupPr><m:e>${run("x")}</m:e>` +
			`<m:sup><w:del w:id="21" ${bob}>${run("2")}</w:del><w:ins w:id="22" ${bob}>${run("3")}</w:ins></m:sup></m:sSup></m:oMath></w:p>`
		const { editor } = await pagedEditor(buildDocx({ body }))

		editor.suspend()

		const reflow = open(editor)
		const painted = (): Element | null | undefined => scroller.querySelector(".fo-docx-reflow-math math")

		expect(scroller.dataset["foRevisions"]).toBe("final")
		expect(painted()?.textContent).toBe("x3")

		act(() => {
			editor.setView(RevisionView.Original)
		})

		expect(painted()?.textContent).toBe("x2")

		act(() => {
			editor.setView(RevisionView.Markup)
		})

		expect(painted()?.textContent).toBe("x23")

		// Bob is the second reviewer: the second author colour, as the pages and balloons give him (the tree the
		// view painted, kept per node and view).
		let math: Node | undefined

		editor.body.session.state.doc.descendants(node => {
			if (node.type.name === "math") math = node

			return math === undefined
		})

		const slots: number[] = []
		const walk = (element: MathElement): void => {
			const revision = element.attributes?.revision

			if (revision !== undefined) slots.push(revision >> 2)

			for (const child of element.children) if (typeof child !== "string") walk(child)
		}
		const tree = math === undefined ? null : equationTree(math, editor.body.session.story.part, { view: "markup" })

		if (tree !== null) walk(tree)

		expect(slots.length).toBeGreaterThan(1)
		expect(slots.every(slot => slot === 2)).toBe(true)

		// An author new in the session, after another one the balloons met first: the colour the balloons give her.
		const authors = modelAuthors(editor.edits.model)

		authors.index("Dan")
		editor.body.session.context.identity.author = "Cleo"

		act(() => {
			void editor.execute({ type: "review.track", on: true })

			const view = reflow.main.view

			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)))
			void editor.execute({ type: "equation.insert", latex: "z", display: false })
		})

		const inserted: Node[] = []

		editor.body.session.state.doc.descendants(node => {
			if (node.type.name === "math") inserted.push(node)

			return true
		})

		const cleo: number[] = []
		const collect = (element: MathElement): void => {
			const revision = element.attributes?.revision

			if (revision !== undefined) cleo.push(revision >> 2)

			for (const child of element.children) if (typeof child !== "string") collect(child)
		}
		const added = inserted[1] === undefined ? null : equationTree(inserted[1], editor.body.session.story.part, { view: "markup" })

		expect(scroller.querySelectorAll(".fo-docx-reflow-math math")).toHaveLength(2)

		if (added !== null) collect(added)

		// Ada 0, Bob 1, Dan 2 (met by the balloons), Cleo 3: the fourth colour slot.
		expect(authors.index("Cleo")).toBe(3)
		expect(cleo.length).toBeGreaterThan(0)
		expect(cleo.every(slot => slot === 4)).toBe(true)
		expect(scroller.querySelectorAll(".fo-docx-reflow-math.fo-docx-placeholder")).toHaveLength(0)
		editor.resume()
	})

	it("shows a text box's text the layout has not placed", async () => {
		const box =
			'<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor behindDoc="0" allowOverlap="1" layoutInCell="1" relativeHeight="1" simplePos="0" locked="0"><wp:simplePos x="0" y="0"/>' +
			'<wp:positionH relativeFrom="page"><wp:posOffset>952500</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>4762500</wp:posOffset></wp:positionV>' +
			'<wp:extent cx="1905000" cy="952500"/><wp:wrapNone/><wp:docPr id="3" name="t"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
			"<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>inside the box</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>" +
			"</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>"
		const { editor } = await pagedEditor(buildDocx({ body: `<w:p>${box}<w:r><w:t>body</w:t></w:r></w:p>` }))

		// The layout never placed the drawing (its object is unknown).
		vi.spyOn(editor.layout.objects, "idOf").mockReturnValue(-1)

		open(editor)

		expect(scroller.querySelector(".fo-docx-reflow-textbox .fo-docx-reflow-doc")?.textContent).toBe("inside the box")
	})
})

describe("ReflowView, stories and focus", () => {
	let scroller: HTMLDivElement
	let views: ReflowView[]

	const open = (editor: PagedEditor, overrides: Partial<ReflowViewOptions> = {}): ReflowView => {
		const view = new ReflowView(editor, scroller, optionsOf(overrides))

		views.push(view)

		return view
	}
	const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
	const NOTES =
		'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
		'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
	const reference = (id: number, text = "Ref"): string =>
		`<w:p><w:r><w:t>${text}</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${String(id)}"/></w:r></w:p>`
	const note = (id: number, text = "Note text"): string =>
		`<w:footnote w:id="${String(id)}"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:footnote>`
	const press = (element: Element | null | undefined): void => {
		element?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }))
	}

	beforeEach(() => {
		scroller = document.createElement("div")
		scroller.className = "fo-docx-reflow"
		document.body.appendChild(scroller)
		views = []
	})

	afterEach(() => {
		for (const view of views) view.destroy()

		scroller.remove()
	})

	it("keeps editing a note while its reference is drawn anew and the revision view changes", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Start") + reference(1), footnotes: NOTES + note(1) }))
		const reflow = open(editor)
		const story = editor.edits.model.footnotes.get("1")?.index ?? -1

		act(() => press(scroller.querySelector(".fo-docx-reflow-note")))

		const nested = reflow.viewOf(story)

		nested?.focus()
		expect(editor.activeStory).toBe(story)

		// The paragraph holding the reference changed (its reference bold): its node views made anew.
		act(() => {
			const body = editor.body.session
			const at = paragraphPos(editor, 1)

			body.dispatch(
				body.state.tr.addMark(at + 1, at + body.state.doc.child(1).nodeSize - 1, docxSchema.marks.bold.create({ value: true }))
			)
		})
		await Promise.resolve()

		expect(editor.activeStory).toBe(story)
		expect(reflow.viewOf(story)).toBeDefined()

		act(() => {
			editor.setView(RevisionView.Markup)
		})
		await Promise.resolve()

		expect(editor.activeStory).toBe(story)

		const again = reflow.viewOf(story)

		act(() => {
			again?.dispatch(again.state.tr.insertText("Z", 3))
		})

		expect(editor.storySession(story)?.state.doc.textContent).toBe("NoZte text")
	})

	it("names a note by its number, again when it changes, and enters one only shown from the keyboard", async () => {
		const { editor } = await pagedEditor(
			buildDocx({ body: p("Start") + reference(1) + reference(2), footnotes: NOTES + note(1, "First") + note(2, "Second") })
		)
		const reflow = open(editor, { storyLabel: (kind, mark) => `${kind} ${mark}` })
		const second = editor.edits.model.footnotes.get("2")?.index ?? -1
		const mounts = (): HTMLElement[] => [...scroller.querySelectorAll<HTMLElement>(".fo-docx-reflow-note")]

		expect(mounts().map(mount => mount.getAttribute("aria-label"))).toEqual(["footnote 1", "footnote 2"])
		expect(editor.sessions).toHaveLength(1)

		// Only shown (no session yet): in the tab order, and focusing it enters it.
		const shown = mounts()[1]

		expect(shown?.tabIndex).toBe(0)
		act(() => {
			shown?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
		})

		expect(editor.activeStory).toBe(second)
		expect(reflow.viewOf(second)?.hasFocus()).toBe(true)
		expect(mounts()[1]?.getAttribute("aria-label")).toBe("footnote 2")

		// The first reference deleted: the second note is numbered 1, its name too.
		act(() => {
			editor.exitStory()

			const body = editor.body.session
			const at = paragraphPos(editor, 1)

			body.dispatch(body.state.tr.delete(at, at + body.state.doc.child(1).nodeSize))
		})

		expect(mounts().map(mount => mount.getAttribute("aria-label"))).toEqual(["footnote 1"])

		// note.goto from the caret at the reference, as on the pages: the note edited, the caret in it.
		const body = editor.body.session
		const ref = paragraphPos(editor, 1) + 1 + "Ref".length

		act(() => {
			body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, ref)))
		})
		await act(async () => {
			expect(await editor.execute({ type: "note.goto" })).toBe(true)
		})

		expect(editor.activeStory).toBe(second)
		expect(reflow.viewOf(second)?.hasFocus()).toBe(true)
	})

	it("does not edit a header or footer, which it does not show: their commands are off while it shows the document", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					p("Start") +
					reference(1) +
					'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
				headers: { rIdH: p("Header text") },
				footnotes: NOTES + note(1)
			})
		)
		const HEADER_COMMANDS = [
			"header.edit",
			"footer.edit",
			"header.differentFirst",
			"header.differentOddEven",
			"header.remove",
			"footer.remove"
		] as const
		const enabled = (): boolean[] => HEADER_COMMANDS.map(type => editor.snapshot().enabled[type])

		expect(enabled()).toEqual([true, true, true, true, true, false])

		const reflow = open(editor)

		expect(enabled()).toEqual([false, false, false, false, false, false])
		expect(editor.headersShown).toBe(false)

		const body = editor.body.session.story.story.index

		act(() => {
			editor.body.session.dispatch(editor.body.session.state.tr.setSelection(TextSelection.create(editor.body.session.state.doc, 3)))
		})

		for (const type of ["header.edit", "footer.edit"] as const) {
			await act(async () => {
				await editor.execute({ type })
				await Promise.resolve()
			})

			expect(editor.activeStory).toBe(body)
			expect(editor.body.session.state.selection.from).toBe(3)
		}

		expect(await editor.execute({ type: "header.differentFirst" })).toBe(false)

		// The pages back: the commands too.
		reflow.destroy()
		views.splice(views.indexOf(reflow), 1)
		expect(editor.headersShown).toBe(true)
		expect(enabled()).toEqual([true, true, true, true, true, false])
	})

	it("makes no session for notes scrolled past and shows a note entered off the screen", async () => {
		const body = Array.from({ length: 200 }, (_, k) => reference(k + 1, `Paragraph ${String(k)} ${"lorem ipsum ".repeat(12)}`)).join("")
		const { editor } = await pagedEditor(
			buildDocx({ body, footnotes: NOTES + Array.from({ length: 200 }, (_, k) => note(k + 1, `Note ${String(k)}`)).join("") })
		)
		const reflow = open(editor)

		editor.suspend()

		for (let k = 0; k < 20; k++) {
			scroller.scrollTop = k * 3000
			scroller.dispatchEvent(new Event("scroll"))
			await frame()
		}

		expect(editor.sessions).toHaveLength(1)

		// note.goto, review.next, a command: editing enters a note whose reference is far from the screen.
		const story = editor.edits.model.footnotes.get("150")?.index ?? -1

		scroller.scrollTop = 0
		scroller.dispatchEvent(new Event("scroll"))
		await frame()
		act(() => {
			editor.enterStory(story, -1)
		})

		expect(reflow.viewOf(story)?.state.doc.textContent).toBe("Note 149")
		editor.resume()
	})

	it("goes back to the body's caret on Escape from a note, as the pages do", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Start here") + reference(1), footnotes: NOTES + note(1) }))
		const reflow = open(editor)
		const story = editor.edits.model.footnotes.get("1")?.index ?? -1
		const body = editor.body.session

		body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, 3)))
		act(() => press(scroller.querySelector(".fo-docx-reflow-note")))

		const nested = reflow.viewOf(story)

		act(() => {
			if (nested !== undefined) key(nested, "Escape")
		})

		expect(editor.activeStory).toBe(body.story.story.index)
		expect(body.state.selection.head).toBe(3)
	})

	it("takes focus and the cut's comments from the pages' input view it replaces", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					'<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Commented</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>' +
					p("After"),
				comments: '<w:comment w:id="7" w:author="Ann"><w:p><w:r><w:t>Look</w:t></w:r></w:p></w:comment>'
			})
		)
		const host = document.createElement("div")

		document.body.appendChild(host)

		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const doc = editor.body.session.state.doc

		sink.focus()
		sink.view.dispatch(sink.view.state.tr.setSelection(TextSelection.create(sink.view.state.doc, 0, doc.child(0).nodeSize)))

		const text = sink.clipboardContent()?.text ?? ""

		sink.deleteSelection()
		expect(docxComments(editor).comment("7")).toBeUndefined()
		sink.destroy()
		host.remove()

		const reflow = open(editor)

		expect(scroller.contains(document.activeElement)).toBe(true)

		act(() => {
			reflow.paste({ text })
		})

		expect(docxComments(editor).comment("7")).toBeDefined()
	})

	it("fills a cell with the table's shading where its own paints nothing, as the pages do", async () => {
		const table =
			'<w:tbl><w:tblPr><w:shd w:val="clear" w:color="auto" w:fill="00FF00"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>' +
			'<w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="auto"/></w:tcPr><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
		const { editor } = await pagedEditor(buildDocx({ body: table + p("After") }))

		open(editor)

		expect(scroller.querySelector("td")?.style.getPropertyValue("background-color")).toBe("#00FF00")
	})

	it("keeps its table of shared decoration attributes bounded", () => {
		const table = new InternTable<{ readonly key: string }>(3)
		const made = Array.from({ length: 10 }, (_, k) => table.get(String(k), () => ({ key: String(k) })))

		expect(table.size).toBeLessThanOrEqual(3)
		expect(made.map(value => value.key)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])
		expect(table.get("9", () => ({ key: "again" }))).toBe(made[9])
	})
})

describe("Escape", () => {
	const escape = (target: Element): KeyboardEvent => {
		const event = new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true })

		target.dispatchEvent(event)

		return event
	}
	const DOC = buildDocx({
		body:
			p("Body text") +
			'<w:p><w:r><w:t>Ref</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>' +
			'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
		headers: { rIdH: p("Header text") },
		footnotes:
			'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
			'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
			'<w:footnote w:id="1"><w:p><w:r><w:t>Note text</w:t></w:r></w:p></w:footnote>'
	})
	const PAINTER = { marks: [], paragraph: null, sticky: false }

	it("leaves an Escape the input view does not take to the host, and takes it out of a header or the painter", async () => {
		const { editor } = await pagedEditor(DOC)
		const host = document.createElement("div")

		document.body.appendChild(host)

		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const body = editor.body.session.story.story.index

		expect(escape(sink.view.dom).defaultPrevented).toBe(false)

		editor.setPainter(PAINTER)
		expect(escape(sink.view.dom).defaultPrevented).toBe(true)
		expect(editor.painter).toBeUndefined()

		const header = editor.edits.model.stories.find(story => story.kind === "header")?.index ?? -1

		editor.enterStory(header, 0)
		expect(escape(sink.view.dom).defaultPrevented).toBe(true)
		expect(editor.activeStory).toBe(body)

		sink.destroy()
		host.remove()
	})

	it("leaves an Escape Mobile view does not take to the host, and takes it out of a note or the painter", async () => {
		const { editor } = await pagedEditor(DOC)
		const scroller = document.createElement("div")

		document.body.appendChild(scroller)

		const reflow = new ReflowView(editor, scroller, optionsOf())
		const body = editor.body.session.story.story.index

		expect(escape(reflow.main.view.dom).defaultPrevented).toBe(false)

		editor.setPainter(PAINTER)
		expect(escape(reflow.main.view.dom).defaultPrevented).toBe(true)
		expect(editor.painter).toBeUndefined()

		act(() => {
			scroller
				.querySelector(".fo-docx-reflow-note")
				?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }))
		})

		const note = reflow.viewOf(editor.edits.model.footnotes.get("1")?.index ?? -1)

		if (note === undefined) throw new Error("no note view")

		note.focus()
		expect(escape(note.dom).defaultPrevented).toBe(true)
		expect(editor.activeStory).toBe(body)

		reflow.destroy()
		scroller.remove()
	})
})

describe("DocxReflow", () => {
	let container: HTMLDivElement
	let root: Root

	beforeEach(() => {
		container = document.createElement("div")
		document.body.appendChild(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
	})

	it("fills the editor handle", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("First paragraph") + p("Second") }))
		const handle = { current: null as DocxEditorHandle | null }
		const onFind = vi.fn()

		act(() =>
			root.render(
				<DocxReflow
					ref={value => {
						handle.current = value
					}}
					editor={editor}
					document={documentOf()}
					label="Document"
					onFind={onFind}
				/>
			)
		)

		const scroller = container.querySelector<HTMLElement>(".fo-docx-reflow")

		expect(scroller?.dataset["foEditing"]).toBe("")
		expect(handle.current?.scrollElement()).toBe(scroller)
		expect(scroller?.textContent).toContain("First paragraph")

		act(() => {
			handle.current?.selectAll()
		})

		expect(editor.selection().from).toBeLessThan(3)
		expect(handle.current?.clipboardContent()?.text).toBe("First paragraph\nSecond")

		act(() => {
			handle.current?.paste({ text: "Pasted" })
		})

		expect(editor.body.session.state.doc.textContent).toBe("Pasted")
		expect(scroller?.textContent).toContain("Pasted")

		const view = scroller?.querySelector<HTMLElement>(".fo-docx-reflow-doc")

		view?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true }))

		expect(onFind).toHaveBeenCalledTimes(1)
	})

	it("brings the caret's paragraph into view when the pages are shown again", async () => {
		const { editor } = await pagedEditor(LONG)
		const session = editor.body.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, paragraphPos(editor, 200) + 3)))

		act(() =>
			root.render(
				<DocxEditor
					editor={editor}
					document={documentOf()}
					zoom={1}
					label="Document"
				/>
			)
		)

		const pages = container.querySelector<HTMLElement>(".fo-docx-pages")

		await act(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))))

		const caret = editor.caret()

		expect(caret?.page).toBeGreaterThan(3)
		expect(pages?.scrollTop).toBeGreaterThan(1000 * (caret?.page ?? 0) - 400)
	})

	it("keeps room right of the pages for an aside", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Text") }))
		const widthWith = (aside: number | undefined): number => {
			act(() =>
				root.render(
					<DocxEditor
						editor={editor}
						document={documentOf()}
						zoom={1}
						label="Document"
						gap={16}
						{...(aside === undefined ? {} : { aside })}
					/>
				)
			)

			return Number.parseFloat(container.querySelector<HTMLElement>(".fo-docx-pages-content")?.style.width ?? "0")
		}

		expect(widthWith(320) - widthWith(undefined)).toBe(320)
	})

	it("does not bring the caret into view once the user scrolled the pages", async () => {
		const { editor } = await pagedEditor(LONG)
		const session = editor.body.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, paragraphPos(editor, 200) + 3)))

		act(() =>
			root.render(
				<DocxEditor
					editor={editor}
					document={documentOf()}
					zoom={1}
					label="Document"
				/>
			)
		)

		const pages = container.querySelector<HTMLElement>(".fo-docx-pages")

		pages?.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 }))
		await act(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))))

		expect(pages?.scrollTop).toBe(0)
	})
})

describe("ReflowView, long tables", () => {
	let scroller: HTMLDivElement
	let views: ReflowView[]

	const open = (editor: PagedEditor): ReflowView => {
		const view = new ReflowView(editor, scroller, optionsOf())

		views.push(view)

		return view
	}
	const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
	const cell = (text: string): string =>
		`<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
	const GRID = '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>'
	const table = (
		rows: number,
		row: (k: number) => string = k => `<w:tr>${cell(`r${String(k)}a`)}${cell(`r${String(k)}b`)}</w:tr>`
	): string => `<w:tbl>${GRID}${Array.from({ length: rows }, (_, k) => row(k)).join("")}</w:tbl>`
	const scrollTo = async (top: number): Promise<void> => {
		scroller.scrollTop = top
		scroller.dispatchEvent(new Event("scroll"))
		await frame()
		await frame()
	}
	// The position inside the first paragraph of row `row`, cell `column` of the table at block 1.
	const cellPos = (editor: PagedEditor, row: number, column = 0): number => {
		const tbl = editor.body.session.state.doc.child(1)
		let at = paragraphPos(editor, 1) + 1

		for (let r = 0; r < row; r++) at += tbl.child(r).nodeSize

		at += 1

		for (let k = 0; k < column; k++) at += tbl.child(row).child(k).nodeSize

		return at + 2
	}

	beforeEach(() => {
		scroller = document.createElement("div")
		scroller.className = "fo-docx-reflow"
		document.body.appendChild(scroller)
		views = []
	})

	afterEach(() => {
		for (const view of views) view.destroy()

		scroller.remove()
	})

	it("never reads its own writes of a paragraph's look or a gap row's height back as an edit", async () => {
		const { editor } = await pagedEditor(
			buildDocx({ body: '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Before</w:t></w:r></w:p>' + table(200) + p("After") })
		)
		const reflow = open(editor)
		const session = editor.body.session

		editor.suspend()
		// The first rows header rows: rows with a node mark, which wraps them.
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, cellPos(editor, 0), cellPos(editor, 2, 1))))
		expect(await editor.execute({ type: "table.row.header" })).toBe(true)
		await frame()
		expect(scroller.querySelectorAll(".fo-docx-reflow-node-mark > tr").length).toBe(3)

		const before = session.state.doc

		await scrollTo(reflow.heights.top(1) + 2000)

		// Rows before and after the screen are gap rows of their rows' height; the rows drawn have none set.
		const gaps = [...scroller.querySelectorAll<HTMLElement>(".fo-docx-reflow-gap-row > td")]

		expect(gaps.length).toBe(2)
		for (const gap of gaps) expect(Number.parseFloat(gap.style.height)).toBeGreaterThan(100)
		for (const td of scroller.querySelectorAll<HTMLElement>("tr:not(.fo-docx-reflow-gap-row) > td")) expect(td.style.height).toBe("")

		// A look written outside an update (the faces changed) is the view's, not the user's.
		for (const paragraph of scroller.querySelectorAll<HTMLElement>(".fo-docx-reflow-p"))
			paragraph.setAttribute("style", `${paragraph.getAttribute("style") ?? ""};text-indent:3px`)
		await frame()
		// What the view's observer took since (it reads on its own too): nothing to read back.
		;(Reflect.get(reflow.main.view, "domObserver") as { flush: () => void }).flush()

		expect(session.state.doc).toBe(before)
		editor.resume()
	})

	it("deletes the rows of a long table scrolled to its end", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Before") + table(200) + p("After") }))
		const reflow = open(editor)
		const session = editor.body.session

		editor.suspend()

		for (const top of [reflow.heights.top(1) + 1000, reflow.heights.top(2) - 900, reflow.heights.top(2) - 500]) await scrollTo(top)

		expect(reflow.screenRows(1)[1]).toBe(200)

		session.dispatch(
			session.state.tr.setSelection(TextSelection.create(session.state.doc, cellPos(editor, 100), cellPos(editor, 199, 1)))
		)

		expect(await editor.execute({ type: "table.row.delete" })).toBe(true)
		await frame()

		expect(session.state.doc.child(1).childCount).toBe(100)
		expect(reflow.main.view.state.doc.content.size).toBe(session.state.doc.content.size)
		expect(reflow.screenRows(1)[1] ?? 0).toBeLessThanOrEqual(100)
		expect(scroller.textContent).toContain("r99b")
		editor.resume()
	})

	it("keeps editing a note referenced from a long table's row while scrolling away from it", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					p("Before") +
					table(200, k =>
						k === 5
							? `<w:tr>${cell("x")}<w:tc><w:p><w:r><w:t>noted</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p></w:tc></w:tr>`
							: `<w:tr>${cell(`r${String(k)}a`)}${cell("y")}</w:tr>`
					) +
					Array.from({ length: 50 }, (_, k) => p(`After ${String(k)}`)).join(""),
				footnotes: SEPARATORS + '<w:footnote w:id="1"><w:p><w:r><w:t>Note text</w:t></w:r></w:p></w:footnote>'
			})
		)
		const reflow = open(editor)

		editor.suspend()
		scroller
			.querySelector(".fo-docx-reflow-note")
			?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }))

		const story =
			editor.sessions.find(session => session.story.story.kind === "footnote" && session.state.doc.textContent === "Note text")?.story
				.story.index ?? -1

		reflow.viewOf(story)?.focus()
		expect(editor.activeStory).toBe(story)

		for (const top of [reflow.heights.top(1) + 3000, reflow.heights.top(1) + 6000, reflow.heights.top(2) + 500]) {
			await scrollTo(top)

			expect(editor.activeStory).toBe(story)
			expect(reflow.viewOf(story)).toBeDefined()
		}

		editor.resume()
	})
})

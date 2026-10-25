// @vitest-environment happy-dom
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { closeHistory } from "prosemirror-history"
import { TextSelection } from "prosemirror-state"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SOURCE_INTS, type DocumentLayout, type PageDisplayList } from "@filen/office/core/docx"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxPageData, DocxSessionApi, DocxTextStyle } from "@filen/office/dom/docx"
import { DocxMediaCache, paintPage, patchPage, type DocxDocument, type DocxTables } from "@filen/office/react/docx"
import { DocxEditor, EditSink, type DocxEditorHandle, type DocxEditorMark } from "@filen/office/react/docx/editor"
import { plainSlice, plainText } from "../react/docx/edit/sink"
import { buildDocx } from "./docxSynthetic"
import { pagedEditor, settle } from "./pagedDomFixtures"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SESSION: DocxSessionApi = {
	objects: () => Promise.resolve([]),
	media: () => Promise.resolve(null),
	locate: () => Promise.resolve(null),
	find: () => Promise.resolve(new Int32Array(0)),
	annotations: () => Promise.resolve(null),
	close: () => undefined
}

// The renderer's view of a layout page (no objects or links in these documents).
function pageData(page: PageDisplayList): DocxPageData {
	const text = page.text

	return {
		index: page.index,
		number: page.number,
		numberText: page.numberText,
		section: page.section,
		width: page.width,
		height: page.height,
		lineCount: text.lineCount,
		fragmentCount: text.fragmentCount,
		decorationCount: text.decorationCount,
		lineFloats: text.lineFloats,
		lineInts: text.lineInts,
		fragmentFloats: text.fragmentFloats,
		fragmentInts: text.fragmentInts,
		decorationFloats: text.decorationFloats,
		decorationInts: text.decorationInts,
		graphicCount: page.graphicCount,
		graphicFloats: page.graphicFloats,
		graphicInts: page.graphicInts,
		objectCount: 0,
		objectFloats: new Float32Array(0),
		objectInts: new Int32Array(0),
		objectKinds: new Uint8Array(0),
		sourceCount: page.sourceCount,
		sourceInts: page.sourceInts.slice(0, page.sourceCount * SOURCE_INTS),
		sourceTexts: page.sourceTexts,
		linkCount: 0,
		linkInts: new Int32Array(0)
	}
}

function tablesOf(layout: DocumentLayout): DocxTables {
	const styles: DocxTextStyle[] = []

	for (let id = 0; id < layout.styles.count; id++) {
		const style = layout.styles.get(id)

		styles.push({
			font: `400 ${Math.round(style.size)}px sans-serif`,
			smallCapsFont: "400 10px sans-serif",
			color: "",
			kerning: true,
			letterSpacing: 0,
			scaleX: 1,
			shift: 0,
			ascent: style.size * 0.8,
			descent: style.size * 0.2,
			revision: 0
		})
	}

	return { styles, decorations: [], links: [] }
}

function documentOf(editor: PagedEditor): DocxDocument {
	const pages: DocxPageData[] = []

	for (let index = 0; index < editor.pageCount; index++) {
		const page = editor.page(index)

		if (page !== undefined) pages.push(pageData(page))
	}

	return {
		status: "ready",
		info: undefined,
		pages,
		pageCount: pages.length,
		tables: tablesOf(editor.layout),
		session: SESSION,
		media: new DocxMediaCache(SESSION),
		error: undefined
	}
}

const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const LONG_PARAGRAPHS = 60
const LONG = buildDocx({
	body: Array.from({ length: LONG_PARAGRAPHS }, (_, k) => p(`Paragraph ${k} ${"lorem ipsum dolor sit amet ".repeat(12)}`)).join("")
})

function paragraphPos(editor: PagedEditor, index: number): number {
	let found = -1

	editor.state.doc.forEach((_node, offset, k) => {
		if (k === index) found = offset
	})

	return found
}

const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))

describe("line patching", () => {
	it("repaints only changed lines and equals a fresh paint", async () => {
		const { editor } = await pagedEditor(LONG)
		const before = editor.page(1)

		if (before === undefined) throw new Error("no page")

		const tables = tablesOf(editor.layout)
		const painted = paintPage(pageData(before), { document, tables })
		// A paragraph in the middle of page 2.
		const target = editor.geometry.hitTest(1, 300, 500)

		if (target === undefined) throw new Error("no hit")

		editor.dispatch(editor.state.tr.insertText("typed words ", target.pos))
		await settle(editor)

		const after = editor.page(1)

		if (after === undefined || after === before) throw new Error("page not laid out again")

		const inserted = vi.spyOn(painted.parts.textElements, "insertBefore")
		const patched = patchPage(painted, pageData(after), { document, tables: tablesOf(editor.layout) })
		const fresh = paintPage(pageData(after), { document, tables: tablesOf(editor.layout) })

		expect(patched.painted.root.innerHTML).toBe(fresh.root.innerHTML)

		// Lines above the edit kept their elements.
		const kept = patched.painted.lines.filter(line => painted.lines.some(old => old.text === line.text))

		expect(kept.length).toBeGreaterThan(5)
		// Only new lines were put in the DOM: kept ones stay where they are (a moved element is restyled and
		// laid out again).
		expect(inserted.mock.calls.length).toBe(patched.painted.lines.length - kept.length)
		expect(patched.painted.lines[0]?.text).toBe(painted.lines[0]?.text)
		// A line where it was, showing the same text of the same paragraph, is kept as painted (nothing made).
		expect(patched.painted.lines[0]).toBe(painted.lines[0])

		// Patching to the page as it was brings back what it looked like.
		const back = patchPage(patched.painted, pageData(before), { document, tables })

		expect(back.painted.root.innerHTML).toBe(paintPage(pageData(before), { document, tables }).root.innerHTML)
	})
})

describe("DocxEditor", () => {
	let container: HTMLDivElement
	let root: Root

	beforeEach(() => {
		container = document.createElement("div")
		container.style.height = "800px"
		document.body.appendChild(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
	})

	it("renders pages, an input view windowed around the selection, caret and selection", async () => {
		const { editor } = await pagedEditor(LONG)
		const handle = { current: null as DocxEditorHandle | null }

		act(() =>
			root.render(
				<DocxEditor
					ref={value => {
						handle.current = value
					}}
					editor={editor}
					document={documentOf(editor)}
					zoom={1}
					label="Document"
					window={3}
				/>
			)
		)
		await act(frame)

		const textbox = container.querySelector<HTMLElement>("[role=textbox]")

		expect(textbox?.getAttribute("aria-label")).toBe("Document")
		expect(container.querySelector(".fo-docx-pages")?.getAttribute("aria-hidden")).toBe("true")
		// Only the blocks near the selection are in the input view; the rest is one empty gap after them.
		const filled = Array.from(textbox?.children ?? []).filter(child => child.childNodes.length > 0)

		expect(textbox?.children.length).toBeLessThanOrEqual(8)
		expect(filled.length).toBeLessThanOrEqual(7)
		expect(textbox?.lastElementChild?.childNodes.length).toBe(0)
		expect(container.querySelectorAll(".fo-docx-page").length).toBeGreaterThan(0)

		// A caret in paragraph 2, drawn on its page.
		await act(async () => {
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, paragraphPos(editor, 2) + 5)))
			handle.current?.focus()
			await frame()
		})
		expect(container.querySelectorAll(".fo-docx-caret").length).toBe(1)

		// The window followed the selection to paragraph 40.
		await act(async () => {
			const at = paragraphPos(editor, 40) + 3

			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at, at + 30)))
			await frame()
		})

		const blocks = Array.from(textbox?.children ?? [])

		// A gap, the blocks around paragraph 40, a gap.
		expect(blocks.length).toBeLessThanOrEqual(9)
		expect(blocks[0]?.childNodes.length).toBe(0)
		expect(textbox?.textContent).toContain("Paragraph 40 ")
		expect(textbox?.textContent).not.toContain("Paragraph 2 ")

		// A range: selection boxes on the mounted page that shows it, no caret.
		const ends = editor.ends()

		if (ends.start !== undefined) {
			act(() => handle.current?.scrollToPage(ends.start?.page ?? 0))
			await act(frame)
		}

		expect(container.querySelectorAll(".fo-docx-caret").length).toBe(0)
	})

	it("shows itself focused (the caret) when remounted holding focus", async () => {
		const { editor } = await pagedEditor(LONG)
		const handle = { current: null as DocxEditorHandle | null }
		const view = (key: string) => (
			<DocxEditor
				key={key}
				ref={value => {
					handle.current = value
				}}
				editor={editor}
				document={documentOf(editor)}
				zoom={1}
				label="Document"
				window={3}
			/>
		)

		act(() => root.render(view("a")))
		await act(async () => {
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, paragraphPos(editor, 2) + 5)))
			handle.current?.focus()
			await frame()
		})
		expect(container.querySelector(".fo-docx-editor")?.hasAttribute("data-fo-focused")).toBe(true)

		// The new input view takes the focus the old one handed on as it is built, before anything listens to it.
		act(() => root.render(view("b")))
		await act(frame)

		expect(container.querySelector("[role=textbox]")).toBe(document.activeElement)
		expect(container.querySelector(".fo-docx-editor")?.hasAttribute("data-fo-focused")).toBe(true)
		expect(container.querySelectorAll(".fo-docx-caret").length).toBe(1)
	})

	it("draws the caret under StrictMode, whose rehearsed unmount cancels the first frame", async () => {
		const { editor } = await pagedEditor(LONG)
		const handle = { current: null as DocxEditorHandle | null }

		act(() =>
			root.render(
				<StrictMode>
					<DocxEditor
						ref={value => {
							handle.current = value
						}}
						editor={editor}
						document={documentOf(editor)}
						zoom={1}
						label="Document"
						window={3}
					/>
				</StrictMode>
			)
		)
		await act(async () => {
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, paragraphPos(editor, 2) + 5)))
			handle.current?.focus()
			await frame()
		})

		expect(container.querySelectorAll(".fo-docx-caret").length).toBe(1)
	})

	it("types through the input view and patches the page", async () => {
		const { editor } = await pagedEditor(LONG)
		let document = documentOf(editor)
		const render = (): void =>
			root.render(
				<DocxEditor
					editor={editor}
					document={document}
					zoom={1}
					label="Document"
				/>
			)

		act(render)
		await act(frame)

		const before = container.querySelector('[data-fo-page="0"] .fo-docx-text')?.textContent ?? ""

		await act(async () => {
			editor.dispatch(editor.state.tr.insertText("HELLO ", paragraphPos(editor, 0) + 1))
			await settle(editor)
			document = documentOf(editor)
			render()
			await frame()
		})

		const after = container.querySelector('[data-fo-page="0"] .fo-docx-text')?.textContent ?? ""

		expect(after).not.toBe(before)
		expect(after).toContain("HELLO")
	})
})

const GAP = 16

// A point of page `index` on screen (happy-dom lays nothing out: client space is the content's own, the
// pages stacked from the gap at the left edge).
function clientPoint(editor: PagedEditor, index: number, x: number, y: number): { clientX: number; clientY: number } {
	let top = GAP

	for (let k = 0; k < index; k++) top += (editor.page(k)?.height ?? 0) + GAP

	return { clientX: GAP + x, clientY: top + y }
}

function pointer(type: string, point: { clientX: number; clientY: number }, init: PointerEventInit = {}): PointerEvent {
	return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", ...point, ...init })
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	target.dispatchEvent(event)

	return event
}

// The first textblock whose text starts with `text`: its content's start.
function textStart(editor: PagedEditor, text: string): number {
	let found = -1

	editor.state.doc.descendants((node, pos) => {
		if (found < 0 && node.isTextblock && node.textContent.startsWith(text)) found = pos + 1

		return found < 0
	})

	return found
}

const caretAt = (editor: PagedEditor, pos: number): void => {
	editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

describe("DocxEditor input", () => {
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

	const mount = async (editor: PagedEditor, props: { readOnly?: boolean; marks?: readonly DocxEditorMark[]; zoom?: number } = {}) => {
		const handle = { current: null as DocxEditorHandle | null }

		act(() =>
			root.render(
				<DocxEditor
					ref={value => {
						handle.current = value
					}}
					editor={editor}
					document={documentOf(editor)}
					zoom={1}
					gap={GAP}
					label="Document"
					{...props}
				/>
			)
		)
		await act(frame)

		const content = container.querySelector<HTMLElement>(".fo-docx-pages-content")
		const textbox = container.querySelector<HTMLElement>("[role=textbox]")

		if (content === null || textbox === null) throw new Error("not rendered")

		return { handle, content, textbox }
	}

	it("places the pages anew when the zoom or a page's size changes, as when nothing did", async () => {
		const { editor } = await pagedEditor(LONG)
		const places = (): string[] =>
			Array.from(container.querySelectorAll<HTMLElement>("[data-fo-page]"), page => `${page.style.top}|${page.style.height}`)

		const { content } = await mount(editor)
		const first = places()
		const height = content.style.height

		await mount(editor, { zoom: 2 })
		expect(places()).not.toEqual(first)
		expect(Number.parseFloat(content.style.height)).toBeGreaterThan(1.9 * Number.parseFloat(height))

		// Typing lays pages out again at their size: the places stay.
		await mount(editor)
		await act(async () => {
			editor.dispatch(editor.state.tr.insertText("typed ", paragraphPos(editor, 2) + 1))
			await frame()
		})
		expect(places()).toEqual(first)
		expect(content.style.height).toBe(height)
	})

	it("counts clicks itself: a double click selects the word, a triple click the paragraph", async () => {
		const { editor } = await pagedEditor(LONG)
		const { content } = await mount(editor)
		const box = editor.geometry.locate(paragraphPos(editor, 1) + 14)

		if (box === undefined) throw new Error("no caret")

		const point = clientPoint(editor, box.page, box.x + 1, box.top + box.height / 2)
		const press = (init: PointerEventInit = {}): void =>
			act(() => {
				content.dispatchEvent(pointer("pointerdown", point, init))
				content.dispatchEvent(pointer("pointerup", point, init))
			})
		const paragraph = editor.state.doc.child(1)

		press()
		expect(editor.selection().empty).toBe(true)

		press()

		const word = editor.selection()

		expect(word.empty).toBe(false)
		expect(word.to - word.from).toBeLessThan(10)

		press()
		expect(editor.selection().to - editor.selection().from).toBe(paragraph.content.size)

		// Shift+click extends instead, from the paragraph's start.
		press({ shiftKey: true })
		expect(editor.selection().anchor).toBe(paragraphPos(editor, 1) + 1)
		expect(editor.selection().head).toBeLessThan(paragraphPos(editor, 1) + 1 + paragraph.content.size)
	})

	it("edits a note beside the body (no dimming, a click or tap in the body goes back), a header dimmed and left by a double click", async () => {
		const NOTES =
			'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
			'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
			'<w:footnote w:id="1"><w:p><w:r><w:t>Note text</w:t></w:r></w:p></w:footnote>'
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					'<w:p><w:r><w:t>Body text with a note</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>' +
					"<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>" +
					'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
				headers: { rIdH: "<w:p><w:r><w:t>Header text</w:t></w:r></w:p>" },
				footnotes: NOTES
			})
		)
		const { content } = await mount(editor)
		const body = editor.body.session.story.story.index
		const second = textStart(editor, "Second paragraph") + 3
		const box = editor.geometry.locate(second)

		if (box === undefined) throw new Error("no caret")

		const point = clientPoint(editor, box.page, box.x + 1, box.top + box.height / 2)
		const page = container.querySelector(`[data-fo-page="${String(box.page)}"]`) ?? content
		const click = (init: PointerEventInit = {}): void =>
			act(() => {
				page.dispatchEvent(pointer("pointerdown", point, init))
				page.dispatchEvent(pointer("pointerup", point, init))
			})
		const dimmed = (): boolean => container.querySelector(".fo-docx-dim") !== null
		const note = editor.edits.model.footnotes.get("1")?.index ?? -1
		const header = editor.edits.model.stories.findIndex(story => story.kind === "header")

		act(() => {
			editor.enterStory(note, -1)
		})
		await act(frame)
		expect(editor.activeStory).toBe(note)
		expect(dimmed()).toBe(false)

		// One click in the body: the caret there.
		click()
		expect(editor.activeStory).toBe(body)
		expect(editor.selection().head).toBe(second)

		// One tap, the same (touch has no Escape key and no double click to leave by).
		act(() => {
			editor.enterStory(note, -1)
		})
		await act(frame)
		expect(editor.activeStory).toBe(note)
		click({ pointerType: "touch" })
		expect(editor.activeStory).toBe(body)
		expect(editor.selection().head).toBe(second)

		act(() => {
			editor.enterStory(header, 0)
		})
		await act(frame)
		expect(dimmed()).toBe(true)

		// A header is left by a double click on the body only (presses apart, not counted as one).
		const apart = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 600))

		await apart()
		click()
		expect(editor.activeStory).toBe(header)
		await apart()
		click()
		click()
		expect(editor.activeStory).toBe(body)
		await act(frame)
		expect(dimmed()).toBe(false)
	})

	it("places the caret on the nearest line for presses between and beside pages", async () => {
		const { editor } = await pagedEditor(LONG)
		const { content } = await mount(editor)
		const page = editor.page(0)

		if (page === undefined) throw new Error("no page")

		// Just below page 0: its last line; just above page 1: its first.
		act(() => content.dispatchEvent(pointer("pointerdown", clientPoint(editor, 0, 300, page.height + 3))))
		act(() => content.dispatchEvent(pointer("pointerup", clientPoint(editor, 0, 300, page.height + 3))))
		expect(editor.caret()?.page).toBe(0)

		act(() => content.dispatchEvent(pointer("pointerdown", clientPoint(editor, 1, 300, -3), { clientX: GAP + 300 + 1000 })))
		act(() => content.dispatchEvent(pointer("pointerup", clientPoint(editor, 1, 300, -3))))

		const caret = editor.caret()

		expect(caret?.page).toBe(1)
		// Far right of the page: the line's end.
		expect(caret?.x ?? 0).toBeGreaterThan(page.width / 2)
	})

	it("leaves touch scrolling to the browser and keeps focus after a tap", async () => {
		const { editor } = await pagedEditor(LONG)
		const { content, textbox } = await mount(editor)
		const before = editor.selection().head
		const point = clientPoint(editor, 0, 300, 300)
		const down = pointer("pointerdown", point, { pointerType: "touch" })

		act(() => content.dispatchEvent(down))
		expect(down.defaultPrevented).toBe(false)

		// The browser took the gesture over: nothing selected or focused.
		act(() => content.dispatchEvent(pointer("pointercancel", point, { pointerType: "touch" })))
		expect(editor.selection().head).toBe(before)
		expect(document.activeElement).not.toBe(textbox)

		// The compatibility mousedown after a tap moves no focus.
		const mouse = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...point })

		content.dispatchEvent(mouse)
		expect(mouse.defaultPrevented).toBe(true)
	})

	it("keeps a touch handle's other end where it was when the drag began", async () => {
		const { editor } = await pagedEditor(LONG)
		const { handle } = await mount(editor)
		const start = paragraphPos(editor, 1) + 20

		act(() => {
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start, start + 5)))
		})

		const end = editor.geometry.locate(start + 5)

		if (end === undefined) throw new Error("no end")

		// The start handle dragged past the end, then further.
		for (const dx of [60, 120]) {
			const point = clientPoint(editor, end.page, end.x + dx, end.top + end.height / 2)

			act(() => handle.current?.dragSelectionEnd("start", point.clientX, point.clientY))
			expect(Math.min(editor.selection().anchor, editor.selection().head)).toBe(start + 5)
		}

		act(() => handle.current?.endSelectionDrag())
	})

	it("is read-only through the view: no edits, selection and focus still", async () => {
		const { editor } = await pagedEditor(LONG)
		const { textbox, handle } = await mount(editor, { readOnly: true })
		const doc = editor.state.doc

		expect(textbox.getAttribute("contenteditable")).toBe("false")
		expect(textbox.getAttribute("aria-readonly")).toBe("true")
		expect(textbox.getAttribute("inputmode")).toBe("none")
		expect(textbox.getAttribute("tabindex")).toBe("0")
		expect(container.querySelector(".fo-docx-editor")?.hasAttribute("data-fo-read-only")).toBe(true)

		act(() => handle.current?.focus())
		expect(document.activeElement).toBe(textbox)

		const pos = paragraphPos(editor, 2) + 3

		act(() => caretAt(editor, pos))
		act(() => {
			key(textbox, { key: "End" })
			key(textbox, { key: "Enter" })
			key(textbox, { key: "Backspace" })
			key(textbox, { key: "b", ctrlKey: true })
		})
		expect(editor.state.doc).toBe(doc)
		expect(editor.selection().head).toBeGreaterThan(pos)

		// Editable again.
		await mount(editor, { readOnly: false })
		expect(textbox.getAttribute("contenteditable")).toBe("true")
		expect(textbox.hasAttribute("aria-readonly")).toBe(false)
	})

	it("draws the marks of each page in one pass, keeping the boxes that did not move", async () => {
		const { editor } = await pagedEditor(LONG)
		const marks: DocxEditorMark[] = []

		editor.state.doc.forEach((_node, offset) => marks.push({ from: offset + 1, to: offset + 10, kind: "spelling" }))

		const rangeRects = vi.spyOn(editor, "rangeRects")
		const rangesRects = vi.spyOn(editor.geometry, "rangesRects")
		const { handle } = await mount(editor, { marks })
		const mounted = Array.from(container.querySelectorAll<HTMLElement>("[data-fo-page]")).map(page => Number(page.dataset["foPage"]))
		const drawn = (): Element[] => Array.from(container.querySelectorAll('.fo-docx-mark[data-fo-mark="spelling"]'))
		// A box per mark on a line: a wave starting at each box.
		const boxes = (): number => drawn().reduce((sum, path) => sum + (path.getAttribute("d")?.match(/M/g)?.length ?? 0), 0)
		let expected = 0

		for (const index of mounted) for (const mark of marks) expected += editor.rangeRects(mark.from, mark.to, index).length

		expect(mounted.length).toBeGreaterThan(0)
		expect(expected).toBeGreaterThan(0)
		expect(boxes()).toBe(expected)
		// One call per page drawn, never one per mark.
		expect(rangeRects.mock.calls.length).toBe(mounted.length * marks.length)
		expect(rangesRects.mock.calls.length).toBeLessThanOrEqual(mounted.length * 2)

		const before = drawn()
		const calls = rangesRects.mock.calls.length

		// The caret moving redraws no mark.
		await act(async () => {
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, paragraphPos(editor, 3) + 2)))
			handle.current?.focus()
			await frame()
		})
		expect(rangesRects.mock.calls.length).toBe(calls)
		expect(drawn()).toEqual(before)

		const caret = container.querySelector(".fo-docx-caret")

		expect(caret).not.toBeNull()

		// Typing: paths of lines it did not touch are the same elements, and so is the caret.
		await act(async () => {
			editor.dispatch(editor.state.tr.insertText("x"))
			await frame()
		})

		const after = drawn()

		expect(after.filter(element => before.includes(element)).length).toBeGreaterThan(before.length / 2)
		expect(container.querySelector(".fo-docx-caret")).toBe(caret)
		expect(container.querySelectorAll(".fo-docx-caret").length).toBe(1)
	})

	it("draws a path of marks per line and touches only the path of the line typed in", async () => {
		const { editor } = await pagedEditor(LONG)
		let marks: DocxEditorMark[] = []

		editor.state.doc.forEach((_node, offset) => marks.push({ from: offset + 1, to: offset + 10, kind: "spelling" }))
		await mount(editor, { marks })

		const rows = (): Map<Element, string> =>
			new Map(Array.from(container.querySelectorAll(".fo-docx-mark"), path => [path, path.getAttribute("d") ?? ""]))
		const before = rows()

		// One path per line: every mark here sits on its paragraph's first line.
		expect(before.size).toBeGreaterThan(5)
		expect([...before.values()].every(d => d.match(/M/g)?.length === 1)).toBe(true)
		expect(container.querySelectorAll("svg.fo-docx-marks").length).toBe(container.querySelectorAll("[data-fo-page]").length)

		const tr = editor.state.tr.insertText("x", paragraphPos(editor, 3) + 3)
		const original = marks

		marks = marks.map(mark => ({ ...mark, from: tr.mapping.map(mark.from), to: tr.mapping.map(mark.to) }))
		editor.dispatch(tr)
		await mount(editor, { marks })

		const after = rows()
		const changed = [...after].filter(([row, content]) => before.get(row) !== content)

		expect(after.size).toBe(before.size)
		expect(changed.length).toBe(1)

		// Undone: the paths drawn are the ones drawn before the edit.
		expect(editor.session.execute({ type: "history.undo" })).toBe(true)
		await mount(editor, { marks: original })
		expect([...rows().values()].sort()).toEqual([...before.values()].sort())
	})

	it("orders marks moved in place again for each document drawn", async () => {
		const { editor } = await pagedEditor(LONG)
		const start = paragraphPos(editor, 1) + 1
		// Marks a checker moves in place through edits (the list stays the same).
		const first = { from: start, to: start + 5, kind: "spelling" }
		const second = { from: start + 20, to: start + 25, kind: "repeated" }
		const marks: DocxEditorMark[] = [first, second]
		const count = (kind: string): number => container.querySelectorAll(`.fo-docx-mark[data-fo-mark="${kind}"]`).length

		await mount(editor, { marks })
		expect([count("spelling"), count("repeated")]).toEqual([1, 1])

		// The first now lies after the second, in another paragraph: the list is out of order.
		const later = paragraphPos(editor, 2) + 1

		first.from = later
		first.to = later + 5
		await act(async () => {
			editor.dispatch(editor.state.tr.insertText("x", paragraphPos(editor, 5) + 1))
			await frame()
		})
		expect([count("spelling"), count("repeated")]).toEqual([1, 1])
	})

	it("draws find results in a drawing of their own, under no other kind", async () => {
		const { editor } = await pagedEditor(LONG)
		const start = paragraphPos(editor, 0) + 1

		await mount(editor, {
			marks: [
				{ from: start, to: start + 9, kind: "find-active" },
				{ from: start + 10, to: start + 15, kind: "repeated" },
				{ from: start + 20, to: start + 25, kind: "find" }
			]
		})

		const blended = container.querySelector("svg.fo-docx-marks[data-fo-blend]")
		const plain = container.querySelector("svg.fo-docx-marks:not([data-fo-blend])")

		expect(blended?.querySelectorAll('[data-fo-mark="find"], [data-fo-mark="find-active"]').length).toBe(2)
		expect(plain?.querySelectorAll('[data-fo-mark="repeated"]').length).toBe(1)
		expect(blended?.querySelector('[data-fo-mark="find-active"]')?.getAttribute("d")).toMatch(/^M[\d.]+ 0h[\d.]+v[\d.]+h-[\d.]+z$/)
		// The plain drawing comes first: highlights blend over it.
		expect(plain?.compareDocumentPosition(blended as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
	})
})

describe("EditSink", () => {
	let host: HTMLDivElement

	beforeEach(() => {
		host = document.createElement("div")
		document.body.appendChild(host)
	})

	afterEach(() => host.remove())

	const sinkOf = (editor: PagedEditor, options: { readOnly?: boolean; apple?: boolean; window?: number } = {}): EditSink =>
		new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined, ...options })

	it("holds the blocks around the selection at the document's positions, each run of the rest one gap", async () => {
		const { editor } = await pagedEditor(LONG)

		caretAt(editor, paragraphPos(editor, 30) + 3)

		const sink = sinkOf(editor, { window: 3 })
		const view = (): typeof sink.view.state.doc => sink.view.state.doc

		// Gap, seven blocks, gap: the document's size, its blocks where they are in it.
		expect(view().childCount).toBe(9)
		expect(view().content.size).toBe(editor.state.doc.content.size)
		expect(view().nodeAt(paragraphPos(editor, 30))).toBe(editor.state.doc.child(30))
		expect(view().nodeAt(paragraphPos(editor, 27))).toBe(editor.state.doc.child(27))
		expect(sink.view.dom.children[0]?.childNodes.length).toBe(0)
		expect(sink.view.state.selection.head).toBe(paragraphPos(editor, 30) + 3)

		// Typing through the view edits the document at the same position.
		const pos = paragraphPos(editor, 31) + 2

		sink.view.dispatch(sink.view.state.tr.insertText("typed", pos))
		expect(editor.state.doc.textBetween(pos, pos + 5)).toBe("typed")
		expect(view().content.size).toBe(editor.state.doc.content.size)
		expect(view().nodeAt(paragraphPos(editor, 31))).toBe(editor.state.doc.child(31))
		expect(sink.view.state.selection.head).toBe(editor.selection().head)

		// A step to the next block keeps the window (and its gaps); far away it moves.
		const gap = view().child(0)

		caretAt(editor, paragraphPos(editor, 32) + 1)
		expect(view().child(0)).toBe(gap)
		caretAt(editor, paragraphPos(editor, 50) + 1)
		expect(view().nodeAt(paragraphPos(editor, 50))).toBe(editor.state.doc.child(50))
		expect(view().content.size).toBe(editor.state.doc.content.size)
		expect(sink.view.dom.textContent).not.toContain("Paragraph 30 ")

		// Undo from the toolbar: the view follows.
		editor.session.execute({ type: "history.undo" })
		expect(editor.state.doc.textBetween(pos, pos + 5)).not.toBe("typed")
		expect(view().content.size).toBe(editor.state.doc.content.size)
		sink.destroy()
	})

	it("takes a selection across its gaps: copy writes the document's text, typing replaces the document's range", async () => {
		const { editor } = await pagedEditor(LONG)
		const sink = sinkOf(editor, { window: 2 })
		const from = paragraphPos(editor, 2) + 4
		const to = paragraphPos(editor, 50) + 6

		sink.view.dispatch(sink.view.state.tr.setSelection(TextSelection.create(sink.view.state.doc, from, to)))
		expect(editor.selection()).toMatchObject({ from, to })
		// Blocks around each end, the rest in gaps.
		expect(sink.view.state.doc.childCount).toBeLessThan(15)

		const written = new Map<string, string>()
		const copy = Object.assign(new Event("copy", { bubbles: true, cancelable: true }), {
			clipboardData: {
				clearData: () => written.clear(),
				setData: (type: string, value: string) => written.set(type, value),
				getData: (type: string) => written.get(type) ?? ""
			}
		})

		sink.view.dom.dispatchEvent(copy)
		expect(copy.defaultPrevented).toBe(true)
		expect(written.get("text/plain")).toBe(plainText(editor.state.doc, from, to, () => ""))
		expect(written.get("text/plain")).toContain("Paragraph 30 ")

		// Typing over it: the same document as typing over the session's own selection.
		const expected = editor.state.tr.insertText("X").doc

		sink.view.dispatch(sink.view.state.tr.insertText("X"))
		expect(editor.state.doc.eq(expected)).toBe(true)
		expect(sink.view.state.doc.content.size).toBe(editor.state.doc.content.size)
		expect(editor.state.doc.childCount).toBe(LONG_PARAGRAPHS - 48)
		sink.destroy()
	})

	it("undoes and redoes from beforeinput (Edit menu, shake, a soft keyboard) in the session, once", async () => {
		const { editor } = await pagedEditor(LONG)
		const sink = sinkOf(editor)
		const doc = editor.state.doc
		const pos = paragraphPos(editor, 1) + 2
		const input = (inputType: string): { prevented: number; handled: boolean } => {
			const event = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true })
			let prevented = 0
			const prevent = event.preventDefault.bind(event)

			event.preventDefault = () => {
				prevented++
				prevent()
			}
			sink.view.dom.dispatchEvent(event)

			return { prevented, handled: event.defaultPrevented }
		}

		sink.view.dispatch(sink.view.state.tr.insertText("typed", pos))

		const typed = editor.state.doc

		expect(typed).not.toBe(doc)
		expect(input("historyUndo")).toEqual({ prevented: 1, handled: true })
		expect(editor.state.doc.eq(doc)).toBe(true)
		expect(sink.view.state.doc.content.size).toBe(doc.content.size)
		expect(input("historyRedo")).toEqual({ prevented: 1, handled: true })
		expect(editor.state.doc.eq(typed)).toBe(true)
		// Other input is left to the view.
		expect(input("insertText").prevented).toBe(0)
		sink.destroy()
	})

	it("undoes from the keyboard in the order of edits across stories, and Esc clears the format painter first", async () => {
		const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					para("Body text") +
					'<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
				headers: { rIdH1: para("Header") }
			})
		)
		const header = editor.edits.model.stories.find(story => story.kind === "header")?.index ?? -1
		const body = editor.activeStory
		const sink = sinkOf(editor)
		// Each edit an event of its own.
		const typeAtStart = (text: string): void => {
			editor.dispatch(closeHistory(editor.state.tr.insertText(text, TextSelection.atStart(editor.state.doc).from)))
		}
		const undoKey = (): void => {
			key(sink.view.dom, { key: "z", code: "KeyZ", ctrlKey: true })
		}
		const text = (story: number): string => editor.storySession(story)?.state.doc.textContent ?? ""

		typeAtStart("A")
		expect(editor.enterStory(header, 0)).toBe(true)
		typeAtStart("H")
		editor.exitStory()
		typeAtStart("B")
		expect(text(body)).toBe("BABody text")
		expect(text(header)).toBe("HHeader")

		undoKey()
		expect(text(body)).toBe("ABody text")
		undoKey()
		expect(editor.activeStory).toBe(header)
		expect(text(header)).toBe("Header")
		undoKey()
		expect(editor.activeStory).toBe(body)
		expect(text(body)).toBe("Body text")
		expect(editor.snapshot().canUndo).toBe(false)

		editor.setPainter({ marks: [], paragraph: null, sticky: false })
		key(sink.view.dom, { key: "Escape", code: "Escape" })
		expect(editor.painter).toBeUndefined()
		sink.destroy()
	})

	it("takes a word step read-only, which the browser makes, at once (no selectionchange read yet)", async () => {
		const { editor } = await pagedEditor(LONG)
		const sink = sinkOf(editor, { readOnly: true })
		const start = paragraphPos(editor, 1) + 1
		const selection = document.getSelection()
		// The browser's word step; its selectionchange still queued.
		const modify = vi.fn(() => {
			const { node } = sink.view.domAtPos(start)

			selection?.collapse(node.nodeType === 3 ? node : (node.firstChild ?? node), 0)
		})
		const hold = (event: Event): void => {
			event.stopImmediatePropagation()
		}

		// Read-only, the view takes focus as any element with a tab stop.
		sink.view.dom.focus()
		sink.view.dispatch(sink.view.state.tr.setSelection(TextSelection.create(sink.view.state.doc, start + 6)))
		Object.defineProperty(selection, "modify", { value: modify, configurable: true })
		window.addEventListener("selectionchange", hold, true)

		try {
			expect(key(sink.view.dom, { key: "ArrowLeft", ctrlKey: true }).defaultPrevented).toBe(true)
		} finally {
			window.removeEventListener("selectionchange", hold, true)
			Reflect.deleteProperty(selection ?? {}, "modify")
		}

		expect(modify).toHaveBeenCalledWith("move", "left", "word")
		expect(editor.selection().head).toBe(start)
		sink.destroy()
	})

	it("refuses edits read-only and allows them once writable", async () => {
		const { editor } = await pagedEditor(LONG)
		const sink = sinkOf(editor, { readOnly: true })
		const doc = editor.state.doc
		const pos = paragraphPos(editor, 1) + 2

		sink.view.dispatch(sink.view.state.tr.insertText("typed", pos))
		expect(editor.state.doc).toBe(doc)

		sink.view.dispatch(sink.view.state.tr.setSelection(TextSelection.create(sink.view.state.doc, pos)))
		expect(editor.selection().head).toBe(pos)

		sink.setReadOnly(false)
		expect(sink.view.editable).toBe(true)
		expect(sink.view.dom.getAttribute("contenteditable")).toBe("true")

		sink.view.dispatch(sink.view.state.tr.insertText("typed", pos))
		expect(editor.state.doc.textBetween(pos, pos + 5)).toBe("typed")
		sink.destroy()
	})

	it("underlines the composed text where a browser rewrote the whole paragraph", async () => {
		const { editor } = await pagedEditor(LONG)
		const sink = sinkOf(editor)
		const start = paragraphPos(editor, 1) + 1
		const caret = start + 10
		const paragraph = editor.state.doc.child(1)
		const composing = (text: string): void => {
			const before = paragraph.textBetween(0, 10)
			const after = paragraph.textBetween(10, paragraph.content.size)
			const update = Object.assign(new Event("compositionupdate", { bubbles: true }), { data: text })

			sink.view.dom.dispatchEvent(update)

			// The browser's caret: after the composed text.
			const tr = sink.view.state.tr.insertText(before + text + after, start, start + editor.state.doc.child(1).content.size)

			sink.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret + text.length)))
		}

		caretAt(editor, caret)
		sink.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }))
		expect(sink.view.composing).toBe(true)

		composing("あ")
		composing("あい")
		expect(editor.composition).toEqual({ from: caret, to: caret + 2 })

		sink.view.dom.dispatchEvent(Object.assign(new Event("compositionend", { bubbles: true }), { data: "あい" }))
		expect(editor.composition).toBeUndefined()
		sink.destroy()
	})

	it("sizes its text like the painted caret's line and column", async () => {
		const { editor } = await pagedEditor(LONG)
		const sink = new EditSink(editor, host, {
			label: "Document",
			caretClientRect: () => ({ left: 100, top: 200, height: 24, width: 480 })
		})

		sink.align()
		expect(sink.element.style.lineHeight).toBe("24px")
		expect(sink.element.style.fontSize).toBe("20px")
		expect(sink.element.style.width).toBe("480px")
		sink.destroy()
	})

	it("joins paragraphs on word and line deletions at their edges, Ctrl+Arrow to line ends on macOS", async () => {
		const { editor } = await pagedEditor(LONG)
		const sink = sinkOf(editor, { apple: true })
		const count = editor.state.doc.childCount

		caretAt(editor, paragraphPos(editor, 2) + 1)
		key(sink.view.dom, { key: "Backspace", altKey: true })
		expect(editor.state.doc.childCount).toBe(count - 1)

		const end = paragraphPos(editor, 3) + editor.state.doc.child(3).nodeSize - 1

		caretAt(editor, end)
		key(sink.view.dom, { key: "Delete", altKey: true })
		expect(editor.state.doc.childCount).toBe(count - 2)

		caretAt(editor, paragraphPos(editor, 5) + 3)
		key(sink.view.dom, { key: "ArrowRight", ctrlKey: true })

		const line = editor.geometry.lineBoundary(paragraphPos(editor, 5) + 3, 1, 1)

		expect(editor.selection().head).toBe(line?.pos)
		sink.destroy()
	})

	it("steps on screen through right-to-left lines", async () => {
		const { editor } = await pagedEditor(
			buildDocx({ body: '<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:t xml:space="preserve">שלום עולם יפה</w:t></w:r></w:p>' })
		)
		const sink = sinkOf(editor)
		const pos = textStart(editor, "שלום") + 4

		caretAt(editor, pos)

		const x = editor.caret()?.x ?? 0

		key(sink.view.dom, { key: "ArrowLeft" })
		expect(editor.selection().head).toBe(pos + 1)
		expect(editor.caret()?.x ?? 0).toBeLessThan(x)
		expect(sink.view.dom.querySelector("p")?.dir).toBe("auto")
		sink.destroy()
	})
})

describe("plain text clipboard", () => {
	it("copies paragraphs, table cells and rows, empty paragraphs and list numbers like Word", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					p("Before") +
					p("") +
					'<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
					`<w:tr><w:tc>${p("A1")}</w:tc><w:tc>${p("B1")}</w:tc></w:tr><w:tr><w:tc>${p("A2")}</w:tc><w:tc>${p("B2")}</w:tc></w:tr></w:tbl>` +
					p("Item one") +
					p("After")
			})
		)
		const doc = editor.state.doc
		const item = textStart(editor, "Item")
		const marker = (pos: number): string => (pos === item ? "1.\t" : "")

		expect(plainText(doc, 0, doc.content.size, marker)).toBe("Before\n\nA1\tB1\nA2\tB2\n1.\tItem one\nAfter")
		// From inside a paragraph: no marker for a paragraph started before the range.
		expect(plainText(doc, item + 2, item + 6, marker)).toBe("em o")
	})

	it("pastes plain text as one paragraph per line, tabs as tabs", async () => {
		const { editor } = await pagedEditor(LONG)
		const slice = plainSlice("a\tb\r\n\nc\u0001", editor.state.doc.resolve(paragraphPos(editor, 1) + 3))
		const paragraphs: string[] = []

		slice.content.forEach(node => paragraphs.push(node.textBetween(0, node.content.size, undefined, leaf => leaf.type.name)))
		expect(paragraphs).toEqual(["atabb", "", "c"])
		expect(slice.openStart).toBe(1)
		expect(slice.openEnd).toBe(1)
	})
})

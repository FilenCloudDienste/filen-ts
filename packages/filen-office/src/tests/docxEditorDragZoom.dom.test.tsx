// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxSessionApi } from "@filen/office/dom/docx"
import { DocxMediaCache, type DocxDocument } from "@filen/office/react/docx"
import { DocxEditor } from "@filen/office/react/docx/editor"
import { unitDragSelection } from "../react/docx/edit/unitDrag"
import { anchoredScrollTop } from "../react/docx/viewport"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// Double- and triple-click drags by whole words and paragraphs, and zooming keeping the view on its place.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const GAP = 16
const SESSION: DocxSessionApi = {
	objects: () => Promise.resolve([]),
	media: () => Promise.resolve(null),
	locate: () => Promise.resolve(null),
	find: () => Promise.resolve(new Int32Array(0)),
	annotations: () => Promise.resolve(null),
	close: () => undefined
}
// No pages from the renderer: the editor stacks them at the default Letter size, as the layout has them.
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
const LONG = buildDocx({
	body: Array.from({ length: 60 }, (_, k) => p(`Paragraph ${String(k)} ${"lorem ipsum dolor sit amet ".repeat(12)}`)).join("")
})

const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))

// A point of page `index` on screen (happy-dom lays nothing out: client space is the content's own).
function clientPoint(editor: PagedEditor, index: number, x: number, y: number): { clientX: number; clientY: number } {
	let top = GAP

	for (let k = 0; k < index; k++) top += (editor.page(k)?.height ?? 0) + GAP

	return { clientX: GAP + x, clientY: top + y }
}

function pointer(type: string, point: { clientX: number; clientY: number }): PointerEvent {
	return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", ...point })
}

function paragraphStart(editor: PagedEditor, index: number): number {
	let found = -1

	editor.state.doc.forEach((_node, offset, k) => {
		if (k === index) found = offset + 1
	})

	return found
}

describe("unitDragSelection", () => {
	const pressed = { from: 10, to: 15 }

	it("keeps the pressed unit while the pointer is in it", () => {
		expect(unitDragSelection(pressed, pressed)).toEqual({ anchor: 10, head: 15 })
	})

	it("grows forward to the end of the unit under the pointer, from the pressed one's start", () => {
		expect(unitDragSelection(pressed, { from: 21, to: 27 })).toEqual({ anchor: 10, head: 27 })
	})

	it("grows backward to the start of the unit under the pointer, from the pressed one's end", () => {
		expect(unitDragSelection(pressed, { from: 2, to: 8 })).toEqual({ anchor: 15, head: 2 })
	})
})

describe("anchoredScrollTop", () => {
	const stack = (zoom: number, count: number) => {
		const tops = new Float64Array(count)
		const heights = new Float64Array(count)

		for (let i = 0; i < count; i++) {
			tops[i] = GAP + i * (1056 * zoom + GAP)
			heights[i] = 1056 * zoom
		}

		return { tops, heights }
	}

	it("keeps the same fraction of the same page at the top", () => {
		const before = stack(1, 40)
		const after = stack(2, 40)
		// A quarter down page 30.
		const top = (before.tops[30] ?? 0) + 1056 / 4

		expect(anchoredScrollTop(before, after, top)).toBeCloseTo((after.tops[30] ?? 0) + 2112 / 4, 6)
	})

	it("leaves the position where there were no pages", () => {
		expect(anchoredScrollTop(stack(1, 0), stack(2, 4), 300)).toBe(300)
	})
})

describe("DocxEditor pointer and zoom", () => {
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

	const mount = async (editor: PagedEditor, zoom = 1) => {
		act(() =>
			root.render(
				<DocxEditor
					editor={editor}
					document={DOCUMENT}
					zoom={zoom}
					gap={GAP}
					label="Document"
				/>
			)
		)
		await act(frame)

		const pages = container.querySelector<HTMLElement>(".fo-docx-pages")
		const content = container.querySelector<HTMLElement>(".fo-docx-pages-content")

		if (pages === null || content === null) throw new Error("not rendered")

		return { pages, content }
	}

	it("keeps a double-clicked word through jitter and extends a drag by whole words either way", async () => {
		const { editor } = await pagedEditor(LONG)
		const { content } = await mount(editor)
		// "ipsum" in paragraph 1 ("Paragraph 1 lorem ipsum ..."), pressed in its middle.
		const start = paragraphStart(editor, 1)
		const ipsum = start + "Paragraph 1 lorem ".length
		const at = (pos: number): { clientX: number; clientY: number } => {
			const box = editor.geometry.locate(pos)

			if (box === undefined) throw new Error("no caret")

			return clientPoint(editor, box.page, box.x + 0.5, box.top + box.height / 2)
		}
		const press = at(ipsum + 2)

		act(() => {
			content.dispatchEvent(pointer("pointerdown", press))
			content.dispatchEvent(pointer("pointerup", press))
			content.dispatchEvent(pointer("pointerdown", press))
		})

		const word = editor.selection()

		expect(word.empty).toBe(false)
		expect(word.from).toBeLessThanOrEqual(ipsum)
		expect(word.to).toBeGreaterThanOrEqual(ipsum + "ipsum".length)

		// A jitter within the click slop, even one that crosses a character: the word stays selected.
		act(() => content.dispatchEvent(pointer("pointermove", { clientX: press.clientX - 3, clientY: press.clientY + 1 })))
		expect(editor.selection()).toMatchObject({ from: word.from, to: word.to })

		// Into the middle of "sit": the selection ends at the end of that word, from the start of "ipsum".
		const sit = start + "Paragraph 1 lorem ipsum dolor ".length

		act(() => content.dispatchEvent(pointer("pointermove", at(sit + 1))))

		const sitRange = editor.geometry.wordRange(sit + 1)

		expect(editor.selection()).toMatchObject({ anchor: word.from, head: sitRange.to })

		// Back before the pressed word: from its end to the start of "lorem"; "ipsum" stays selected.
		const lorem = start + "Paragraph 1 ".length

		act(() => content.dispatchEvent(pointer("pointermove", at(lorem + 2))))

		const loremRange = editor.geometry.wordRange(lorem + 2)

		expect(editor.selection()).toMatchObject({ anchor: word.to, head: loremRange.from })

		act(() => content.dispatchEvent(pointer("pointerup", at(lorem + 2))))
	})

	it("extends a triple-click drag by whole paragraphs", async () => {
		const { editor } = await pagedEditor(LONG)
		const { content } = await mount(editor)
		const box = editor.geometry.locate(paragraphStart(editor, 1) + 14)
		const next = editor.geometry.locate(paragraphStart(editor, 2) + 14)

		if (box === undefined || next === undefined) throw new Error("no caret")

		const press = clientPoint(editor, box.page, box.x + 0.5, box.top + box.height / 2)

		act(() => {
			for (let k = 0; k < 2; k++) {
				content.dispatchEvent(pointer("pointerdown", press))
				content.dispatchEvent(pointer("pointerup", press))
			}

			content.dispatchEvent(pointer("pointerdown", press))
		})

		const paragraph = editor.selection()

		act(() => content.dispatchEvent(pointer("pointermove", clientPoint(editor, next.page, next.x + 0.5, next.top + next.height / 2))))
		expect(editor.selection()).toMatchObject({
			anchor: paragraph.from,
			head: editor.geometry.paragraphRange(paragraphStart(editor, 2) + 14).to
		})
		act(() => content.dispatchEvent(pointer("pointerup", press)))
	})

	it("keeps the same spot of the same page at the top of the view when zoomed", async () => {
		const { editor } = await pagedEditor(LONG)
		const { pages } = await mount(editor)

		expect(editor.pageCount).toBeGreaterThanOrEqual(4)

		const page = (editor.page(0)?.height ?? 0) + GAP
		// A quarter down page 2.
		const top = GAP + 2 * page + (editor.page(2)?.height ?? 0) / 4

		pages.scrollTop = top
		act(() => pages.dispatchEvent(new Event("scroll")))
		await act(frame)

		await mount(editor, 2)
		expect(pages.scrollTop).toBeCloseTo(GAP + 2 * (2 * (page - GAP) + GAP) + (2 * (editor.page(2)?.height ?? 0)) / 4, 3)

		// The pages in view are those around page 2 at the new zoom.
		const shown = Array.from(container.querySelectorAll<HTMLElement>("[data-fo-page]"), element => Number(element.dataset["foPage"]))

		expect(shown).toContain(2)

		await mount(editor, 0.5)
		expect(pages.scrollTop).toBeCloseTo(GAP + 2 * (0.5 * (page - GAP) + GAP) + (0.5 * (editor.page(2)?.height ?? 0)) / 4, 3)
	})
})

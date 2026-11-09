import {
	OBJECT_INTS,
	ObjectKind,
	SECTION_SHIFT,
	SOURCE_INTS,
	SOURCE_MARK_FLOATS,
	SectionMark,
	SourceFlag,
	SourceInt,
	SourceMark
} from "../../../core/docx/layout/index"
import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS,
	LineFlag
} from "../../../core/text/index"
import type { DocxPageData } from "../../../dom/docx/protocol"
import type { DocxTables } from "../store"
import { cssOf, type LineLook, type PaintedLine, type PaintedPage } from "./page"

// Word's formatting marks (Home > Paragraph > Show/Hide ¶) over a painted page: the paragraph mark, spaces,
// non-breaking spaces, tabs, line breaks, page, column and section breaks, end-of-cell and end-of-row marks, hidden
// text and object anchors. Drawn in a layer of their own over the text, from the page's display list and the spans
// already painted (copied, their text made transparent), so nothing moves: the layout and the file are as they
// were. Each line's marks are kept with the line's look and reused while it looks the same.

// The words breaks are labelled with, as Word shows them.
export interface DocxMarkLabels {
	readonly pageBreak: string
	readonly columnBreak: string
	readonly sectionNextPage: string
	readonly sectionContinuous: string
	readonly sectionEvenPage: string
	readonly sectionOddPage: string
	readonly sectionNextColumn: string
}

export const DOCX_MARK_LABELS: DocxMarkLabels = {
	pageBreak: "Page Break",
	columnBreak: "Column Break",
	sectionNextPage: "Section Break (Next Page)",
	sectionContinuous: "Section Break (Continuous)",
	sectionEvenPage: "Section Break (Even Page)",
	sectionOddPage: "Section Break (Odd Page)",
	sectionNextColumn: "Section Break (Next Column)"
}

export function sameLabels(a: DocxMarkLabels, b: DocxMarkLabels): boolean {
	return (
		a.pageBreak === b.pageBreak &&
		a.columnBreak === b.columnBreak &&
		a.sectionNextPage === b.sectionNextPage &&
		a.sectionContinuous === b.sectionContinuous &&
		a.sectionEvenPage === b.sectionEvenPage &&
		a.sectionOddPage === b.sectionOddPage &&
		a.sectionNextColumn === b.sectionNextColumn
	)
}

// The label of a section break that starts the next section as `mark` does (SectionMark).
export function sectionLabel(labels: DocxMarkLabels, mark: number): string {
	switch (mark) {
		case SectionMark.CONTINUOUS:
			return labels.sectionContinuous
		case SectionMark.EVEN_PAGE:
			return labels.sectionEvenPage
		case SectionMark.ODD_PAGE:
			return labels.sectionOddPage
		case SectionMark.NEXT_COLUMN:
			return labels.sectionNextColumn
		default:
			return labels.sectionNextPage
	}
}

export const PARAGRAPH_MARK = "¶"
export const CELL_MARK = "¤"
export const SPACE_MARK = "·"
export const NBSP_MARK = "°"
export const TAB_MARK = "→"
export const LINE_BREAK_MARK = "↵"

const MAX_PX = 1e6
// Room between a cell's or row's edge and its end mark, and the anchor's place left of its paragraph (px).
const ROW_GAP = 2
const ANCHOR_SIZE = 11
const ANCHOR_GAP = 4
// An anchor (Word's object anchor), in a 16 × 16 box.
const ANCHOR_PATH = "M8 1.5a1.75 1.75 0 1 1 0 3.5a1.75 1.75 0 0 1 0-3.5ZM8 5v9.5M5 7.5h6M2.5 9.5a5.5 5.5 0 0 0 11 0"
const SVG = "http://www.w3.org/2000/svg"
// After a style's declarations: marks are drawn in the marks' colour, without the run's effects.
const MARK_PAINT =
	"color:var(--fo-docx-marks,#7f7f7f);-webkit-text-fill-color:currentColor;-webkit-text-stroke:0;text-shadow:none;text-emphasis:none;background:none;"

function px(value: number | undefined): number {
	const v = value ?? 0

	return Number.isFinite(v) ? Math.max(-MAX_PX, Math.min(MAX_PX, Math.round(v * 100) / 100)) : 0
}

interface KeptMarks {
	readonly labels: DocxMarkLabels
	readonly element: HTMLElement | null
}

// Each painted line's marks, by its look (kept lines keep their look object: their marks stay too).
const kept = new WeakMap<LineLook, KeptMarks>()

export interface PageMarksContext {
	readonly document: Document
	readonly tables: DocxTables
	readonly labels: DocxMarkLabels
}

// The marks of one painted page, in `layer` (emptied first when given): line groups reused from earlier paints of
// the same lines, the anchors drawn anew.
export function paintMarks(painted: PaintedPage, context: PageMarksContext, layer?: HTMLElement): HTMLElement {
	const { document } = context
	const root = layer ?? document.createElement("div")
	const page = painted.page
	const children: Node[] = []

	root.className = "fo-docx-layer fo-docx-marks"
	root.setAttribute("aria-hidden", "true")

	for (let line = 0; line < painted.lines.length; line++) {
		const shown = painted.lines[line]

		if (shown === undefined) continue

		let marks = kept.get(shown.look)

		if (marks?.labels !== context.labels) {
			marks = { labels: context.labels, element: lineMarks(page, line, shown, context) }
			kept.set(shown.look, marks)
		}

		const element = marks.element

		if (element === null) continue

		const top = `${px(shown.top)}px`

		if (element.style.top !== top) element.style.top = top
		if (element.style.transform !== shown.turn) {
			element.style.transform = shown.turn
			element.style.transformOrigin = shown.turn === "" ? "" : "0 0"
		}

		children.push(element)
	}

	for (const anchor of anchors(page, document)) children.push(anchor)

	root.replaceChildren(...children)

	return root
}

// The marks of line `line` (null: none), positioned in a group at the line's top.
function lineMarks(page: DocxPageData, line: number, shown: PaintedLine, context: PageMarksContext): HTMLElement | null {
	const { document, tables, labels } = context
	const lf = line * LINE_FLOATS
	const li = line * LINE_INTS
	const lineTop = page.lineFloats[lf] ?? 0
	const height = page.lineFloats[lf + 1] ?? 0
	const baseline = (page.lineFloats[lf + 2] ?? 0) - lineTop
	const lineX = page.lineFloats[lf + 3] ?? 0
	const lineWidth = page.lineFloats[lf + 4] ?? 0
	const first = page.lineInts[li] ?? 0
	const count = page.lineInts[li + 1] ?? 0
	const flags = page.lineInts[li + 4] ?? 0
	const source = page.lineInts[li + 5] ?? -1
	const sourceFlags = page.sourceInts[source * SOURCE_INTS + SourceInt.FLAGS] ?? 0
	const at = source * SOURCE_MARK_FLOATS
	const start = page.sourceMarks?.[at + SourceMark.START] ?? Number.NaN
	const end = page.sourceMarks?.[at + SourceMark.END] ?? Number.NaN
	const markStyle = page.sourceMarks?.[at + SourceMark.STYLE] ?? Number.NaN
	const row = page.sourceMarks?.[at + SourceMark.ROW] ?? Number.NaN
	const rtl = (flags & LineFlag.RTL) !== 0
	const group = document.createElement("div")
	// The style of the line's last text (marks after it are drawn in it, as Word draws them in the run's font).
	let lastStyle = -1

	group.className = "fo-docx-line"

	for (let k = first; k < first + count; k++) {
		const ff = k * FRAGMENT_FLOATS
		const fi = k * FRAGMENT_INTS
		const from = page.fragmentInts[fi] ?? 0
		const to = page.fragmentInts[fi + 1] ?? 0
		const styleIndex = page.fragmentInts[fi + 2] ?? -1
		const kind = (page.fragmentInts[fi + 3] ?? 0) & FRAGMENT_KIND_MASK

		if (kind === FragmentKind.OBJECT || to <= from) continue

		lastStyle = styleIndex

		const style = tables.styles[styleIndex]

		if (kind === FragmentKind.TAB) {
			const css = cssOf(style)
			const x = page.fragmentFloats[ff] ?? 0
			const width = page.fragmentFloats[ff + 1] ?? 0
			const arrow = glyph(document, "fo-docx-mark-tab", TAB_MARK, css.base, x, baseline - css.shift - css.ascent)

			arrow.style.width = `${px(width)}px`
			group.appendChild(arrow)

			continue
		}

		const painted = shown.texts.find(text => text.start === from && text.end === to)

		if (painted === undefined) continue

		const copy = textCopy(document, painted.element, style?.hidden === true ? cssOf(style).color : undefined)

		if (copy !== undefined) group.appendChild(copy)
	}

	const style =
		tables.styles[Number.isNaN(markStyle) || (flags & LineFlag.LAST) === 0 ? lastStyle : markStyle] ?? tables.styles[lastStyle]
	const css = cssOf(style)
	const glyphTop = baseline - css.shift - css.ascent
	// Where marks after the line's text start: at its end, on the left of right-to-left text.
	const after = rtl ? lineX : lineX + lineWidth
	const section = (sourceFlags & SourceFlag.SECTION_MASK) >> SECTION_SHIFT

	if ((flags & (LineFlag.PAGE_BREAK | LineFlag.COLUMN_BREAK)) !== 0) {
		const label = (flags & LineFlag.PAGE_BREAK) !== 0 ? labels.pageBreak : labels.columnBreak

		group.appendChild(rule(document, "fo-docx-mark-break", label, after, start, end, rtl, height, css.base))
	} else if ((flags & LineFlag.LINE_BREAK) !== 0) {
		group.appendChild(trailing(document, LINE_BREAK_MARK, css.base, after, glyphTop, rtl))
	}

	if ((flags & LineFlag.LAST) !== 0) {
		if (section !== 0) {
			group.appendChild(
				rule(document, "fo-docx-mark-section", sectionLabel(labels, section), after, start, end, rtl, height, css.base)
			)
		} else if ((flags & (LineFlag.PAGE_BREAK | LineFlag.COLUMN_BREAK)) === 0) {
			const mark = (sourceFlags & SourceFlag.CELL_END) !== 0 ? CELL_MARK : PARAGRAPH_MARK

			group.appendChild(trailing(document, mark, css.base, after, glyphTop, rtl))
		}
	}

	// A row's end mark beside the first line of its last cell, past the row's edge.
	if ((sourceFlags & SourceFlag.ROW_END) !== 0 && (flags & LineFlag.FIRST) !== 0 && !Number.isNaN(row)) {
		const left = !Number.isNaN(start) && row <= start

		group.appendChild(trailing(document, CELL_MARK, css.base, left ? row - ROW_GAP : row + ROW_GAP, glyphTop, left))
	}

	return group.firstChild === null ? null : group
}

// A mark glyph at (x, top) of its line, in a style's font.
function glyph(document: Document, className: string, text: string, base: string, x: number, top: number): HTMLElement {
	const element = document.createElement("span")

	element.className = `fo-docx-mark ${className}`
	element.style.cssText = `${base}${MARK_PAINT}left:${px(x)}px;top:${px(top)}px;`
	element.textContent = text

	return element
}

// A mark after the line's text (left of `x` when `before`).
function trailing(document: Document, text: string, base: string, x: number, top: number, before: boolean): HTMLElement {
	const element = glyph(document, "fo-docx-mark-end", text, base, x, top)

	if (before) element.dataset["foBefore"] = ""

	return element
}

// A break's labelled dotted rule from the line's text to its area's edge (the start edge for right-to-left text).
function rule(
	document: Document,
	className: string,
	label: string,
	from: number,
	start: number,
	end: number,
	rtl: boolean,
	height: number,
	base: string
): HTMLElement {
	const left = rtl ? (Number.isNaN(start) ? from : Math.min(start, from)) : from
	const right = rtl ? from : Number.isNaN(end) ? from : Math.max(end, from)
	const element = document.createElement("span")
	const text = document.createElement("span")

	element.className = `fo-docx-mark fo-docx-mark-rule ${className}`
	element.style.cssText = `${base}${MARK_PAINT}left:${px(left)}px;top:0;width:${px(right - left)}px;height:${px(height)}px;line-height:${px(height)}px;`
	text.className = "fo-docx-mark-label"
	text.textContent = label
	element.appendChild(text)

	return element
}

const SPACE = 0x20
const IDEOGRAPHIC_SPACE = 0x3000
const NBSP = 0xa0
const NARROW_NBSP = 0x202f

function isMarkedSpace(code: number): boolean {
	return code === SPACE || code === IDEOGRAPHIC_SPACE || code === NBSP || code === NARROW_NBSP
}

// A copy of a painted text span with its text transparent, its spaces and non-breaking spaces marked, and a hidden
// run's dotted underline in `hidden` (its colour); undefined when there is nothing to mark.
function textCopy(document: Document, span: HTMLElement, hidden: string | undefined): HTMLElement | undefined {
	const text = span.textContent

	let spaces = false

	for (let k = 0; k < text.length && !spaces; k++) spaces = isMarkedSpace(text.charCodeAt(k))

	if (!spaces && hidden === undefined) return undefined

	const copy = span.cloneNode(true) as HTMLElement

	copy.classList.add("fo-docx-mark-copy")
	copy.style.color = "transparent"

	if (hidden !== undefined) {
		copy.dataset["foHidden"] = ""
		copy.style.setProperty("--fo-docx-hidden-color", hidden)
	}

	for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
		element.removeAttribute("tabindex")
		element.removeAttribute("role")
		element.removeAttribute("title")
		delete element.dataset["foLink"]
	}

	if (!spaces) return copy

	const walker = document.createTreeWalker(copy, 4)
	const nodes: Text[] = []

	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text)

	for (const node of nodes) markSpaces(document, node)

	return copy
}

// Wraps every space of `node` in a span the mark is drawn on.
function markSpaces(document: Document, node: Text): void {
	const value = node.data
	const parent = node.parentNode

	if (parent === null) return

	let from = 0
	let found = false

	for (let k = 0; k < value.length; k++) {
		const code = value.charCodeAt(k)

		if (!isMarkedSpace(code)) continue

		found = true

		if (k > from) parent.insertBefore(document.createTextNode(value.slice(from, k)), node)

		const space = document.createElement("span")

		space.className = code === NBSP || code === NARROW_NBSP ? "fo-docx-mark-nbsp" : "fo-docx-mark-space"
		space.textContent = value[k] ?? " "
		parent.insertBefore(space, node)
		from = k + 1
	}

	if (!found) return

	if (from < value.length) node.data = value.slice(from)
	else node.remove()
}

// Anchors of the page's floating objects, left of the first line their paragraph has on the page.
function anchors(page: DocxPageData, document: Document): HTMLElement[] {
	if (page.objectCount === 0) return []

	const inline = new Set<number>()

	for (let k = 0; k < page.fragmentCount; k++) {
		const fi = k * FRAGMENT_INTS

		if (((page.fragmentInts[fi + 3] ?? 0) & FRAGMENT_KIND_MASK) === FragmentKind.OBJECT) inline.add(page.fragmentInts[fi + 4] ?? -1)
	}

	const out: HTMLElement[] = []
	const done = new Set<number>()

	for (let o = 0; o < page.objectCount; o++) {
		const id = page.objectInts[o * OBJECT_INTS] ?? -1
		const source = page.objectInts[o * OBJECT_INTS + 2] ?? -1
		const kind = page.objectKinds[o] ?? 0

		if (source < 0 || inline.has(id) || done.has(source) || (kind !== ObjectKind.DRAWING && kind !== ObjectKind.VML)) continue

		let line = 0

		while (line < page.lineCount && page.lineInts[line * LINE_INTS + 5] !== source) line++

		if (line >= page.lineCount) continue

		done.add(source)

		const start = page.sourceMarks?.[source * SOURCE_MARK_FLOATS + SourceMark.START] ?? Number.NaN
		const x = (Number.isNaN(start) ? (page.lineFloats[line * LINE_FLOATS + 3] ?? 0) : start) - ANCHOR_SIZE - ANCHOR_GAP
		const element = document.createElement("span")
		const svg = document.createElementNS(SVG, "svg")
		const path = document.createElementNS(SVG, "path")

		element.className = "fo-docx-mark fo-docx-mark-anchor"
		element.style.cssText = `left:${px(x)}px;top:${px(page.lineFloats[line * LINE_FLOATS] ?? 0)}px;width:${ANCHOR_SIZE}px;height:${ANCHOR_SIZE}px;`
		svg.setAttribute("viewBox", "0 0 16 16")
		path.setAttribute("d", ANCHOR_PATH)
		svg.appendChild(path)
		element.appendChild(svg)
		out.push(element)
	}

	return out
}

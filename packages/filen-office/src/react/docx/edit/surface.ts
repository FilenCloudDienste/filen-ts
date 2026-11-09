import type { Node } from "prosemirror-model"
import { Region, type PageDisplayList } from "../../../core/docx/layout/index"
import { MarkBoxes, type CaretBox, type PagedEditor, type PageRect } from "../../../core/docx/paged/index"
import type { DocxPageData, DocxSessionApi } from "../../../dom/docx/protocol"
import type { DocxMediaCache } from "../media"
import { paintObjects } from "../paint/objects"
import { paintMarks, sameLabels, type DocxMarkLabels } from "../paint/marks"
import { paintPage, patchPage, type PaintedPage } from "../paint/page"
import type { DocxTables } from "../store"

// The formatting marks layer of each painted page's root (a page painted anew gets a new root, and a new layer).
const MARKS_LAYERS = new WeakMap<HTMLElement, HTMLElement>()

// Draws the pages of a paged editor: each mounted page is painted from its display list and, when laid out
// again, patched line by line; above it a layer with the caret, the selection, the text being composed and
// marks from outside (spelling). Structure and data-* attributes only; the look is --fo-* variables.

// A range to mark on the pages (a spelling mistake, a search result) and what kind of mark it is.
export interface DocxEditorMark {
	readonly from: number
	readonly to: number
	readonly kind: string
}

interface MountedPage {
	readonly host: HTMLElement
	readonly layer: HTMLElement
	// Inside the layer, in drawing order: the dimmed body, the marks, selection and composition, the caret.
	readonly under: HTMLElement
	readonly marks: HTMLElement
	readonly over: HTMLElement
	readonly caret: HTMLElement
	// What the marks were last drawn from (redrawn only when one of these changed), the drawings that hold
	// them (made when first needed) and the rows drawn, found by what they show: a redraw keeps the rows that
	// did not change (typing changes the line typed in) and moves those that only moved.
	drawn: { page: PageDisplayList | undefined; doc: Node | undefined; marks: readonly DocxEditorMark[]; story: number }
	// The marks drawn on the page, relative to its first position, and their kinds (from, to, kind id per
	// mark): an edit elsewhere moves them all alike and changes nothing drawn.
	shown: { values: Int32Array; count: number }
	drawings: { plain: SVGSVGElement | undefined; blend: SVGSVGElement | undefined }
	rows: MarkRow[]
	// Rows by the hash of what they show (rows with the same hash are chained).
	rowsByHash: Map<number, MarkRow>
	painted: PaintedPage | undefined
	release: () => void
	signal: { aborted: boolean }
}

// The marks of one kind on one line of a page: one path in the page's drawing, in line coordinates, moved
// as a whole when the line moves. A page with a thousand marks is a path per line, and a keystroke changes the
// path of the line typed in.
interface MarkRow {
	readonly element: SVGPathElement
	// Its kind (id), line height and boxes (left, width pairs), and their hash: equal content draws the same.
	content: Float64Array
	hash: number
	top: number
	// The redraw that last drew it.
	drawn: number
	// The next row with the same hash.
	next: MarkRow | undefined
}

const SVG = "http://www.w3.org/2000/svg"
// Mark kinds drawn as highlights over the text: they multiply with it, in a drawing of their own.
const BLENDED = new Set(["find", "find-active"])
// A misspelling's wave: half-waves this wide, peaks this far from the line's bottom.
const WAVE = 3
const WAVE_TOP = 2.25
const WAVE_BOTTOM = 0.25

// Small numbers for mark kinds, as they are first seen (row contents hold them).
const KIND_IDS = new Map<string, number>()
const KIND_NAMES: string[] = [""]

function kindId(kind: string): number {
	let id = KIND_IDS.get(kind)

	if (id === undefined) {
		id = KIND_NAMES.length
		KIND_IDS.set(kind, id)
		KIND_NAMES.push(kind)
	}

	return id
}

// The path of a line's marks of `kind` (line coordinates: 0 is the line's top), its boxes the (left, width)
// pairs of `boxes` from `start`: a wave under a misspelling, a double line under a repeated word, a box over
// a find result, a dotted line under anything else.
function markPath(kind: string, height: number, boxes: Float64Array, start: number, end: number): string {
	let d = ""

	for (let b = start; b + 1 < end; b += 2) {
		const x = boxes[b] ?? 0
		const width = boxes[b + 1] ?? 0

		if (kind === "spelling") {
			const waves = Math.max(1, Math.round(width / WAVE))
			const middle = height - (WAVE_TOP + WAVE_BOTTOM) / 2
			// A quadratic's extreme lies halfway to its control point.
			const lift = WAVE_TOP - WAVE_BOTTOM

			d += `M${round(x)} ${round(middle)}q${WAVE / 2} ${-lift} ${WAVE} 0${`t${WAVE} 0`.repeat(waves - 1)}`
		} else if (kind === "repeated") {
			d += `M${round(x)} ${round(height - 0.5)}h${round(width)}M${round(x)} ${round(height - 2.5)}h${round(width)}`
		} else if (BLENDED.has(kind)) {
			d += `M${round(x)} 0h${round(width)}v${round(height)}h${round(-width)}z`
		} else {
			d += `M${round(x)} ${round(height - 1)}h${round(width)}`
		}
	}

	return d
}

export interface SurfaceSources {
	readonly session: DocxSessionApi
	readonly media: DocxMediaCache
	readonly tables: DocxTables
}

export class EditSurface {
	private readonly editor: PagedEditor
	private readonly mounted = new Map<number, MountedPage>()
	private sources: SurfaceSources | undefined = undefined
	private pages: readonly (DocxPageData | undefined)[] = []
	// As given, and sorted by `from` (the longest's length bounds where a line's marks start), for the
	// document `orderedFor`.
	private given: readonly DocxEditorMark[] = []
	private marks: readonly DocxEditorMark[] = []
	private orderedFor: Node | undefined = undefined
	private longestMark = 0
	// The labels formatting marks are shown with, undefined while they are hidden.
	private markLabels: DocxMarkLabels | undefined = undefined
	private focused = false
	private caretPage: { index: number; box: CaretBox } | undefined = undefined
	// One caret element, moved rather than made again: its blink runs on the compositor, and a new one each
	// keystroke would change the page's layers (a costly commit on a page with many marks).
	private caretElement: HTMLElement | undefined = undefined
	private caretStyle = ""
	// Reused from page to page and keystroke to keystroke (thousands of numbers each).
	private readonly boxes = new MarkBoxes()
	// The content of a row being matched (kind id, height, then left and width per box).
	private content = new Float64Array(64)
	// Rows to draw anew in this redraw: first box, end and kind id of each.
	private added = new Int32Array(48)
	private redraws = 0
	private blinkPhase = false

	constructor(editor: PagedEditor) {
		this.editor = editor
	}

	mount(index: number, host: HTMLElement, layer: HTMLElement): void {
		this.unmount(index)

		const document = layer.ownerDocument
		const under = document.createElement("div")
		const marks = document.createElement("div")
		const over = document.createElement("div")
		const caret = document.createElement("div")

		layer.replaceChildren(under, marks, over, caret)
		this.mounted.set(index, {
			host,
			layer,
			under,
			marks,
			over,
			caret,
			drawn: { page: undefined, doc: undefined, marks: [], story: -1 },
			shown: { values: new Int32Array(0), count: 0 },
			drawings: { plain: undefined, blend: undefined },
			rows: [],
			rowsByHash: new Map(),
			painted: undefined,
			release: () => undefined,
			signal: { aborted: false }
		})
		this.paint(index)
		this.drawPage(index)
	}

	unmount(index: number): void {
		const page = this.mounted.get(index)

		if (page === undefined) return

		page.signal.aborted = true
		page.release()
		page.host.replaceChildren()
		page.layer.replaceChildren()
		this.mounted.delete(index)
	}

	dispose(): void {
		for (const index of [...this.mounted.keys()]) this.unmount(index)
	}

	// The renderer's page data and tables; mounted pages whose data changed are patched. Whether any was.
	update(pages: readonly (DocxPageData | undefined)[], sources: SurfaceSources): boolean {
		let repainted = false

		this.pages = pages
		this.sources = sources

		for (const index of this.mounted.keys()) if (this.paint(index)) repainted = true

		return repainted
	}

	// Whether the marks changed (draw() shows them).
	setMarks(marks: readonly DocxEditorMark[]): boolean {
		if (this.given === marks) return false

		this.given = marks
		this.order()

		return true
	}

	// The marks given, in order of `from`, and the longest's length. Marks may be moved in place by edits (a
	// spelling checker's are): ordered again for each document drawn.
	private order(): void {
		const marks = this.given
		let sorted = true
		let longest = 0

		this.orderedFor = this.editor.geometry.story.document

		for (let k = 0; k < marks.length; k++) {
			const mark = marks[k]

			if (mark === undefined) continue

			longest = Math.max(longest, mark.to - mark.from)

			if (k > 0 && (marks[k - 1]?.from ?? 0) > mark.from) sorted = false
		}

		this.marks = sorted ? marks : [...marks].sort((a, b) => a.from - b.from)
		this.longestMark = longest
	}

	setFocused(focused: boolean): boolean {
		if (this.focused === focused) return false

		this.focused = focused

		return true
	}

	private paint(index: number): boolean {
		const mounted = this.mounted.get(index)
		const page = this.pages[index]
		const sources = this.sources

		if (mounted === undefined || page === undefined || sources === undefined || mounted.painted?.page === page) return false

		const context = { document: mounted.host.ownerDocument, tables: sources.tables }
		let objectsChanged = true

		if (mounted.painted === undefined || mounted.painted.page.index !== page.index) {
			const painted = paintPage(page, context)

			mounted.host.replaceChildren(painted.root)
			mounted.painted = painted
		} else {
			const patched = patchPage(mounted.painted, page, context)

			mounted.painted = patched.painted
			objectsChanged = patched.objectsChanged
		}

		this.paintFormattingMarks(mounted.painted)

		if (objectsChanged) {
			mounted.signal.aborted = true
			mounted.release()

			const signal = { aborted: false }

			mounted.signal = signal
			mounted.release = paintObjects(mounted.painted.objects, {
				document: mounted.host.ownerDocument,
				session: sources.session,
				media: sources.media,
				signal
			})
		}

		return true
	}

	// Formatting marks shown with these labels (Show/Hide ¶), or none (undefined). Whether that changed.
	setFormattingMarks(labels: DocxMarkLabels | undefined): boolean {
		if (labels === this.markLabels || (labels !== undefined && this.markLabels !== undefined && sameLabels(labels, this.markLabels)))
			return false

		this.markLabels = labels

		for (const mounted of this.mounted.values()) if (mounted.painted !== undefined) this.paintFormattingMarks(mounted.painted)

		return true
	}

	// The marks layer of a painted page brought to what it shows now (taken away while marks are hidden).
	private paintFormattingMarks(painted: PaintedPage): void {
		const sources = this.sources
		const root = painted.root
		const layer = MARKS_LAYERS.get(root)

		if (this.markLabels === undefined || sources === undefined) {
			layer?.remove()

			return
		}

		const next = paintMarks(painted, { document: root.ownerDocument, tables: sources.tables, labels: this.markLabels }, layer)

		if (next.parentNode !== root) root.appendChild(next)

		MARKS_LAYERS.set(root, next)
	}

	// ---- overlays -----------------------------------------------------------------------------------------

	// Redraws caret, selection, composition and marks on every mounted page.
	draw(): void {
		if (this.orderedFor !== this.editor.geometry.story.document) this.order()

		this.caretPage = undefined

		const caret = this.editor.selection().empty ? this.editor.caret() : undefined

		if (caret !== undefined) this.caretPage = { index: caret.page, box: caret }

		for (const index of this.mounted.keys()) this.drawPage(index)
	}

	private drawPage(index: number): void {
		const mounted = this.mounted.get(index)

		if (mounted === undefined) return

		const document = mounted.layer.ownerDocument
		const editor = this.editor
		const selection = editor.selection()

		// Editing a header or footer: the body is shown dimmed (a note is edited beside the body, as in Word).
		const region = editor.activeRegion
		const band = region === Region.HEADER || region === Region.FOOTER ? editor.bodyBand(index) : undefined
		const shown = band === undefined ? undefined : editor.page(index)

		if (band !== undefined && shown !== undefined) {
			mounted.under.replaceChildren(
				rectElement(document, "fo-docx-dim", { page: index, x: 0, y: band.top, width: shown.width, height: band.bottom - band.top })
			)
		} else if (mounted.under.firstChild !== null) {
			mounted.under.replaceChildren()
		}

		this.drawMarks(index, mounted)

		const fragment = document.createDocumentFragment()

		if (!selection.empty) {
			for (const rect of editor.selectionRects(index)) fragment.appendChild(rectElement(document, "fo-docx-selection", rect))
		}

		const composition = editor.composition

		if (composition !== undefined && composition.to > composition.from) {
			for (const rect of editor.rangeRects(composition.from, composition.to, index))
				fragment.appendChild(rectElement(document, "fo-docx-composition", rect))
		}

		mounted.over.replaceChildren(fragment)

		const caret = this.caretPage

		if (caret !== undefined && caret.index === index) this.placeCaret(mounted, caret.box, composition !== undefined)
		else if (this.caretElement !== undefined && this.caretElement.parentNode === mounted.caret) this.caretElement.remove()
	}

	private placeCaret(mounted: MountedPage, box: CaretBox, composing: boolean): void {
		let element = this.caretElement

		if (element === undefined) {
			element = mounted.layer.ownerDocument.createElement("div")
			element.className = "fo-docx-caret"
			this.caretElement = element
		}

		if (element.parentNode !== mounted.caret) mounted.caret.appendChild(element)

		// In sideways text the caret lies across the page.
		const style =
			box.turn === undefined
				? `left:${round(box.x)}px;top:${round(box.top)}px;height:${round(box.height)}px;`
				: `left:${round(box.x)}px;top:${round(box.top)}px;width:${round(box.width ?? 0)}px;height:var(--fo-caret-width, 1.5px);margin-left:0;margin-top:calc(var(--fo-caret-width, 1.5px) / -2);`

		if (style !== this.caretStyle) {
			element.style.cssText = style
			this.caretStyle = style
			// A caret that moved shows at once: its blink starts over, by switching between two equal animations
			// (restarting one through getAnimations() would make the browser style the page there and then).
			this.blinkPhase = !this.blinkPhase
		}

		const blink = this.focused ? (this.blinkPhase ? "b" : "a") : undefined

		if (element.dataset["foBlink"] !== blink) {
			if (blink === undefined) delete element.dataset["foBlink"]
			else element.dataset["foBlink"] = blink
		}

		setFlag(element, "foComposing", composing)
	}

	// The marks within the positions the page shows, all boxes found in one pass over its lines, drawn as a
	// path per line and kind. Only when the page, the document or the marks changed; paths that show what they
	// showed are kept (moved when their line moved), so a keystroke touches the path of the line typed in.
	private drawMarks(index: number, mounted: MountedPage): void {
		const geometry = this.editor.geometry
		const page = geometry.pages.page(index)
		const doc = geometry.story.document
		const story = this.editor.activeStory
		const drawn = mounted.drawn

		if (drawn.page === page && drawn.doc === doc && drawn.marks === this.marks && drawn.story === story) return

		const samePage = drawn.page === page && drawn.story === story

		drawn.page = page
		drawn.doc = doc
		drawn.marks = this.marks
		drawn.story = story

		// The same layout of the page with the same marks on it, only moved (an edit on another page): as drawn.
		if (samePage && this.sameMarksShown(index, mounted.shown)) return

		const marks = this.marks
		const boxes = this.boxes

		boxes.clear()
		geometry.rangesBoxes(marks, this.longestMark, index, boxes)
		this.recordMarksShown(index, mounted.shown)

		// Boxes come line by line: the boxes of one top, one row per kind. Rows showing what they showed are kept
		// (moved when their line moved); the rest are drawn anew below.
		const redraw = ++this.redraws
		const values = boxes.values
		const owners = boxes.owners
		const count = boxes.count
		let added = 0

		for (let first = 0; first < count;) {
			const top = values[4 * first] ?? 0
			const height = values[4 * first + 1] ?? 0
			let end = first + 1

			while (end < count && values[4 * end] === top && values[4 * end + 1] === height) end++

			for (let k = first; k < end; k++) {
				const kind = kindId(marks[owners[k] ?? -1]?.kind ?? "")
				let seen = false

				for (let other = first; other < k && !seen; other++) seen = kindId(marks[owners[other] ?? -1]?.kind ?? "") === kind

				if (seen) continue

				const size = this.rowContent(first, end, kind, height)
				const row = this.keptRow(mounted, hashOf(this.content, size), size, top, redraw)

				if (row !== undefined) {
					if (row.top !== top) {
						row.top = top
						row.element.setAttribute("transform", `translate(0 ${round(top)})`)
					}

					continue
				}

				if (3 * added + 3 > this.added.length) {
					const grown = new Int32Array(this.added.length * 2)

					grown.set(this.added)
					this.added = grown
				}

				this.added[3 * added] = first
				this.added[3 * added + 1] = end
				this.added[3 * added + 2] = kind
				added++
			}

			first = end
		}

		// Rows not kept are drawn again for the new ones (in the drawing of their kind), the rest removed.
		const rows = mounted.rows
		let spare = 0

		for (let k = 0; k < rows.length; k++) {
			const row = rows[k]

			if (row === undefined) continue

			if (row.drawn === redraw) {
				rows[k] = rows[spare] as MarkRow
				rows[spare++] = row
			}
		}

		// rows[0, spare) are kept, rows[spare, ...) are free.
		let free = spare

		for (let a = 0; a < added; a++) {
			const first = this.added[3 * a] ?? 0
			const end = this.added[3 * a + 1] ?? 0
			const kind = this.added[3 * a + 2] ?? 0
			const top = values[4 * first] ?? 0
			const height = values[4 * first + 1] ?? 0
			const size = this.rowContent(first, end, kind, height)
			const name = KIND_NAMES[kind] ?? ""
			const drawing = this.drawing(index, mounted, BLENDED.has(name))
			let row = rows[free]

			if (row === undefined) {
				const element = drawing.ownerDocument.createElementNS(SVG, "path")

				element.setAttribute("class", "fo-docx-mark")
				row = { element, content: new Float64Array(0), hash: 0, top: Number.NaN, drawn: 0, next: undefined }
				rows.push(row)
			} else {
				unlinkRow(mounted.rowsByHash, row)
			}

			free++
			row.content = this.content.slice(0, size)
			row.hash = hashOf(row.content, size)
			row.drawn = redraw
			row.next = mounted.rowsByHash.get(row.hash)
			mounted.rowsByHash.set(row.hash, row)

			if (row.element.parentNode !== drawing) drawing.appendChild(row.element)
			if (row.element.getAttribute("data-fo-mark") !== name) row.element.setAttribute("data-fo-mark", name)

			row.element.setAttribute("d", markPath(name, height, row.content, 2, size))

			if (row.top !== top) row.element.setAttribute("transform", `translate(0 ${round(top)})`)

			row.top = top
		}

		for (let k = free; k < rows.length; k++) {
			const row = rows[k]

			if (row === undefined) continue

			unlinkRow(mounted.rowsByHash, row)
			row.element.remove()
		}

		rows.length = free
	}

	// Writes the content of the row of kind `kind` on the line whose boxes are [first, end) of this.boxes into
	// this.content: kind id, line height, then left and width of each box of the kind. Returns its size.
	private rowContent(first: number, end: number, kind: number, height: number): number {
		const values = this.boxes.values
		const owners = this.boxes.owners
		const marks = this.marks
		const needed = 2 + 2 * (end - first)

		if (this.content.length < needed) this.content = new Float64Array(Math.max(needed, this.content.length * 2))

		const content = this.content
		let size = 0

		content[size++] = kind
		content[size++] = round(height)

		for (let k = first; k < end; k++) {
			if (kindId(marks[owners[k] ?? -1]?.kind ?? "") !== kind) continue

			content[size++] = round(values[4 * k + 2] ?? 0)
			content[size++] = round(values[4 * k + 3] ?? 0)
		}

		return size
	}

	// A row of the page drawn before showing the first `size` numbers of this.content and not kept yet in
	// this redraw (the one at `top`, else any), now kept; undefined when there is none.
	private keptRow(mounted: MountedPage, hash: number, size: number, top: number, redraw: number): MarkRow | undefined {
		let found: MarkRow | undefined

		for (let row = mounted.rowsByHash.get(hash); row !== undefined; row = row.next) {
			if (row.drawn === redraw || !sameContent(row.content, this.content, size)) continue

			if (found === undefined || Math.abs(row.top - top) < Math.abs(found.top - top)) found = row

			if (row.top === top) break
		}

		if (found !== undefined) found.drawn = redraw

		return found
	}

	// The marks that may show on page `index` (those within its positions), each from and to relative to its
	// first position.
	private eachMarkShown(index: number, visit: (from: number, to: number, kind: string) => boolean): void {
		const range = this.editor.geometry.pageRange(index)

		if (range === undefined) return

		const marks = this.marks
		let low = 0
		let high = marks.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((marks[middle]?.from ?? 0) < range.from - this.longestMark) low = middle + 1
			else high = middle
		}

		for (let k = low; k < marks.length; k++) {
			const mark = marks[k]

			if (mark === undefined || mark.from > range.to) break
			if (mark.to < range.from) continue
			if (!visit(mark.from - range.from, mark.to - range.from, mark.kind)) return
		}
	}

	private sameMarksShown(index: number, shown: { readonly values: Int32Array; readonly count: number }): boolean {
		let k = 0
		let same = true

		this.eachMarkShown(index, (from, to, kind) => {
			same =
				k < shown.count &&
				shown.values[3 * k] === from &&
				shown.values[3 * k + 1] === to &&
				shown.values[3 * k + 2] === kindId(kind)
			k++

			return same
		})

		return same && k === shown.count
	}

	private recordMarksShown(index: number, shown: { values: Int32Array; count: number }): void {
		shown.count = 0
		this.eachMarkShown(index, (from, to, kind) => {
			if (3 * shown.count + 3 > shown.values.length) {
				const grown = new Int32Array(Math.max(48, shown.values.length * 2))

				grown.set(shown.values)
				shown.values = grown
			}

			shown.values[3 * shown.count] = from
			shown.values[3 * shown.count + 1] = to
			shown.values[3 * shown.count + 2] = kindId(kind)
			shown.count++

			return true
		})
	}

	// The page's drawing for plain or blended marks, made when first needed and sized to the page.
	private drawing(index: number, mounted: MountedPage, blend: boolean): SVGSVGElement {
		const drawings = mounted.drawings
		const shown = this.editor.page(index)
		const width = shown?.width ?? 0
		const height = shown?.height ?? 0
		let drawing = blend ? drawings.blend : drawings.plain

		if (drawing === undefined) {
			drawing = mounted.layer.ownerDocument.createElementNS(SVG, "svg")
			drawing.setAttribute("class", "fo-docx-marks")
			drawing.setAttribute("aria-hidden", "true")

			if (blend) {
				drawing.setAttribute("data-fo-blend", "")
				drawings.blend = drawing
			} else {
				drawings.plain = drawing
			}

			// Plain marks under the highlights.
			if (blend) mounted.marks.appendChild(drawing)
			else mounted.marks.prepend(drawing)
		}

		if (drawing.getAttribute("width") !== String(round(width))) drawing.setAttribute("width", String(round(width)))
		if (drawing.getAttribute("height") !== String(round(height))) drawing.setAttribute("height", String(round(height)))

		return drawing
	}

	// The caret's box on its page as last drawn, or undefined when it is not drawn (a range is selected or
	// its page is not mounted).
	caret(): { readonly index: number; readonly box: CaretBox } | undefined {
		return this.caretPage === undefined || !this.mounted.has(this.caretPage.index) ? undefined : this.caretPage
	}

	isMounted(index: number): boolean {
		return this.mounted.has(index)
	}
}

function hashOf(content: Float64Array, size: number): number {
	let hash = 2166136261

	for (let k = 0; k < size; k++) hash = Math.imul(hash ^ ((content[k] ?? 0) * 100), 16777619)

	// A small integer: a key that allocates nothing.
	return hash & 0x3fffffff
}

function sameContent(a: Float64Array, b: Float64Array, size: number): boolean {
	if (a.length !== size) return false

	for (let k = 0; k < size; k++) if (a[k] !== b[k]) return false

	return true
}

function unlinkRow(rows: Map<number, MarkRow>, row: MarkRow): void {
	const head = rows.get(row.hash)

	if (head === row) {
		if (row.next === undefined) rows.delete(row.hash)
		else rows.set(row.hash, row.next)
	} else {
		for (let other = head; other !== undefined; other = other.next) {
			if (other.next === row) {
				other.next = row.next

				break
			}
		}
	}

	row.next = undefined
}

function round(value: number): number {
	return Math.round(value * 100) / 100
}

function setFlag(element: HTMLElement, name: string, on: boolean): void {
	if (on === (element.dataset[name] !== undefined)) return

	if (on) element.dataset[name] = ""
	else delete element.dataset[name]
}

function boxStyle(rect: PageRect): string {
	return `left:${round(rect.x)}px;top:${round(rect.y)}px;width:${round(rect.width)}px;height:${round(rect.height)}px;`
}

function rectElement(document: Document, className: string, rect: PageRect): HTMLElement {
	const element = document.createElement("div")

	element.className = className
	element.style.cssText = boxStyle(rect)

	return element
}

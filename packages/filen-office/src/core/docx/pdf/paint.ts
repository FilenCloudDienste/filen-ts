import { classifyLink } from "@filen/shared/linkPolicy"
import {
	SHAPE_CAPS,
	SHAPE_HYPHEN,
	SHAPE_SMALL_CAPS,
	type PdfFontFaceRequest,
	type PdfFontSet,
	type PdfGlyphRun,
	type PdfShapedText
} from "../../pdfwrite/fonts/index"
import {
	DECORATION_FLOATS,
	DECORATION_INTS,
	DecorationKind,
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FRAGMENT_LEVEL_SHIFT,
	FragmentFlag,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS,
	SMALL_CAPS_SCALE,
	TabLeader
} from "../../text/index"
import { symbolTable, symbolToUnicode } from "../../fonts/index"
import { GRAPHIC_FLOATS, GRAPHIC_INTS, Layer, OBJECT_FLOATS, OBJECT_INTS, PageGraphic } from "../layout/output"
import type { DecorationValue } from "../layout/styles"
import { paintDrawingPdf, pictureSource } from "../../drawingml/pdf"
import type { DrawingImage, Paint } from "../../drawingml/index"
import {
	PdfWriteError,
	type PdfGradient,
	type PdfImage,
	type PdfPage,
	type PdfStructOptions,
	type PdfTextOptions,
	type PdfTextRun,
	type PdfWriter
} from "../../pdfwrite/index"
import { mathText } from "./math"
import { mathLayout } from "../layout/math"
import type { MathElement } from "../../math/index"
import {
	PDF_CLIP_FLOATS,
	PDF_CLIP_INTS,
	PDF_LINK_INTS,
	type DocxPdfColumn,
	type DocxPdfDocument,
	type DocxPdfPage,
	type DocxPdfRole,
	type DocxPdfStyle
} from "./types"

// Paints one page of a laid-out document onto a PDF page, as the renderer draws it (react/docx/paint/page.ts):
// fills and graphics behind, the text, its lines over it, objects by layer. Coordinates are the display
// list's px; the page maps them onto points.
//
// Tagged output (ISO 14289-1): text is marked content of the paragraph's structure element (P, H1-H6, LBody
// of a list item, inside the table cells it sits in); fills, rules, borders, headers, footers and repeated
// header rows are artifacts. Elements end with the page: a paragraph continuing on the next page continues in
// a new element there.

// The middle of the ideographic em box (0.88 em above the baseline to 0.12 em below), em above the baseline.
const IDEOGRAPHIC_MIDDLE = 0.38

const BLACK = 0x000000ff
// Synthetic oblique for an upright face drawn as italic (about 12 degrees).
const FAUX_SHEAR = -0.21
const MAX_HEADING = 6

// Refused or approximated content, counted per kind for the export's report. shaping: text runs drawn without
// their font's layout tables (the font asked for more work than the shaping limits allow). untranslated: what the
// source file shows that the document laid out never held (an RTF's equations, shapes, form fields...).
export type DocxPdfRefusal = "image" | "placeholder" | "link" | "shaping" | "untranslated"

export interface PagePaintContext {
	readonly writer: PdfWriter
	readonly fonts: PdfFontSet
	readonly doc: DocxPdfDocument
	readonly requests: readonly PdfFontFaceRequest[]
	// Image bytes by part name, for the drawings' pictures.
	readonly media: ReadonlyMap<string, Uint8Array>
	// Keys of paragraphs drawn on earlier pages (repeated table header rows are drawn as artifacts).
	readonly seen: Set<string>
	// The last heading level tagged (headings never skip a level, ISO 14289-1 §7.4.2).
	heading: number
	readonly refused: Map<DocxPdfRefusal, number>
	readonly yieldIfDue: () => Promise<void>
}

// Glyphs of a fragment with where each goes: one entry per glyph across the runs, in visual order.
interface Placed {
	readonly run: PdfGlyphRun
	readonly index: number
	readonly size: number
	// px from the fragment's start (unscaled by scaleX), and the glyph's own advance with spacing.
	readonly x: number
	readonly width: number
	// Offset of the glyph's cluster in the fragment text.
	readonly cluster: number
}

interface OpenElement {
	readonly key: string
	readonly node: number
	// A table row: its cells' column spans, whether they are header cells, and the next cell not yet tagged.
	readonly row?: RowState
}

// A table row open on the page: its cells, whether they are header cells, its index and table, and the next cell
// not yet tagged.
interface RowState {
	readonly columns: readonly DocxPdfColumn[]
	readonly header: boolean
	readonly table: number
	readonly index: number
	next: number
}

interface WantedElement {
	readonly key: string
	readonly type: string
	readonly options: PdfStructOptions
	readonly row?: Omit<RowState, "next">
	// A cell: its index in its row.
	readonly cell?: number
}

// Paragraphs (sources), or the rows of a table they are in, in reading order; a row's cells by index.
interface SourceGroup {
	readonly items: (number | SourceGroup)[]
	readonly groups: Map<string, SourceGroup>
	// A cell: its index in its row (-1: not a cell).
	readonly cell: number
	// A row: its table and index (-1: not a row).
	readonly table: number
	readonly row: number
}

function sourceGroup(cell: number, table = -1, row = -1): SourceGroup {
	return { items: [], groups: new Map(), cell, table, row }
}

// A table row's content in the order of its cells (each cell's paragraphs together, in their own order), the
// rest as laid out: a cell's paragraph laid out after the next cells' then goes into the same TD, so every row
// has as many cells as its table (ISO 14289-1 §7.5).
export function cellOrder(order: readonly number[], roleOf: (source: number) => DocxPdfRole): readonly number[] {
	if (!order.some(source => roleOf(source).cells.length > 0)) return order

	const root = sourceGroup(-1)
	const child = (parent: SourceGroup, key: string, cell: number, table = -1, row = -1): SourceGroup => {
		let group = parent.groups.get(key)

		if (group === undefined) {
			group = sourceGroup(cell, table, row)
			parent.groups.set(key, group)
			parent.items.push(group)
		}

		return group
	}

	for (const source of order) {
		let group = root

		for (const cell of roleOf(source).cells) {
			const row = child(group, `${String(cell.table)}:${String(cell.row)}`, -1, cell.table, cell.row)

			group = child(row, String(cell.cell), cell.cell)
		}

		group.items.push(source)
	}

	const out: number[] = []
	const walk = (group: SourceGroup, isRow: boolean): void => {
		if (isRow) {
			for (const item of [...group.items].sort((a, b) => cellOf(a) - cellOf(b))) {
				if (typeof item === "number") out.push(item)
				else walk(item, item.cell === -1)
			}

			return
		}

		// A table's rows in row order where its first row comes: a merged cell's content is laid out with the last
		// row of its merge, after rows below its own (every row tags its columns in order, ISO 14289-1 §7.5).
		const rowsOf = new Map<number, SourceGroup[]>()

		for (const item of group.items) {
			if (typeof item === "number" || item.row < 0) continue

			const rows = rowsOf.get(item.table)

			if (rows === undefined) rowsOf.set(item.table, [item])
			else rows.push(item)
		}

		for (const item of group.items) {
			if (typeof item === "number") {
				out.push(item)

				continue
			}

			if (item.row < 0) {
				walk(item, false)

				continue
			}

			const rows = rowsOf.get(item.table)

			if (rows === undefined) continue

			rowsOf.delete(item.table)

			for (const row of rows.sort((a, b) => a.row - b.row)) walk(row, true)
		}
	}

	walk(root, false)

	return out
}

function cellOf(item: number | SourceGroup): number {
	return typeof item === "number" ? -1 : item.cell
}

function refuse(context: PagePaintContext, kind: DocxPdfRefusal): void {
	context.refused.set(kind, (context.refused.get(kind) ?? 0) + 1)
}

function hexColor(color: string | undefined): number | undefined {
	return color !== undefined && /^[0-9A-Fa-f]{6}$/.test(color) ? (Number.parseInt(color, 16) * 256 + 255) >>> 0 : undefined
}

function decorationColor(value: DecorationValue | undefined): number | undefined {
	if (value === undefined) return undefined

	switch (value.kind) {
		case "color":
			return hexColor(value.color)
		case "underline":
		case "border":
			return hexColor(value.color)
		case "revision":
			return BLACK
	}
}

// The text colour under x on a line (decorations without a colour of their own take it).
function colorAt(page: DocxPdfPage, styles: readonly DocxPdfStyle[], line: number, x: number): number {
	const first = page.lineInts[line * LINE_INTS] ?? 0
	const count = page.lineInts[line * LINE_INTS + 1] ?? 0
	let style = -1

	for (let k = first; k < first + count; k++) {
		if ((page.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0) > x + 0.5) break

		style = page.fragmentInts[k * FRAGMENT_INTS + 2] ?? -1
	}

	return styles[style]?.color ?? BLACK
}

type LineStyle = "solid" | "dotted" | "dashed" | "double" | "none"

// ST_Border as the renderer draws it (CSS border styles).
function borderStyle(style: string): LineStyle {
	switch (style) {
		case "dotted":
			return "dotted"
		case "dashed":
		case "dashSmallGap":
		case "dotDash":
		case "dotDotDash":
			return "dashed"
		case "double":
		case "triple":
		case "thinThickSmallGap":
		case "thickThinSmallGap":
		case "thinThickMediumGap":
		case "thickThinMediumGap":
		case "thinThickLargeGap":
		case "thickThinLargeGap":
			return "double"
		case "none":
		case "nil":
			return "none"
		default:
			return "solid"
	}
}

function underlineStyle(style: string): LineStyle {
	if (style === "double" || style === "wavyDouble") return "double"
	if (style.startsWith("dotted") || style === "dotDotDash" || style === "dashDotDotHeavy") return "dotted"
	if (style.startsWith("dash") || style.startsWith("dotDash")) return "dashed"

	return "solid"
}

// A box on the 96 dpi pixel grid, as the renderer's boxes are drawn (edges rounded to whole px, a box thinner
// than a pixel one pixel wide): rules and fills look as they do on screen, crisp at 100 % and in print.
function snap(start: number, size: number): [number, number] {
	const from = Math.round(start)
	let to = Math.round(start + size)

	if (to <= from && size > 0) to = from + 1

	return [from, to - from]
}

// A horizontal (or vertical) line `thickness` thick along the box's top (left) edge, as a CSS border of that
// style draws it.
function edge(
	page: PdfPage,
	style: LineStyle,
	color: number,
	x: number,
	y: number,
	length: number,
	thickness: number,
	vertical: boolean
): void {
	if (style === "none" || !(length > 0) || !(thickness > 0)) return

	if (style === "double" && thickness >= 3) {
		const band = thickness / 3

		if (vertical) {
			fillRect(page, color, x, y, band, length)
			fillRect(page, color, x + 2 * band, y, band, length)
		} else {
			fillRect(page, color, x, y, length, band)
			fillRect(page, color, x, y + 2 * band, length, band)
		}

		return
	}

	if (style === "solid" || style === "double") {
		if (vertical) fillRect(page, color, x, y, thickness, length)
		else fillRect(page, color, x, y, length, thickness)

		return
	}

	page.saveState()
	page.strokeColor(color).lineWidth(thickness)

	if (style === "dotted") page.lineCap("round").dash([0, thickness * 2], 0)
	else page.dash([thickness * 3, thickness * 3], 0)

	const half = thickness / 2

	if (vertical) page.moveTo(x + half, y + (style === "dotted" ? half : 0)).lineTo(x + half, y + length)
	else page.moveTo(x + (style === "dotted" ? half : 0), y + half).lineTo(x + length, y + half)

	page.stroke()
	page.restoreState()
}

function fillRect(page: PdfPage, color: number, x: number, y: number, width: number, height: number): void {
	if (!(width > 0 && height > 0)) return

	const [left, w] = snap(x, width)
	const [top, h] = snap(y, height)

	page.fillColor(color).rect(left, top, w, h).fill()
}

// A page graphic: fills, border lines, column and note rules.
function paintGraphic(page: PdfPage, data: DocxPdfPage, decorations: readonly DecorationValue[], index: number): void {
	const f = index * GRAPHIC_FLOATS
	const i = index * GRAPHIC_INTS
	const x = data.graphicFloats[f] ?? 0
	const y = data.graphicFloats[f + 1] ?? 0
	const width = data.graphicFloats[f + 2] ?? 0
	const height = data.graphicFloats[f + 3] ?? 0
	const kind = data.graphicInts[i] ?? 0
	const value = decorations[(data.graphicInts[i + 1] ?? 0) - 1]

	if (!(width > 0 && height > 0)) return

	switch (kind) {
		case PageGraphic.SHADING: {
			const color = decorationColor(value)

			if (color !== undefined) fillRect(page, color, x, y, width, height)

			return
		}
		case PageGraphic.BORDER: {
			const style = value?.kind === "border" ? borderStyle(value.style) : "solid"
			const color = decorationColor(value) ?? BLACK

			if (width >= height) edge(page, style, color, x, y, width, height, false)
			else edge(page, style, color, x, y, height, width, true)

			return
		}
		case PageGraphic.REVISION_BAR:
			// Only the Markup view draws change bars; the export is the Final view.
			return
		default:
			fillRect(page, BLACK, x, y, width, height)
	}
}

function isFillDecoration(kind: number): boolean {
	return kind === DecorationKind.SHADING || kind === DecorationKind.HIGHLIGHT
}

function paintDecoration(page: PdfPage, data: DocxPdfPage, doc: DocxPdfDocument, index: number): void {
	const f = index * DECORATION_FLOATS
	const i = index * DECORATION_INTS
	const kind = data.decorationInts[i] ?? 0
	const x = data.decorationFloats[f] ?? 0
	const y = data.decorationFloats[f + 1] ?? 0
	const width = data.decorationFloats[f + 2] ?? 0
	const height = data.decorationFloats[f + 3] ?? 0
	const value = doc.decorations[(data.decorationInts[i + 1] ?? 0) - 1]
	const line = data.decorationInts[i + 2] ?? 0

	switch (kind) {
		case DecorationKind.SHADING:
		case DecorationKind.HIGHLIGHT: {
			const color = decorationColor(value)

			if (color !== undefined) fillRect(page, color, x, y, width, height)

			return
		}
		case DecorationKind.BORDER: {
			if (value?.kind !== "border") return

			const style = borderStyle(value.style)
			const color = decorationColor(value) ?? colorAt(data, doc.styles, line, x)
			const thickness = Math.max(1, value.width)

			edge(page, style, color, x, y, width, thickness, false)
			edge(page, style, color, x, y + height - thickness, width, thickness, false)
			edge(page, style, color, x, y, height, thickness, true)
			edge(page, style, color, x + width - thickness, y, height, thickness, true)

			return
		}
		case DecorationKind.UNDERLINE: {
			const color = decorationColor(value) ?? colorAt(data, doc.styles, line, x)
			const style = value?.kind === "underline" ? underlineStyle(value.style) : "solid"

			if (style === "solid") {
				fillRect(page, color, x, y, width, height)
			} else if (style === "double") {
				const band = Math.max(1, height)

				fillRect(page, color, x, y, width, band)
				fillRect(page, color, x, y + band + height, width, band)
			} else {
				edge(page, style, color, x, y, width, Math.max(1, height), false)
			}

			return
		}
		case DecorationKind.STRIKE:
			fillRect(page, colorAt(data, doc.styles, line, x), x, y, width, height)

			return
		case DecorationKind.DOUBLE_STRIKE: {
			const color = colorAt(data, doc.styles, line, x)

			fillRect(page, color, x, y, width, height)
			fillRect(page, color, x, y + 2 * height, width, height)

			return
		}
		case DecorationKind.BAR:
			fillRect(page, BLACK, x, y, Math.max(width, 1), height)

			return
	}
}

// Tab leaders: a 1 px rule of dots, dashes or a line under the tab's span, on the baseline.
function paintLeader(page: PdfPage, leader: number, color: number, x: number, baseline: number, width: number): void {
	const style: LineStyle | undefined =
		leader === TabLeader.DOT || leader === TabLeader.MIDDLE_DOT
			? "dotted"
			: leader === TabLeader.HYPHEN
				? "dashed"
				: leader === TabLeader.UNDERSCORE || leader === TabLeader.HEAVY
					? "solid"
					: undefined

	if (style !== undefined) edge(page, style, color, x, baseline - 1, width, 1, false)
}

// Clip rectangle of each line and placed object, -1 for none.
function clipsOf(data: DocxPdfPage): { lines: Int32Array; objects: Int32Array } {
	const lines = new Int32Array(data.lineCount).fill(-1)
	const objects = new Int32Array(data.objectCount).fill(-1)

	for (let c = 0; c < data.clipCount; c++) {
		const i = c * PDF_CLIP_INTS

		for (let line = data.clipInts[i] ?? 0; line < (data.clipInts[i + 1] ?? 0) && line < lines.length; line++) lines[line] = c
		for (let object = data.clipInts[i + 2] ?? 0; object < (data.clipInts[i + 3] ?? 0) && object < objects.length; object++)
			objects[object] = c
	}

	return { lines, objects }
}

function clipTo(page: PdfPage, data: DocxPdfPage, clip: number): void {
	const f = clip * PDF_CLIP_FLOATS

	page.rect(data.clipFloats[f] ?? 0, data.clipFloats[f + 1] ?? 0, data.clipFloats[f + 2] ?? 0, data.clipFloats[f + 3] ?? 0).clip()
}

const LOWER = /\p{Ll}/u

function isLower(text: string, at: number): boolean {
	return LOWER.test(text.charAt(at))
}

// The page's painter: one per page.
export class DocxPagePainter {
	private readonly context: PagePaintContext
	private readonly page: PdfPage
	private readonly data: DocxPdfPage
	private readonly clips: { lines: Int32Array; objects: Int32Array }
	// Text box text drawn with its box (in the box's place in the stacking order): sources by box object id, and
	// those sources.
	private readonly boxed = new Map<number, number[]>()
	private readonly boxText = new Set<number>()
	// Structure elements open on this page, outermost first.
	private readonly open: OpenElement[] = []
	private readonly tagged: boolean

	constructor(context: PagePaintContext, page: PdfPage, data: DocxPdfPage) {
		this.context = context
		this.page = page
		this.data = data
		this.clips = clipsOf(data)

		const owners = data.sourceOwners

		if (owners !== undefined) {
			const here = new Set<number>()

			for (let object = 0; object < data.objectCount; object++) here.add(data.objectInts[object * OBJECT_INTS] ?? -1)

			for (let source = 0; source < data.sourceCount; source++) {
				const owner = owners[source] ?? -1

				if (owner < 0 || !here.has(owner)) continue

				const list = this.boxed.get(owner)

				if (list === undefined) this.boxed.set(owner, [source])
				else list.push(source)

				this.boxText.add(source)
			}
		}

		for (const role of data.roles) {
			if (role.kind === "artifact") continue

			for (const cell of role.cells) {
				let rows = this.rowsHere.get(cell.table)

				if (rows === undefined) {
					rows = new Set()
					this.rowsHere.set(cell.table, rows)
				}

				rows.add(cell.row)
			}
		}
		this.tagged = context.writer.tagged
	}

	async paint(): Promise<void> {
		const { page, data, context } = this
		const doc = context.doc

		// Behind the text: graphics and objects of the BEHIND layer.
		page.beginArtifact({ type: "Layout" })

		for (let g = 0; g < data.graphicCount; g++) {
			if ((data.graphicInts[g * GRAPHIC_INTS + 2] ?? Layer.TEXT) === Layer.BEHIND) paintGraphic(page, data, doc.decorations, g)
		}

		page.endArtifact()
		await this.paintObjects(object => this.objectLayer(object) === Layer.BEHIND)

		// Fills of the text layer: its graphics, then the shading and highlights of the lines.
		page.beginArtifact({ type: "Layout" })

		for (let g = 0; g < data.graphicCount; g++) {
			if ((data.graphicInts[g * GRAPHIC_INTS + 2] ?? Layer.TEXT) === Layer.TEXT) paintGraphic(page, data, doc.decorations, g)
		}

		for (let line = 0; line < data.lineCount; line++) if (!this.inBox(line)) this.lineDecorations(line, true)

		page.endArtifact()

		await this.paintText()

		// Lines over the text (underlines, strikes, borders, bars).
		page.beginArtifact({ type: "Layout" })

		for (let line = 0; line < data.lineCount; line++) if (!this.inBox(line)) this.lineDecorations(line, false)

		page.endArtifact()

		// Objects of the text layer not anchored to a paragraph drawn here, then the front layer.
		await this.paintObjects(object => this.objectLayer(object) === Layer.TEXT && !this.anchored(object))
		page.beginArtifact({ type: "Layout" })

		for (let g = 0; g < data.graphicCount; g++) {
			if ((data.graphicInts[g * GRAPHIC_INTS + 2] ?? Layer.TEXT) === Layer.FRONT) paintGraphic(page, data, doc.decorations, g)
		}

		page.endArtifact()
		await this.paintObjects(object => this.objectLayer(object) === Layer.FRONT)

		for (const id of [...this.boxed.keys()]) await this.paintBoxText(id)

		this.closeAll()
	}

	private inBox(line: number): boolean {
		return this.boxText.has(this.data.lineInts[line * LINE_INTS + 5] ?? -1)
	}

	private objectLayer(object: number): number {
		return this.data.objectInts[object * OBJECT_INTS + 1] ?? Layer.TEXT
	}

	// Whether a text-layer object is drawn with its paragraph (in its structure element).
	private anchored(object: number): boolean {
		const source = this.data.objectInts[object * OBJECT_INTS + 2] ?? -1

		return source >= 0 && source < this.data.sourceCount && this.roleOf(source).kind !== "artifact"
	}

	private roleOf(source: number): DocxPdfRole {
		return this.data.roles[source] ?? ARTIFACT
	}

	private lineDecorations(line: number, fills: boolean): void {
		const { data, page } = this
		const first = data.lineInts[line * LINE_INTS + 6] ?? 0
		const last = line + 1 < data.lineCount ? (data.lineInts[(line + 1) * LINE_INTS + 6] ?? 0) : data.decorationCount
		const clip = this.clips.lines[line] ?? -1

		if (last <= first) return

		if (clip >= 0) {
			page.saveState()
			clipTo(page, data, clip)
		}

		for (let d = first; d < last; d++) {
			if (isFillDecoration(data.decorationInts[d * DECORATION_INTS] ?? 0) === fills) paintDecoration(page, data, this.context.doc, d)
		}

		if (!fills) this.leaders(line)

		if (clip >= 0) page.restoreState()
	}

	private leaders(line: number): void {
		const { data } = this
		const first = data.lineInts[line * LINE_INTS] ?? 0
		const count = data.lineInts[line * LINE_INTS + 1] ?? 0
		const baseline = data.lineFloats[line * LINE_FLOATS + 2] ?? 0

		for (let k = first; k < first + count; k++) {
			const fi = k * FRAGMENT_INTS

			if (((data.fragmentInts[fi + 3] ?? 0) & FRAGMENT_KIND_MASK) !== FragmentKind.TAB) continue

			const leader = data.fragmentInts[fi + 4] ?? 0
			const style = this.context.doc.styles[data.fragmentInts[fi + 2] ?? -1]

			if (leader === TabLeader.NONE) continue

			paintLeader(
				this.page,
				leader,
				style?.color ?? BLACK,
				data.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0,
				baseline - (style?.shift ?? 0),
				data.fragmentFloats[k * FRAGMENT_FLOATS + 1] ?? 0
			)
		}
	}

	// --- text and structure

	// The page's text, paragraph by paragraph in reading order (the order their first lines were laid out).
	private async paintText(): Promise<void> {
		const { data, context } = this
		const linesBySource = new Map<number, number[]>()
		const order: number[] = []

		for (let line = 0; line < data.lineCount; line++) {
			const source = data.lineInts[line * LINE_INTS + 5] ?? -1

			if (this.boxText.has(source)) continue

			let lines = linesBySource.get(source)

			if (lines === undefined) {
				lines = []
				linesBySource.set(source, lines)
				order.push(source)
			}

			lines.push(line)
		}

		const objectsBySource = new Map<number, number[]>()

		for (let object = 0; object < data.objectCount; object++) {
			if (this.objectLayer(object) !== Layer.TEXT || !this.anchored(object)) continue

			const source = data.objectInts[object * OBJECT_INTS + 2] ?? -1
			const list = objectsBySource.get(source)

			if (list === undefined) objectsBySource.set(source, [object])
			else list.push(object)

			if (!linesBySource.has(source)) {
				linesBySource.set(source, [])
				order.push(source)
			}
		}

		let done = 0

		for (const source of cellOrder(order, source => this.roleOf(source))) {
			const lines = linesBySource.get(source) ?? []

			await this.paintSource(source, lines, objectsBySource.get(source) ?? [], false)
			done += lines.length

			if (done >= 64) {
				done = 0
				await context.yieldIfDue()
			}
		}

		this.closeAll()

		for (const key of this.drawnHere) context.seen.add(key)
	}

	// One paragraph's lines (with their fills and over-lines when `decorations`: text box text, drawn apart from the
	// page's text), then the objects drawn with it.
	private async paintSource(source: number, lines: readonly number[], objects: readonly number[], decorations: boolean): Promise<void> {
		const { data, context } = this
		const role = this.roleOf(source)
		const key = data.keys[source] ?? ""
		const repeated =
			(role.cells.some(cell => cell.header) && key !== "" && context.seen.has(key) && !this.drawnHere.has(key)) ||
			this.inCoveredCell(role)

		if (key !== "") this.drawnHere.add(key)

		if (decorations) this.boxDecorations(lines, true)

		if (role.kind === "artifact" || repeated) {
			this.closeAll()
			this.page.beginArtifact(role.artifact === undefined ? { type: "Pagination" } : { type: "Pagination", subtype: role.artifact })

			for (const line of lines) await this.paintLine(line, undefined)

			this.page.endArtifact()
		} else {
			const node = this.enter(role, source)

			for (const line of lines) await this.paintLine(line, node)

			this.endOpenContent()

			for (const object of objects) await this.paintObject(object, node)
		}

		if (decorations) this.boxDecorations(lines, false)
	}

	private boxDecorations(lines: readonly number[], fills: boolean): void {
		this.endOpenContent()
		this.page.beginArtifact({ type: "Layout" })

		for (const line of lines) this.lineDecorations(line, fills)

		this.page.endArtifact()
	}

	// The text of object `id`'s text box, over the box: its paragraphs in reading order.
	private async paintBoxText(id: number): Promise<void> {
		const sources = this.boxed.get(id)

		if (sources === undefined) return

		// Once, should the object be listed twice.
		this.boxed.delete(id)

		const { data } = this
		const linesBySource = new Map<number, number[]>()

		for (const source of sources) linesBySource.set(source, [])

		for (let line = 0; line < data.lineCount; line++) linesBySource.get(data.lineInts[line * LINE_INTS + 5] ?? -1)?.push(line)

		for (const source of cellOrder(sources, source => this.roleOf(source)))
			await this.paintSource(source, linesBySource.get(source) ?? [], [], true)
	}

	private readonly drawnHere = new Set<string>()
	// The structure element whose marked-content sequence is open: a paragraph's text is one sequence where
	// nothing else (a link, a clip, an object) comes between.
	private contentNode: number | undefined = undefined

	private useContent(node: number): void {
		if (this.contentNode === node) return

		this.endOpenContent()
		this.page.beginContent(node)
		this.contentNode = node
	}

	private endOpenContent(): void {
		if (this.contentNode === undefined) return

		this.page.endContent()
		this.contentNode = undefined
	}

	// Opens the structure elements `role` needs (keeping those already open that it shares) and returns the
	// element the paragraph's content goes into.
	private enter(role: DocxPdfRole, source: number): number {
		const wanted: WantedElement[] = []

		for (const cell of role.cells) {
			wanted.push({ key: `t${cell.table}`, type: "Table", options: {} })
			wanted.push({
				key: `r${cell.table}:${cell.row}`,
				type: "TR",
				options: {},
				row: { columns: cell.columns, header: cell.header, table: cell.table, index: cell.row }
			})
			wanted.push({ key: `c${cell.table}:${cell.row}:${cell.cell}`, type: "", options: {}, cell: cell.cell })
		}

		let block: string

		if (role.kind === "listItem") {
			wanted.push({ key: `l${role.list}`, type: "L", options: {} })
			wanted.push({ key: `i${source}`, type: "LI", options: {} })
			block = "LBody"
		} else if (role.kind === "heading") {
			const level = Math.min(MAX_HEADING, Math.max(1, Math.min(role.level, this.context.heading + 1)))

			this.context.heading = level
			block = `H${level}`
		} else {
			block = "P"
		}

		wanted.push({ key: `b${source}`, type: block, options: {} })

		let shared = 0

		while (shared < this.open.length && shared < wanted.length && this.open[shared]?.key === wanted[shared]?.key) shared++

		while (this.open.length > shared) this.closeLast()

		for (let k = shared; k < wanted.length; k++) {
			const element = wanted[k]

			if (element === undefined) continue

			if (element.cell !== undefined) {
				const row = this.open[this.open.length - 1]?.row

				if (row !== undefined) {
					// Cells of the row with nothing on this page come first, empty.
					while (row.next < element.cell) this.emptyCell(row)

					this.open.push({ key: element.key, node: this.context.writer.open(...this.cellElement(row, element.cell)) })
					row.next = element.cell + 1

					continue
				}
			}

			const node = this.context.writer.open(element.type === "" ? "TD" : element.type, element.options)

			this.open.push(
				element.row === undefined ? { key: element.key, node } : { key: element.key, node, row: { ...element.row, next: 0 } }
			)
		}

		return this.open[this.open.length - 1]?.node ?? 0
	}

	// A cell of the row with nothing of its own drawn here: tagged empty, unless a merge from a row above on this
	// page covers it.
	private emptyCell(row: RowState): void {
		const writer = this.context.writer

		if (!this.covered(row.table, row.index, row.columns[row.next])) writer.close(writer.open(...this.cellElement(row, row.next)))

		row.next++
	}

	// Rows of each table with content on this page (cells of merges across rows are tagged once per page).
	private readonly rowsHere = new Map<number, Set<number>>()

	// Whether an earlier row of the cell's merge is on this page (the merge is tagged there, a page piece of a
	// table starting with the first of its rows here).
	private covered(table: number, row: number, column: DocxPdfColumn | undefined): boolean {
		const rows = this.rowsHere.get(table)

		if (column === undefined || rows === undefined) return false

		for (let r = column.top; r < row; r++) if (rows.has(r)) return true

		return false
	}

	// A paragraph in a cell another (merged) cell covers on this page: its content is that cell's.
	private inCoveredCell(role: DocxPdfRole): boolean {
		return role.cells.some(cell => this.covered(cell.table, cell.row, cell.columns[cell.cell]))
	}

	// TH (scope Column) in a header row, TD otherwise, with its column span and the rows of its merge on this page.
	private cellElement(row: Omit<RowState, "next">, cell: number): [string, PdfStructOptions] {
		const column = row.columns[cell]
		const span = column?.span ?? 1
		let rows = 0

		for (let r = row.index; r <= (column?.end ?? row.index); r++)
			if (r === row.index || this.rowsHere.get(row.table)?.has(r) === true) rows++

		const options: PdfStructOptions = {
			...(row.header ? { scope: "Column" as const } : {}),
			...(span > 1 ? { colSpan: span } : {}),
			...(rows > 1 ? { rowSpan: rows } : {})
		}

		return [row.header ? "TH" : "TD", options]
	}

	private closeLast(): void {
		this.endOpenContent()

		const element = this.open.pop()

		if (element === undefined) return

		// A row ends with all its cells tagged (ISO 14289-1 §7.5: every row as many columns).
		if (element.row !== undefined) while (element.row.next < element.row.columns.length) this.emptyCell(element.row)

		this.context.writer.close(element.node)
	}

	closeAll(): void {
		this.endOpenContent()

		while (this.open.length > 0) this.closeLast()
	}

	// One line's text fragments; `node` the structure element (undefined: inside an artifact).
	private async paintLine(line: number, node: number | undefined): Promise<void> {
		const { data, page } = this
		const lf = line * LINE_FLOATS
		const li = line * LINE_INTS
		const top = data.lineFloats[lf] ?? 0
		const height = data.lineFloats[lf + 1] ?? 0
		const baseline = data.lineFloats[lf + 2] ?? 0
		const first = data.lineInts[li] ?? 0
		const count = data.lineInts[li + 1] ?? 0
		const source = data.lineInts[li + 5] ?? -1
		const text = data.sourceTexts[source] ?? ""
		const clip = this.clips.lines[line] ?? -1

		for (let k = first; k < first + count; k++) {
			const fi = k * FRAGMENT_INTS
			const info = data.fragmentInts[fi + 3] ?? 0

			if ((info & FRAGMENT_KIND_MASK) !== FragmentKind.TEXT) continue

			const start = data.fragmentInts[fi] ?? 0
			const end = data.fragmentInts[fi + 1] ?? 0

			if (end <= start && (info & FragmentFlag.HYPHEN) === 0) continue

			if (clip >= 0) {
				this.endOpenContent()
				page.saveState()
				clipTo(page, data, clip)
			}

			await this.paintFragment(k, text, source, baseline, top, height, node)

			if (clip >= 0) {
				this.endOpenContent()
				page.restoreState()
			}
		}
	}

	// Shapes a fragment's text in `style`, small capitals split out, into placed glyphs (x from the fragment's
	// start, before the fit to the layout's width; clusters are offsets in `text`).
	private async shapeFragment(text: string, styleId: number, info: number): Promise<Placed[]> {
		const start = 0
		const end = text.length
		const { fonts } = this.context
		const style = this.context.doc.styles[styleId]
		const request = this.context.requests[styleId]

		if (style === undefined || request === undefined) return []

		const level = info >> FRAGMENT_LEVEL_SHIFT
		const flags = ((info & FragmentFlag.CAPS) !== 0 ? SHAPE_CAPS : 0) | ((info & FragmentFlag.HYPHEN) !== 0 ? SHAPE_HYPHEN : 0)
		const smallCaps = (info & FragmentFlag.SMALL_CAPS) !== 0
		// Pieces of the fragment: [start, end, small] in logical order.
		const pieces: [number, number, boolean][] = []

		if (smallCaps && (level & 1) === 0) {
			for (let at = start; at < end;) {
				const lower = isLower(text, at)
				let next = at + 1

				while (next < end && isLower(text, next) === lower) next++

				pieces.push([at, next, lower])
				at = next
			}
		}

		if (pieces.length === 0) pieces.push([start, end, false])

		const placed: Placed[] = []
		let x = 0

		for (let p = 0; p < pieces.length; p++) {
			const [from, to, small] = pieces[p] ?? [start, end, false]
			const pending = fonts.prepare(text, from, to, request)

			if (pending !== undefined) await pending

			const pieceFlags = (small ? SHAPE_SMALL_CAPS : 0) | (p === pieces.length - 1 ? flags : flags & ~SHAPE_HYPHEN)
			const shaped = fonts.shape(text, from, to, request, { level, flags: pieceFlags })
			const size = small ? style.size * SMALL_CAPS_SCALE : style.size

			for (const run of shaped.runs) {
				for (let index = 0; index < run.glyphs.length; index++) {
					const cluster = (run.clusters[index] ?? 0) + (from - start)
					const width = ((run.advances[index] ?? 0) * size) / 1000

					placed.push({ run, index, size, x, width, cluster })
					x += width
				}
			}
		}

		return placed
	}

	private async paintFragment(
		fragment: number,
		text: string,
		source: number,
		baseline: number,
		lineTop: number,
		lineHeight: number,
		node: number | undefined
	): Promise<void> {
		const { data, page, context } = this
		const ff = fragment * FRAGMENT_FLOATS
		const fi = fragment * FRAGMENT_INTS
		const start = data.fragmentInts[fi] ?? 0
		const end = data.fragmentInts[fi + 1] ?? 0
		const styleId = data.fragmentInts[fi + 2] ?? -1
		const info = data.fragmentInts[fi + 3] ?? 0
		const style = context.doc.styles[styleId]

		if (style === undefined) return

		const fragmentText = symbolMapped(text.slice(start, end), style.symbolFont)
		const placed = await this.shapeFragment(fragmentText, styleId, info)

		if (placed.length === 0) return

		const scaleX = style.scaleX > 0 && Number.isFinite(style.scaleX) ? Math.min(style.scaleX, 10) : 1
		const wordSpacing = data.fragmentFloats[ff + 2] ?? 0
		const letterSpacing = style.letterSpacing + (data.fragmentFloats[ff + 3] ?? 0)
		// Natural advance of each glyph with the spacing CSS adds, then the fit to the layout's width (in the
		// fragment's unscaled space): spread between glyphs, or a horizontal scale.
		const advances = placed.map(
			glyph => glyph.width + letterSpacing + (wordSpacing !== 0 && fragmentText.charCodeAt(glyph.cluster) === 0x20 ? wordSpacing : 0)
		)
		const natural = advances.reduce((sum, value) => sum + value, 0)
		const target = (data.fragmentFloats[ff + 1] ?? natural * scaleX) / scaleX
		const fit = style.fit === "scale" && natural > 0 ? target / natural : 1
		const spread = style.fit === "scale" || placed.length < 2 ? 0 : (target - natural) / (placed.length - 1)
		const x0 = data.fragmentFloats[ff] ?? 0
		const y = baseline - style.shift
		const upright = (info & FragmentFlag.UPRIGHT) !== 0
		// Link ranges over this fragment's text.
		const links = this.linkPieces(source, start, end)
		const linkOf = (cluster: number): number => {
			for (const [from, to, link] of links) if (cluster + start >= from && cluster + start < to) return link

			return -1
		}
		// Segments: consecutive glyphs drawn alike (size, link, faux style).
		let at = 0
		let pen = 0

		while (at < placed.length) {
			const head = placed[at]

			if (head === undefined) break

			const link = linkOf(head.cluster)
			const fauxBold = head.run.fauxBold
			const fauxItalic = head.run.fauxItalic
			let next = at + 1

			while (next < placed.length) {
				const glyph = placed[next]

				if (
					glyph === undefined ||
					glyph.size !== head.size ||
					glyph.run.fauxBold !== fauxBold ||
					glyph.run.fauxItalic !== fauxItalic ||
					(linkOf(glyph.cluster) !== link && glyph.run.actualText === undefined)
				)
					break

				next++
			}

			let segmentNatural = 0

			for (let k = at; k < next; k++) segmentNatural += advances[k] ?? 0

			const segmentWidth = (segmentNatural + (next - at - 1) * spread) * fit
			const runs = sliceRuns(placed, at, next)
			const x = x0 + pen * scaleX

			pen += (segmentNatural + (next - at) * spread) * fit

			const look = drawingLook(style, context.doc)
			const base = [scaleX, 0, fauxItalic ? FAUX_SHEAR * scaleX : 0, 1] as const
			// An upright cluster of sideways text: turned 90° counter-clockwise about the centre of its cell (x + width / 2,
			// 0.38 em above the baseline: the ideographic em box's middle, as the style carries no font extents), so its
			// origin moves to where the turned cell puts it.
			const middle = head.size * IDEOGRAPHIC_MIDDLE
			const turned = upright
				? {
						x: x + (segmentWidth * scaleX) / 2 + middle,
						y: y - middle + (segmentWidth * scaleX) / 2,
						transform: [base[1], -base[0], base[3], -base[2]] as const
					}
				: undefined
			const options = {
				x: turned?.x ?? x,
				y: turned?.y ?? y,
				size: head.size,
				color: look.color,
				text: fragmentText,
				wordSpacing,
				letterSpacing,
				width: segmentWidth,
				fit: style.fit,
				...(turned !== undefined ? { transform: turned.transform } : scaleX !== 1 || fauxItalic ? { transform: base } : {}),
				...(fauxBold ? { render: "fillStroke" as const, strokeWidth: head.size / 30 } : {}),
				...(look.stroke === undefined
					? {}
					: {
							render: look.filled ? ("fillStroke" as const) : ("stroke" as const),
							strokeWidth: look.stroke.width,
							strokeColor: look.stroke.color
						})
			}
			const target = link >= 0 ? context.doc.links[link] : undefined
			const allowed = target !== undefined && linkAllowed(target)

			if (target !== undefined && !allowed) refuse(context, "link")

			if (node === undefined || !this.tagged) {
				await this.showText(runs, options, look, [x, lineTop, segmentWidth * scaleX, lineHeight])
			} else if (allowed) {
				this.endOpenContent()

				const linkNode = context.writer.open("Link")

				page.beginContent(linkNode)
				await this.showText(runs, options, look, [x, lineTop, segmentWidth * scaleX, lineHeight])
				page.endContent()
				context.writer.close(linkNode)
				this.addLink(target, x, lineTop, segmentWidth * scaleX, lineHeight, fragmentText, placed, at, next, linkNode)
			} else {
				this.useContent(node)
				await this.showText(runs, options, look, [x, lineTop, segmentWidth * scaleX, lineHeight])
			}

			if (!this.tagged && allowed)
				this.addLink(target, x, lineTop, segmentWidth * scaleX, lineHeight, fragmentText, placed, at, next, undefined)

			at = next
		}
	}

	// Shows a fragment's runs; with a gradient fill (ISO 32000-1 §9.3.6 mode 7) the glyphs clip the shading painted
	// through them, and an outline is stroked over in a second pass whose text reads as nothing (ActualText ""), so
	// the fragment's text is extracted once.
	private async showText(
		runs: readonly PdfTextRun[],
		options: PdfTextOptions,
		look: DrawingLook,
		box: readonly [number, number, number, number]
	): Promise<void> {
		const page = this.page
		const gradient = look.gradient

		if (gradient === undefined) {
			page.text(runs, options)

			return
		}

		page.saveState()
		page.text(runs, { ...options, render: "clip" })
		await page.gradient(textGradient(gradient, box))
		page.restoreState()

		if (look.stroke !== undefined) {
			page.text(
				runs.map(run => ({ ...run, actualText: "" })),
				{ ...options, render: "stroke", strokeWidth: look.stroke.width, strokeColor: look.stroke.color }
			)
		}
	}

	private addLink(
		target: { readonly kind: "external"; readonly href: string } | { readonly kind: "internal"; readonly anchor: string },
		x: number,
		top: number,
		width: number,
		height: number,
		fragmentText: string,
		placed: readonly Placed[],
		from: number,
		to: number,
		node: number | undefined
	): void {
		let low = Number.POSITIVE_INFINITY
		let high = 0

		for (let k = from; k < to; k++) {
			const cluster = placed[k]?.cluster ?? 0

			low = Math.min(low, cluster)
			high = Math.max(high, cluster + 1)
		}

		const contents = Number.isFinite(low) ? fragmentText.slice(low, high).trim() : ""
		const linkTarget = target.kind === "external" ? { uri: target.href } : { dest: target.anchor }

		this.page.link([x, top, Math.max(width, 0.01), Math.max(height, 0.01)], linkTarget, {
			contents: contents.length > 0 ? contents : target.kind === "external" ? target.href : target.anchor,
			...(node === undefined ? {} : { node })
		})
	}

	// [from, to, link] ranges of the source's links overlapping [start, end).
	private linkPieces(source: number, start: number, end: number): [number, number, number][] {
		const { data } = this
		const out: [number, number, number][] = []

		for (let k = 0; k < data.linkCount; k++) {
			const at = k * PDF_LINK_INTS

			if ((data.linkInts[at] ?? -1) !== source) continue

			const from = data.linkInts[at + 1] ?? 0
			const to = data.linkInts[at + 2] ?? 0

			if (to > start && from < end) out.push([from, to, data.linkInts[at + 3] ?? -1])
		}

		return out
	}

	// --- objects

	private async paintObjects(filter: (object: number) => boolean): Promise<void> {
		for (let object = 0; object < this.data.objectCount; object++) {
			if (filter(object)) await this.paintObject(object, undefined)
		}
	}

	// One object; `parent` is the structure element of its paragraph when it is drawn with it.
	private async paintObject(object: number, parent: number | undefined): Promise<void> {
		const { data, page, context } = this
		const f = object * OBJECT_FLOATS
		const id = data.objectInts[object * OBJECT_INTS] ?? -1
		const x = data.objectFloats[f] ?? 0
		const y = data.objectFloats[f + 1] ?? 0
		const width = data.objectFloats[f + 2] ?? 0
		const height = data.objectFloats[f + 3] ?? 0
		const entry = context.doc.objects.get(id)
		const clip = object < this.clips.objects.length ? (this.clips.objects[object] ?? -1) : -1

		if (entry === undefined || !(width > 0) || !(height > 0)) {
			await this.paintBoxText(id)

			return
		}

		this.endOpenContent()

		const alt = entry.kind === "drawing" ? entry.alt : entry.kind === "math" ? mathText(entry.tree) : undefined
		const figure = this.tagged && alt !== undefined && alt.trim().length > 0 && entry.kind !== "placeholder"
		let node: number | undefined

		if (figure) {
			// A figure with no paragraph of its own stands beside the page's paragraphs.
			if (parent === undefined) this.closeAll()

			node = context.writer.open(entry.kind === "math" ? "Formula" : "Figure", {
				alt: alt.trim(),
				bbox: [x, y, x + width, y + height]
			})
			page.beginContent(node)
		} else {
			page.beginArtifact({ type: "Layout" })
		}

		if (clip >= 0) {
			page.saveState()
			clipTo(page, data, clip)
		}

		switch (entry.kind) {
			case "drawing": {
				const drawing = entry.drawing
				const sx = drawing.width > 0 ? width / drawing.width : 1
				const sy = drawing.height > 0 ? height / drawing.height : 1

				// The drawing's frame scaled onto the object's box, as the renderer's SVG viewBox does.
				await paintDrawingPdf(
					{ page, fonts: context.fonts, image: image => this.image(image), defaultFamily: DRAWING_FAMILY },
					drawing,
					[sx, 0, 0, sy, x, y]
				)

				break
			}
			case "separator":
				fillRect(page, BLACK, x, y, width, 1)

				break
			case "checkbox":
				page.saveState()
				page.strokeColor(BLACK)
					.lineWidth(1)
					.rect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1))
					.stroke()

				if (entry.checked)
					page.moveTo(x, y)
						.lineTo(x + width, y + height)
						.moveTo(x, y + height)
						.lineTo(x + width, y)
						.stroke()

				page.restoreState()

				break
			case "math":
				await this.paintMath(entry.tree, entry.fontSize, x, y, width, height)

				break
			case "placeholder":
				refuse(context, "placeholder")

				break
		}

		if (clip >= 0) page.restoreState()

		if (node === undefined) {
			page.endArtifact()
		} else {
			page.endContent()
			context.writer.close(node)
		}

		await this.paintBoxText(id)
	}

	// A drawing's picture, written once per export; one the PDF cannot carry is reported, not drawn.
	private async image(image: DrawingImage): Promise<PdfImage | undefined> {
		const part = image.partName
		const bytes =
			part === undefined || image.handling === "placeholder" || image.handling === "metafile"
				? undefined
				: this.context.media.get(part)

		if (part === undefined || bytes === undefined) {
			refuse(this.context, "image")

			return undefined
		}

		try {
			return await this.context.writer.image(pictureSource(image, bytes, part))
		} catch (error) {
			if (!(error instanceof PdfWriteError)) throw error

			refuse(this.context, "image")

			return undefined
		}
	}

	// An equation laid out by the layout's own math rules (core/docx/layout/math.ts): the box it reserved filled
	// with the tokens, fraction bars and radicals that layout places, the tokens measured in the face drawn.
	private async paintMath(tree: MathElement, fontSize: number, x: number, y: number, width: number, height: number): Promise<void> {
		const { fonts } = this.context
		const all = mathText(tree)
		const request = (italic: boolean): PdfFontFaceRequest => ({ family: MATH_FAMILY, bold: false, italic, slot: "ascii" })

		for (const italic of [false, true]) {
			const pending = all.length === 0 ? undefined : fonts.prepare(all, 0, all.length, request(italic))

			if (pending !== undefined) await pending
		}

		const shaped = new Map<string, PdfShapedText>()
		const shape = (text: string, italic: boolean): PdfShapedText => {
			const key = `${italic ? 1 : 0}${text}`
			let found = shaped.get(key)

			if (found === undefined) {
				found = fonts.shape(text, 0, text.length, request(italic), { level: 0, flags: 0, bidi: true })
				shaped.set(key, found)
			}

			return found
		}
		// Every token measured upright (as layout measures it): an italic token is fitted to that width.
		const layout = mathLayout(tree, fontSize, false, (text, size) => (shape(text, false).width * size) / 1000)
		const box = layout.box
		const sx = box.width > 0 ? width / box.width : 1
		const sy = box.ascent + box.descent > 0 ? height / (box.ascent + box.descent) : 1
		const page = this.page

		page.saveState()
		page.concat([sx, 0, 0, sy, x, y + box.ascent * sy])

		for (const item of layout.items) {
			if (item.kind === "text") {
				const runs = shape(item.text, item.italic).runs

				page.text(runs as readonly PdfTextRun[], {
					x: item.x,
					y: item.y,
					size: item.size,
					color: BLACK,
					text: item.text,
					width: item.width
				})
			} else if (item.kind === "rule") {
				page.fillColor(BLACK).rect(item.x, item.y, item.width, item.height).fill()
			} else if (item.points.length >= 4) {
				page.strokeColor(BLACK).lineWidth(item.width).lineJoin("round").lineCap("round")
				page.moveTo(item.points[0] ?? 0, item.points[1] ?? 0)

				for (let k = 2; k + 1 < item.points.length; k += 2) page.lineTo(item.points[k] ?? 0, item.points[k + 1] ?? 0)

				page.stroke()
			}
		}

		page.restoreState()
	}
}

// A symbol font's codes as the Unicode characters they show, where one UTF-16 unit stays one (offsets keep
// meaning the source's); a code whose character is outside the BMP is left (and reported missing).
interface DrawingLook {
	readonly color: number
	readonly filled: boolean
	readonly stroke: { readonly width: number; readonly color: number } | undefined
	// A gradient fill, painted through the glyphs as a clip.
	readonly gradient: Extract<Paint, { kind: "linear" | "path" | "gradient" }> | undefined
}

// A gradient fill of text over its fragment's box (x, y, width, height px) as a PDF shading: a:lin along its angle
// through the box's centre, reaching the box's corners; a:path from the focus rectangle's centre to the farthest
// corner.
function textGradient(paint: NonNullable<DrawingLook["gradient"]>, box: readonly [number, number, number, number]): PdfGradient {
	const [x, y, width, height] = box
	const bounds: [number, number, number, number] = [x, y, x + width, y + height]
	const stops = { offsets: paint.stops.offsets, colors: paint.stops.colors }

	if (paint.kind === "path") {
		const cx = x + (width * (paint.focus.left + (1 - paint.focus.right))) / 2
		const cy = y + (height * (paint.focus.top + (1 - paint.focus.bottom))) / 2
		const radius = Math.max(
			Math.hypot(cx - x, cy - y),
			Math.hypot(x + width - cx, cy - y),
			Math.hypot(cx - x, y + height - cy),
			Math.hypot(x + width - cx, y + height - cy)
		)

		return { type: "radial", coords: [cx, cy, 0, cx, cy, Math.max(radius, 0.01)], ...stops, spread: "pad", bounds }
	}

	const angle = ((paint.kind === "linear" ? paint.angle : 0) * Math.PI) / 180
	const dx = Math.cos(angle)
	const dy = Math.sin(angle)
	const half = Math.max((Math.abs(width * dx) + Math.abs(height * dy)) / 2, 0.01)
	const cx = x + width / 2
	const cy = y + height / 2

	return { type: "axial", coords: [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half], ...stops, spread: "pad", bounds }
}

// How a DrawingML style's optional fields draw (DocxPdfStyle.paint, alpha, outline): the fill colour with the glyphs'
// opacity (a solid fill's; a paint's is its own), a gradient or pattern fill in its mean colour, and the outline's width and colour (text rendering mode 2,
// or 1 for text without a fill, ISO 32000-1 §9.3.6). A document's styles have none of the fields: their colour as is.
function drawingLook(style: DocxPdfStyle, doc: DocxPdfDocument): DrawingLook {
	if (style.paint === undefined && style.alpha === undefined && style.outline === undefined) {
		return { color: style.color, filled: true, stroke: undefined, gradient: undefined }
	}

	const paint = style.paint === undefined ? undefined : doc.paints?.[style.paint]
	const base = paint === undefined ? style.color : meanColor(paint, style.color)
	// A paint carries its own opacity (its stops'); alpha is the solid fill's, as the DOM and canvas painters read it.
	const alpha = style.alpha === undefined || paint !== undefined ? 1 : Math.min(1, Math.max(0, style.alpha))
	const color = ((base & 0xffffff00) | Math.round((base & 255) * alpha)) >>> 0
	const outline = style.outline === undefined ? undefined : doc.strokes?.[style.outline]
	const strokePaint = outline === undefined ? undefined : doc.paints?.[outline.paint]

	return {
		color,
		filled: alpha > 0,
		gradient:
			paint !== undefined && alpha > 0 && (paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient")
				? paint
				: undefined,
		stroke:
			outline === undefined || !(outline.width > 0)
				? undefined
				: { width: outline.width, color: strokePaint === undefined ? style.color : meanColor(strokePaint, style.color) }
	}
}

// One colour for a paint: a solid's, a gradient's mean, a pattern's blend of foreground and background.
function meanColor(paint: Paint, fallback: number): number {
	switch (paint.kind) {
		case "solid":
			return paint.color
		case "pattern":
			return blendColors(paint.foreground, paint.background, patternShare(paint.pattern))
		case "linear":
		case "path":
		case "gradient": {
			const colors = paint.stops.colors

			if (colors.length === 0) return fallback

			let mean = colors[0] ?? fallback

			for (let k = 1; k < colors.length; k++) mean = blendColors(colors[k] ?? fallback, mean, 1 / (k + 1))

			return mean
		}
		default:
			return fallback
	}
}

function patternShare(pattern: string): number {
	const percent = /^pct(\d+)$/.exec(pattern)

	return percent === null ? 0.5 : Number.parseInt(percent[1] ?? "50", 10) / 100
}

function blendColors(top: number, bottom: number, share: number): number {
	let out = 0

	for (const shift of [24, 16, 8, 0])
		out = out * 256 + Math.round(((top >>> shift) & 255) * share + ((bottom >>> shift) & 255) * (1 - share))

	return out >>> 0
}

function symbolMapped(text: string, family: string | undefined): string {
	const table = family === undefined ? undefined : symbolTable(family)

	if (table === undefined) return text

	let out = ""

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		const mapped = symbolToUnicode(table, code)

		out += mapped > 0 && mapped < 0x10000 ? String.fromCharCode(mapped) : text.charAt(i)
	}

	return out
}

// The family a drawing's text without a typeface of its own is drawn in (Word's default body font).
const DRAWING_FAMILY = "Calibri"

// The family name an equation's text is drawn with when it has no face of its own (the default resolver's
// math substitute).
export const MATH_FAMILY = "Cambria Math"

const ARTIFACT: DocxPdfRole = { kind: "artifact", level: 0, list: -1, cells: [] }

function linkAllowed(
	target: { readonly kind: "external"; readonly href: string } | { readonly kind: "internal"; readonly anchor: string }
): boolean {
	if (target.kind === "internal") return target.anchor.length > 0

	const verdict = classifyLink(target.href)

	return verdict.kind === "external" || (verdict.kind === "internal" && verdict.fragment.length > 0)
}

// The glyphs [from, to) of `placed` as runs (views of the shaped runs' arrays).
function sliceRuns(placed: readonly Placed[], from: number, to: number): PdfTextRun[] {
	const out: PdfTextRun[] = []
	let k = from

	while (k < to) {
		const head = placed[k]

		if (head === undefined) break

		const run = head.run
		let next = k + 1

		while (next < to && placed[next]?.run === run && placed[next]?.index === (placed[next - 1]?.index ?? -2) + 1) next++

		const a = head.index
		const b = a + (next - k)

		out.push(
			a === 0 && b === run.glyphs.length
				? run
				: {
						font: run.font,
						glyphs: run.glyphs.subarray(a, b),
						advances: run.advances.subarray(a, b),
						dx: run.dx === null ? null : run.dx.subarray(a, b),
						dy: run.dy === null ? null : run.dy.subarray(a, b),
						clusters: run.clusters.subarray(a, b),
						actualText: run.actualText
					}
		)
		k = next
	}

	return out
}

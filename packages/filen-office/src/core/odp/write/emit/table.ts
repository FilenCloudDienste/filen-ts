import type { EmitPiece, EmitResult } from "../../../pptx/write/types"
import {
	refused,
	type LineProps,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type TableCell,
	type TableCellProps,
	type TableModel,
	type Xfrm
} from "../../../presentation/model"
import { decodeUtf8, escapeAttribute, escapeText } from "../../../xml/index"
import type { OdpEmitContext, OdpEmitFamily } from "../emit"
import { OdpStyles, alphaOf, cm, declared, hexColor, setProperty, styleChanges, type StyleChanges } from "../styles"
import { IDENTITY, OdpShapeWriter, markupOf } from "./shape"
import { emitOdpText } from "./text"
import { isRefused } from "../../../presentation/refusal"

// The table family's ODF markup: a draw:frame holding table:table (ODF 1.3 Part 3 §10.3.6, Part 1 §9.1). The frame's
// box, name and title are the shape family's (a source frame is patched there); the table is written from the model:
// a table:table-column per grid column and a table:table-row per row with their sizes in automatic styles, each
// cell's text through the text family, its spans, and its properties (fill, borders, padding, vertical alignment) in
// an automatic table-cell style derived from the cell's own (ODF 1.3 §17.18 style:table-cell-properties: the
// standard's place for them). A covered cell is table:covered-table-cell (§9.1.5). The template and the flags of
// which template styles apply are the source's, the flags from the model.

const FLAGS = [
	["firstRow", "table:use-first-row-styles"],
	["lastRow", "table:use-last-row-styles"],
	["firstCol", "table:use-first-column-styles"],
	["lastCol", "table:use-last-column-styles"],
	["bandRow", "table:use-banding-rows-styles"],
	["bandCol", "table:use-banding-columns-styles"]
] as const

const SIDES = [
	["l", "left"],
	["r", "right"],
	["t", "top"],
	["b", "bottom"]
] as const

const ANCHORS: Readonly<Record<string, string>> = { t: "top", ctr: "middle", b: "bottom" }

function border(line: LineProps | "none"): string | Refused {
	if (line === "none") return "none"

	const fill = line.fill

	if (fill === "none") return "none"
	if (fill !== undefined && fill.kind !== "solid") return refused("unsupported", `a ${fill.kind} cell border`)

	const color = fill === undefined ? "#000000" : hexColor(fill.color)

	if (isRefused(color)) return color

	// In cm, to the EMU (a width in pt to four places reads back off by one).
	return `${cm(line.w ?? 9525)} solid ${color}`
}

// A cell's properties as table-cell style changes.
function cellChanges(props: TableCellProps | undefined): StyleChanges | Refused {
	const changes = styleChanges()

	if (props === undefined) return changes

	const fill = props.fill

	if (fill !== undefined) {
		if (fill === "none") {
			setProperty(changes, "table-cell", "fo:background-color", "transparent")
		} else if (fill.kind === "solid") {
			const color = hexColor(fill.color)

			if (isRefused(color)) return color
			if (alphaOf(fill.color) !== 100_000) return refused("unsupported", "a transparent cell fill")

			setProperty(changes, "table-cell", "fo:background-color", color)
		} else {
			return refused("unsupported", `a ${fill.kind} cell fill`)
		}
	}

	for (const [side, name] of SIDES) {
		const line = props.borders?.[side]

		if (line === undefined) continue

		const value = border(line)

		if (isRefused(value)) return value

		setProperty(changes, "table-cell", `fo:border-${name}`, value)
	}

	for (const [key, name] of [
		["marL", "left"],
		["marR", "right"],
		["marT", "top"],
		["marB", "bottom"]
	] as const) {
		const value = props[key]

		if (value !== undefined) setProperty(changes, "table-cell", `fo:padding-${name}`, cm(value))
	}

	if (props.anchor !== undefined) setProperty(changes, "table-cell", "style:vertical-align", ANCHORS[props.anchor] ?? "top")
	if (props.borders?.tl2br !== undefined || props.borders?.bl2tr !== undefined) {
		for (const [side, name] of [
			["tl2br", "style:diagonal-tl-br"],
			["bl2tr", "style:diagonal-bl-tr"]
		] as const) {
			const line = props.borders[side]

			if (line === undefined) continue

			const value = border(line)

			if (isRefused(value)) return value

			setProperty(changes, "table-cell", name, value)
		}
	}

	return changes
}

interface Source {
	readonly writer: OdpShapeWriter
	// The source cell's own style name by its node (a style the source names stays the parent of the written one).
	styleOf(cell: TableCell): string | undefined
	attributes(): ReadonlyMap<string, string>
}

function cellXml(
	context: OdpEmitContext,
	styles: OdpStyles,
	slide: SlideNode,
	shape: ShapeNode,
	cell: TableCell,
	source: Source | undefined
): string | Refused {
	if (cell.hMerge === true || cell.vMerge === true) return "<table:covered-table-cell/>"

	const changes = cellChanges(cell.props)

	if (isRefused(changes)) return changes

	const base = source?.styleOf(cell)
	const style = changes.attributes.size === 0 && base === undefined ? undefined : styles.derived("table-cell", base, changes)
	const { frame: _frame, ph: _ph, ...plain } = shape
	const text = markupOf(
		emitOdpText.emit(
			{
				slide,
				shape: { ...plain, kind: "sp", text: cell.text },
				touch: { kind: "shape", slide: slide.ref, shape: shape.id, dirt: { kind: "text" } }
			},
			context
		)
	)

	if (isRefused(text)) return text

	return (
		`<table:table-cell${style === undefined ? "" : ` table:style-name="${escapeAttribute(style)}"`}` +
		`${cell.gridSpan === undefined ? "" : ` table:number-columns-spanned="${String(cell.gridSpan)}"`}` +
		`${cell.rowSpan === undefined ? "" : ` table:number-rows-spanned="${String(cell.rowSpan)}"`}` +
		` office:value-type="string">${text === "" ? "<text:p/>" : text}</table:table-cell>`
	)
}

// table:table of the model.
export function odpTableXml(
	context: OdpEmitContext,
	slide: SlideNode,
	shape: ShapeNode,
	table: TableModel,
	source?: Source
): string | Refused {
	if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

	const styles = context.styles
	const kept = source?.attributes() ?? new Map<string, string>()
	let out = "<table:table"

	for (const [name, value] of kept) {
		if (FLAGS.some(([, attribute]) => attribute === name)) continue

		out += ` ${name}="${escapeAttribute(value)}"`
	}

	for (const [flag, attribute] of FLAGS) if (table.flags[flag]) out += ` ${attribute}="true"`

	out += ">"

	// Sizes are positive lengths (§20.244, §20.348): a column or row of no size takes none (it fits its content).
	for (const width of table.grid) {
		const changes = styleChanges()

		setProperty(changes, "table-column", "style:column-width", cm(width))
		out +=
			width > 0
				? `<table:table-column table:style-name="${escapeAttribute(styles.derived("table-column", undefined, changes))}"/>`
				: "<table:table-column/>"
	}

	for (const row of table.rows) {
		const changes = styleChanges()

		setProperty(changes, "table-row", "style:row-height", cm(row.h))
		out +=
			row.h > 0
				? `<table:table-row table:style-name="${escapeAttribute(styles.derived("table-row", undefined, changes))}">`
				: "<table:table-row>"

		for (const cell of row.cells) {
			const markup = cellXml(context, styles, slide, shape, cell, source)

			if (isRefused(markup)) return markup

			out += markup
		}

		out += "</table:table-row>"
	}

	return `${out}</table:table>`
}

// A new frame's box: svg:x/y/width/height, a turned one placed by draw:transform about its corner (as the shape
// family writes a box; the reader's angle turns counter-clockwise, DrawingML's rot clockwise).
export function frameBox(xfrm: Xfrm): string {
	const size = ` svg:width="${cm(xfrm.cx)}" svg:height="${cm(xfrm.cy)}"`

	if (xfrm.rot === 0) return ` svg:x="${cm(xfrm.x)}" svg:y="${cm(xfrm.y)}"${size}`

	const a = -((xfrm.rot / 60_000) * Math.PI) / 180
	const cos = Math.cos(a)
	const sin = Math.sin(a)
	const halfW = xfrm.cx / 2
	const halfH = xfrm.cy / 2
	const tx = xfrm.x + halfW - (cos * halfW + sin * halfH)
	const ty = xfrm.y + halfH - (-sin * halfW + cos * halfH)

	return `${size} draw:transform="rotate (${a.toFixed(12)}) translate (${cm(tx)} ${cm(ty)})"`
}

export function altMarkup(shape: ShapeNode): string {
	return (
		(shape.alt?.title === undefined || shape.alt.title === "" ? "" : `<svg:title>${escapeText(shape.alt.title)}</svg:title>`) +
		(shape.alt?.descr === undefined || shape.alt.descr === "" ? "" : `<svg:desc>${escapeText(shape.alt.descr)}</svg:desc>`)
	)
}

export const emitOdpTable: OdpEmitFamily = {
	emit(request, context): EmitResult {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "a table emit without a shape")
		if (shape.frame?.kind !== "table") return refused("unsupported", "a table emit for a shape that is not a table")
		if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

		const styles = context.styles
		const fragment = context.document === undefined ? undefined : styles.env.fragmentOf(context.document)
		const writer = new OdpShapeWriter(context, fragment, request.slide, () => undefined)
		const node = writer.sourceNode(shape)
		const table = shape.frame.table

		if (node === undefined || fragment === undefined) {
			if (shape.xfrm === undefined) return refused("unsupported", "a new table without a box")

			const markup = odpTableXml(context, request.slide, shape, table)

			if (isRefused(markup)) return markup

			const name = shape.name === "" ? "" : ` draw:name="${escapeAttribute(shape.name)}"`

			return { kind: "markup", pieces: [`<draw:frame${name}${frameBox(shape.xfrm)}>${markup}${altMarkup(shape)}</draw:frame>`] }
		}

		const document = fragment.document
		let tableNode = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
			if (fragment.name(child) === "table:table") tableNode = child

		const source: Source = {
			writer,
			styleOf: cell => {
				const src = cell.src

				if (src?.format !== "odp" || src.part !== fragment.part || src.fragment !== fragment.offset || src.epoch !== fragment.epoch)
					return undefined

				return fragment.attributes(src.node).get("table:style-name")
			},
			attributes: () => (tableNode < 0 ? new Map() : fragment.attributes(tableNode))
		}
		const markup = odpTableXml(context, request.slide, shape, table, source)

		if (isRefused(markup)) return markup

		const pieces = writer.element(shape, IDENTITY, { xfrm: true, alt: true, name: true, hidden: true }, true)

		if (isRefused(pieces)) return pieces

		const out: EmitPiece[] = []
		let replaced = false

		// The shape writer nests this frame in the one it patches, which takes markup only: the frame's kept children (a
		// replacement image, a title) are written as their source text.
		for (const piece of pieces) {
			if (typeof piece === "string") {
				out.push(piece)
			} else if (piece instanceof Uint8Array) {
				out.push(decodeUtf8(piece))
			} else if (piece.hole === tableNode) {
				out.push(declared(markup, fragment.namespaces.inScope(tableNode)))
				replaced = true
			} else {
				out.push(decodeUtf8(document.raw(piece.hole)))
			}
		}

		if (!replaced) return refused("malformed", "a table frame without its table:table")

		return { kind: "markup", pieces: out }
	}
}

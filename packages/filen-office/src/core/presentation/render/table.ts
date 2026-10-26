import { IDENTITY, ItemKind, rgbaHex, type DrawingList, type Rgba } from "../../drawingml/displayList"
import { GROUP_PAINT, NO_PAINT, fillChild, readFillElement, shapeLine, styleRef, type PaintContext } from "../../drawingml/fill"
import { readColorIn } from "../../drawingml/color"
import { D, EMU_PER_PX, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { parseXml, type XmlDocument } from "../../xml/index"
import type { TableCell, TableModel } from "../model"
import { fillXml, lineXml, ScratchWriter } from "./markup"
import type { RenderServices, TableTextStyle } from "./services"
import { builtinTableStyle } from "./tableStyles"

// A table frame (a:tbl, §21.1.3) drawn from the model: the grid, rows grown to their text, merged cells, fills and
// borders from each cell's own properties (typed edits first, then its a:tcPr), else from the table style
// (§20.1.4.2.26 a:tblStyle in the tableStyles part) by region, later regions overriding earlier ones: the whole table,
// banded columns, banded rows, first and last column, first and last row, then the corner cells.

// Cell margins default to 0.1in left/right, 0.05in top/bottom (§21.1.3.17).
const DEFAULT_MAR_LR = 91440
const DEFAULT_MAR_TB = 45720

export const MAX_TABLE_CELLS = 100_000
export const MAX_GRID_COLUMNS = 1000
// Grid positions (rows × grid columns): the occupancy of merged areas is one byte each.
export const MAX_GRID_AREA = 1_000_000

type Side = "left" | "right" | "top" | "bottom"

const CELL_SIDES: Readonly<Record<Side, string>> = { left: "lnL", right: "lnR", top: "lnT", bottom: "lnB" }

// One region of a table style: its node and the cells it covers (inclusive).
interface Region {
	readonly node: number
	readonly rows: readonly [number, number]
	readonly columns: readonly [number, number]
}

export interface TableCellBox {
	readonly row: number
	readonly column: number
	readonly cell: TableCell
	// The cell box (px, frame-local).
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	// Margins (px).
	readonly marL: number
	readonly marR: number
	readonly marT: number
	readonly marB: number
	readonly anchor: "t" | "ctr" | "b"
	readonly vert: string | undefined
	readonly textStyle: TableTextStyle | undefined
}

export interface TableRender {
	readonly list: DrawingList
	readonly cells: readonly TableCellBox[]
	// Column edges and row edges (px, frame-local).
	readonly columnEdges: readonly number[]
	readonly rowEdges: readonly number[]
	readonly refused?: "tooLarge"
}

export interface TableRenderInput {
	readonly table: TableModel
	readonly context: PaintContext
	readonly services: RenderServices
	// The part the table's a:tc nodes are in.
	readonly part: string | undefined
	// The tableStyles part (§19.3.3.1) and its name.
	readonly tableStyles: { readonly document: XmlDocument; readonly part: string } | undefined
	// The laid-out text height of a cell (px) for an inner width, or 0 without a text engine.
	readonly textHeight: (cell: TableCell, row: number, column: number, width: number, style: TableTextStyle | undefined) => number
}

// The style a table names (else the part's default): the tableStyles part's, else PowerPoint's built-in one.
function styleNode(document: XmlDocument | undefined, id: string | undefined): { reader: DrawingReader; node: number } | undefined {
	const reader = document === undefined ? undefined : drawingReader(document)
	const root = document === undefined ? -1 : document.documentElement()
	const wanted = id ?? (reader === undefined ? undefined : reader.attr(root, "def"))

	if (wanted === undefined) return undefined

	if (reader !== undefined) {
		for (const style of reader.children(root, D.A, "tblStyle"))
			if (reader.attr(style, "styleId") === wanted) return { reader, node: style }
	}

	return builtinTableStyle(wanted)
}

// A table style's regions in drawing order (whole table, banded columns, banded rows, first and last column, first
// and last row, the corners). Bands are kept per column and per row, so the regions a cell's span meets are found by
// index, never by testing every region.
interface Regions {
	readonly whole: Region | undefined
	readonly bandColumns: readonly (Region | undefined)[]
	readonly bandRows: readonly (Region | undefined)[]
	readonly rest: readonly Region[]
}

const NO_REGIONS: Regions = { whole: undefined, bandColumns: [], bandRows: [], rest: [] }

function regions(reader: DrawingReader, style: number, table: TableModel, rowCount: number, columnCount: number): Regions {
	const flags = table.flags
	const lastRow = rowCount - 1
	const lastColumn = columnCount - 1
	const nodes = new Map<string, number>()
	const region = (name: string, rows: readonly [number, number], columns: readonly [number, number]): Region | undefined => {
		let node = nodes.get(name)

		if (node === undefined) {
			node = reader.child(style, D.A, name)
			nodes.set(name, node)
		}

		return node >= 0 && rows[0] <= rows[1] && columns[0] <= columns[1] ? { node, rows, columns } : undefined
	}
	const bandColumns: (Region | undefined)[] = []
	const bandRows: (Region | undefined)[] = []
	const rest: Region[] = []

	if (flags.bandCol) {
		const first = flags.firstCol ? 1 : 0
		const last = flags.lastCol ? lastColumn - 1 : lastColumn

		for (let column = first; column <= last; column++)
			bandColumns[column] = region((column - first) % 2 === 0 ? "band1V" : "band2V", [0, lastRow], [column, column])
	}

	if (flags.bandRow) {
		const first = flags.firstRow ? 1 : 0
		const last = flags.lastRow ? lastRow - 1 : lastRow

		for (let row = first; row <= last; row++)
			bandRows[row] = region((row - first) % 2 === 0 ? "band1H" : "band2H", [row, row], [0, lastColumn])
	}

	const add = (on: boolean, name: string, rows: readonly [number, number], columns: readonly [number, number]): void => {
		const found = on ? region(name, rows, columns) : undefined

		if (found !== undefined) rest.push(found)
	}

	add(flags.firstCol, "firstCol", [0, lastRow], [0, 0])
	add(flags.lastCol, "lastCol", [0, lastRow], [lastColumn, lastColumn])
	add(flags.firstRow, "firstRow", [0, 0], [0, lastColumn])
	add(flags.lastRow, "lastRow", [lastRow, lastRow], [0, lastColumn])
	add(flags.firstRow && flags.firstCol, "nwCell", [0, 0], [0, 0])
	add(flags.firstRow && flags.lastCol, "neCell", [0, 0], [lastColumn, lastColumn])
	add(flags.lastRow && flags.firstCol, "swCell", [lastRow, lastRow], [0, 0])
	add(flags.lastRow && flags.lastCol, "seCell", [lastRow, lastRow], [lastColumn, lastColumn])

	return { whole: region("wholeTbl", [0, lastRow], [0, lastColumn]), bandColumns, bandRows, rest }
}

// The regions a cell's area (rows top..bottom, columns left..right) meets, in drawing order: rectangle intersection.
function covering(all: Regions, top: number, left: number, bottom: number, right: number): Region[] {
	const out: Region[] = []

	if (all.whole !== undefined) out.push(all.whole)

	for (let column = left; column <= right && column < all.bandColumns.length; column++) {
		const band = all.bandColumns[column]

		if (band !== undefined) out.push(band)
	}

	for (let row = top; row <= bottom && row < all.bandRows.length; row++) {
		const band = all.bandRows[row]

		if (band !== undefined) out.push(band)
	}

	for (const region of all.rest)
		if (region.rows[0] <= bottom && region.rows[1] >= top && region.columns[0] <= right && region.columns[1] >= left) out.push(region)

	return out
}

function covers(region: Region, row: number, column: number): boolean {
	return row >= region.rows[0] && row <= region.rows[1] && column >= region.columns[0] && column <= region.columns[1]
}

// The style border of a cell side within a region: its outer side, else the inside line.
function regionSide(region: Region, side: Side, top: number, left: number, bottom: number, right: number): string {
	switch (side) {
		case "top":
			return top === region.rows[0] ? "top" : "insideH"
		case "bottom":
			return bottom === region.rows[1] ? "bottom" : "insideH"
		case "left":
			return left === region.columns[0] ? "left" : "insideV"
		case "right":
			return right === region.columns[1] ? "right" : "insideV"
	}
}

function textStyleOf(
	reader: DrawingReader,
	node: number,
	context: PaintContext,
	base: TableTextStyle | undefined
): TableTextStyle | undefined {
	if (node < 0) return base

	const bold = reader.attr(node, "b")
	const italic = reader.attr(node, "i")
	const fontRef = reader.child(node, D.A, "fontRef")
	const color: Rgba | undefined =
		readColorIn(reader, node, context.theme) ?? (fontRef < 0 ? undefined : readColorIn(reader, fontRef, context.theme))
	const font = reader.attr(fontRef, "idx")
	const out: { -readonly [K in keyof TableTextStyle]: TableTextStyle[K] } = { ...base }

	if (bold === "on" || bold === "off") out.bold = bold === "on"
	if (italic === "on" || italic === "off") out.italic = italic === "on"
	if (color !== undefined) out.color = rgbaHex(color)
	if (font === "major" || font === "minor") out.font = font

	return out
}

// The whole table in one step (tests and callers without a slice clock).
export function renderTable(input: TableRenderInput): TableRender {
	const steps = renderTableSteps(input)

	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

// The table as steps (one per cell), so a sliced render can give the host a turn between them (runSliced).
export function* renderTableSteps(input: TableRenderInput): Generator<void, TableRender> {
	const { table, services } = input
	const columnCount = table.grid.length
	const rowCount = table.rows.length
	let cellCount = 0

	for (const row of table.rows) cellCount += row.cells.length

	const list = input.context.list

	if (columnCount > MAX_GRID_COLUMNS || cellCount > MAX_TABLE_CELLS || rowCount * columnCount > MAX_GRID_AREA)
		return { list, cells: [], columnEdges: [], rowEdges: [], refused: "tooLarge" }

	const columnEdges = [0]

	for (const width of table.grid) columnEdges.push((columnEdges[columnEdges.length - 1] ?? 0) + Math.max(0, width) / EMU_PER_PX)

	const style = styleNode(input.tableStyles?.document, table.styleId)
	const styleContext: PaintContext | undefined =
		style === undefined ? undefined : { ...input.context, images: imagesOf(services, input.tableStyles?.part) }
	const styleRegions = style === undefined ? NO_REGIONS : regions(style.reader, style.node, table, rowCount, columnCount)
	// Grid positions an earlier cell's span covers: a covered cell is part of that cell (drawn once, by it), whether or
	// not it carries hMerge/vMerge.
	const occupied = new Uint8Array(rowCount * columnCount)
	const cellSource = input.part === undefined ? undefined : services.xml(input.part)
	const cellReader = cellSource === undefined ? undefined : drawingReader(cellSource)
	const cellContext: PaintContext = { ...input.context, images: imagesOf(services, input.part) }
	const edits = editedProps(input, table)

	// Pass 1: cell boxes in grid terms, margins, text styles and the text heights rows grow to.
	interface Pending {
		row: number
		column: number
		cell: TableCell
		rowSpan: number
		columnSpan: number
		tcPr: number
		marL: number
		marR: number
		marT: number
		marB: number
		anchor: "t" | "ctr" | "b"
		vert: string | undefined
		textStyle: TableTextStyle | undefined
		regions: Region[]
	}

	const pending: Pending[] = []
	const heights = table.rows.map(row => Math.max(0, row.h) / EMU_PER_PX)

	for (let r = 0; r < rowCount; r++) {
		const row = table.rows[r]

		if (row === undefined) continue

		for (let c = 0; c < row.cells.length && c < columnCount; c++) {
			const cell = row.cells[c]

			if (cell === undefined || cell.hMerge === true || cell.vMerge === true || occupied[r * columnCount + c] === 1) continue

			const tc = cell.src?.format === "pptx" && cellReader !== undefined && cell.src.part === input.part ? cell.src.node : -1
			const tcPr = tc < 0 || cellReader === undefined ? -1 : cellReader.child(tc, D.A, "tcPr")
			const props = cell.props
			const margin = (typed: number | undefined, name: string, fallback: number): number =>
				(typed ?? (tcPr >= 0 && cellReader !== undefined ? cellReader.emu(tcPr, name, fallback) : fallback)) / EMU_PER_PX
			const anchorText = props?.anchor ?? (tcPr >= 0 ? cellReader?.attr(tcPr, "anchor") : undefined)
			const anchor = anchorText === "ctr" || anchorText === "b" ? anchorText : "t"
			// The span, cut to the grid and to the positions no earlier span holds (overlapping spans are malformed:
			// each position belongs to one cell), so every position is marked once.
			let columnSpan = 1
			const wantColumns = Math.min(cell.gridSpan ?? 1, columnCount - c)

			while (columnSpan < wantColumns && occupied[r * columnCount + c + columnSpan] !== 1) columnSpan++

			let rowSpan = 1
			const wantRows = Math.min(cell.rowSpan ?? 1, rowCount - r)

			for (; rowSpan < wantRows; rowSpan++) {
				const base = (r + rowSpan) * columnCount + c
				let free = true

				for (let k = 0; k < columnSpan && free; k++) free = occupied[base + k] !== 1

				if (!free) break
			}

			for (let rr = r; rr < r + rowSpan; rr++) occupied.fill(1, rr * columnCount + c, rr * columnCount + c + columnSpan)

			const regionsHere = covering(styleRegions, r, c, r + rowSpan - 1, c + columnSpan - 1)
			let textStyle: TableTextStyle | undefined

			if (style !== undefined && styleContext !== undefined)
				for (const region of regionsHere.filter(candidate => covers(candidate, r, c)))
					textStyle = textStyleOf(style.reader, style.reader.child(region.node, D.A, "tcTxStyle"), styleContext, textStyle)

			const entry: Pending = {
				row: r,
				column: c,
				cell,
				rowSpan,
				columnSpan,
				tcPr,
				marL: margin(props?.marL, "marL", DEFAULT_MAR_LR),
				marR: margin(props?.marR, "marR", DEFAULT_MAR_LR),
				marT: margin(props?.marT, "marT", DEFAULT_MAR_TB),
				marB: margin(props?.marB, "marB", DEFAULT_MAR_TB),
				anchor,
				vert: props?.vert ?? (tcPr >= 0 ? cellReader?.attr(tcPr, "vert") : undefined),
				textStyle,
				regions: regionsHere
			}

			pending.push(entry)

			if (rowSpan === 1) {
				const width = (columnEdges[c + columnSpan] ?? 0) - (columnEdges[c] ?? 0) - entry.marL - entry.marR
				const text = input.textHeight(cell, r, c, Math.max(0, width), textStyle)

				if (text > 0) heights[r] = Math.max(heights[r] ?? 0, text + entry.marT + entry.marB)
			}

			yield
		}
	}

	const rowEdges = [0]

	for (const height of heights) rowEdges.push((rowEdges[rowEdges.length - 1] ?? 0) + height)

	const tableWidth = columnEdges[columnEdges.length - 1] ?? 0
	const tableHeight = rowEdges[rowEdges.length - 1] ?? 0

	// The table background (a:tblPr fill, the style's tblBg) under every cell.
	const tblPr =
		table.src?.format === "pptx" && cellReader !== undefined && table.src.part === input.part
			? cellReader.child(table.src.node, D.A, "tblPr")
			: -1
	let background =
		tblPr >= 0 && cellReader !== undefined ? readFillElement(cellContext, cellReader, fillChild(cellReader, tblPr)) : undefined

	if (background === undefined && style !== undefined && styleContext !== undefined) {
		const tblBg = style.reader.child(style.node, D.A, "tblBg")

		background = paintOf(styleContext, style.reader, tblBg)
	}

	if (background !== undefined && background >= 0) rectangle(list, 0, 0, tableWidth, tableHeight, background)

	const cells: TableCellBox[] = []
	const borders: { x1: number; y1: number; x2: number; y2: number; stroke: number }[] = []

	for (const entry of pending) {
		const x = columnEdges[entry.column] ?? 0
		const y = rowEdges[entry.row] ?? 0
		const width = (columnEdges[entry.column + entry.columnSpan] ?? x) - x
		const height = (rowEdges[entry.row + entry.rowSpan] ?? y) - y
		const edited = edits.get(entry.cell)

		// Fill: the typed edit, the cell's own, else the last style region with one.
		let fill =
			edited?.fill ??
			(entry.tcPr >= 0 && cellReader !== undefined
				? readFillElement(cellContext, cellReader, fillChild(cellReader, entry.tcPr))
				: undefined)

		if (fill === undefined && style !== undefined && styleContext !== undefined) {
			for (const region of entry.regions) {
				if (!covers(region, entry.row, entry.column)) continue

				const paint = paintOf(
					styleContext,
					style.reader,
					style.reader.child(style.reader.child(region.node, D.A, "tcStyle"), D.A, "fill")
				)

				if (paint !== undefined) fill = paint
			}
		}

		if (fill !== undefined && fill !== NO_PAINT && fill !== GROUP_PAINT) rectangle(list, x, y, width, height, fill)

		const top = entry.row
		const left = entry.column
		const bottom = entry.row + entry.rowSpan - 1
		const right = entry.column + entry.columnSpan - 1

		for (const side of ["top", "bottom", "left", "right"] as const) {
			let stroke: number | undefined = edited?.borders.get(side)

			if (stroke === undefined && entry.tcPr >= 0 && cellReader !== undefined) {
				const ln = cellReader.child(entry.tcPr, D.A, CELL_SIDES[side])

				if (ln >= 0) stroke = shapeLine(cellContext, cellReader, ln, undefined)?.stroke ?? -1
			}

			if (stroke === undefined && style !== undefined && styleContext !== undefined) {
				for (const region of entry.regions) {
					const border = style.reader.child(style.reader.child(region.node, D.A, "tcStyle"), D.A, "tcBdr")
					const holder = style.reader.child(border, D.A, regionSide(region, side, top, left, bottom, right))

					if (holder < 0) continue

					stroke = borderOf(styleContext, style.reader, holder)
				}
			}

			if (stroke === undefined || stroke < 0) continue

			const x2 = x + width
			const y2 = y + height

			borders.push(
				side === "top"
					? { x1: x, y1: y, x2, y2: y, stroke }
					: side === "bottom"
						? { x1: x, y1: y2, x2, y2, stroke }
						: side === "left"
							? { x1: x, y1: y, x2: x, y2, stroke }
							: { x1: x2, y1: y, x2, y2, stroke }
			)
		}

		cells.push({
			row: entry.row,
			column: entry.column,
			cell: entry.cell,
			x,
			y,
			width,
			height,
			marL: entry.marL,
			marR: entry.marR,
			marT: entry.marT,
			marB: entry.marB,
			anchor: entry.anchor,
			vert: entry.vert,
			textStyle: entry.textStyle
		})

		yield
	}

	// Borders over every fill.
	for (const border of borders) {
		const firstCommand = list.commandCount
		const firstCoord = list.coordCount

		list.moveTo(border.x1, border.y1)
		list.lineTo(border.x2, border.y2)
		list.addItem(ItemKind.PATH, IDENTITY, 0, 0, tableWidth, tableHeight, firstCommand, firstCoord, -1, border.stroke, -1, -1, 0, 0)
	}

	return { list, cells, columnEdges, rowEdges }
}

function imagesOf(services: RenderServices, part: string | undefined): PaintContext["images"] {
	return id => {
		const relationship = part === undefined ? undefined : services.relationship(part, id)

		return relationship === undefined || relationship.external
			? undefined
			: { partName: relationship.target, contentType: services.contentType(relationship.target) }
	}
}

function rectangle(list: DrawingList, x: number, y: number, width: number, height: number, fill: number): void {
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	list.moveTo(x, y)
	list.lineTo(x + width, y)
	list.lineTo(x + width, y + height)
	list.lineTo(x, y + height)
	list.close()
	list.addItem(ItemKind.PATH, IDENTITY, x, y, width, height, firstCommand, firstCoord, fill, -1, -1, -1, 0, 0)
}

// A style fill holder (a:fill, a:tblBg): its fill element, else its fill reference into the theme.
function paintOf(context: PaintContext, reader: DrawingReader, holder: number): number | undefined {
	if (holder < 0) return undefined

	const own = readFillElement(context, reader, fillChild(reader, holder))

	if (own !== undefined) return own

	const ref = styleRef(context, reader, reader.child(holder, D.A, "fillRef"), "fill")

	return ref === undefined || ref.node < 0 ? undefined : readFillElement(context, ref.reader, ref.node, ref.color)
}

// A style border holder (a:left, a:insideH…): its a:ln, else its line reference; -1 for none.
function borderOf(context: PaintContext, reader: DrawingReader, holder: number): number {
	const ln = reader.child(holder, D.A, "ln")

	if (ln >= 0) return shapeLine(context, reader, ln, undefined)?.stroke ?? -1

	const ref = styleRef(context, reader, reader.child(holder, D.A, "lnRef"), "line")

	return ref === undefined ? -1 : (shapeLine(context, reader, -1, ref)?.stroke ?? -1)
}

interface EditedCell {
	readonly fill: number | undefined
	readonly borders: Map<Side, number>
}

// Typed cell properties (edits) as paints: written into one scratch document and read like source markup.
function editedProps(input: TableRenderInput, table: TableModel): Map<TableCell, EditedCell> {
	const out = new Map<TableCell, EditedCell>()
	const edited = table.rows.flatMap(row => row.cells).filter(cell => cell.props?.fill !== undefined || cell.props?.borders !== undefined)

	if (edited.length === 0) return out

	const writer = new ScratchWriter(input.services)
	const image: Parameters<typeof fillXml>[1] = fill =>
		fill.part !== undefined
			? writer.target(fill.part)
			: fill.inserted !== undefined
				? writer.target(`inserted:${String(fill.inserted)}`)
				: undefined

	for (const cell of edited) {
		const props = cell.props
		const borders = props?.borders

		writer.push("<a:tcPr>")

		for (const side of ["left", "right", "top", "bottom"] as const) {
			const key = side === "left" ? "l" : side === "right" ? "r" : side === "top" ? "t" : "b"
			const line = borders?.[key]

			if (line !== undefined)
				writer.push(
					lineXml(line, image)
						.replace(/^<a:ln/, `<a:${CELL_SIDES[side]}`)
						.replace(/<\/a:ln>$/, `</a:${CELL_SIDES[side]}>`)
				)
		}

		if (props?.fill !== undefined) writer.push(fillXml(props.fill, image))

		writer.push("</a:tcPr>")
	}

	const document = parseXml(new TextEncoder().encode(writer.finish()))
	const reader = drawingReader(document)
	const context: PaintContext = { ...input.context, images: id => writer.image(id) }
	let node = document.firstChildElement(document.documentElement())

	for (const cell of edited) {
		const borders = new Map<Side, number>()

		for (const side of ["left", "right", "top", "bottom"] as const) {
			const ln = reader.child(node, D.A, CELL_SIDES[side])

			if (ln >= 0) borders.set(side, shapeLine(context, reader, ln, undefined)?.stroke ?? -1)
		}

		const fill = cell.props?.fill === undefined ? undefined : readFillElement(context, reader, fillChild(reader, node))

		out.set(cell, { fill, borders })
		node = document.nextSiblingElement(node)
	}

	return out
}

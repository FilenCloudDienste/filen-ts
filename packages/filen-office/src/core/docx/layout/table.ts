import { spliceAll } from "../../arrays"
import { Item, RevisionView } from "../model/kinds"
import { Ns } from "../model/namespaces"
import type { StoryPart } from "../model/part"
import type {
	ResolvedBorder,
	ResolvedCellBorders,
	ResolvedShading,
	ResolvedTableBorders,
	ResolvedTableRowProps,
	TableCellProps,
	TablePositionProps,
	WidthProps
} from "../props/types"
import { shadingColor } from "../theme/color"
import { marginTwips } from "../styles/cellMargins"
import type { PropsStore } from "../props/store"
import type { CellFormat, ParagraphFormat, PropertyResolver, RowPosition, TableFormat } from "../styles/resolve"
import { ref, refItem, refPart } from "./edits"
import { Area, BlockFlow, byParity, FlowStatus, nextToken, type Engine, type FlowSnapshot } from "./flow"
import { PageGraphic, Layer, OutputMark, SourceFlag } from "./output"
import { borderWidth, shadingDark } from "./styles"
import { textDirectionLeftToRight, textDirectionTurn, textDirectionUpright, type TurnAngle } from "./turns"
import { EPSILON, twips } from "./units"

// Table layout: the grid from w:tblGrid (scaled to a percentage width), rows of cells laid out as block
// flows, vertical merges, row heights, borders with the heavier border winning a shared edge, header rows
// repeated on every page and rows split across pages unless w:cantSplit.

interface Slot {
	// The cell, and the part its row is laid out from.
	readonly item: number
	readonly part: StoryPart
	readonly format: CellFormat
	readonly column: number
	readonly span: number
	readonly x: number
	readonly width: number
	readonly continued: boolean
	// The cell's text runs sideways (w:textDirection, see turns.ts): 90 or 270, 0 for horizontal text. `mirrored`:
	// its lines follow each other left to right (tbLrV); `upright`: its East Asian characters stand upright.
	readonly turn: 0 | TurnAngle
	readonly mirrored: boolean
	readonly upright: boolean
	// Rows a vertical merge starting here spans (1 otherwise; -1 until counted).
	rows: number
}

// A vertical merge of sideways text: laid out once its last row is, from the top of the first row it spans on that
// page (`token` the area that top is in).
interface TurnedMerge {
	readonly slot: Slot
	top: number
	token: number
}

interface RowInfo {
	readonly item: number
	readonly table: TableFormat
	readonly props: ResolvedTableRowProps
	readonly slots: readonly Slot[]
	// Every paragraph of its cells is kept with the next (undefined until asked).
	keep: boolean | undefined
}

// A vertical merge's content in one area: the cell starting it, its output between `from` and `to`, from the
// top of the row it starts or resumes in (`exact`: that row's height is exact).
interface MergePart {
	readonly slot: Slot
	readonly from: OutputMark
	readonly to: OutputMark
	readonly top: number
	readonly token: number
	readonly exact: boolean
}

// Where a run of rows kept with the next began in an area (see TableLayout.run).
interface RowChain {
	readonly row: number
	readonly y: number
	readonly placed: number
	readonly footnotes: number
	readonly exclusions: number
	readonly token: number
	// It began at the area's top (or right under the header rows repeated there).
	readonly top: boolean
}

function widthPx(width: WidthProps | undefined, reference: number): number {
	if (width === undefined) return 0
	if (width.type === "dxa") return twips(width.value)
	if (width.type === "pct") return (width.value / 5000) * reference

	return 0
}

// Border numbers and precedence for resolving two borders on one edge, as Word does it (MS-OI29500 notes on
// ISO/IEC 29500-1 §17.4.66): the heavier border (width in eighths of a point times its number; dotted and
// dashed weigh 1) wins, then the style earlier in the precedence list, then the darker colour.
const BORDER_NUMBERS: Readonly<Record<string, number>> = {
	single: 1,
	thick: 2,
	double: 3,
	dotDash: 8,
	dotDotDash: 9,
	triple: 10,
	thinThickSmallGap: 11,
	thickThinSmallGap: 12,
	thinThickThinSmallGap: 13,
	thinThickMediumGap: 14,
	thickThinMediumGap: 15,
	thinThickThinMediumGap: 16,
	thinThickLargeGap: 17,
	thickThinLargeGap: 18,
	thinThickThinLargeGap: 19,
	wave: 20,
	doubleWave: 21,
	dashSmallGap: 22,
	dashDotStroked: 23,
	threeDEmboss: 24,
	threeDEngrave: 25,
	outset: 26,
	inset: 27
}

const BORDER_PRECEDENCE = [
	"single",
	"thick",
	"double",
	"dotted",
	"dashed",
	"dotDash",
	"dotDotDash",
	"triple",
	"thinThickSmallGap",
	"thickThinSmallGap",
	"thinThickThinSmallGap",
	"thinThickMediumGap",
	"thickThinMediumGap",
	"thinThickThinMediumGap",
	"thinThickLargeGap",
	"thickThinLargeGap",
	"thinThickThinLargeGap",
	"wave",
	"doubleWave",
	"dashSmallGap",
	"dashDotStroked",
	"threeDEmboss",
	"threeDEngrave",
	"outset",
	"inset"
]

function borderWeight(border: ResolvedBorder): number {
	if (border.style === "dotted" || border.style === "dashed") return 1

	return border.size * (BORDER_NUMBERS[border.style] ?? 1)
}

function precedence(style: string): number {
	const at = BORDER_PRECEDENCE.indexOf(style)

	return at < 0 ? BORDER_PRECEDENCE.length : at
}

// Brightness tests in turn: R + B + 2G, then B + 2G, then G (automatic colour is black).
function brightness(color: string | undefined, test: number): number {
	const value = color === undefined ? 0 : Number.parseInt(color, 16)
	const r = (value >> 16) & 255
	const g = (value >> 8) & 255
	const b = value & 255

	return test === 0 ? r + b + 2 * g : test === 1 ? b + 2 * g : g
}

// A border that draws a line (not nil or none), or undefined.
function visible(border: ResolvedBorder | undefined): ResolvedBorder | undefined {
	return border === undefined || border.style === "nil" || border.style === "none" ? undefined : border
}

// The border drawn where `a` (first in reading order) and `b` meet. A cell's "nil" hides both.
export function heavier(a: ResolvedBorder | undefined, b: ResolvedBorder | undefined): ResolvedBorder | undefined {
	if (a?.style === "nil" || b?.style === "nil") return undefined
	if (a === undefined) return b
	if (b === undefined || a === b) return a

	const weight = borderWeight(b) - borderWeight(a)

	if (weight !== 0) return weight > 0 ? b : a

	const style = precedence(b.style) - precedence(a.style)

	if (style !== 0) return style < 0 ? b : a

	for (let test = 0; test < 3; test++) {
		const difference = brightness(b.color, test) - brightness(a.color, test)

		if (difference !== 0) return difference < 0 ? b : a
	}

	return a
}

// Where a table's cells meet the edges and each other, the border the pages draw (and the reflowed view): the top
// of a cell first on its page (`first`: the table's first row), a cell's bottom (with the cell below it), its start
// edge (with the cell before it) and the end edge of a row's last cell.
export function topEdge(borders: ResolvedCellBorders, table: ResolvedTableBorders, first: boolean): ResolvedBorder | undefined {
	return first ? (borders.top ?? table.top) : (borders.top ?? table.insideH ?? table.top)
}

export function bottomEdge(
	borders: ResolvedCellBorders,
	table: ResolvedTableBorders,
	last: boolean,
	below: ResolvedCellBorders | undefined
): ResolvedBorder | undefined {
	const own = last ? (borders.bottom ?? table.bottom) : (borders.bottom ?? table.insideH)

	return below === undefined ? own : heavier(own, below.top)
}

export function startEdge(
	borders: ResolvedCellBorders,
	table: ResolvedTableBorders,
	previous: ResolvedCellBorders | undefined,
	first: boolean
): ResolvedBorder | undefined {
	return first ? (borders.start ?? table.start) : heavier(borders.start ?? table.insideV, previous?.end ?? table.insideV)
}

export function endEdge(borders: ResolvedCellBorders, table: ResolvedTableBorders): ResolvedBorder | undefined {
	return borders.end ?? table.end
}

// What fills a cell: its own shading when that paints anything, else the table's.
export function cellFill(cell: ResolvedShading | undefined, table: ResolvedShading | undefined): ResolvedShading | undefined {
	return cell !== undefined && shadingColor(cell.pattern, cell.color, cell.fill) !== undefined ? cell : table
}

// The table row `row` of the table at `table` of `part` is laid out with (its w:tblPrEx over the table's
// w:tblPr; `direct` the table's own), and the row's properties. `rowPart`: the part the row is laid out from
// (an edit's overlay).
export function rowFormat(
	resolver: PropertyResolver,
	store: PropsStore,
	part: StoryPart,
	table: number,
	row: number,
	direct: TableFormat,
	position: RowPosition,
	rowPart: StoryPart = part
): { readonly table: TableFormat; readonly props: ResolvedTableRowProps } {
	const document = rowPart.document
	const rowRow = rowPart.aux[row] ?? -1
	const tblPrEx = rowPart.rows.tblPrEx[rowRow] ?? -1
	const format =
		tblPrEx < 0
			? direct
			: resolver.table(
					store.tableLook(part.document, part.tables.tblPr[part.aux[table] ?? -1] ?? -1),
					store.tableLook(document, tblPrEx)
				)

	return { table: format, props: resolver.row(format, store.rowLook(document, rowPart.rows.trPr[rowRow] ?? -1), position) }
}

// A cell's format in its row (`own` its w:tcPr) from grid column `column` of `columns`, and the columns it spans
// (`span`: its own w:gridSpan unless given).
export function cellFormat(
	resolver: PropertyResolver,
	table: TableFormat,
	own: TableCellProps,
	position: RowPosition,
	column: number,
	columns: number,
	span: number = Math.max(1, own.gridSpan ?? 1)
): { readonly format: CellFormat; readonly span: number } {
	return {
		format: resolver.cell(table, own, { ...position, gridColumn: column, gridSpan: span, gridColumnCount: columns }),
		span
	}
}

// The cells of row `row` of `part` the revision view shows (all of them in the Markup view).
export function cellItems(part: StoryPart, row: number, view: RevisionView): number[] {
	const out: number[] = []

	for (let item = row + 1; item < part.end(row);) {
		const kind = part.kinds[item]

		if (kind === Item.Cell) {
			if (view === RevisionView.Markup || !part.hidden(item, view)) out.push(item)

			item = part.end(item)
		} else if (
			kind === Item.Sdt ||
			kind === Item.CustomXml ||
			kind === Item.AlternateContent ||
			kind === Item.Insertion ||
			kind === Item.Deletion
		) {
			item++
		} else {
			item = part.end(item)
		}
	}

	return out
}

// w:tblpPr with Word's defaults and adjustments (MS-OI29500 §17.4.57).
export interface FloatingTablePosition extends TablePositionProps {
	readonly horzAnchor: "text" | "margin" | "page"
	readonly vertAnchor: "text" | "margin" | "page"
	// Twips from the anchor.
	readonly x: number
	readonly y: number
}

// Word anchors a table horizontally to the text and vertically to the margin by default, ignores a tblpPr
// without attributes and one at 0, 0 from the text horizontally but not vertically, and places tables one
// twip before tblpX and tblpY (MS-OI29500 §17.4.57 a, b, e).
function floatingPosition(position: TablePositionProps | undefined): FloatingTablePosition | undefined {
	if (position === undefined || Object.values(position).every(value => value === undefined)) return undefined

	const horzAnchor = position.horzAnchor ?? "text"
	const vertAnchor = position.vertAnchor ?? "margin"
	const x = position.x ?? 0
	const y = position.y ?? 0

	if (
		x === 0 &&
		y === 0 &&
		horzAnchor === "text" &&
		vertAnchor !== "text" &&
		position.xSpec === undefined &&
		position.ySpec === undefined
	)
		return undefined

	return {
		...position,
		horzAnchor,
		vertAnchor,
		x: position.x === undefined ? 0 : x - 1,
		y: position.y === undefined ? 0 : y - 1
	}
}

// A table's state where a page opens between two of its rows, no row split and no vertical merge running on
// (see TableLayout.snapshot): layout can restart there. The grid stays as the table's first page set it.
export interface TableSnapshot {
	readonly row: number
	readonly headerRows: number
	readonly stalled: number
	// Rows were placed in the area before, and its header rows were repeated there.
	readonly placed: boolean
	readonly repeated: boolean
	readonly grid: readonly number[]
	readonly gridX: readonly number[]
	readonly left: number
	readonly width: number
	// The row split at the page before: its cells' flows (null for a cell it does not continue). Compared only,
	// to meet an earlier layout again: layout never restarts at such a page.
	readonly cells: readonly (FlowSnapshot | null)[] | undefined
}

// The rows of table `table` laid out in revision view `view`, appended to `out`.
export function tableRows(part: StoryPart, table: number, view: RevisionView, out: number[] = []): number[] {
	for (let item = table + 1; item < part.end(table);) {
		const kind = part.kinds[item]

		if (kind === Item.Row) {
			if (view === RevisionView.Markup || !part.hidden(item, view)) out.push(item)

			item = part.end(item)
		} else if (
			kind === Item.Sdt ||
			kind === Item.CustomXml ||
			kind === Item.AlternateContent ||
			kind === Item.Insertion ||
			kind === Item.Deletion
		) {
			item++
		} else {
			item = part.end(item)
		}
	}

	return out
}

// Token of a table resumed from a snapshot until its first area (no area has it).
const RESUMED = -2

// A point in px: how far a cell's preferred width may lie from its grid column before the grid is stale.
const POINT = twips(20)

// The index in `rows` (items of a table's rows, ascending) of the row holding `item`, or -1.
export function rowIndex(part: StoryPart, rows: readonly number[], item: number): number {
	let low = 0
	let high = rows.length - 1

	while (low <= high) {
		const mid = (low + high) >> 1

		if ((rows[mid] ?? 0) <= item) low = mid + 1
		else high = mid - 1
	}

	const row = rows[high]

	return row !== undefined && item < part.end(row) ? high : -1
}

// The rows of a table laid out in a revision view: its own, or the rows an edit gave it (some of overlay
// parts, see LayoutEdits.rows).
export class LaidRows {
	readonly part: StoryPart
	readonly items: number[] = []
	// Each row's part (undefined: all are the table's).
	readonly parts: StoryPart[] | undefined
	// Per part, its rows' items (ascending) and their indices, made when first asked.
	private byPart: Map<number, { readonly items: number[]; readonly rows: number[]; readonly part: StoryPart }> | undefined = undefined

	constructor(
		part: StoryPart,
		table: number,
		view: RevisionView,
		list: Float64Array | undefined,
		partOf: (index: number) => StoryPart | undefined
	) {
		this.part = part

		if (list === undefined) {
			tableRows(part, table, view, this.items)
			this.parts = undefined

			return
		}

		const parts: StoryPart[] = []

		for (const value of list) {
			const row = Number.isNaN(value) ? undefined : partOf(refPart(value))
			const item = refItem(value)

			if (row === undefined || (view !== RevisionView.Markup && row.hidden(item, view))) continue

			this.items.push(item)
			parts.push(row)
		}

		this.parts = parts
	}

	partAt(k: number): StoryPart {
		return this.parts?.[k] ?? this.part
	}

	// The index of the row holding item `item` of part `part`, or -1.
	indexOf(part: number, item: number): number {
		const parts = this.parts

		if (parts === undefined) return part === this.part.index ? rowIndex(this.part, this.items, item) : -1

		let byPart = this.byPart

		if (byPart === undefined) {
			byPart = new Map()

			for (let k = 0; k < parts.length; k++) {
				const row = parts[k]

				if (row === undefined) continue

				let entry = byPart.get(row.index)

				if (entry === undefined) {
					entry = { items: [], rows: [], part: row }
					byPart.set(row.index, entry)
				}

				entry.items.push(this.items[k] ?? -1)
				entry.rows.push(k)
			}

			// Rows moved by an edit may stand out of their part's order.
			for (const entry of byPart.values()) {
				let sorted = true

				for (let k = 1; k < entry.items.length && sorted; k++) sorted = (entry.items[k - 1] ?? 0) < (entry.items[k] ?? 0)

				if (sorted) continue

				const order = entry.items.map((_, k) => k).sort((a, b) => (entry.items[a] ?? 0) - (entry.items[b] ?? 0))
				const items = order.map(k => entry.items[k] ?? -1)
				const rows = order.map(k => entry.rows[k] ?? -1)

				spliceAll(entry.items, 0, items.length, items)
				spliceAll(entry.rows, 0, rows.length, rows)
			}

			this.byPart = byPart
		}

		const entry = byPart.get(part)

		if (entry === undefined) return -1

		const at = rowIndex(entry.part, entry.items, item)

		return at < 0 ? -1 : (entry.rows[at] ?? -1)
	}
}

// The rows table `item` of `part` is laid out with (see LaidRows).
export function laidRows(engine: Engine, part: StoryPart, item: number): LaidRows {
	return new LaidRows(part, item, engine.view, engine.edits?.rows?.get(ref(part.index, item)), index => engine.part(index))
}

export function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
	if (a === b) return true
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

export class TableLayout {
	readonly flow: BlockFlow
	readonly engine: Engine
	readonly part: StoryPart
	readonly item: number
	y = 0
	// Laid out as a floating table (w:tblpPr) at a position the flow chose: its own offset is applied.
	floated = false
	// Floated: past this bottom it cannot fit where it floats, and laying it out stops (tooTall).
	floatLimit = Infinity
	tooTall = false
	// Body rows placed in the current area (repeated header rows not counted).
	rowsPlaced = 0
	private readonly laid: LaidRows
	private readonly rows: number[]
	private readonly direct: TableFormat
	private readonly floating: FloatingTablePosition | undefined
	private grid: number[] = []
	private gridX: number[] = []
	private tableX = 0
	private tableWidth = 0
	private headerRows = 0
	// Areas in a row where no row went (none placed, none split): after two, the next row goes in however it
	// fits. Header rows repeated in an area that then left no room for a body row are not repeated in the next
	// one, where the row goes in at the top; the areas after it repeat them again (Word decides per page). So a
	// table always ends, whatever its rows.
	private stalled = 0
	private repeatedOn = -1
	private row = 0
	private continuing = false
	private token = -1
	private started = false
	private breakChecked = false
	private readonly infos = new Map<number, RowInfo>()
	private readonly pool: BlockFlow[] = []
	private readonly headerPool: BlockFlow[] = []
	private readonly cellArea = new Area()
	private readonly mark = new OutputMark()
	// Per grid column: where the content of a vertical merge ends, and the area (token) it ends in.
	private mergeBottoms: number[] = []
	private mergeTokens: number[] = []
	// Per grid column, a vertical merge whose content did not fit its page: it continues in the rows the
	// merge spans on the next page, and the area (token) it last ran in.
	private mergeFlows: (BlockFlow | undefined)[] = []
	private mergeAreas: number[] = []
	// Per grid column, the part of a vertical merge laid out in the area it last ran in (aligned where it ends).
	private mergeParts: (MergePart | undefined)[] = []
	// Per slot of the row laid out: it starts a vertical merge there.
	private readonly mergedSlots: boolean[] = []
	// Per grid column, a vertical merge of sideways text under way (see TurnedMerge).
	private turnedMerges: (TurnedMerge | undefined)[] = []
	// Rows kept with the next one placed in this area since the last row that is not: where they began, to move
	// them with a row that does not fit (see run).
	private chain: RowChain | undefined = undefined
	private readonly chainMark = new OutputMark()
	// Set while header rows are repeated on a page: their merges are their own and end at the last header row.
	// `cut`: a repeated header row did not fit (or a merge in them ran out of page).
	private repeating = false
	private cut = false
	private readonly cells = new Map<number, TableCellProps>()

	// `resume`: continues from a snapshot (see snapshot()) in a page's first area.
	constructor(flow: BlockFlow, part: StoryPart, item: number, area: Area, resume?: TableSnapshot) {
		const engine = flow.engine

		this.flow = flow
		this.engine = engine
		this.part = part
		this.item = item

		const tableRow = part.aux[item] ?? -1
		const tblPr = part.tables.tblPr[tableRow] ?? -1

		this.direct = engine.resolver.table(engine.store.tableLook(part.document, tblPr))
		this.floating = floatingPosition(this.direct.props.position)
		this.laid = laidRows(engine, part, item)
		this.rows = this.laid.items

		if (resume === undefined) {
			this.computeGrid(area)

			return
		}

		this.grid = resume.grid as number[]
		this.gridX = resume.gridX as number[]
		this.tableX = resume.left
		this.tableWidth = resume.width
		this.row = resume.row
		this.headerRows = resume.headerRows
		this.stalled = resume.stalled
		this.rowsPlaced = resume.placed ? 1 : 0
		// The area before is gone: a token no area has, the header rows repeated there or not.
		this.token = RESUMED
		this.repeatedOn = resume.repeated ? RESUMED : -1
		this.started = true
		this.breakChecked = true
	}

	// The state to continue from in the next page's first area, when a page opens now: undefined unless the
	// table flows with the text with no vertical merge running on (a split row's is for comparing only).
	snapshot(): TableSnapshot | undefined {
		if (!this.started || !this.breakChecked || this.repeating || this.floated || this.floating !== undefined) return undefined

		for (const flow of this.mergeFlows) if (flow !== undefined) return undefined

		let cells: (FlowSnapshot | null)[] | undefined

		if (this.continuing) {
			const info = this.info(this.row)

			if (info === undefined) return undefined

			cells = []

			for (const [k, slot] of info.slots.entries()) {
				const state = slot.continued ? null : this.pool[k]?.snapshot()

				if (state === undefined) return undefined

				cells.push(state)
			}
		}

		return {
			row: this.row,
			headerRows: this.headerRows,
			stalled: this.stalled,
			placed: this.rowsPlaced > 0,
			repeated: this.repeatedOn === this.token,
			grid: this.grid,
			gridX: this.gridX,
			left: this.tableX,
			width: this.tableWidth,
			cells
		}
	}

	// Whether item `item` of part `part` (in a cell) is laid out from here on: in a row not laid out yet, or a
	// header row the table repeats.
	ahead(part: number, item: number): boolean {
		if (this.laid.parts !== undefined) {
			const row = this.laid.indexOf(part, item)

			return row >= 0 && (row >= this.row || row < this.headerRows)
		}

		if (part !== this.part.index) return false

		const current = this.rows[this.row]

		if (current !== undefined && item >= current) return true

		const header = this.rows[this.headerRows - 1]

		return header !== undefined && item < this.part.end(header)
	}

	// The index among the rows laid out of the row holding item `item` of part `part`, or -1 (in no row laid
	// out).
	rowOf(part: number, item: number): number {
		return this.laid.indexOf(part, item)
	}

	private cellItems(part: StoryPart, row: number): number[] {
		return cellItems(part, row, this.engine.view)
	}

	private computeGrid(area: Area): void {
		const part = this.part
		const document = part.document
		const reader = part.reader
		const grid = this.grid
		const tableRow = part.aux[this.item] ?? -1
		const tblGrid = part.tables.tblGrid[tableRow] ?? -1

		if (tblGrid >= 0) {
			for (let child = document.firstChildElement(tblGrid); child >= 0; child = document.nextSiblingElement(child)) {
				if (document.localName(child) === "gridCol") grid.push(Math.max(0, twips(reader.int(child, Ns.W, "w", 0))))
			}
		}

		const props = this.direct.props
		const wanted = widthPx(props.width, area.width)
		// An autofit table is laid out from its cells' preferred widths (w:tcW); its w:tblGrid is only the grid last
		// computed from them (§17.4.53), stale in files from other generators. Per grid column the widest single
		// column cell's, while every cell gives one; cells spanning columns as (column, span, width).
		const preferred: number[] = []
		const spanned: number[] = []
		let usable = props.layout === "autofit"
		let columns = 0

		for (let k = 0; k < this.rows.length && k < 32; k++) {
			const row = this.rows[k] ?? -1
			const from = this.laid.partAt(k)
			const rowProps = this.engine.store.rowLook(from.document, from.rows.trPr[from.aux[row] ?? -1] ?? -1)
			let column = rowProps.gridBefore ?? 0

			for (const cell of this.cellItems(from, row)) {
				const own = this.cellProps(from, cell)
				const span = own.gridSpan ?? 1

				if (usable) {
					const width = widthPx(own.width, wanted > 0 ? wanted : area.width)

					if (width <= 0) usable = false
					else if (span <= 1) preferred[column] = Math.max(preferred[column] ?? 0, width)
					else spanned.push(column, span, width)
				}

				column += span
			}

			columns = Math.max(columns, column + (rowProps.gridAfter ?? 0))
		}

		while (grid.length < columns) grid.push(0)

		if (usable) this.preferGrid(preferred, spanned, wanted)

		const known = grid.reduce((sum, w) => sum + w, 0)
		const zero = grid.filter(w => w <= 0).length

		if (zero > 0) {
			const share = Math.max(0, (wanted > 0 ? wanted : area.width) - known) / zero

			for (let c = 0; c < grid.length; c++) if ((grid[c] ?? 0) <= 0) grid[c] = Math.max(share, 8)
		} else if (
			wanted > 0 &&
			known > 0 &&
			(props.width.type === "pct" || (props.layout === "fixed" && Math.abs(wanted - known) > 1) || wanted > known + 1)
		) {
			const scale = wanted / known

			for (let c = 0; c < grid.length; c++) grid[c] = (grid[c] ?? 0) * scale
		}

		let x = 0

		for (const w of grid) {
			this.gridX.push(x)
			x += w
		}

		this.tableWidth = x

		const firstMargin = twips(marginTwips(props.cellMargins.start))
		let left: number

		if (props.physicalAlignment === "center") left = area.left + (area.width - x) / 2
		else if (props.physicalAlignment === "right") left = area.left + area.width - x
		else {
			left = area.left + widthPx(props.indent, area.width)

			// Before Word 2013 the first cell's text, not its border, lines up with the indent.
			if (this.engine.compat.compatibilityMode < 15) left -= firstMargin
		}

		const position = this.floating

		if (position !== undefined) {
			const frame = area.frame
			const anchor = position.horzAnchor
			const start = anchor === "page" ? 0 : anchor === "margin" ? frame.marginLeft : area.left
			const size =
				anchor === "page" ? frame.width : anchor === "margin" ? frame.width - frame.marginLeft - frame.marginRight : area.width
			const align = position.xSpec

			if (byParity(align)) this.engine.parityReads++

			left =
				align === "center"
					? start + (size - x) / 2
					: align === "right" || (align === "outside" && frame.odd) || (align === "inside" && !frame.odd)
						? start + size - x
						: align === "left" || align === "inside" || align === "outside"
							? start
							: start + twips(position.x)
		}

		this.tableX = left
	}

	// Replaces the grid's columns with the cells' preferred widths (see computeGrid) when any differs from it by
	// more than a point: a cell spanning columns gives the columns no single column cell sized their share of what
	// those did not take. `wanted`: the table's preferred width (0 for none).
	private preferGrid(preferred: number[], spanned: readonly number[], wanted: number): void {
		const grid = this.grid

		for (let s = 0; s < spanned.length; s += 3) {
			const column = spanned[s] ?? 0
			const end = Math.min(grid.length, column + (spanned[s + 1] ?? 1))
			let taken = 0
			let open = 0

			for (let c = column; c < end; c++) {
				const width = preferred[c]

				if (width === undefined) open++
				else taken += width
			}

			const share = open > 0 ? ((spanned[s + 2] ?? 0) - taken) / open : 0

			if (share <= 0) continue

			for (let c = column; c < end; c++) if (preferred[c] === undefined) preferred[c] = share
		}

		let differs = false
		let total = 0

		for (let c = 0; c < grid.length; c++) {
			const width = preferred[c]

			total += width ?? grid[c] ?? 0

			if (width !== undefined && Math.abs(width - (grid[c] ?? 0)) > POINT) differs = true
		}

		// Cells wider or narrower together than the table's own preferred width are no truer than the grid.
		if (!differs || (wanted > 0 && Math.abs(total - wanted) > POINT)) return

		for (let c = 0; c < grid.length; c++) grid[c] = preferred[c] ?? grid[c] ?? 0
	}

	// w:tblpPr as Word applies it, when the table floats.
	get position(): FloatingTablePosition | undefined {
		return this.floating
	}

	get overlap(): "never" | "overlap" {
		return this.direct.props.overlap
	}

	// The table's left edge and width.
	get left(): number {
		return this.tableX
	}

	get width(): number {
		return this.tableWidth
	}

	// A cell's direct properties, parsed once (the grid reads the first rows before they are laid out).
	private cellProps(part: StoryPart, cell: number): TableCellProps {
		const key = ref(part.index, cell)
		let props = this.cells.get(key)

		if (props === undefined) {
			props = this.engine.store.cellLook(part.document, part.cells.tcPr[part.aux[cell] ?? -1] ?? -1)
			this.cells.set(key, props)
		}

		return props
	}

	private info(index: number): RowInfo | undefined {
		let info = this.infos.get(index)

		if (info !== undefined) return info

		const item = this.rows[index]

		if (item === undefined) return undefined

		const engine = this.engine
		const position = { rowIndex: index, rowCount: this.rows.length }
		const from = this.laid.partAt(index)
		const { table, props } = rowFormat(engine.resolver, engine.store, this.part, this.item, item, this.direct, position, from)
		const slots: Slot[] = []
		let column = props.gridBefore
		const bidi = this.direct.props.bidiVisual
		const cells = this.cellItems(from, item)

		for (let c = 0; c < cells.length; c++) {
			const cell = cells[c] ?? -1
			const direct = this.cellProps(from, cell)

			this.cells.delete(ref(from.index, cell))

			// A legacy horizontal merge (w:hMerge, §17.4.22): the cells continuing it widen the one starting it and
			// show nothing of their own.
			let own = Math.max(1, direct.gridSpan ?? 1)

			if (direct.hMerge === "restart") {
				while (c + 1 < cells.length) {
					const next = this.cellProps(from, cells[c + 1] ?? -1)

					if (next.hMerge !== "continue") break

					this.cells.delete(ref(from.index, cells[c + 1] ?? -1))
					own += Math.max(1, next.gridSpan ?? 1)
					c++
				}
			}

			const { format, span } = cellFormat(engine.resolver, table, direct, position, column, this.grid.length, own)
			const end = Math.min(this.grid.length, column + span)
			const start = this.gridX[Math.min(column, this.gridX.length - 1)] ?? 0
			const width = (this.gridX[end - 1] ?? start) + (this.grid[end - 1] ?? 0) - start

			slots.push({
				item: cell,
				part: from,
				format,
				column,
				span,
				x: bidi ? this.tableX + this.tableWidth - start - width : this.tableX + start,
				width: Math.max(1, width),
				continued: format.props.vMerge === "continue",
				turn: textDirectionTurn(format.props.textDirection),
				mirrored: textDirectionLeftToRight(format.props.textDirection),
				upright: textDirectionUpright(format.props.textDirection),
				rows: format.props.vMerge === "restart" ? -1 : 1
			})
			column += span
		}

		info = { item, table, props, slots, keep: undefined }
		this.infos.set(index, info)

		return info
	}

	// Rows a vertical merge starting at `slot` of row `index` spans, counted once (iteratively: rows are read
	// ahead without counting their own merges).
	private spanOf(index: number, slot: Slot): number {
		if (slot.rows >= 0) return slot.rows

		let rows = 1

		for (let next = index + 1; next < this.rows.length && rows < 4096; next++) {
			const below = this.info(next)?.slots.find(candidate => candidate.column === slot.column)

			if (below === undefined || !below.continued) break

			rows++
		}

		slot.rows = rows

		return rows
	}

	// Rows repeated at the top of every page (counted once the table began).
	get headerCount(): number {
		return this.headerRows
	}

	// The row layout continues at.
	get currentRow(): number {
		return this.row
	}

	// The header rows again at the top of a page, unless they do not fit it (as Word). A merge in them ends
	// with them (one running on into the body is drawn to the last header row), and the merges the body rows
	// continue are set aside meanwhile: the repeat neither runs them nor starts them over (which would never let
	// them end).
	private repeatHeaders(area: Area): void {
		const bottoms = this.mergeBottoms
		const tokens = this.mergeTokens
		const flows = this.mergeFlows
		const areas = this.mergeAreas
		const parts = this.mergeParts
		const turned = this.turnedMerges
		const top = this.y
		const mark = area.page.mark(new OutputMark())
		const footnotes = area.footnotes?.mark() ?? 0
		const exclusions = area.exclusions?.count ?? 0

		this.mergeBottoms = []
		this.mergeTokens = []
		this.mergeFlows = []
		this.mergeAreas = []
		this.mergeParts = []
		this.turnedMerges = []
		this.repeating = true
		this.cut = false

		try {
			for (let r = 0; r < this.headerRows; r++) this.layoutRow(area, r, this.headerPool, true, false)
		} finally {
			this.repeating = false
			this.mergeBottoms = bottoms
			this.mergeTokens = tokens
			this.mergeFlows = flows
			this.mergeAreas = areas
			this.mergeParts = parts
			this.turnedMerges = turned
		}

		if (!this.cut && this.y <= area.bottom + EPSILON) {
			this.repeatedOn = area.token

			return
		}

		area.page.rollback(mark)
		area.footnotes?.rollback(footnotes)

		if (area.exclusions !== null) area.exclusions.count = exclusions

		this.y = top
	}

	// Lays out rows from `top` until the table ends or the area is full.
	run(area: Area, top: number): FlowStatus {
		const page = area.page

		if (this.token !== area.token) {
			const fresh = !this.started

			if (!fresh) this.stalled = this.rowsPlaced === 0 ? this.stalled + 1 : 0

			const crowded = this.stalled > 0 && this.repeatedOn === this.token

			this.token = area.token
			this.rowsPlaced = 0
			this.y = top
			this.started = true
			this.chain = undefined

			if (!fresh && !crowded && this.headerRows > 0 && this.row >= this.headerRows && area.breaks) this.repeatHeaders(area)
		}

		if (this.row === 0 && !this.continuing && !this.breakChecked) {
			this.breakChecked = true

			while (this.headerRows < this.rows.length && this.info(this.headerRows)?.props.header === true) this.headerRows++

			// A page break before the table's first paragraph breaks before the table.
			if (area.breaks && !area.empty && this.firstParagraphBreaks()) return FlowStatus.PAGE_BREAK

			const position = this.floating

			if (!this.floated && position !== undefined && position.vertAnchor === "text" && position.ySpec === undefined && position.y > 0)
				this.y += twips(position.y)
		}

		let placed = 0
		// Rows kept with the next move together with the row that does not fit, in a table flowing with the text.
		const chains = area.breaks && !this.floated && this.floating === undefined

		while (this.row < this.rows.length) {
			const info = this.info(this.row)

			if (info === undefined || info.props.hidden) {
				this.row++

				continue
			}

			// Out of time between two rows: the area goes on in the next slice (a body table flowing with the text:
			// a floating one is laid out whole, again from its start).
			if (placed > 0 && this.flow.suspendable && !this.floated && this.engine.due) return FlowStatus.SUSPEND

			placed++
			page.mark(this.mark)

			// A row kept with the next one (not the rest of a split row) begins a chain unless one is under way.
			const keep = chains && this.keptWithNext(info)
			const chain =
				keep && this.chain === undefined && !this.continuing
					? {
							row: this.row,
							y: this.y,
							placed: this.rowsPlaced,
							footnotes: area.footnotes?.mark() ?? 0,
							exclusions: area.exclusions?.count ?? 0,
							token: area.token,
							top: this.rowsPlaced === 0 && (area.empty || this.stalled > 1)
						}
					: undefined
			const status = this.layoutRow(area, this.row, this.pool, false, this.continuing)

			if (status === FlowStatus.SUSPEND) return FlowStatus.SUSPEND

			if (status === FlowStatus.DONE) {
				if (!keep) this.chain = undefined
				else if (chain !== undefined) {
					this.chain = chain
					this.chainMark.copy(this.mark)
				}

				this.continuing = false
				this.infos.delete(this.row - 64)
				this.row++
				this.rowsPlaced++

				if (this.y > this.floatLimit) {
					this.tooTall = true

					return FlowStatus.OVERFLOW
				}

				continue
			}

			// The row moved whole to the next area: the rows kept with it go along (a split row keeps them on its page).
			if (this.continuing) this.chain = undefined
			else this.rollbackChain(area)

			return FlowStatus.OVERFLOW
		}

		return FlowStatus.DONE
	}

	private cellMargins(slot: Slot): { top: number; bottom: number; start: number; end: number } {
		const margins = slot.format.props.margins
		const px = (width: WidthProps): number => twips(marginTwips(width))

		return { top: px(margins.top), bottom: px(margins.bottom), start: px(margins.start), end: px(margins.end) }
	}

	// Word's cell spacing (w:tblCellSpacing, §17.4.44) in px, kept around every cell: cells lie that far in from
	// the table's edge and twice it apart. A table translated from OpenDocument lays its spacing out as
	// LibreOffice does instead (rowMargins).
	private spacing(info: RowInfo): number {
		if (this.engine.compat.libreOfficeSpacing) return 0

		const width = info.props.cellSpacing ?? info.table.props.cellSpacing

		return width === undefined ? 0 : Math.max(0, widthPx(width, this.tableWidth))
	}

	// The width a cell's content is laid out at.
	private cellWidth(slot: Slot, info: RowInfo): number {
		const margins = this.cellMargins(slot)

		return Math.max(1, slot.width - margins.start - margins.end - 2 * this.spacing(info))
	}

	// A cell's margins in row `index` with the room its horizontal borders take in a table translated from OpenDocument,
	// as LibreOffice lays it out (measured): with collapsing borders the border between two rows once, above the lower
	// row, and the table's bottom border under its last row; with separate borders (cell spacing) each cell's own top
	// and bottom. Word draws borders over the margins instead, with its cell spacing around them.
	private rowMargins(slot: Slot, info: RowInfo, index: number): { top: number; bottom: number; start: number; end: number } {
		const margins = this.cellMargins(slot)
		const spacing = this.spacing(info)

		if (spacing > 0) {
			margins.top += spacing
			margins.bottom += spacing
			margins.start += spacing
			margins.end += spacing

			return margins
		}

		if (!this.engine.compat.libreOfficeSpacing || slot.continued) return margins

		const table = info.table.props.borders
		const borders = slot.format.props.borders
		const last = index === this.rows.length - 1
		const width = (border: ResolvedBorder | undefined): number =>
			border === undefined || border.style === "nil" ? 0 : borderWidth(border)

		if (info.table.props.cellSpacing !== undefined) {
			margins.top += width(topEdge(borders, table, index === 0))
			margins.bottom += width(last ? (borders.bottom ?? table.bottom) : (borders.bottom ?? table.insideH))

			return margins
		}

		const above = index === 0 ? undefined : this.info(index - 1)?.slots.find(candidate => candidate.column === slot.column)

		margins.top += width(
			above === undefined ? topEdge(borders, table, index === 0) : bottomEdge(above.format.props.borders, table, false, borders)
		)

		if (last) margins.bottom += width(bottomEdge(borders, table, true, undefined))

		return margins
	}

	// Lays out one row (or the rest of a split row). DONE when it ended in the area; OVERFLOW when it moved
	// (nothing kept) or split (continuing); SUSPEND when fonts must load first (nothing kept).
	private layoutRow(area: Area, index: number, pool: BlockFlow[], header: boolean, continuing: boolean): FlowStatus {
		const engine = this.engine
		const info = this.info(index)
		const page = area.page

		if (info === undefined) return FlowStatus.DONE

		const top = this.y
		const props = info.props
		const exact = props.height?.rule === "exact"
		const rowMark = page.mark(new OutputMark())
		const atTop = this.rowsPlaced === 0 && (area.empty || header || this.stalled > 1)

		const footnoteMark = area.footnotes?.mark() ?? 0
		const exclusionMark = area.exclusions?.count ?? 0
		const missingBefore = engine.styles.hasMissing
		// The rest of a split row is laid out again when it needed fonts not loaded yet: its cells resume from
		// these (null for a cell without a flow; undefined, so no resuming, for one inside a nested table).
		const resume =
			continuing && this.flow.suspendable
				? info.slots.map((_, k) => {
						const flow = pool[k]

						return flow === undefined ? null : flow.snapshot()
					})
				: undefined
		// Merges continued in this row: their state before, to take back when the row is.
		const merges: { column: number; state: FlowSnapshot | undefined; area: number; bottom: number; token: number }[] = []
		// Merges starting in this row that did not fit: they continue on the next page once the row stays.
		const started: { slot: number; column: number }[] = []

		if (!continuing) {
			info.slots.forEach((slot, k) => {
				let flow = pool[k]

				if (flow === undefined) {
					flow = this.cellFlow()
					pool[k] = flow
				}

				if (!slot.continued) this.startCell(flow, slot, info)
				else flow.setRange(this.part, 0, 0)
			})
		}

		const cellArea = this.cellArea.copy(area)
		const token = nextToken()
		let overflow = false
		let anyPlaced = false
		let height = 0
		// Where each slot's output begins and ends (sideways text is laid out after the others, see layTurned).
		const cellMarks: OutputMark[] = []
		const cellEnds: OutputMark[] = []
		// Slots whose merge part (see mergeParts) began here: its end is the slot's end mark.
		const parts: number[] = []
		// Slots of sideways text, laid out once the row's height is known.
		const turned: number[] = []

		cellArea.breaks = false
		cellArea.inTable = true
		cellArea.token = token
		this.mergedSlots.length = 0

		const laySlot = (slot: Slot, k: number): void => {
			const flow = pool[k]
			const margins = this.rowMargins(slot, info, index)

			cellMarks.push(page.mark(new OutputMark()))
			this.mergedSlots.push(false)
			cellArea.left = slot.x + margins.start
			cellArea.width = Math.max(1, slot.width - margins.start - margins.end)
			cellArea.empty = atTop

			const merge = this.mergeFlows[slot.column]

			if (merge !== undefined && (slot.continued || continuing)) {
				this.mergedSlots[k] = true

				// A merge that ran out of page continues at the top of this page's first row it spans.
				if (this.mergeAreas[slot.column] === area.token) return

				merges.push({
					column: slot.column,
					state: merge.snapshot(),
					area: this.mergeAreas[slot.column] ?? -1,
					bottom: this.mergeBottoms[slot.column] ?? Number.NaN,
					token: this.mergeTokens[slot.column] ?? -1
				})
				cellArea.top = top
				cellArea.bottom = area.bottom - margins.bottom

				const before = page.text.lineCount

				merge.run(cellArea)

				if (page.text.lineCount > before) anyPlaced = true

				this.mergeAreas[slot.column] = area.token
				this.mergeBottoms[slot.column] = merge.contentBottom() + margins.bottom
				this.mergeTokens[slot.column] = area.token

				const part = this.mergeParts[slot.column]

				if (part !== undefined) {
					this.mergeParts[slot.column] = {
						...part,
						from: cellMarks[k] ?? part.from,
						to: new OutputMark(),
						top,
						token: area.token,
						exact
					}
					parts.push(k)
				}

				return
			}

			if (flow === undefined || slot.continued) return

			// Sideways text is laid out whole on the row's first page (the rest of a split row holds none of it).
			if (slot.turn !== 0) {
				if (!continuing) turned.push(k)

				return
			}

			cellArea.top = top + (continuing ? 0 : margins.top)

			const span = this.spanOf(index, slot)
			const merged = (this.repeating ? Math.min(span, this.headerRows - index) : span) > 1

			// A merge's content fills the rows it spans; what does not fit the page continues on the next.
			cellArea.bottom = exact ? Infinity : area.bottom - margins.bottom

			const before = page.text.lineCount
			const status = flow.run(cellArea)

			if (page.text.lineCount > before) anyPlaced = true

			const bottom = flow.contentBottom() + margins.bottom

			this.mergedSlots[k] = merged

			if (merged) {
				this.mergeBottoms[slot.column] = bottom
				this.mergeTokens[slot.column] = area.token
				this.mergeParts[slot.column] = {
					slot,
					from: cellMarks[k] ?? new OutputMark(),
					to: new OutputMark(),
					top,
					token: area.token,
					exact
				}
				parts.push(k)

				if (status === FlowStatus.OVERFLOW) started.push({ slot: k, column: slot.column })
			} else {
				if (status === FlowStatus.OVERFLOW) overflow = true

				height = Math.max(height, bottom - top)
			}
		}

		info.slots.forEach(laySlot)

		// Each slot ends where the next begins (sideways text laid out later gets marks of its own).
		const rowEnd = page.mark(new OutputMark())

		for (let k = 0; k < info.slots.length; k++) cellEnds.push(cellMarks[k + 1] ?? rowEnd)

		for (const k of parts) {
			const column = info.slots[k]?.column ?? -1
			const end = cellEnds[k]

			if (end !== undefined) this.mergeParts[column]?.to.copy(end)
		}

		// Sideways text needs the length its longest line takes, which the row grows to (in a merge, the rows it spans).
		for (const k of turned) {
			const slot = info.slots[k]
			const flow = pool[k]

			if (slot === undefined || flow === undefined) continue

			const margins = this.rowMargins(slot, info, index)
			const span = this.spanOf(index, slot)
			const merged = (this.repeating ? Math.min(span, this.headerRows - index) : span) > 1
			const length = exact && !merged ? 0 : this.measureTurned(area, info, flow, slot, margins, top, atTop)

			this.mergedSlots[k] = merged

			if (merged) {
				this.mergeBottoms[slot.column] = top + margins.top + length + margins.bottom
				this.mergeTokens[slot.column] = area.token
			} else {
				height = Math.max(height, margins.top + length + margins.bottom)
			}
		}

		for (const slot of info.slots) {
			if (!slot.continued) continue

			const column = slot.column
			const merged = this.mergeTokens[column] === area.token ? (this.mergeBottoms[column] ?? Number.NaN) : Number.NaN

			if (Number.isNaN(merged) || !this.lastOfMerge(index, column)) continue

			height = Math.max(height, merged - top)

			// The merge ends here with content left: the row splits so that it continues.
			if (this.mergeFlows[column]?.done === false && this.mergeAreas[column] === area.token) overflow = true
		}

		if (props.height !== undefined) {
			const h = twips(props.height.value)

			if (props.height.rule === "exact") height = h
			else height = Math.max(height, h)
		}

		// A row that needed fonts not loaded yet is laid out again once they are.
		const resumable =
			(!continuing || (resume !== undefined && resume.every(state => state !== undefined))) &&
			merges.every(entry => entry.state !== undefined)

		if (!missingBefore && this.flow.suspendable && engine.styles.hasMissing && resumable) {
			this.takeBack(area, info, merges, rowMark, footnoteMark, exclusionMark)

			if (resume !== undefined) {
				info.slots.forEach((slot, k) => {
					const state = resume[k]
					const flow = pool[k]

					if (state === undefined || state === null || flow === undefined || slot.continued) return

					cellArea.width = this.cellWidth(slot, info)
					flow.restore(state, cellArea)
				})
			}

			return FlowStatus.SUSPEND
		}

		// Kept with stand-ins for fonts still loading (it could not wait for them): its page is laid out again.
		if (this.flow.suspendable && engine.styles.hasMissing) engine.standIns = true

		const fits = !overflow && top + height <= area.bottom + EPSILON

		if (this.repeating && (!fits || started.length > 0)) this.cut = true

		if (!fits && !header) {
			const splittable = !props.cantSplit && !exact

			if (!atTop && (!splittable || !anyPlaced || !overflow)) {
				this.takeBack(area, info, merges, rowMark, footnoteMark, exclusionMark)

				return FlowStatus.OVERFLOW
			}

			if (overflow) {
				// Split: this part reaches the area's bottom, the rest continues on the next page.
				height = Math.max(0, area.bottom - top)
				this.keepMerges(area, pool, started)
				this.layTurned(area, info, index, pool, turned, cellMarks, cellEnds, top, height)
				this.drawRow(area, info, index, top, height, true)
				this.y = top + height
				this.continuing = true
				this.rowsPlaced++

				return FlowStatus.OVERFLOW
			}
		}

		this.keepMerges(area, pool, started)
		this.layTurned(area, info, index, pool, turned, cellMarks, cellEnds, top, height)
		this.alignCells(area, info, index, pool, cellMarks, cellEnds, top, height)

		// A row of exact height cuts what its cells hold beyond it (a merge's, where the merge ends).
		if (exact) {
			info.slots.forEach((slot, k) => {
				const from = cellMarks[k]
				const to = cellEnds[k]

				if (from !== undefined && to !== undefined && !slot.continued && this.mergedSlots[k] !== true)
					page.addClip(slot.x, top, slot.width, height, from.lines, to.lines, from.objects, to.objects)
			})
		}

		this.endMerges(area, info, index, top, height)
		this.endTurnedMerges(area, info, index, top, height)
		this.drawRow(area, info, index, top, height, false)
		this.y = top + height

		return FlowStatus.DONE
	}

	// Sets `flow` to lay out the cell of `slot` from its start.
	private startCell(flow: BlockFlow, slot: Slot, info: RowInfo): void {
		const fill = cellFill(slot.format.props.shading, info.table.props.shading)

		flow.setContainer(slot.part, slot.item, slot.format)
		flow.darkFill = (fill === undefined ? undefined : shadingDark(fill)) ?? this.flow.darkFill
		flow.lastFlags = SourceFlag.CELL_END

		// The row's end mark follows its last cell, on the side the row ends (a mirrored row's left).
		if (slot === info.slots[info.slots.length - 1]) {
			const first = info.slots[0]
			const mirrored = first !== undefined && first !== slot && first.x > slot.x

			flow.firstFlags = SourceFlag.ROW_END
			flow.rowEnd = mirrored ? slot.x : slot.x + slot.width
		}
	}

	// The scratch area sideways text of a cell is laid out in: its lines `length` long from (x, y), nothing below it
	// to stop at and no wrapping of the page's text around what it holds (its frame is not the page's).
	private turnedArea(area: Area, x: number, y: number, length: number): Area {
		const cellArea = this.cellArea.copy(area)

		cellArea.breaks = false
		cellArea.inTable = true
		cellArea.token = nextToken()
		cellArea.left = x
		cellArea.width = Math.max(1, length)
		cellArea.top = y
		cellArea.bottom = Infinity
		cellArea.empty = true
		cellArea.exclusions = null
		cellArea.bodyExclusions = null

		return cellArea
	}

	// The length the lines of sideways text in `slot` need, as Word grows the row to fit them: laid out as long as
	// the page allows (on a page with rows above it, a whole page's height, so that a row that cannot fit moves on),
	// the room its longest line left over taken off. The trial layout is taken back and the flow set to start over.
	private measureTurned(
		area: Area,
		info: RowInfo,
		flow: BlockFlow,
		slot: Slot,
		margins: { top: number; bottom: number; start: number },
		top: number,
		atTop: boolean
	): number {
		const page = area.page
		const frame = area.frame
		const body = frame.height - frame.marginTop - frame.marginBottom
		const left = area.bottom - top
		const room = !Number.isFinite(left) ? body : atTop ? left : Math.max(left, body)
		const length = Math.max(1, room - margins.top - margins.bottom)
		const mark = page.mark(new OutputMark())
		const footnotes = area.footnotes?.mark() ?? 0
		const layouter = this.engine.layouter
		const outer = layouter.leastFree

		layouter.leastFree = Infinity
		flow.run(this.turnedArea(area, slot.x + margins.start, top + margins.top, length))

		const free = layouter.leastFree

		layouter.leastFree = outer
		page.rollback(mark)
		area.footnotes?.rollback(footnotes)
		this.startCell(flow, slot, info)

		return free === Infinity ? 0 : Math.min(length, Math.max(0, length - free))
	}

	// Sideways text of the row's cells (`turned`), once the row's height is known: a cell starting a vertical merge
	// waits for the merge's last row (endTurnedMerges).
	private layTurned(
		area: Area,
		info: RowInfo,
		index: number,
		pool: BlockFlow[],
		turned: readonly number[],
		marks: OutputMark[],
		ends: OutputMark[],
		top: number,
		height: number
	): void {
		const page = area.page

		for (const k of turned) {
			const slot = info.slots[k]
			const flow = pool[k]

			if (slot === undefined || flow === undefined) continue

			if (this.mergedSlots[k] === true) {
				this.turnedMerges[slot.column] = { slot, top, token: area.token }

				continue
			}

			marks[k] = page.mark(new OutputMark())
			this.placeTurned(area, slot, flow, this.rowMargins(slot, info, index), top, top + height)
			ends[k] = page.mark(new OutputMark())
		}
	}

	// Lays out the sideways text of `slot` in its box between `top` and `bottom`: lines as long as the box is tall,
	// aligned across it (w:vAlign: top is where the first line is), then turned onto it.
	private placeTurned(
		area: Area,
		slot: Slot,
		flow: BlockFlow,
		margins: { top: number; bottom: number; start: number; end: number },
		top: number,
		bottom: number
	): void {
		if (slot.turn === 0) return

		const page = area.page
		const x = slot.x + margins.start
		const y = top + margins.top
		const across = Math.max(1, slot.width - margins.start - margins.end)
		const length = Math.max(1, bottom - y - margins.bottom)
		const mark = page.mark(new OutputMark())

		flow.run(this.turnedArea(area, x, y, length))

		if (slot.upright) page.uprightSince(mark, this.engine.styles.table)

		const align = slot.format.props.vAlign
		const free = across - (flow.contentBottom() - y)

		if ((align === "center" || align === "bottom") && free > EPSILON) page.move(mark, null, 0, align === "center" ? free / 2 : free)
		if (slot.mirrored) page.mirrorSince(mark, y, across)

		page.addTurn(slot.turn, x, y, across, length, mark)
	}

	// Where vertical merges of sideways text end in this row: their text laid out over the rows they span on this
	// page. A merge running on to the next page starts over at the top of its first row there.
	private endTurnedMerges(area: Area, info: RowInfo, index: number, top: number, height: number): void {
		for (const slot of info.slots) {
			if (!slot.continued) continue

			const entry = this.turnedMerges[slot.column]

			if (entry === undefined) continue

			if (entry.token !== area.token) {
				entry.top = top
				entry.token = area.token
			}

			if (!this.lastOfMerge(index, slot.column)) continue

			this.turnedMerges[slot.column] = undefined

			const start = entry.slot
			const flow = this.cellFlow()

			this.startCell(flow, start, info)
			this.placeTurned(area, start, flow, this.cellMargins(start), entry.top, top + height)
			this.diagonals(area, start, info, entry.top, top + height - entry.top)
		}
	}

	private cellFlow(): BlockFlow {
		return new BlockFlow(this.engine, { ...this.flow.story, breaksAsLines: true }, this.flow.region, false)
	}

	// Takes a row back: its output, notes and exclusions, and the merges it continued.
	private takeBack(
		area: Area,
		info: RowInfo,
		merges: readonly { column: number; state: FlowSnapshot | undefined; area: number; bottom: number; token: number }[],
		rowMark: OutputMark,
		footnoteMark: number,
		exclusionMark: number
	): void {
		area.page.rollback(rowMark)
		area.footnotes?.rollback(footnoteMark)

		if (area.exclusions !== null) area.exclusions.count = exclusionMark

		for (const entry of merges) {
			const flow = this.mergeFlows[entry.column]
			const slot = info.slots.find(candidate => candidate.column === entry.column)

			if (flow !== undefined && entry.state !== undefined && slot !== undefined) {
				this.cellArea.width = this.cellWidth(slot, info)
				flow.restore(entry.state, this.cellArea)
			}

			this.mergeAreas[entry.column] = entry.area
			this.mergeBottoms[entry.column] = entry.bottom
			this.mergeTokens[entry.column] = entry.token
		}
	}

	// Once a row stays: merges starting in it that did not fit continue later (their flows leave the pool),
	// and merges that ended are dropped.
	private keepMerges(area: Area, pool: BlockFlow[], started: readonly { slot: number; column: number }[]): void {
		for (const entry of started) {
			this.mergeFlows[entry.column] = pool[entry.slot]
			this.mergeAreas[entry.column] = area.token
			pool[entry.slot] = this.cellFlow()
		}

		for (let column = 0; column < this.mergeFlows.length; column++) {
			if (this.mergeFlows[column]?.done === true) this.mergeFlows[column] = undefined
		}
	}

	private firstParagraphBreaks(): boolean {
		const slot = this.info(0)?.slots[0]

		if (slot === undefined) return false

		const part = slot.part

		for (let item = slot.item + 1; item < part.end(slot.item); item++) {
			if (part.kinds[item] === Item.Paragraph) return this.paragraphProps(slot, item)?.pageBreakBefore === true
		}

		return false
	}

	// The properties paragraph `item` of a cell is laid out with (an edited one from its overlay).
	private paragraphProps(slot: Slot, item: number): ParagraphFormat["props"] | undefined {
		const part = slot.part
		const substitute = this.engine.edits?.substitutes.get(ref(part.index, item))
		const from = substitute === undefined ? part : this.engine.part(refPart(substitute))

		return from === undefined
			? undefined
			: this.engine.content.formatOf(from, substitute === undefined ? item : refItem(substitute), slot.format).props
	}

	// Every paragraph of the row's cells is kept with the next (w:keepNext): the row stays on the page of the row
	// after it, as Word keeps rows selected and set to keep with the next together.
	private keptWithNext(info: RowInfo): boolean {
		if (info.keep !== undefined) return info.keep

		let keep = false

		cells: for (const slot of info.slots) {
			if (slot.continued) continue

			const part = slot.part

			for (let item = slot.item + 1; item < part.end(slot.item); item++) {
				if (part.kinds[item] !== Item.Paragraph) continue

				keep = this.paragraphProps(slot, item)?.keepNext === true

				if (!keep) break cells
			}
		}

		info.keep = keep

		return keep
	}

	// The rows kept with the next that end the table in area `area` (their chain), undefined when it does not end
	// with any there: they stay with the block after the table (see BlockFlow.keepTableRows).
	keptRows(area: Area): { readonly placed: number; readonly y: number; readonly top: boolean } | undefined {
		const chain = this.chain

		return chain !== undefined && chain.token === area.token && this.row >= this.rows.length ? chain : undefined
	}

	// The block after the table does not fit with the rows that end it: they move to the next area, from where
	// the table goes on (see rollbackChain).
	moveKeptRows(area: Area): boolean {
		return this.rollbackChain(area)
	}

	// Moves the rows kept with the next placed in this area since `chain` began to the next area; false when
	// there are none or they began at its top (they cannot move anywhere better) or a merge runs on past them.
	private rollbackChain(area: Area): boolean {
		const chain = this.chain

		this.chain = undefined

		if (chain === undefined || chain.token !== area.token || chain.top) return false

		for (const flow of this.mergeFlows) if (flow !== undefined) return false

		area.page.rollback(this.chainMark)
		area.footnotes?.rollback(chain.footnotes)

		if (area.exclusions !== null) area.exclusions.count = chain.exclusions

		this.row = chain.row
		this.y = chain.y
		this.rowsPlaced = chain.placed

		return true
	}

	private lastOfMerge(index: number, column: number): boolean {
		if (this.repeating && index >= this.headerRows - 1) return true

		const next = this.info(index + 1)
		const slot = next?.slots.find(candidate => candidate.column === column)

		return slot === undefined || !slot.continued
	}

	// Cell vertical alignment once the row's height is known.
	private alignCells(
		area: Area,
		info: RowInfo,
		index: number,
		pool: BlockFlow[],
		marks: OutputMark[],
		ends: OutputMark[],
		top: number,
		height: number
	): void {
		const page = area.page

		info.slots.forEach((slot, k) => {
			const align = slot.format.props.vAlign
			const flow = pool[k]
			const from = marks[k]
			const to = ends[k]

			// A merge is aligned across the rows it spans where it ends (endMerges); sideways text across its cell
			// (placeTurned).
			if (
				(align !== "center" && align !== "bottom") ||
				flow === undefined ||
				from === undefined ||
				to === undefined ||
				slot.continued ||
				slot.turn !== 0 ||
				this.mergedSlots[k] === true
			)
				return

			const margins = this.rowMargins(slot, info, index)
			const free = top + height - margins.bottom - flow.contentBottom()

			if (free <= EPSILON) return

			page.move(from, to, 0, align === "center" ? free / 2 : free)
		})
	}

	// Where vertical merges end in this row with all their content laid out: their content aligned across the rows
	// they span in this area (w:vAlign of the cell starting them), cut at an exact height and their diagonal
	// borders drawn. A merge running on to the next area is aligned there, its earlier parts at their tops.
	private endMerges(area: Area, info: RowInfo, index: number, top: number, height: number): void {
		const page = area.page

		for (const slot of info.slots) {
			if (!slot.continued) continue

			const column = slot.column
			const part = this.mergeParts[column]

			if (
				part === undefined ||
				part.token !== area.token ||
				this.mergeTokens[column] !== area.token ||
				this.mergeFlows[column] !== undefined ||
				!this.lastOfMerge(index, column)
			)
				continue

			this.mergeParts[column] = undefined

			const start = part.slot
			const align = start.format.props.vAlign
			const bottom = top + height
			const free = bottom - (this.mergeBottoms[column] ?? bottom)

			if ((align === "center" || align === "bottom") && free > EPSILON)
				page.move(part.from, part.to, 0, align === "center" ? free / 2 : free)

			if (part.exact)
				page.addClip(
					start.x,
					part.top,
					start.width,
					bottom - part.top,
					part.from.lines,
					part.to.lines,
					part.from.objects,
					part.to.objects
				)

			this.diagonals(area, start, info, part.top, bottom - part.top)
		}
	}

	// A cell's diagonal borders (w:tl2br, w:tr2bl, §17.4.79-80) corner to corner of its box.
	private diagonals(area: Area, slot: Slot, info: RowInfo, top: number, height: number): void {
		const borders = slot.format.props.borders
		const down = visible(borders.tl2br)
		const up = visible(borders.tr2bl)

		if (down === undefined && up === undefined) return

		const spacing = this.spacing(info)
		const x = slot.x + spacing
		const y = top + spacing
		const width = slot.width - 2 * spacing
		const tall = height - 2 * spacing

		if (width <= 0 || tall <= 0) return

		const decorations = this.engine.decorations

		if (down !== undefined) area.page.addGraphic(PageGraphic.DIAGONAL_DOWN, decorations.border(down), Layer.TEXT, x, y, width, tall)
		if (up !== undefined) area.page.addGraphic(PageGraphic.DIAGONAL_UP, decorations.border(up), Layer.TEXT, x, y, width, tall)
	}

	// A row of a table with Word's cell spacing (see spacing): the table's fill and outer border around it, and
	// in it every cell's own fill and four borders, inset by the spacing and shared with no other cell.
	private drawSpaced(area: Area, info: RowInfo, index: number, top: number, height: number, split: boolean, spacing: number): void {
		const page = area.page
		const decorations = this.engine.decorations
		const table = info.table.props.borders
		const first = index === 0 || this.rowsPlaced === 0
		const last = index === this.rows.length - 1 || split
		const next = last ? undefined : this.info(index + 1)
		const bidi = this.direct.props.bidiVisual
		const line = (border: ResolvedBorder | undefined, x: number, y: number, horizontal: boolean, length: number): void => {
			if (border === undefined || border.style === "nil" || length <= 0) return

			const width = borderWidth(border)

			page.addGraphic(
				PageGraphic.BORDER,
				decorations.border(border),
				Layer.TEXT,
				horizontal ? x : x - width / 2,
				horizontal ? y - width / 2 : y,
				horizontal ? length : width,
				horizontal ? width : length
			)
		}
		const left = this.tableX
		const right = left + this.tableWidth
		const fill = decorations.shading(info.table.props.shading)

		if (fill !== 0) page.addGraphic(PageGraphic.SHADING, fill, Layer.BEHIND, left, top, this.tableWidth, height)

		if (first) line(table.top, left, top, true, this.tableWidth)
		if (last) line(table.bottom, left, top + height, true, this.tableWidth)

		line(bidi ? table.end : table.start, left, top, false, height)
		line(bidi ? table.start : table.end, right, top, false, height)

		info.slots.forEach((slot, k) => {
			const borders = slot.format.props.borders
			const x = slot.x + spacing
			const width = slot.width - 2 * spacing

			if (width <= 0) return

			// A merge's cells join up: no spacing between the rows it spans.
			const below = next?.slots.find(candidate => candidate.column === slot.column)
			const merged = below?.continued === true
			const y = slot.continued ? top : top + spacing
			const bottom = merged ? top + height : top + height - spacing
			const own = slot.format.props.shading
			const shading = own === undefined || shadingColor(own.pattern, own.color, own.fill) === undefined ? 0 : decorations.shading(own)

			if (shading !== 0) page.addGraphic(PageGraphic.SHADING, shading, Layer.BEHIND, x, y, width, bottom - y)

			if (!slot.continued) line(topEdge(borders, table, index === 0), x, y, true, width)

			if (!merged) line(last ? (borders.bottom ?? table.bottom) : (borders.bottom ?? table.insideH), x, bottom, true, width)

			const start = borders.start ?? (k === 0 ? table.start : table.insideV)
			const end = borders.end ?? (k === info.slots.length - 1 ? table.end : table.insideV)

			line(start, bidi ? x + width : x, y, false, bottom - y)
			line(end, bidi ? x : x + width, y, false, bottom - y)
		})
	}

	private drawRow(area: Area, info: RowInfo, index: number, top: number, height: number, split: boolean): void {
		info.slots.forEach((slot, k) => {
			if (!slot.continued && this.mergedSlots[k] !== true) this.diagonals(area, slot, info, top, height)
		})

		const spacing = this.spacing(info)

		if (spacing > 0) {
			this.drawSpaced(area, info, index, top, height, split, spacing)

			return
		}

		const page = area.page
		const decorations = this.engine.decorations
		const tableBorders = info.table.props.borders
		const first = index === 0 || this.rowsPlaced === 0
		const last = index === this.rows.length - 1 || split
		const next = last ? undefined : this.info(index + 1)
		const bidi = this.direct.props.bidiVisual
		// Translated from OpenDocument, horizontal borders lie in the room rowMargins gives them: under the line they start
		// from (`inward` 1), or over it (-1).
		const odf = this.engine.compat.libreOfficeSpacing
		const separate = odf && info.table.props.cellSpacing !== undefined
		const line = (border: ResolvedBorder | undefined, x: number, y: number, horizontal: boolean, length: number, inward = 0): void => {
			if (border === undefined || border.style === "nil" || length <= 0) return

			const width = borderWidth(border)

			page.addGraphic(
				PageGraphic.BORDER,
				decorations.border(border),
				Layer.TEXT,
				horizontal ? x : x - width / 2,
				horizontal ? y - width / 2 + (odf ? (inward * width) / 2 : 0) : y,
				horizontal ? length : width,
				horizontal ? width : length
			)
		}

		info.slots.forEach((slot, k) => {
			const borders = slot.format.props.borders
			const fill = decorations.shading(cellFill(slot.format.props.shading, info.table.props.shading))

			if (fill !== 0) page.addGraphic(PageGraphic.SHADING, fill, Layer.BEHIND, slot.x, top, slot.width, height)

			if (separate) {
				if (!slot.continued) line(topEdge(borders, tableBorders, index === 0), slot.x, top, true, slot.width, 1)

				line(
					last ? (borders.bottom ?? tableBorders.bottom) : (borders.bottom ?? tableBorders.insideH),
					slot.x,
					top + height,
					true,
					slot.width,
					-1
				)
			} else {
				if (first && !slot.continued) line(topEdge(borders, tableBorders, index === 0), slot.x, top, true, slot.width, 1)

				const below = next?.slots.find(candidate => candidate.column === slot.column)

				if (below === undefined || !below.continued)
					line(
						bottomEdge(borders, tableBorders, last, below?.format.props.borders),
						slot.x,
						top + height,
						true,
						slot.width,
						last ? -1 : 1
					)
			}

			// The start edge is the right one in a right-to-left table (w:bidiVisual).
			line(
				startEdge(borders, tableBorders, info.slots[k - 1]?.format.props.borders, k === 0),
				bidi ? slot.x + slot.width : slot.x,
				top,
				false,
				height
			)

			if (k === info.slots.length - 1) line(endEdge(borders, tableBorders), bidi ? slot.x : slot.x + slot.width, top, false, height)
		})
	}
}

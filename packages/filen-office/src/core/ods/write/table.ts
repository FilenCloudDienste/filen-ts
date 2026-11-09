import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../sheet/protocol"
import { ColFlag, RowFlag, rowRunAt, type XlsxColRange, type XlsxSheetEntry, type XlsxSheetModel } from "../../xlsx/model/types"
import { decodeUtf8, escapeAttribute } from "../../xml/index"
import type { OdsCellStyles } from "../styles/cell"
import type { OdsSourceRowProps, OdsTableSource } from "../source"
import { SourceAxis } from "./axis"
import { CellRefused, cellMarkup, sameContent, Value, type CellValue } from "./cells"
import { decodeRows, type DecodedRows } from "./decode"
import type { SheetView } from "./sheet"
import type { OdsStyleWriter } from "./styles"
import { annotationMarkup, NO_FEATURES, type SheetFeatures } from "./features"
import { tagAttribute, tagAttributes } from "./stream"
import { DEFAULT_ROW_PT } from "../read/sheet"
import { patchAttributes, type Shifter } from "../unheld"

// One table:table as the writer emits it. A source row element whose rows an edit left alone is copied as its bytes;
// a repeated one an edit cut into is split into copies of itself around what changed; a changed row is written
// again, every cell the model holds as the source did copied as its bytes, a repeated cell split the same way. Rows
// and columns an edit inserted are written from the model, deleted ones left out.

const encoder = new TextEncoder()
const decoder = { decode: (bytes: Uint8Array): string => decodeUtf8(bytes) }

// What a new table holds beyond the model (a conversion's page setup and conditional formats).
export interface NewTable {
	// The master page its style names (ODF 1.3 Part 3 §16.9), else "Default".
	readonly masterPage?: string
	// Rows and columns a new page starts at (fo:break-before, §20.191).
	readonly rowBreaks?: ReadonlySet<number>
	readonly colBreaks?: ReadonlySet<number>
	// Rows and columns repeated on every printed page (table:table-header-rows, -columns, §9.1.7, §9.1.12).
	readonly titleRows?: TitleSpan | null
	readonly titleCols?: TitleSpan | null
	// Frames anchored to cells (draw:frame, ODF 1.3 Part 3 §10.4.3), by "row,col": markup each cell holds.
	readonly frames?: ReadonlyMap<string, string>
	// Markup it ends with (after its rows and names).
	readonly end?: string
}

export interface TitleSpan {
	readonly first: number
	readonly last: number
}

export const NO_NEW_TABLE: NewTable = {}

export interface TableContext {
	readonly styles: OdsStyleWriter
	readonly cellStyles: OdsCellStyles
	readonly prefixes: ReadonlyMap<string, string>
	// Days from 1970-01-01 to the null date.
	readonly nullDate: number
	readonly calcext: boolean
}

// A run of a source row element's rows, as written.
type Decision =
	| { readonly kind: "copy"; readonly count: number }
	| {
			readonly kind: "props"
			readonly count: number
			readonly first: number
			readonly props: { readonly heightPt: number; readonly flags: number }
	  }
	// `count` rows alike from `target` (rows a column edit moved the cells of): written once, repeated.
	| { readonly kind: "rewrite"; readonly target: number; readonly count: number }
	| { readonly kind: "fresh"; readonly from: number; readonly to: number }

interface SourceRowProps {
	readonly heightPt: number
	readonly custom: boolean
	readonly pageBreak: boolean
	readonly hidden: boolean
	readonly outline: number
}

const NO_ROW_PROPS: OdsSourceRowProps = {
	heightPt: Number.NaN,
	custom: false,
	pageBreak: false,
	hidden: false,
	outline: 0,
	defaultCellStyle: undefined
}

interface CellExtras {
	readonly note: string | undefined
	readonly link: string | undefined
	readonly validation: string | undefined
	readonly kept: string
	// The source's formula the model holds only the result of, where the cell holds that result still.
	readonly formula?: string | undefined
}

const NO_EXTRAS: CellExtras = { note: undefined, link: undefined, validation: undefined, kept: "" }

// A cell element of a source row: its bytes in the row, the source columns it covers, its start tag's end.
interface SourceCell {
	readonly start: number
	readonly end: number
	readonly openEnd: number
	readonly first: number
	readonly repeat: number
	readonly covered: boolean
	readonly empty: boolean
}

function setAttribute(tag: string, name: string, value: string | undefined): string {
	const pattern = new RegExp(`\\s${name.replace(".", "\\.")}="[^"]*"`)
	const close = tag.endsWith("/>") ? "/>" : ">"
	const without = tag.replace(pattern, "")

	if (value === undefined) return without

	return `${without.slice(0, without.length - close.length)} ${name}="${escapeAttribute(value)}"${close}`
}

// The start tag of an element's bytes, and where it ends.
function startTag(bytes: Uint8Array): { tag: string; end: number } {
	let quote = 0

	for (let k = 1; k < bytes.length; k++) {
		const b = bytes[k]

		if (quote !== 0) {
			if (b === quote) quote = 0
		} else if (b === 34 || b === 39) {
			quote = b
		} else if (b === 62) {
			return { tag: decoder.decode(bytes.subarray(0, k + 1)), end: k + 1 }
		}
	}

	throw new Error("A start tag is not closed")
}

// The cell elements of a row element (its bytes), in order.
function sourceCells(row: Uint8Array, cellName: Uint8Array, coveredName: Uint8Array): SourceCell[] {
	return scanCells(row, cellName, coveredName).cells
}

// The end of the tag starting at `lt` (its ">"), past quoted attribute values; -1 for none.
function tagEnd(row: Uint8Array, lt: number): number {
	let from = lt + 1

	for (;;) {
		const gt = row.indexOf(62, from)

		if (gt < 0) return -1

		let quote = from

		while (quote < gt && row[quote] !== 34 && row[quote] !== 39) quote++

		if (quote === gt) return gt

		const close = row.indexOf(row[quote] ?? 34, quote + 1)

		if (close < 0) return -1

		from = close + 1
	}
}

// A source row's cells, and whether anything in it ties a cell to its column or to another part (a formula, a merge,
// a validation, a note, a link).
function scanCells(row: Uint8Array, cellName: Uint8Array, coveredName: Uint8Array): { cells: SourceCell[]; bound: boolean } {
	const out: SourceCell[] = []
	let bound = false
	const { end: openEnd } = startTag(row)
	let depth = 0
	let at = openEnd
	let col = 0
	let current: { start: number; openEnd: number; repeat: number; covered: boolean } | null = null

	if (row[openEnd - 2] === 47) return { cells: out, bound }

	while (at < row.length) {
		const lt = row.indexOf(60, at)

		if (lt < 0) break

		const end = tagEnd(row, lt)
		const gt = end < 0 ? row.length : end

		const next = row[lt + 1]

		if (next === 33 || next === 63) {
			// A comment or processing instruction: past it.
			const close =
				next === 33 && row[lt + 2] === 45 ? findBytes(row, "-->", lt + 4) : findBytes(row, next === 63 ? "?>" : ">", lt + 2)

			at = close < 0 ? row.length : close

			continue
		}

		const empty = row[gt - 1] === 47

		if (next === 47) {
			depth--

			if (depth === 0 && current !== null) {
				out.push({ ...current, end: gt + 1, first: col, empty: false })
				col += current.repeat
				current = null
			}

			if (depth < 0) break
		} else {
			if (depth === 0) {
				const tag = row.subarray(lt, gt + 1)
				const covered = startsWithName(tag, coveredName)

				if (covered || startsWithName(tag, cellName)) {
					const info = cellTag(tag)
					const repeat = info.repeat

					if (covered || info.bound) bound = true

					if (empty) {
						out.push({ start: lt, end: gt + 1, openEnd: gt + 1, first: col, repeat, covered, empty: true })
						col += repeat
					} else {
						current = { start: lt, openEnd: gt + 1, repeat, covered }
					}
				}
			}

			// Inside a cell: a note or a link.
			if (depth > 0 && !bound) bound = boundElement(row, lt + 1)

			if (!empty) depth++
		}

		at = gt + 1
	}

	return { cells: out, bound }
}

const REPEATED = new TextEncoder().encode("table:number-columns-repeated=")
const FORMULA = new TextEncoder().encode(":formula=")
const SPANNED = new TextEncoder().encode("-spanned=")
const VALIDATION = new TextEncoder().encode(":content-validation-name=")

// A cell's start tag: its number-columns-repeated (1 without one), and whether it names a formula, a span or a
// validation. Read from its bytes alone.
function cellTag(tag: Uint8Array): { repeat: number; bound: boolean } {
	let repeat = 1
	let bound = false

	for (let at = 0; at < tag.length; at++) {
		const byte = tag[at]

		if ((byte === 32 || byte === 9 || byte === 10 || byte === 13) && startsAt(tag, at + 1, REPEATED)) {
			let value = 0
			let k = at + 1 + REPEATED.length + 1

			// Clamped at the grid's width: a repeat past it reaches no column more.
			for (; tag[k] !== undefined && (tag[k] ?? 0) >= 48 && (tag[k] ?? 0) <= 57; k++)
				value = Math.min(value * 10 + (tag[k] ?? 0) - 48, SHEET_MAX_COLS)

			repeat = Math.max(1, value)
		} else if (byte === 58 && (startsAt(tag, at, FORMULA) || startsAt(tag, at, VALIDATION))) bound = true
		else if (byte === 45 && startsAt(tag, at, SPANNED)) bound = true
	}

	return { repeat, bound }
}
const ANNOTATION = new TextEncoder().encode("annotation")

// Whether the element whose name starts at `at` is a note (*:annotation, *:annotation-end) or a link (*:a).
function boundElement(row: Uint8Array, at: number): boolean {
	let colon = at

	while (colon < row.length && row[colon] !== 58 && row[colon] !== 32 && row[colon] !== 62 && row[colon] !== 47) colon++

	if (row[colon] !== 58) return false

	const next = row[colon + 2]

	if (row[colon + 1] === 97 && (next === 32 || next === 62 || next === 47 || next === 9 || next === 10 || next === 13)) return true

	return startsAt(row, colon + 1, ANNOTATION)
}

function findBytes(bytes: Uint8Array, text: string, from: number): number {
	for (let k = from; k + text.length <= bytes.length; k++) {
		let match = true

		for (let j = 0; j < text.length && match; j++) match = bytes[k + j] === text.charCodeAt(j)

		if (match) return k + text.length
	}

	return -1
}

function startsWithName(tag: Uint8Array, name: Uint8Array): boolean {
	for (let k = 0; k < name.length; k++) if (tag[k + 1] !== name[k]) return false

	const after = tag[name.length + 1]

	return after === 32 || after === 9 || after === 10 || after === 13 || after === 47 || after === 62
}

function rowOutline(flags: number): number {
	return (flags & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT
}

function colOutline(flags: number): number {
	return (flags & ColFlag.OUTLINE_MASK) >> ColFlag.OUTLINE_SHIFT
}

// Column groups shown collapsed, as start * 16 + level: Excel marks the summary column after a collapsed group
// (col@collapsed, ECMA-376 Part 1 §18.3.1.13), ODF the group itself (table:display, ODF 1.3 Part 3 §19.614).
// `ranges` ascend.
function collapsedColumnGroups(ranges: readonly XlsxColRange[]): Set<number> {
	const groups = new Set<number>()

	for (let k = 0; k < ranges.length; k++) {
		const range = ranges[k]

		if (range === undefined || (range.flags & ColFlag.COLLAPSED) === 0) continue

		const level = colOutline(range.flags) + 1
		let start = range.first

		for (let j = k - 1; j >= 0; j--) {
			const before = ranges[j]

			if (before === undefined || before.last + 1 !== start || colOutline(before.flags) < level) break

			start = before.first
		}

		if (start < range.first) groups.add(start * 16 + level)
	}

	return groups
}

// Rows of a table written from the model joined into one piece of the stream.
const ROWS_PER_PIECE = 512

export class TableWriter {
	private readonly context: TableContext
	readonly entry: XlsxSheetEntry
	readonly model: XlsxSheetModel
	readonly view: SheetView
	readonly source: OdsTableSource | null
	private readonly rowAxis: SourceAxis
	private readonly colAxis: SourceAxis
	// Target rows written so far (the next one to write).
	private nextTarget = 0
	// Source rows gone through.
	private sourceRow = 0
	// The source's columns (table:table-column elements and their wrappers) as written, for reading rows back.
	columnsMarkup: Uint8Array = new Uint8Array(0)
	// How many columns the source declares (its table:table-column repeats).
	sourceColumns = 0
	private readonly cellName = encoder.encode("table:table-cell")
	private readonly coveredName = encoder.encode("table:covered-table-cell")
	// Decisions for the row element under way.
	private pending: Decision[] = []
	private pendingProps: SourceRowProps | null = null
	// Whether a cell of this sheet may differ from its source although no row is marked (columns moved), and the row
	// from which cells shifted in a band may.
	private readonly columnsMoved: boolean
	private readonly movedFrom: number
	// The columns are through: rows come next.
	hasRowsStarted = false
	// Some row of the table was written.
	private rowsWritten = false
	// A source row dropped or written otherwise: the heights a reader counts for its default may have changed.
	private rowsChanged = false
	// Row elements written from the model, in the order they go out, for the save's proof of what it changed alone
	// (span.ts); null once that cannot prove it (too many, or a source element's rows not adding up).
	spanRows: SpanRow[] | null = []
	// The table:table-column elements written in place of the source's (columns moved or changed), null for none.
	writtenColumns: string | null = null
	// A source row style at the sheet's default height (not a user-set one where one is), for the rows after the last.
	private defaultStyle: { name: string; custom: boolean } | null = null
	// Notes and links an edit changed, and the rows they are on.
	features: SheetFeatures = NO_FEATURES
	// A new table's page breaks and print titles.
	fresh: NewTable = NO_NEW_TABLE
	// Rows holding what the model does not carry that names cells by address (unheld.ts), with how the sheets moved:
	// written with those addresses moved. Null where nothing moved.
	unheld: TableUnheld | null = null
	// The row element under way is one of those.
	private patching = false
	// The first rows of the row elements holding what the model does not carry, and whether one was written
	// otherwise than copied (the save's proof then reads it all back, comparing those).
	unheldRows: ReadonlySet<number> | null = null
	rewroteUnheld = false
	// Rows before movedFrom anchoring a source merge the model no longer has as it was (rows went in or out inside
	// it), ascending: each is written again with the span the model has.
	private respanRows: number[] | null = null

	constructor(context: TableContext, entry: XlsxSheetEntry, model: XlsxSheetModel, view: SheetView, source: OdsTableSource | null) {
		this.context = context
		this.entry = entry
		this.model = model
		this.view = view
		this.source = source

		const axes = model as { rowAxis?: SourceAxis; colAxis?: SourceAxis }

		this.rowAxis = source === null ? SourceAxis.identity(0) : (axes.rowAxis ?? SourceAxis.identity(SHEET_MAX_ROWS))
		this.colAxis = source === null ? SourceAxis.identity(0) : (axes.colAxis ?? SourceAxis.identity(SHEET_MAX_COLS))
		this.columnsMoved = !this.colAxis.identity
		this.movedFrom = (model as { movedFrom?: number }).movedFrom ?? SHEET_MAX_ROWS
	}

	// --- Columns ---

	// Whether the columns are written from the model: moved, or their widths, visibility or formats changed.
	get columnsChanged(): boolean {
		if (this.source === null || this.columnsMoved) return true

		return !sameCols(this.model.cols, this.source.cols)
	}

	// The table's columns from the model, wide enough for every column the source declared and every cell, and at
	// least LibreOffice's 1,024 (16,384 past them): columns at the default width are then the commonest, which is
	// how a reader tells the default.
	columns(): string {
		const width = Math.max(this.width(), 1)
		// A new table's columns reach the grid's last, every one as wide as the model has it (a reader takes its own
		// default for columns a table does not declare).
		const total = Math.min(SHEET_MAX_COLS, width > 1024 || this.source === null ? SHEET_MAX_COLS : 1024)
		const ranges = [...this.model.cols].sort((a, b) => a.first - b.first)
		const parts: string[] = []
		let col = 0
		// Columns in groups as deep as their outline levels (table:table-column-group, ODF 1.3 Part 3 §9.1.10).
		let level = 0
		const collapsed = collapsedColumnGroups(ranges)
		const nest = (to: number, from: number): void => {
			for (; level < to; level++)
				parts.push(
					collapsed.has(from * 16 + level + 1) ? '<table:table-column-group table:display="false">' : "<table:table-column-group>"
				)
			for (; level > to; level--) parts.push("</table:table-column-group>")
		}

		// A new table's page breaks start a run of their own, its print titles are a run of their own.
		const breaks = [...(this.fresh.colBreaks ?? [])].sort((a, b) => a - b)
		const titles = this.fresh.titleCols ?? null
		let nextBreak = 0
		const write = (from: number, count: number, range: XlsxColRange | undefined): void => {
			const px = this.view.columnPx(range)
			const style = this.context.styles.column(px, breaks[nextBreak] === from)
			const hidden = range !== undefined && (range.flags & ColFlag.HIDDEN) !== 0
			const cellStyle = range === undefined || range.style <= 0 ? this.context.styles.cell(0) : this.context.styles.cell(range.style)
			let tag = `<table:table-column table:style-name="${escapeAttribute(style)}"`

			if (count > 1) tag += ` table:number-columns-repeated="${count}"`
			if (hidden) tag += ' table:visibility="collapse"'
			if (cellStyle !== undefined) tag += ` table:default-cell-style-name="${escapeAttribute(cellStyle)}"`

			parts.push(`${tag}/>`)
		}
		const emit = (from: number, count: number, range: XlsxColRange | undefined): void => {
			if (count <= 0) return

			nest(range === undefined ? 0 : (range.flags & ColFlag.OUTLINE_MASK) >> ColFlag.OUTLINE_SHIFT, from)

			const end = from + count

			for (let at = from; at < end;) {
				let stop = end

				// A column starting a page alone: every column of a repeated one would.
				while (nextBreak < breaks.length && (breaks[nextBreak] ?? 0) < at) nextBreak++
				if (breaks[nextBreak] === at) stop = at + 1
				else if (nextBreak < breaks.length) stop = Math.min(stop, breaks[nextBreak] ?? stop)
				if (titles !== null) stop = Math.min(stop, at < titles.first ? titles.first : at <= titles.last ? titles.last + 1 : stop)
				if (titles !== null && at === titles.first) parts.push("<table:table-header-columns>")

				write(at, stop - at, range)

				if (titles !== null && stop === titles.last + 1) parts.push("</table:table-header-columns>")

				at = stop
			}
		}

		for (const range of ranges) {
			if (range.first >= total) break

			emit(col, range.first - col, undefined)
			emit(Math.max(range.first, col), Math.min(range.last + 1, total) - Math.max(range.first, col), range)
			col = Math.min(range.last + 1, total)
		}

		emit(col, total - col, undefined)
		nest(0, total)

		return parts.join("")
	}

	// Columns the table spans: the source's, moved as the columns were, and every cell's.
	private width(): number {
		// A new table declares every column of the grid (columns()): its rows reach the last, as a source table's
		// rows reach the columns it declares, so a later save writes them again as they are.
		if (this.source === null) return SHEET_MAX_COLS

		let width = 0

		if (this.source !== null) {
			this.colAxis.forEach((target, source, length) => {
				const end = Math.min(source + length, this.sourceColumns)

				if (end > source) width = Math.max(width, target + end - source)
			})
		}

		width = Math.max(width, this.view.store.colExtent, this.model.styleRuns?.colExtent ?? 0)

		for (const range of this.model.cols) width = Math.max(width, Math.min(range.last + 1, width + 1024))

		return Math.min(SHEET_MAX_COLS, width)
	}

	// --- Rows ---

	private respanned(): number[] {
		if (this.respanRows !== null) return this.respanRows

		const rows = new Set<number>()
		const merges = this.source?.merges

		// Columns moved write every row again; rows not moved leave a merge's height to an edit, which marks its rows.
		if (merges !== undefined && !this.columnsMoved && (!this.rowAxis.identity || this.movedFrom < SHEET_MAX_ROWS)) {
			for (let k = 0; k + 3 < merges.length; k += 4) {
				const anchor = this.rowAxis.target(merges[k] ?? 0)

				if (anchor < 0 || anchor >= this.movedFrom) continue

				const col = merges[k + 1] ?? 0
				const merge = this.view.mergeAt(anchor, col)

				if (
					merge === undefined ||
					merge.endRow - merge.startRow !== (merges[k + 2] ?? 0) - (merges[k] ?? 0) ||
					merge.endCol - merge.startCol !== (merges[k + 3] ?? 0) - col
				)
					rows.add(anchor)
			}
		}

		this.respanRows = [...rows].sort((a, b) => a - b)

		return this.respanRows
	}

	// Those of respanned() in [from, to).
	private respannedIn(from: number, to: number): number[] {
		const rows = this.respanned()

		if (rows.length === 0 || to <= from) return []

		let low = 0
		let high = rows.length

		while (low < high) {
			const mid = (low + high) >> 1

			if ((rows[mid] ?? 0) < from) low = mid + 1
			else high = mid
		}

		const out: number[] = []

		for (let k = low; k < rows.length && (rows[k] ?? 0) < to; k++) out.push(rows[k] ?? 0)

		return out
	}

	private sourceProps(tag: Uint8Array, outline: number): SourceRowProps {
		const attributes = tagAttributes(tag)
		const style = this.context.cellStyles.row(attributes.get("table:style-name"))
		const visibility = attributes.get("table:visibility")

		return {
			heightPt: style.heightPt,
			custom: style.custom,
			pageBreak: style.pageBreak,
			hidden: visibility !== undefined && visibility !== "visible",
			outline: Math.min(7, outline)
		}
	}

	// The format the cells of source row `row` take without naming one (-1: their column's), before the rows go out;
	// null for a row the source has none of.
	plannedRowXf(row: number): number | null {
		const source = this.source

		if (source === null) return null

		const at = this.rowAxis.source(row)

		if (at < 0 || at >= source.rows) return null

		const defaultCell = source.rowProps.at(at)?.defaultCellStyle

		return this.view.rowStyle(row) >= 0 || defaultCell === undefined ? -1 : this.context.cellStyles.xf(defaultCell)
	}

	// Every row style the source's rows are written with, before the rows go out: a row whose properties are not its
	// tag's any more has its tag given the model's. Once per stretch of rows alike in both; yields as it goes.
	*sourceRowStyles(visit: (heightPt: number, custom: boolean, pageBreak: boolean) => void): Generator<void, void> {
		const source = this.source

		if (source === null) return

		const end = Math.min(source.rows, SHEET_MAX_ROWS)
		let steps = 0

		for (let at = 0; at < end;) {
			const target = this.rowAxis.target(at)

			if (target < 0) {
				const kept = this.rowAxis.nextKept(at)

				at = kept < 0 || kept <= at ? end : kept

				continue
			}

			const run = Math.max(1, Math.min(end - at, this.rowAxis.runFrom(at), source.rowProps.runFrom(at)))
			const stop = target + run
			const props = source.rowProps.at(at) ?? NO_ROW_PROPS
			const points = new Set<number>([target])

			for (const row of this.view.storeRowsIn(target, stop)) {
				points.add(row)
				if (row + 1 < stop) points.add(row + 1)
			}

			for (const runRow of this.view.runsIn(target, stop)) {
				points.add(Math.max(target, runRow.first))
				if (runRow.last + 1 < stop) points.add(runRow.last + 1)
			}

			for (const row of points) {
				if (this.sameProps(props, row)) continue

				const rowProps = this.view.rowProps(row)

				visit(this.view.height(rowProps), (rowProps.flags & RowFlag.CUSTOM_HEIGHT) !== 0, props.pageBreak)
			}

			at += run

			if (++steps % 256 === 0 || points.size > 256) yield
		}
	}

	// Whether a cell of format `xf` names its style, in a row whose cells take `rowXf` without one (-1: their column's).
	namesStyle(xf: number, col: number, rowXf: number): boolean {
		return xf !== (rowXf >= 0 ? rowXf : this.columnXf(col))
	}

	private sameProps(source: SourceRowProps, row: number): boolean {
		const props = this.view.rowProps(row)
		// A row of none has the sheet's default; a source row whose style gives none was read at LibreOffice's.
		const fallback = this.model.format.defaultRowHeight
		const height = Number.isNaN(props.heightPt) ? fallback : props.heightPt

		return (
			((props.flags & RowFlag.HIDDEN) !== 0) === source.hidden &&
			(props.flags & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT === source.outline &&
			height === (Number.isNaN(source.heightPt) ? DEFAULT_ROW_PT : source.heightPt) &&
			this.view.rowStyle(row) < 0
		)
	}

	// A row element's start tag (its bytes up to ">"): how its rows are written. "pass" when it is copied whole.
	rowStart(tag: Uint8Array, outline: number): "pass" | "capture" {
		const attributes = tagAttributes(tag)
		const repeat = Math.max(1, Number.parseInt(attributes.get("table:number-rows-repeated") ?? "1", 10) || 1)
		const props = this.sourceProps(tag, outline)
		const styleName = attributes.get("table:style-name")

		if (
			styleName !== undefined &&
			!props.pageBreak &&
			props.heightPt === this.model.format.defaultRowHeight &&
			(this.defaultStyle?.custom ?? true)
		)
			this.defaultStyle = { name: styleName, custom: props.custom }

		const decisions: Decision[] = []
		const add = (decision: Decision): void => {
			const last = decisions[decisions.length - 1]

			if (decision.kind === "copy" && last?.kind === "copy")
				decisions[decisions.length - 1] = { kind: "copy", count: last.count + decision.count }
			else if (
				decision.kind === "props" &&
				last?.kind === "props" &&
				last.props.flags === decision.props.flags &&
				(last.props.heightPt === decision.props.heightPt ||
					(Number.isNaN(last.props.heightPt) && Number.isNaN(decision.props.heightPt)))
			)
				decisions[decisions.length - 1] = { ...last, count: last.count + decision.count }
			else decisions.push(decision)
		}
		const first = this.sourceRow
		const end = first + Math.min(repeat, SHEET_MAX_ROWS - first)

		this.patching = this.unheld?.rows.has(first) === true

		this.sourceRow = first + repeat

		for (let at = first; at < end;) {
			const target = this.rowAxis.target(at)

			if (target < 0) {
				// Deleted: up to the next row kept.
				const kept = this.rowAxis.nextKept(at)

				at = kept < 0 ? end : Math.min(end, kept)
				this.rowsChanged = true

				continue
			}

			if (target > this.nextTarget) add({ kind: "fresh", from: this.nextTarget, to: target })

			const run = Math.min(end - at, this.rowAxis.runFrom(at))
			const stop = target + run
			const respanned = this.respannedIn(target, stop)
			const special = new Set<number>([...this.view.storeRowsIn(target, stop), ...this.view.markedIn(target, stop), ...respanned])

			for (const row of this.features.rows) if (row >= target && row < stop) special.add(row)

			if (this.movedFrom > target && this.movedFrom < stop) special.add(this.movedFrom)

			// Rows alike only between where formats of empty cells and merges change.
			if (this.columnsMoved || stop > this.movedFrom) {
				this.model.styleRuns?.forEach(
					{ startRow: target, startCol: 0, endRow: stop - 1, endCol: SHEET_MAX_COLS - 1 },
					(startRow, _c, endRow) => {
						special.add(startRow)
						if (endRow + 1 < stop) special.add(endRow + 1)
					}
				)

				for (const merge of this.view.mergesBetween(target, stop)) {
					const last = Math.min(merge.endRow + 1, stop - 1)

					for (let row = Math.max(merge.startRow, target); row <= last; row++) special.add(row)
				}
			}

			for (const runRow of this.view.runsIn(target, stop)) {
				special.add(Math.max(target, runRow.first))
				if (runRow.last + 1 < stop) special.add(runRow.last + 1)
			}

			const ordered = [...special].sort((a, b) => a - b)
			let row = target

			const plain = (to: number): void => {
				if (to <= row) return

				const count = to - row

				const moved = this.columnsMoved || row >= this.movedFrom

				if (moved || !this.sameProps(props, row)) {
					// A run's (or no) properties over these rows: the same for each.
					if (moved) add({ kind: "rewrite", target: row, count })
					else add({ kind: "props", count, first: row, props: this.view.rowProps(row) })
				} else {
					add({ kind: "copy", count })
				}

				row = to
			}

			for (const next of ordered) {
				if (next < row) continue

				// Rows before it share what the one at `row` has (a run, or nothing).
				plain(next)

				const marked = this.view.markedIn(next, next + 1).length > 0 || this.features.rows.has(next)
				const nextRun = this.view.runsIn(next, next + 1)[0]

				if (marked || this.columnsMoved || next >= this.movedFrom || respanned.includes(next)) {
					add({ kind: "rewrite", target: next, count: 1 })
					row = next + 1
				} else if (nextRun !== undefined && this.view.storeRowsIn(next, next + 1).length === 0) {
					plain(Math.min(stop, nextRun.last + 1))
				} else {
					if (this.sameProps(props, next)) add({ kind: "copy", count: 1 })
					else add({ kind: "props", count: 1, first: next, props: this.view.rowProps(next) })

					row = next + 1
				}
			}

			plain(stop)
			this.nextTarget = stop
			at += run
		}

		this.pending = decisions
		this.pendingProps = props

		if (this.unheldRows?.has(first) === true && decisions.some(decision => decision.kind !== "copy")) this.rewroteUnheld = true

		if (decisions.length > 0) this.rowsWritten = true
		if (decisions.some(decision => decision.kind !== "copy")) this.rowsChanged = true

		return !this.patching && decisions.length === 1 && decisions[0]?.kind === "copy" && decisions[0].count === repeat
			? "pass"
			: "capture"
	}

	// The captured row element: what replaces it.
	// The captured row element: what replaces it, or (a row written again cell by cell) a function giving that once
	// called, after the rows captured meanwhile, so the source rows are read back together.
	rowEnd(captured: Uint8Array): string | Uint8Array | (() => string) {
		const written = this.rowWritten(captured)
		const unheld = this.unheld

		if (!this.patching || unheld === null) return written

		this.patching = false

		if (typeof written === "function") return () => movedRow(written(), unheld)
		if (typeof written === "string") return movedRow(written, unheld)

		return encoder.encode(movedRow(decoder.decode(written), unheld))
	}

	private rowWritten(captured: Uint8Array): string | Uint8Array | (() => string) {
		const decisions = this.pending
		const props = this.pendingProps

		this.pending = []

		if (!decisions.some(decision => decision.kind === "rewrite")) return this.rowOutput(captured, decisions, props, null)

		if (this.shiftedOnly(captured, decisions)) {
			// Rows whose cells only moved along: their bytes moved, none read back.
			if (decisions.every(decision => decision.kind === "rewrite")) {
				const { tag } = startTag(captured)

				return joined(
					decisions.flatMap(decision =>
						decision.kind === "rewrite" ? this.shiftRow(decision.target, decision.count, tag, captured, props) : []
					)
				)
			}

			return this.rowOutput(captured, decisions, props, null, true)
		}

		const element = captured.slice()
		const { tag, end } = startTag(element)
		const selfClosing = tag.endsWith("/>")
		const open = encoder.encode(setAttribute(tag, "table:number-rows-repeated", undefined))
		const closeAt = selfClosing ? element.length : element.length - closeLength(element)
		const close = element.subarray(closeAt)
		const body = element.subarray(selfClosing ? element.length : end, closeAt)
		const bytes = new Uint8Array(open.length + body.length + close.length)

		bytes.set(open, 0)
		bytes.set(body, open.length)
		bytes.set(close, open.length + body.length)

		const job: QueuedRow = { bytes, decoded: null }

		this.queue.push(job)

		return () => {
			if (job.decoded === null) this.decodeQueue()

			return this.rowOutput(element, decisions, props, job.decoded)
		}
	}

	// Rows captured to be written again: read back in one pass, each its own row of the snippet.
	private queue: QueuedRow[] = []

	private decodeQueue(): void {
		const queue = this.queue

		this.queue = []

		const decoded = decodeRows(
			this.context.cellStyles,
			this.context.prefixes,
			this.columnsMarkup,
			queue.map(job => job.bytes)
		)

		queue.forEach((job, index) => {
			job.decoded = rowOf(decoded, index)
		})
	}

	// Rows written again only as columns moved (inserted or deleted): no edit marked them, nor does anything about
	// them depend on a column (a formula, a merge, a note, a link, a validation, a row format). Each source cell is
	// the model's at its column now, so it is copied without reading it back, as an unmarked row is.
	private shiftedOnly(element: Uint8Array, decisions: readonly Decision[]): boolean {
		const features = this.features

		// A validation's cells name it, so none may be on the row (the bytes are checked below) or newly written.
		const validations = features.validations

		if (!this.columnsMoved || features.notes !== null || features.links !== null) return false
		if (validations !== null && (validations.rows.size > 0 || validations.fresh.length > 0)) return false

		for (const decision of decisions) {
			if (decision.kind !== "rewrite") continue

			for (let row = decision.target; row < decision.target + decision.count; row++)
				if (
					row >= this.movedFrom ||
					features.rows.has(row) ||
					this.view.markedIn(row, row + 1).length > 0 ||
					this.view.mergesIn(row).length > 0 ||
					this.view.rowStyle(row) >= 0
				)
					return false
		}

		const scan = scanCells(element, this.cellName, this.coveredName)

		this.lastScan = { element, cells: scan.cells }

		return !scan.bound
	}

	private rowOutput(
		element: Uint8Array,
		decisions: readonly Decision[],
		props: SourceRowProps | null,
		decoded: DecodedRows | null,
		shifted = false
	): string {
		const { tag, end } = startTag(element)
		const selfClosing = tag.endsWith("/>")
		let text: string | undefined
		const body = (): string =>
			(text ??= selfClosing ? "" : decoder.decode(element.subarray(end, element.length - closeLength(element))))
		const close = selfClosing ? "" : closeOf(tag)
		const out: string[] = []
		const open = (count: number, patch?: { heightPt: number; flags: number }, first = 0): string => {
			let next = setAttribute(tag, "table:number-rows-repeated", count > 1 ? String(count) : undefined)

			if (patch !== undefined) {
				const custom = (patch.flags & RowFlag.CUSTOM_HEIGHT) !== 0
				const style = this.context.styles.row(this.view.height(patch), custom, props?.pageBreak === true)

				next = setAttribute(next, "table:style-name", style)
				next = setAttribute(next, "table:visibility", this.view.visibility(first, patch.flags))
			}

			return next
		}

		for (const decision of decisions) {
			switch (decision.kind) {
				case "copy":
					out.push(open(decision.count) + body() + close)
					break
				case "props":
					out.push(open(decision.count, decision.props, decision.first) + body() + close)
					this.span(decision.first, decision.count, out[out.length - 1] ?? "")
					break
				case "fresh":
					for (let row = decision.from; row < decision.to;) row = this.spanFresh(row, decision.to, out)
					break
				case "rewrite": {
					if (decoded === null && !shifted) throw new Error("A row written again was not read back")

					const written = this.rewriteRow(decision.target, tag, element, decoded, props)

					out.push(
						decision.count > 1
							? written.replace(/^<table:table-row\b/, `<table:table-row table:number-rows-repeated="${decision.count}"`)
							: written
					)
					this.span(decision.target, decision.count, out[out.length - 1] ?? "")
					break
				}
			}
		}

		const written = out.join("")
		const repeat = Math.max(1, Number.parseInt(tagAttribute(element, "table:number-rows-repeated") ?? "1", 10) || 1)

		// The rows a source element became add up to its own where no row moved: else its proof is the whole file's.
		if (this.spanRows !== null && this.rowAxis.identity && rowsIn(written) !== repeat) this.spanRows = null

		return written
	}

	private span(target: number, count: number, markup: string): void {
		if (this.spanRows === null) return

		if (this.spanRows.length >= SPAN_ROWS) this.spanRows = null
		else this.spanRows.push({ target, count, markup })
	}

	// Row groups shown collapsed, as start * 16 + level: Excel marks the summary row after a collapsed group
	// (row@collapsed, ECMA-376 Part 1 §18.3.1.73), ODF the group itself (table:display, ODF 1.3 Part 3 §19.614).
	private collapsedRowGroups(): Set<number> {
		const groups = new Set<number>()
		const runs = this.model.rowRuns
		const summaries: number[] = []

		for (const run of runs ?? []) if ((run.flags & RowFlag.COLLAPSED) !== 0) summaries.push(run.first)

		for (const block of this.view.store.blocks) {
			for (let i = 0; i < block.rowCount; i++)
				if (((block.rowFlags[i] ?? 0) & RowFlag.COLLAPSED) !== 0) summaries.push(block.firstRow + (block.rows[i] ?? 0))
		}

		for (const row of summaries) {
			const flags = this.view.rowProps(row).flags

			// A store row over a run has its own flags.
			if ((flags & RowFlag.COLLAPSED) === 0) continue

			const level = rowOutline(flags) + 1
			let start = row

			// Back over the group's rows: a run's at a time, store rows one by one.
			while (start > 0 && rowOutline(this.view.rowProps(start - 1).flags) >= level) {
				const before = start - 1
				const run = rowRunAt(runs, before)
				const stored = run === undefined ? [] : this.view.storeRowsIn(run.first, before + 1)
				const lastStored = stored[stored.length - 1]

				start = run === undefined || lastStored === before ? before : Math.max(run.first, (lastStored ?? -1) + 1)
			}

			if (start < row) groups.add(start * 16 + level)
		}

		return groups
	}

	private spanFresh(from: number, to: number, out: string[]): number {
		const next = this.freshRows(from, to, out)

		this.span(from, next - from, out[out.length - 1] ?? "")

		return next
	}

	// Rows past the source's last: written from the model up to the last row it holds anything on (a new sheet
	// at least one, a table holding one row at least, ODF 1.3 Part 3 §9.1.2).
	rowsEnd(): string {
		return [...this.rowsEndPieces()].join("")
	}

	// rowsEnd in pieces of some rows each, for a writer that streams them.
	*rowsEndPieces(): Generator<string> {
		let out: string[] = []
		const last = Math.max(this.lastModelRow(), this.source === null ? 0 : -1)

		const wrote = this.nextTarget <= last
		// A new sheet's rows in groups as deep as their outline levels (table:table-row-group, ODF 1.3 Part 3 §9.1.9).
		let level = 0
		const grouped = this.source === null
		const collapsed = grouped ? this.collapsedRowGroups() : null
		const nest = (to: number, from: number): void => {
			for (; level < to; level++)
				out.push(
					collapsed?.has(from * 16 + level + 1) === true
						? '<table:table-row-group table:display="false">'
						: "<table:table-row-group>"
				)
			for (; level > to; level--) out.push("</table:table-row-group>")
		}

		const titles = this.fresh.titleRows ?? null

		for (let row = this.nextTarget; row <= last;) {
			if (grouped) nest((this.view.rowProps(row).flags & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT, row)

			// Print titles are a run of their own.
			const stop =
				titles === null
					? last + 1
					: Math.min(last + 1, row < titles.first ? titles.first : row <= titles.last ? titles.last + 1 : last + 1)

			if (titles !== null && row === titles.first) out.push("<table:table-header-rows>")

			row = this.spanFresh(row, stop, out)

			if (titles !== null && row === titles.last + 1) out.push("</table:table-header-rows>")

			if (out.length >= ROWS_PER_PIECE) {
				yield out.join("")
				out = []
			}
		}

		this.nextTarget = Math.max(this.nextTarget, last + 1)
		nest(0, last + 1)

		// Rows written or changed are followed by the rest of the grid at the sheet's default height, as LibreOffice
		// writes a table: a reader takes the commonest height for the rows a table does not reach, which the rows
		// before may no longer be. A table left with no row (every one deleted) holds that run alone (§9.1.2: a table
		// has a row at least).
		if ((wrote || this.rowsChanged || !this.rowsWritten) && this.nextTarget < SHEET_MAX_ROWS) {
			const count = SHEET_MAX_ROWS - this.nextTarget
			const cells = `<table:table-cell table:number-columns-repeated="${Math.max(1, this.width())}"/></table:table-row>`

			// Only rows changed: the style the source already has for that height (or none, the reader's own default),
			// so no automatic style is added that the stream's head did not hold.
			if (wrote || !this.rowsWritten) out.push(`${this.rowOpen({ heightPt: Number.NaN, flags: 0 }, count, this.nextTarget)}${cells}`)
			else if (this.defaultStyle !== null)
				out.push(
					`<table:table-row table:style-name="${escapeAttribute(this.defaultStyle.name)}" table:number-rows-repeated="${count}">${cells}`
				)
			else if (this.model.format.defaultRowHeight === DEFAULT_ROW_PT)
				out.push(`<table:table-row table:number-rows-repeated="${count}">${cells}`)
			else this.spanRows = null

			if (out.length > 0) this.span(this.nextTarget, count, out[out.length - 1] ?? "")

			this.nextTarget = SHEET_MAX_ROWS
		}

		if (out.length > 0) yield out.join("")
	}

	// The last row the model has anything on.
	lastModelRow(): number {
		let last = Math.max(this.view.store.rowExtent, this.model.styleRuns?.rowExtent ?? 0) - 1
		const runs = this.model.rowRuns

		if (runs !== undefined && runs.length > 0) last = Math.max(last, runs[runs.length - 1]?.last ?? -1)

		const quads = this.model.merges

		for (let k = 0; k + 3 < quads.length; k += 4) last = Math.max(last, quads[k + 2] ?? 0)

		// Rows a note, a link or a validation is on.
		for (const row of this.features.rows) last = Math.max(last, row)

		// A new table's validations, whose rows none of the above names, its page breaks and print titles.
		if (this.source === null) {
			last = Math.max(last, this.features.validations?.lastRow ?? -1, this.fresh.titleRows?.last ?? -1)

			for (const row of this.fresh.rowBreaks ?? []) last = Math.max(last, row)
		}
		for (const map of [this.features.notes, this.features.links, this.fresh.frames])
			for (const cell of map?.keys() ?? []) last = Math.max(last, Number(cell.split(",")[0]))

		return Math.min(SHEET_MAX_ROWS - 1, last)
	}

	// Rows from `from` (before `to`) the source has none of: one written, or a run of alike empty ones together.
	// Returns the next row to write.
	private freshRows(from: number, to: number, out: string[]): number {
		const props = this.view.rowProps(from)
		const cells = this.view.cellCols(from)
		const runs = this.model.styleRuns
		let styled = false

		runs?.forEach({ startRow: from, startCol: 0, endRow: from, endCol: SHEET_MAX_COLS - 1 }, () => {
			styled = true
		})

		const merges = this.view.mergesIn(from)
		// Rows only covered by the same merges (none starting on them) are alike: their covered cells.
		const inside = merges.every(merge => merge.startRow < from)
		const lastInside = merges.reduce((last, merge) => Math.min(last, merge.endRow), SHEET_MAX_ROWS - 1)
		// A new table's rows alike but for their validations' names hold the same ones up to the next break.
		const validations = this.source === null ? this.features.validations : null
		const featured = (row: number): boolean =>
			validations === null ? this.featureColsOf(row).length > 0 || this.features.rows.has(row) : this.noteOrLink(row)

		// A row starting a page stands alone: every row of a repeated one would.
		const breaks = this.fresh.rowBreaks

		if (cells.length === 0 && !styled && inside && !featured(from) && this.view.rowStyle(from) < 0 && breaks?.has(from) !== true) {
			// Empty rows alike: up to the next row with anything of its own.
			let next = from + 1
			const store = this.view.storeRowsIn(from + 1, to)[0] ?? to

			while (next < Math.min(to, store)) {
				const other = this.view.rowProps(next)
				let otherStyled = false

				runs?.forEach({ startRow: next, startCol: 0, endRow: next, endCol: SHEET_MAX_COLS - 1 }, () => {
					otherStyled = true
				})

				if (
					otherStyled ||
					other.flags !== props.flags ||
					!sameHeight(other.heightPt, props.heightPt) ||
					next > lastInside ||
					(this.mergeBreaks().has(next) && !sameMerges(this.view.mergesIn(next), merges)) ||
					featured(next) ||
					validations?.breaks.has(next) === true ||
					breaks?.has(next) === true
				)
					break

				next++
			}

			out.push(this.rowOpen(props, next - from, from) + this.freshCells(from) + "</table:table-row>")

			return next
		}

		out.push(this.rowOpen(props, 1, from) + this.freshCells(from) + "</table:table-row>")

		return from + 1
	}

	private rowOpen(props: { heightPt: number; flags: number }, count: number, row: number): string {
		const style = this.context.styles.row(
			this.view.height(props),
			(props.flags & RowFlag.CUSTOM_HEIGHT) !== 0,
			this.fresh.rowBreaks?.has(row) === true
		)
		let tag = `<table:table-row table:style-name="${escapeAttribute(style)}"`

		if (count > 1) tag += ` table:number-rows-repeated="${count}"`
		const visibility = this.view.visibility(row, props.flags)

		if (visibility !== undefined) tag += ` table:visibility="${visibility}"`

		return `${tag}>`
	}

	// The column default format of the output (what a cell without a style of its own takes).
	private columnXf(col: number): number {
		for (const range of this.model.cols) if (col >= range.first && col <= range.last) return Math.max(0, range.style)

		return 0
	}

	// Columns of a row with a note or a link an edit changed, by row.
	private featureCols: Map<number, number[]> | null = null

	// Rows where the merges a row is in may change: each merge's first row and the row after its last.
	private mergeBreaksSet: Set<number> | null = null

	private mergeBreaks(): ReadonlySet<number> {
		if (this.mergeBreaksSet === null) {
			const quads = this.model.merges
			const breaks = new Set<number>()

			for (let k = 0; k + 3 < quads.length; k += 4) breaks.add(quads[k] ?? 0).add((quads[k + 2] ?? 0) + 1)

			this.mergeBreaksSet = breaks
		}

		return this.mergeBreaksSet
	}

	// Whether a note or a link is on the row.
	private noteOrLink(row: number): boolean {
		return (this.noteLinkCols().get(row)?.length ?? 0) > 0
	}

	// Columns of each row's notes and links, built once.
	private noteLinkCols(): Map<number, number[]> {
		if (this.featureCols === null) {
			const index = new Map<number, number[]>()

			for (const map of [this.features.notes, this.features.links, this.fresh.frames]) {
				for (const cell of map?.keys() ?? []) {
					const [at = 0, col = 0] = cell.split(",").map(Number)
					let list = index.get(at)

					if (list === undefined) index.set(at, (list = []))

					list.push(col)
				}
			}

			this.featureCols = index
		}

		return this.featureCols
	}

	private featureColsOf(row: number): readonly number[] {
		const cols = this.noteLinkCols().get(row) ?? []
		const validations = this.features.validations?.bounds(row) ?? []

		return validations.length === 0 ? cols : [...cols, ...validations.map(col => col - 1).filter(col => col >= 0), ...validations]
	}

	// Where a row's cells change: stored cells, format runs, column ranges, merges, notes and links.
	private bounds(row: number, width: number): number[] {
		const set = new Set<number>([0, width])

		for (const col of this.featureColsOf(row)) {
			set.add(col)
			set.add(col + 1)
		}

		for (const col of this.view.cellCols(row)) {
			set.add(col)
			set.add(col + 1)
		}

		this.view.styleBounds(row, set)

		for (const merge of this.view.mergesIn(row)) {
			set.add(merge.startCol)
			set.add(merge.startCol + 1)
			set.add(merge.endCol + 1)
		}

		return [...set].filter(col => col >= 0 && col <= width).sort((a, b) => a - b)
	}

	// Columns a row's cells span: the table's, and those a note, a link or a merge of the row reaches.
	private rowWidth(row: number): number {
		// A row format reaches the grid's last column: its cells are written to there, as LibreOffice writes a
		// formatted row (a reader takes a row's default cell style for the cells it has, not the columns past them).
		if (this.view.rowStyle(row) >= 0) return SHEET_MAX_COLS

		let width = Math.max(1, this.width())

		for (const col of this.featureColsOf(row)) width = Math.max(width, col + 1)
		for (const merge of this.view.mergesIn(row)) width = Math.max(width, merge.endCol + 1)

		return Math.min(SHEET_MAX_COLS, width)
	}

	// A fresh row's cells from the model.
	private freshCells(row: number): string {
		const width = this.rowWidth(row)
		const bounds = this.bounds(row, width)
		const out: string[] = []

		for (let k = 0; k + 1 < bounds.length; k++) {
			const from = bounds[k] ?? 0
			const to = bounds[k + 1] ?? 0

			if (to <= from) continue

			// The row's bounds hold each note's and link's column and the next, and where its validations change: a
			// span between two is alike, a note or a link only ever a span of its own.
			const features =
				this.features.notes !== null ||
				this.features.links !== null ||
				this.features.validations !== null ||
				this.fresh.frames !== undefined

			out.push(
				this.cell(
					row,
					from,
					this.view.cell(row, from),
					to - from,
					undefined,
					features ? this.extras(row, from, null, undefined, null, -1) : NO_EXTRAS
				)
			)
		}

		return out.join("")
	}

	// What a cell carries besides its value: kept from its source cell, or from the model where an edit changed it.
	private extras(
		row: number,
		col: number,
		element: Uint8Array | null,
		source: SourceCell | undefined,
		decoded: DecodedRows | null,
		sourceCol: number
	): CellExtras {
		const features = this.features
		const modelNote = features.notes?.get(`${row},${col}`)
		const note =
			features.notes !== null
				? modelNote === undefined
					? undefined
					: annotationMarkup(modelNote)
				: element === null || source === undefined
					? undefined
					: annotation(element, source)
		const link =
			features.links !== null ? features.links.get(`${row},${col}`) : decoded === null ? undefined : decoded.link(0, sourceCol)

		return {
			note,
			link,
			validation:
				features.validations !== null
					? features.validations.name(row, col)
					: element === null || source === undefined
						? undefined
						: tagAttribute(element.subarray(source.start, source.openEnd), "table:content-validation-name"),
			kept:
				element === null || source === undefined ? (this.fresh.frames?.get(`${row},${col}`) ?? "") : keptChildren(element, source),
			formula: keptFormula(this.view.cell(row, col), element, source, decoded, sourceCol)
		}
	}

	// One cell element (or a run of alike ones) from the model.
	private cell(
		row: number,
		col: number,
		cell: CellValue,
		repeat: number,
		sourceFormula: string | undefined,
		extras: CellExtras,
		rowXf = -1
	): string {
		const implicit = rowXf >= 0 ? rowXf : this.columnXf(col)
		const merge = this.view.mergeAt(row, col)
		const covered = this.view.covered(row, col)
		const styles = this.context.styles

		if (cell.formula !== null && cell.formula !== "" && repeat > 1) throw new CellRefused("a repeated formula")

		return cellMarkup(cell, {
			styleName: cell.xf === implicit ? undefined : styles.cell(cell.xf),
			repeat: merge === undefined ? repeat : 1,
			colSpan: merge === undefined ? 1 : merge.endCol - merge.startCol + 1,
			rowSpan: merge === undefined ? 1 : merge.endRow - merge.startRow + 1,
			covered,
			validation: extras.validation,
			sourceFormula,
			shown: cell.value === Value.NUMBER ? this.view.shown(row, col) : "",
			numberKind: this.view.numberKind(cell.xf),
			nullDate: this.context.nullDate,
			calcext: this.context.calcext,
			runStyles: cell.runs === null ? null : cell.runs.map(run => (run.font === null ? undefined : styles.text(run.font))),
			note: extras.note,
			link: extras.link,
			kept: extras.kept,
			keptFormula: extras.formula
		})
	}

	// A source row written again: its start tag with the model's properties, each cell the model holds as the source
	// did copied as its bytes, every other cell from the model.
	private rewriteRow(
		target: number,
		tag: string,
		element: Uint8Array,
		// Null for a row only shifted (shiftedOnly): its source cells copied as they are.
		decoded: DecodedRows | null,
		pendingProps: SourceRowProps | null
	): string {
		const cells = sourceCells(element, this.cellName, this.coveredName)
		const { open, rowXf } = this.rowTag(target, tag, pendingProps)

		return this.rewriteRowCells(target, element, cells, open, rowXf, decoded)
	}

	// A row only shifted (shiftedOnly), as bytes: each source cell copied to its column now (its repeat split where
	// columns came between or went), the columns inserted written from the model.
	// The cells shiftedOnly read of the row it was given last.
	private lastScan: { readonly element: Uint8Array; readonly cells: readonly SourceCell[] } | null = null

	private shiftRow(target: number, count: number, tag: string, element: Uint8Array, pendingProps: SourceRowProps | null): Uint8Array[] {
		const cells = this.lastScan?.element === element ? this.lastScan.cells : sourceCells(element, this.cellName, this.coveredName)
		const { open, rowXf } = this.rowTag(target, tag, pendingProps)
		const out: Uint8Array[] = [
			encoder.encode(count > 1 ? open.replace(/^<([^\s/>]+)/u, `<$1 table:number-rows-repeated="${count}"`) : open)
		]
		const width = this.rowWidth(target)
		// Where the model's cells change along the row (only where any are written from it): between two, alike.
		let bounds: number[] | null = null
		let next = 0
		const fill = (to: number): void => {
			bounds ??= this.bounds(target, width)

			let k = bounds.findIndex(bound => bound > next)

			for (let col = next; col < to;) {
				const end = Math.min(to, k < 0 ? to : (bounds?.[k] ?? to))

				out.push(encoder.encode(this.cell(target, col, this.view.cell(target, col), end - col, undefined, NO_EXTRAS, rowXf)))
				col = end
				if (k >= 0) k++
			}
		}

		for (const cell of cells) {
			// A repeat past the grid's last column (which the reader never materialises) is cut there.
			const last = Math.min(cell.first + cell.repeat, SHEET_MAX_COLS)

			for (let at = cell.first; at < last;) {
				const to = this.colAxis.target(at)

				if (to < 0) {
					// Deleted (or pushed past the last column): on to the next column kept, in one step.
					const kept = this.colAxis.nextKept(at)

					if (kept < 0) break

					at = kept

					continue
				}

				const length = Math.min(last - at, this.colAxis.runFrom(at))

				if (to > next) fill(to)

				out.push(length === cell.repeat ? element.subarray(cell.start, cell.end) : repeated(element, cell, length))
				next = to + length
				at += length
			}
		}

		// Past the source's last cell, the model's to the row's width.
		if (next < width) fill(width)

		out.push(this.closeBytes(open))

		return out
	}

	private closing: { readonly tag: string; readonly bytes: Uint8Array } | null = null

	private closeBytes(open: string): Uint8Array {
		const tag = closeOf(open)

		if (this.closing?.tag !== tag) this.closing = { tag, bytes: encoder.encode(tag) }

		return this.closing.bytes
	}

	private rowTag(target: number, tag: string, pendingProps: SourceRowProps | null): { open: string; rowXf: number } {
		const props = this.view.rowProps(target)
		const rowStyle = this.view.rowStyle(target)
		const same = this.sameProps(
			pendingProps ?? { heightPt: Number.NaN, custom: false, pageBreak: false, hidden: false, outline: 0 },
			target
		)

		// The source's tag as it is: no attribute to change.
		if (
			same &&
			rowStyle < 0 &&
			!tag.endsWith("/>") &&
			!tag.includes("number-rows-repeated") &&
			!tag.includes("default-cell-style-name")
		)
			return { open: tag, rowXf: -1 }

		let open = setAttribute(tag, "table:number-rows-repeated", undefined)

		if (!this.sameProps(pendingProps ?? { heightPt: Number.NaN, custom: false, pageBreak: false, hidden: false, outline: 0 }, target)) {
			const style = this.context.styles.row(
				this.view.height(props),
				(props.flags & RowFlag.CUSTOM_HEIGHT) !== 0,
				pendingProps?.pageBreak === true
			)

			open = setAttribute(open, "table:style-name", style)
			open = setAttribute(open, "table:visibility", this.view.visibility(target, props.flags))
		}

		const rowDefault = tagAttribute(encoder.encode(open), "table:default-cell-style-name")
		let rowXf = rowDefault === undefined ? -1 : this.context.cellStyles.xf(rowDefault)

		if (rowStyle >= 0) {
			const name = this.context.styles.cell(rowStyle)

			// Named on the row too (§19.616), but LibreOffice 7.5 reads no row's default cell style: each cell names
			// the style itself, as LibreOffice writes a formatted row.
			open = setAttribute(open, "table:default-cell-style-name", name)
			rowXf = -1
		}

		if (open.endsWith("/>")) open = `${open.slice(0, -2)}>`

		return { open, rowXf }
	}

	private rewriteRowCells(
		target: number,
		element: Uint8Array,
		cells: readonly SourceCell[],
		open: string,
		rowXf: number,
		decoded: DecodedRows | null
	): string {
		const width = this.rowWidth(target)
		const out: string[] = []
		// Source cells by the column they start at, and the one covering each source column.
		const cellAt = (source: number): SourceCell | undefined => {
			let low = 0
			let high = cells.length - 1

			while (low <= high) {
				const mid = (low + high) >>> 1
				const cell = cells[mid] as SourceCell

				if (cell.first + cell.repeat <= source) low = mid + 1
				else if (cell.first > source) high = mid - 1
				else return cell
			}

			return undefined
		}
		const bounds = new Set<number>(this.bounds(target, width))

		// Source cells' bounds, moved to their columns now.
		for (const cell of cells) {
			for (const edge of [cell.first, cell.first + cell.repeat]) {
				const moved = this.colAxis.target(edge)

				if (moved >= 0) bounds.add(moved)
			}
		}

		this.colAxis.forEach((start, _source, length) => {
			bounds.add(start)
			bounds.add(start + length)
		})

		const sorted = [...bounds].filter(col => col >= 0 && col <= width).sort((a, b) => a - b)

		for (let k = 0; k + 1 < sorted.length; k++) {
			const from = sorted[k] ?? 0
			const to = sorted[k + 1] ?? 0

			if (to <= from) continue

			const model = this.view.cell(target, from)
			const sourceCol = this.colAxis.source(from)
			const source = sourceCol < 0 ? undefined : cellAt(sourceCol)
			const covered = this.view.covered(target, from)
			const merge = this.view.mergeAt(target, from)

			if (source !== undefined && decoded === null) {
				out.push(this.copyCell(element, source, to - from))

				continue
			}

			if (source !== undefined && decoded !== null) {
				const read = decoded.cell(0, sourceCol)
				const readMerge = decoded.merge(0, sourceCol)
				const sameMerge =
					(merge === undefined && readMerge === undefined) ||
					(merge !== undefined &&
						readMerge !== undefined &&
						merge.endRow - merge.startRow === readMerge.endRow &&
						merge.endCol - merge.startCol === readMerge.endCol - sourceCol)
				const readNote = decoded.note(0, sourceCol)
				const modelNote = this.features.notes?.get(`${target},${from}`)
				const sameNote =
					this.features.notes === null ||
					(readNote === undefined
						? modelNote === undefined
						: modelNote !== undefined && modelNote.text === readNote.text && modelNote.author === readNote.author)
				const sameLink = this.features.links === null || this.features.links.get(`${target},${from}`) === decoded.link(0, sourceCol)
				const sameValidation =
					this.features.validations === null ||
					this.features.validations.name(target, from) ===
						tagAttribute(element.subarray(source.start, source.openEnd), "table:content-validation-name")

				if (
					source.covered === covered &&
					sameMerge &&
					sameNote &&
					sameLink &&
					sameValidation &&
					sameContent(model, read) &&
					model.xf === read.xf
				) {
					out.push(this.copyCell(element, source, to - from))

					continue
				}
			}

			const extras = this.extras(target, from, element, source, decoded, sourceCol)
			const sourceFormula =
				source !== undefined && model.formula !== null
					? sourceFormulaOf(element, source, model, decoded?.cell(0, sourceCol) ?? model)
					: undefined
			const single =
				model.formula !== null || this.features.notes !== null || this.features.links !== null || this.features.validations !== null

			if (single && to - from > 1) {
				for (let col = from; col < to; col++) {
					const sourceAt = this.colAxis.source(col)

					out.push(
						this.cell(
							target,
							col,
							this.view.cell(target, col),
							1,
							sourceFormula,
							this.extras(target, col, element, sourceAt < 0 ? undefined : cellAt(sourceAt), decoded, sourceAt),
							rowXf
						)
					)
				}
			} else {
				out.push(this.cell(target, from, model, to - from, sourceFormula, extras, rowXf))
			}
		}

		return `${open}${out.join("")}${closeOf(open)}`
	}

	// A source cell's bytes, `repeat` of it.
	private copyCell(row: Uint8Array, cell: SourceCell, repeat: number): string {
		const bytes = decoder.decode(row.subarray(cell.start, cell.end))

		if (repeat === cell.repeat) return bytes

		const open = decoder.decode(row.subarray(cell.start, cell.openEnd))
		const patched = setAttribute(open, "table:number-columns-repeated", repeat > 1 ? String(repeat) : undefined)

		return patched + bytes.slice(open.length)
	}
}

function startsAt(bytes: Uint8Array, at: number, text: Uint8Array): boolean {
	if (at + text.length > bytes.length) return false

	for (let k = 0; k < text.length; k++) if (bytes[at + k] !== text[k]) return false

	return true
}

// A source cell's bytes with `repeat` as its number-columns-repeated.
function repeated(row: Uint8Array, cell: SourceCell, repeat: number): Uint8Array {
	const open = encoder.encode(
		setAttribute(
			decoder.decode(row.subarray(cell.start, cell.openEnd)),
			"table:number-columns-repeated",
			repeat > 1 ? String(repeat) : undefined
		)
	)
	const rest = row.subarray(cell.openEnd, cell.end)
	const out = new Uint8Array(open.length + rest.length)

	out.set(open, 0)
	out.set(rest, open.length)

	return out
}

// The end tag of a start tag's element, under its own prefix.
function closeOf(tag: string): string {
	return `</${/^<([^\s/>]+)/u.exec(tag)?.[1] ?? "table:table-row"}>`
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
	let size = 0

	for (const part of parts) size += part.length

	const out = new Uint8Array(size)
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

// The rows of row elements one after another: each element's number-rows-repeated (1 without one).
function rowsIn(markup: string): number {
	let rows = 0

	for (const match of markup.matchAll(/<table:table-row\b([^>]*)>/gu)) {
		const repeat = /table:number-rows-repeated="(\d+)"/u.exec(match[1] ?? "")?.[1]

		rows += repeat === undefined ? 1 : Number(repeat)
	}

	return rows
}

// Past this many row elements written, the save is proved by reading it all back.
const SPAN_ROWS = 4096

export interface SpanRow {
	// The first row the element stands for, and how many it does (its number-rows-repeated).
	readonly target: number
	readonly count: number
	readonly markup: string
}

interface QueuedRow {
	readonly bytes: Uint8Array
	decoded: DecodedRows | null
}

// The k-th row of rows read back together, as its own row 0.
function rowOf(rows: DecodedRows, k: number): DecodedRows {
	return {
		built: rows.built,
		shared: rows.shared,
		cell: (row, col) => rows.cell(row + k, col),
		note: (row, col) => rows.note(row + k, col),
		link: (row, col) => rows.link(row + k, col),
		merge: (row, col) => {
			const merge = rows.merge(row + k, col)

			return merge === undefined ? undefined : { endRow: merge.endRow - k, endCol: merge.endCol }
		}
	}
}

function closeLength(element: Uint8Array): number {
	let k = element.length - 1

	while (k > 0 && element[k] !== 60) k--

	return element.length - k
}

function sameMerges(a: readonly { readonly startRow: number; readonly startCol: number }[], b: typeof a): boolean {
	return a.length === b.length && a.every((merge, k) => merge.startRow === b[k]?.startRow && merge.startCol === b[k]?.startCol)
}

function sameHeight(a: number, b: number): boolean {
	return a === b || (Number.isNaN(a) && Number.isNaN(b))
}

function sameCols(a: readonly XlsxColRange[], b: readonly XlsxColRange[]): boolean {
	if (a === b) return true
	if (a.length !== b.length) return false

	return a.every((range, k) => {
		const other = b[k]

		return (
			other !== undefined &&
			range.first === other.first &&
			range.last === other.last &&
			range.style === other.style &&
			range.flags === other.flags &&
			range.px === other.px &&
			sameHeight(range.width, other.width)
		)
	})
}

export interface TableUnheld {
	// The first rows of the source row elements holding them.
	readonly rows: ReadonlySet<number>
	// The table's name in the source (references without a sheet are on it).
	readonly own: string
	readonly shifter: Shifter
	// Formulas the model does not hold, as written.
	readonly formulas: ReadonlySet<string>
	readonly tablePrefix: (prefix: string) => boolean
}

// A row's markup with the references of the formulas the model does not hold, and the end cells of the shapes
// anchored in it, moved as the sheets were.
function movedRow(markup: string, unheld: TableUnheld): string {
	const patched = patchAttributes(markup, unheld.tablePrefix, (local, value) => {
		if (local === "formula") return unheld.formulas.has(value) ? unheld.shifter.formula(value, unheld.own, "formula") : undefined
		if (local === "end-cell-address") return unheld.shifter.address(value)

		return undefined
	})

	if (patched === null) throw new CellRefused("a reference that cannot be moved")

	return patched
}

// The children of a source cell the model does not hold (shapes and frames anchored to it), as written.
function keptChildren(row: Uint8Array, cell: SourceCell): string {
	if (cell.empty) return ""

	const inner = decoder.decode(row.subarray(cell.openEnd, cell.end)).replace(/<\/table:(?:covered-)?table-cell>$/, "")
	const kept: string[] = []
	const pattern = /<(draw:[A-Za-z-]+|table:detective|table:cell-range-source)\b/g

	// exec, not matchAll: matchAll iterates a copy of the pattern, so moving lastIndex past a kept element would not
	// skip the elements inside it.
	for (let match = pattern.exec(inner); match !== null; match = pattern.exec(inner)) {
		const name = match[1] ?? ""
		const start = match.index
		const tail = inner.indexOf(">", start)

		if (tail < 0) continue

		if (inner[tail - 1] === "/") {
			kept.push(inner.slice(start, tail + 1))
			pattern.lastIndex = tail + 1

			continue
		}

		const closeTag = `</${name}>`
		let depth = 1
		let at = tail + 1

		while (depth > 0) {
			const nextOpen = inner.indexOf(`<${name}`, at)
			const nextClose = inner.indexOf(closeTag, at)

			if (nextClose < 0) break

			if (nextOpen >= 0 && nextOpen < nextClose) {
				depth++
				at = nextOpen + name.length + 1
			} else {
				depth--
				at = nextClose + closeTag.length
			}
		}

		kept.push(inner.slice(start, at))
		pattern.lastIndex = at
	}

	return kept.join("")
}

// A source cell's table:formula the reader did not take into the model (its result alone is the cell's), while the
// model's cell still holds that result: the formula is the cell's still.
function keptFormula(
	model: CellValue,
	row: Uint8Array | null,
	cell: SourceCell | undefined,
	decoded: DecodedRows | null,
	sourceCol: number
): string | undefined {
	if (row === null || cell === undefined || decoded === null || cell.covered || model.formula !== null) return undefined

	const formula = tagAttribute(row.subarray(cell.start, cell.openEnd), "table:formula")

	if (formula === undefined) return undefined

	const read = decoded.cell(0, sourceCol)

	return read.formula === null && sameContent(model, read) ? formula : undefined
}

// A source cell's office:annotation, as written.
function annotation(row: Uint8Array, cell: SourceCell): string | undefined {
	if (cell.empty) return undefined

	const inner = decoder.decode(row.subarray(cell.openEnd, cell.end))
	const start = inner.indexOf("<office:annotation")

	if (start < 0 || inner.startsWith("<office:annotation-end", start)) return undefined

	const end = inner.indexOf("</office:annotation>", start)

	return end < 0 ? undefined : inner.slice(start, end + "</office:annotation>".length)
}

// The source's table:formula when the model's formula is the one it read from it.
function sourceFormulaOf(row: Uint8Array, cell: SourceCell, model: CellValue, read: CellValue): string | undefined {
	if (
		read.formula === null ||
		model.formula === null ||
		!sameContent({ ...model, value: read.value, number: read.number, text: read.text, runs: read.runs }, read)
	)
		return undefined

	return tagAttribute(row.subarray(cell.start, cell.openEnd), "table:formula")
}

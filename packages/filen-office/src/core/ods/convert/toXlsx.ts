import { spliceAll } from "../../arrays"
import { BytePieces, OpcPackage, bytesSource, memorySink, parseRelationships, writeZip, type ByteChunks } from "../../opc/index"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../sheet/protocol"
import { encodeUtf8, escapeAttribute, escapeText, decodeUtf8 } from "../../xml/index"
import { XlsxParts } from "../../xlsx/package/parts"
import { ChangeLog } from "../../xlsx/model/changes"
import { XlsxWorkbook } from "../../xlsx/model/workbook"
import type { CellWrite, RowProperties, SheetStore } from "../../xlsx/model/store"
import {
	CellKind,
	RowFlag,
	rowRunAt,
	type XlsxColRange,
	type XlsxRowRun,
	type XlsxSheetModel,
	type XlsxStyleTable,
	type XlsxXf
} from "../../xlsx/model/types"
import { saveXlsx } from "../../xlsx/write/save"
import { stylesExtent, STYLES_CONTENT_TYPE, writeStyles } from "../../xlsx/write/styles"
import { StyleTable } from "../../xlsx/model/styles"
import { XlsxDocument } from "../../xlsx/edit/document"
import { RenderStyleTable } from "../../sheet/session"
import { TRANSITIONAL } from "../../xlsx/write/namespaces"
import { cellRef, parseCellRef } from "../../xlsx/write/text"
import { newVml } from "../../xlsx/comments/vml"
import { planRefEdit } from "../../xlsx/refs/plan"
import { currentSection } from "../write/features"
import { textSheetName } from "../../xlsx/convert/text"
import { openOds } from "../open"
import { odsSource, type OdsSource } from "../source"
import type { OdsIssue } from "../issues"
import { SheetLossyReport, type SheetLossyKind } from "./report"
import { abortClock, aborted, Aborted, showsDate, type SheetConversion, type SheetConvertOptions } from "./types"

// An OpenDocument spreadsheet as a SpreadsheetML workbook: the reader's model (formulas already in Excel's grammar,
// those it could not take holding their cached results) written by the xlsx writer as a package of its own, every
// sheet a new part, and read back by the writer's gate. What SpreadsheetML has no form for (rows in runs past the
// grid's default, formats of empty cells past a budget) is written as rows and cells, or reported.

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
const OFFICE_DOCUMENT = `${TRANSITIONAL.relationships}/officeDocument`
const WORKSHEET_RELATIONSHIP = `${TRANSITIONAL.relationships}/worksheet`
const COMMENTS_RELATIONSHIP = `${TRANSITIONAL.relationships}/comments`
const VML_RELATIONSHIP = `${TRANSITIONAL.relationships}/vmlDrawing`
const WORKBOOK_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
const VML_TYPE = "application/vnd.openxmlformats-officedocument.vmlDrawing"
const WORKBOOK_PART = "xl/workbook.xml"
const STYLES_PART = "xl/styles.xml"
const EMPTY_SHEET_PART = "xl/worksheets/sheet1.xml"
const EMPTY_SHEET_RELATIONSHIP = "rIdSheet1"
const WORKSHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
const STYLES_RELATIONSHIP = `${TRANSITIONAL.relationships}/styles`
const LAST_ROW = SHEET_MAX_ROWS - 1
const LAST_COL = SHEET_MAX_COLS - 1
// Cells written for formats of empty cells (style runs), across the workbook: past it, a run is reported instead.
const RUN_CELL_BUDGET = 1 << 20
// Rows written as rows of their own, across the workbook (placeRowRuns, placeStyleRuns' row formats).
const RUN_ROW_BUDGET = 1 << 20
// Cells set in one store write.
const WRITE_BATCH = 1 << 14

// What each kind of reader issue is lost as.
const ISSUE_KINDS: Readonly<Record<OdsIssue["kind"], SheetLossyKind | null>> = {
	drawing: "picture",
	// Listed one by one from the unheld formulas.
	formula: null,
	dataStyle: "cellFormat",
	rotation: "cellFormat",
	pivotTable: "pivotTable",
	scenario: "other",
	linkedSheet: "externalLink",
	form: "picture",
	ddeLink: "externalLink",
	consolidation: "other",
	labelRanges: "definedName",
	trackedChanges: "other",
	subTable: "other",
	detective: "other",
	cellRangeSource: "externalLink",
	conditionalFormat: "conditionalFormat",
	validation: "dataValidation",
	filter: "filter",
	link: "other",
	name: "definedName",
	nullDate: "other",
	repeat: "other",
	// The formatter's own separators: shown, nothing kept apart.
	locale: null
}

function attr(name: string, value: string | number): string {
	return ` ${name}="${escapeAttribute(String(value))}"`
}

function areaName(row: number, rows: number, col: number, cols: number): string {
	const first = cellRef(row, col)

	return rows <= 1 && cols <= 1 ? first : `${first}:${cellRef(row + Math.max(1, rows) - 1, col + Math.max(1, cols) - 1)}`
}

function reportIssues(
	issues: readonly OdsIssue[],
	source: OdsSource,
	report: SheetLossyReport,
	named: (sheet: string | undefined) => string | undefined
): void {
	for (const issue of issues) {
		const kind = issue.kind === "drawing" && issue.detail?.startsWith("chart") === true ? "chart" : ISSUE_KINDS[issue.kind]

		if (kind !== null) report.note(kind, named(issue.sheet), issue.count)
	}

	const formulas = source.unheld.items.filter(item => item.kind === "formula")

	for (const item of formulas)
		report.formula(
			item.sheet,
			areaName(item.row, item.rows, item.col, item.cols),
			item.text,
			Math.max(1, item.rows) * Math.max(1, item.cols)
		)

	// Too many to follow one by one: counted as the reader counted them.
	if (source.unheld.opaque !== null || formulas.length === 0)
		for (const issue of issues)
			if (issue.kind === "formula" && formulas.length === 0) report.note("formula", named(issue.sheet), issue.count)
}

// Dates before 1900-03-01: OpenDocument counts from 1899-12-30, the 1900 date system counts a 1900-02-29 that was
// not (ECMA-376 Part 1 §18.17.4.1), so their serials are a day lower in SpreadsheetML. Earlier than its day 1 a
// date has no serial there: such cells are reported, their numbers kept. The 1904 date system has no such day
// (§18.17.4.2): its serials are OpenDocument's from a 1904-01-01 null date, and only a date before that is reported.
function shiftEarlyDates(
	model: XlsxSheetModel,
	codeOf: (xf: number) => string,
	sheet: string,
	report: SheetLossyReport,
	date1904: boolean
): void {
	const memo = new Map<string, boolean>()
	const xfs = new Map<number, boolean>()
	const writes: CellWrite[] = []

	for (const block of model.store.blocks) {
		for (let index = 0; index < block.rowCount; index++) {
			const end = block.rowStarts[index + 1] ?? 0

			for (let k = block.rowStarts[index] ?? 0; k < end; k++) {
				if (block.kinds[k] !== CellKind.NUMBER) continue

				const value = block.values[k] ?? 0

				if (value >= (date1904 ? 0 : 61)) continue

				const xf = block.styles[k] ?? 0
				let date = xfs.get(xf)

				if (date === undefined) xfs.set(xf, (date = showsDate(codeOf(xf), memo)))
				if (!date) continue

				if (date1904) {
					report.note("other", sheet)

					continue
				}

				if (value < 1) {
					if (Math.floor(value) !== 0 || value < 0) report.note("other", sheet)

					continue
				}

				writes.push({
					row: block.firstRow + (block.rows[index] ?? 0),
					col: block.cols[k] ?? 0,
					kind: CellKind.NUMBER,
					value: value - 1,
					style: xf,
					formula: block.formulas?.[k] ?? -1,
					origin: -1
				})
			}
		}
	}

	;(model.store as SheetStore).setCells(writes)
}

// Numbers General shows rounded to the document's standard precision (LibreOffice's "Standard" with a number of
// decimals, style:decimal-places of the default cell style, ODF 1.3 Part 3 §20.258): SpreadsheetML's General has no
// such precision, so they show more digits there. Reported per sheet.
function reportPrecision(
	model: XlsxSheetModel,
	precision: number,
	codeOf: (xf: number) => string,
	sheet: string,
	report: SheetLossyReport
): void {
	const scale = 10 ** precision
	const general = new Map<number, boolean>()
	let count = 0

	for (const block of model.store.blocks) {
		for (let k = 0, end = block.rowStarts[block.rowCount] ?? 0; k < end; k++) {
			if (block.kinds[k] !== CellKind.NUMBER) continue

			const value = block.values[k] ?? 0
			const xf = block.styles[k] ?? 0
			let plain = general.get(xf)

			if (plain === undefined) general.set(xf, (plain = codeOf(xf) === "General"))
			if (plain && Math.round(value * scale) / scale !== value) count++
		}
	}

	report.note("cellFormat", sheet, count)
}

// The column range holding `col`, or undefined.
function columnAt(cols: readonly XlsxColRange[], col: number): XlsxColRange | undefined {
	for (const range of cols) if (col >= range.first && col <= range.last) return range

	return undefined
}

// A cell format alike to `xf` but its own record: what an empty cell gets to undo its column's format.
function ownCopy(styles: XlsxStyleTable, xf: number, copies: Map<number, number>): number {
	let copy = copies.get(xf)

	if (copy === undefined) {
		const record = styles.cellXfs[xf] as XlsxXf

		;(styles.cellXfs as XlsxXf[]).push({ ...record })
		copy = styles.cellXfs.length - 1
		copies.set(xf, copy)
	}

	return copy
}

interface RunBudget {
	left: number
}

// Formats of empty cells held in runs: a run to the sheet's last row becomes its columns' format, a run to the last
// column its rows' format (customFormat), each with the cells before it that keep another format written as cells;
// any other run its cells. A run whose cells would pass the budget is reported.
function placeStyleRuns(
	model: XlsxSheetModel,
	styles: XlsxStyleTable,
	budget: RunBudget,
	rowBudget: RunBudget,
	sheet: string,
	report: SheetLossyReport
): boolean {
	const runs = model.styleRuns

	if (runs === undefined) return true

	const store = model.store as SheetStore
	const copies = new Map<number, number>()
	const cells = new Map<number, Map<number, number>>()
	const rowStyles = new Map<number, number>()
	const columnStyles: { first: number; last: number; style: number }[] = []
	let lost = 0
	const held = (row: number, col: number): boolean => {
		const slot = store.locate(row, col)

		return slot >= 0
	}
	const cellStyle = (row: number, col: number, style: number): void => {
		let byCol = cells.get(row)

		if (byCol === undefined) cells.set(row, (byCol = new Map()))

		byCol.set(col, style)
	}
	// The format an empty cell shows without a run: its column's.
	const beneath = (col: number): number => Math.max(0, columnAt(model.cols, col)?.style ?? 0)
	const own = (style: number, col: number): number => (style === 0 && beneath(col) !== 0 ? ownCopy(styles, 0, copies) : style)
	const all = { startRow: 0, startCol: 0, endRow: LAST_ROW, endCol: LAST_COL }
	const list: [number, number, number, number, number][] = []

	runs.forEach(all, (startRow, startCol, endRow, endCol, style) => list.push([startRow, startCol, endRow, endCol, style]))

	// Rows and columns first: cells written for other runs go over them.
	const order = (run: [number, number, number, number, number]): number => (run[2] === LAST_ROW ? 0 : run[3] === LAST_COL ? 1 : 2)

	list.sort((a, b) => order(a) - order(b))

	// Rows formatted across the sheet: SpreadsheetML has a row's format alone, one row element each. The format on most
	// of the rows is the columns' instead (where the columns have no format of their own to lose), the other rows their
	// own, few: a run of a million formatted rows is one column range, not a million rows.
	const across = new Map<number, number>()

	for (const [startRow, startCol, endRow, endCol, style] of list)
		if (startCol === 0 && endCol === LAST_COL && !(startRow === 0 && endRow === LAST_ROW))
			across.set(style, (across.get(style) ?? 0) + endRow - startRow + 1)

	const commonest = [...across].reduce<[number, number] | null>(
		(best, entry) => (best === null || entry[1] > best[1] ? entry : best),
		null
	)
	const plainColumns =
		model.cols.every(range => range.style <= 0) && !list.some(([startRow, , endRow]) => startRow === 0 && endRow === LAST_ROW)

	if (commonest !== null && plainColumns && commonest[1] * 2 > LAST_ROW + 1) {
		const style = commonest[0]
		const runs = list.filter(
			([startRow, startCol, endRow, endCol, own]) =>
				own === style && startCol === 0 && endCol === LAST_COL && !(startRow === 0 && endRow === LAST_ROW)
		)
		const others = LAST_ROW + 1 - commonest[1]

		if (others > rowBudget.left) return false

		rowBudget.left -= others
		columnStyles.push({ first: 0, last: LAST_COL, style })

		// The other rows keep the format they showed: the columns' (none).
		let at = 0

		for (const [startRow, , endRow] of [...runs].sort((a, b) => a[0] - b[0])) {
			for (let row = at; row < startRow; row++) rowStyles.set(row, 0)

			at = Math.max(at, endRow + 1)
		}

		for (let row = at; row <= LAST_ROW; row++) rowStyles.set(row, 0)

		spliceAll(
			list,
			0,
			list.length,
			list.filter(run => !runs.includes(run))
		)
	}

	for (const [startRow, startCol, endRow, endCol, style] of list) {
		const height = endRow - startRow + 1
		const width = endCol - startCol + 1

		if (endRow === LAST_ROW && startRow === 0) {
			columnStyles.push({ first: startCol, last: endCol, style })

			continue
		}

		if (endCol === LAST_COL) {
			// The row's format (each row one of its own, charged to the row budget: past it nothing is laid out), and
			// the cells before the run keep what they showed.
			if (height > rowBudget.left) return false

			rowBudget.left -= height

			const before = startCol * height

			if (before > budget.left) {
				lost++
				continue
			}

			budget.left -= before

			for (let row = startRow; row <= endRow; row++) {
				rowStyles.set(row, style)

				for (let col = 0; col < startCol; col++) if (!held(row, col)) cellStyle(row, col, own(beneath(col), col))
			}

			continue
		}

		const area = height * width

		if (area > budget.left) {
			lost++
			continue
		}

		budget.left -= area

		for (let row = startRow; row <= endRow; row++)
			for (let col = startCol; col <= endCol; col++) if (!held(row, col)) cellStyle(row, col, own(style, col))
	}

	if (columnStyles.length > 0) model.cols = withColumnStyles(model.cols, columnStyles, model.format.defaultColPx ?? Number.NaN)

	if (rowStyles.size > 0) {
		const rows: RowProperties[] = []

		for (const [row, style] of rowStyles) {
			const block = store.blocks[store.blockOf(row)]
			const index = block === undefined || row < block.firstRow ? -1 : block.rowIndex(row)
			const flags = block !== undefined && index >= 0 ? (block.rowFlags[index] ?? 0) : 0
			const height = block !== undefined && index >= 0 ? (block.rowHeights[index] ?? Number.NaN) : Number.NaN

			rows.push({ row, height, style, flags: flags | RowFlag.CUSTOM_FORMAT })
		}

		store.setRows(rows)
	}

	let batch: CellWrite[] = []

	for (const [row, byCol] of cells) {
		for (const [col, style] of byCol) {
			batch.push({ row, col, kind: CellKind.EMPTY, value: 0, style, formula: -1, origin: -1 })

			if (batch.length >= WRITE_BATCH) {
				store.setCells(batch)
				batch = []
			}
		}
	}

	store.setCells(batch)
	delete model.styleRuns

	if (lost > 0) report.note("cellFormat", sheet, lost)

	return true
}

// Column ranges with the formats of runs over whole columns laid over them.
function withColumnStyles(
	cols: readonly XlsxColRange[],
	runs: readonly { first: number; last: number; style: number }[],
	defaultPx: number
): XlsxColRange[] {
	const bounds = new Set<number>([0, SHEET_MAX_COLS])

	for (const range of cols) bounds.add(range.first).add(range.last + 1)
	for (const run of runs) bounds.add(run.first).add(run.last + 1)

	const sorted = [...bounds].sort((a, b) => a - b)
	const out: XlsxColRange[] = []

	for (let k = 0; k + 1 < sorted.length; k++) {
		const first = sorted[k] ?? 0
		const last = (sorted[k + 1] ?? 0) - 1
		const base = columnAt(cols, first)
		const run = runs.find(candidate => first >= candidate.first && first <= candidate.last)

		if (base === undefined && run === undefined) continue

		const range: XlsxColRange = base ?? {
			first,
			last,
			width: Number.NaN,
			...(!Number.isNaN(defaultPx) && { px: defaultPx }),
			style: -1,
			flags: 0
		}

		out.push({ ...range, first, last, style: run?.style ?? range.style })
	}

	return out
}

// Rows held in runs (hidden or resized rows without cells) as rows of the store: a run to the grid's end becomes the
// sheet's default row, the rows above it that have none of their own then written with the old default.
// Properties of empty rows held in runs (OpenDocument's repeated rows): the commonest, by rows, becomes the sheet's
// default row (sheetFormatPr defaultRowHeight, customHeight, zeroHeight; ECMA-376 Part 1 §18.3.1.81), every other
// row is a row of its own, as are the rows that kept the old default when it changed. Those rows are charged to
// `budget`; past it the conversion is refused (tooLarge) before any is laid out.
function placeRowRuns(model: XlsxSheetModel & { rowRuns?: unknown }, budget: RunBudget): boolean {
	const runs = model.rowRuns

	if (runs === undefined || runs.length === 0) return true

	const store = model.store as SheetStore
	const before = model.format
	// What a default row can be: a height and whether rows are hidden, nothing else.
	const defaultable = (flags: number): boolean => (flags & ~(RowFlag.HIDDEN | RowFlag.CUSTOM_HEIGHT)) === 0
	const key = (height: number, flags: number): string =>
		`${String((flags & RowFlag.HIDDEN) !== 0)}|${Number.isNaN(height) || height === before.defaultRowHeight ? "d" : String(height)}`
	const original = key(Number.NaN, before.zeroHeight ? RowFlag.HIDDEN : 0)
	const counts = new Map<string, { rows: number; run: XlsxRowRun }>()
	let inRuns = 0

	for (const run of runs) {
		const count = run.last - run.first + 1

		inRuns += count

		if (!defaultable(run.flags)) continue

		const k = key(run.heightPt, run.flags)
		const entry = counts.get(k)

		if (entry === undefined) counts.set(k, { rows: count, run })
		else entry.rows += count
	}

	// Rows in neither a run nor a block: the old default's.
	let inBlocks = 0

	for (const block of store.blocks)
		for (let index = 0; index < block.rowCount; index++)
			if (rowRunAt(runs, block.firstRow + (block.rows[index] ?? 0)) === undefined) inBlocks++

	const gaps = Math.max(0, LAST_ROW + 1 - inRuns - inBlocks)
	// Rows written for a default: the runs' other rows, and the gaps when it is not the old one.
	const cost = (k: string): number => inRuns - (counts.get(k)?.rows ?? 0) + (k === original ? 0 : gaps)
	let chosen = original
	let least = cost(original)

	for (const k of counts.keys()) {
		const own = cost(k)

		if (own < least) {
			least = own
			chosen = k
		}
	}

	if (least > budget.left) return false

	budget.left -= least

	const rows: RowProperties[] = []
	const tail = chosen === original ? undefined : counts.get(chosen)?.run

	for (const run of runs) {
		if (defaultable(run.flags) && key(run.heightPt, run.flags) === chosen) continue

		for (let row = run.first; row <= run.last; row++) rows.push({ row, height: run.heightPt, style: -1, flags: run.flags })
	}

	if (tail !== undefined) {
		const hidden = (tail.flags & RowFlag.HIDDEN) !== 0

		model.format = {
			...before,
			zeroHeight: hidden,
			customHeight: !Number.isNaN(tail.heightPt) || before.customHeight,
			defaultRowHeight: Number.isNaN(tail.heightPt) ? before.defaultRowHeight : tail.heightPt
		}

		// The gaps keep the old default (a block's rows have their own properties).
		let at = 0

		for (const run of [...runs, { first: LAST_ROW + 1, last: LAST_ROW + 1, flags: 0, heightPt: Number.NaN }]) {
			for (let row = at; row < run.first; row++) {
				const block = store.blocks[store.blockOf(row)]

				if (block !== undefined && row >= block.firstRow && block.rowIndex(row) >= 0) continue

				rows.push({ row, height: before.defaultRowHeight, style: -1, flags: before.customHeight ? RowFlag.CUSTOM_HEIGHT : 0 })
			}

			at = run.last + 1
		}
	}

	store.setRows(rows)
	;(model as { rowRuns?: unknown }).rowRuns = undefined

	return true
}

// SpreadsheetML's error values (ECMA-376 Part 1 §18.18.21 ST_CellErrorType).
const EXCEL_ERRORS: ReadonlySet<string> = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA"])

// LibreOffice's own error codes ("Err:502"; the codes are LibreOffice Help's "Error codes in LibreOffice Calc") as
// the Excel error LibreOffice 7.5 writes for each in its own .xlsx export (seen: 502, 509, 511 and 522 as #VALUE!,
// 520 as #N/A; the rest by the same grouping): argument, syntax and circular-reference errors are #VALUE!, a missing
// code #NULL!, the others #N/A.
const LIBREOFFICE_ERRORS: Readonly<Record<string, string>> = {
	"Err:502": "#VALUE!",
	"Err:503": "#NUM!",
	"Err:504": "#VALUE!",
	"Err:508": "#VALUE!",
	"Err:509": "#VALUE!",
	"Err:510": "#VALUE!",
	"Err:511": "#VALUE!",
	"Err:519": "#VALUE!",
	"Err:521": "#NULL!",
	"Err:522": "#VALUE!",
	"Err:524": "#REF!",
	"Err:525": "#NAME?",
	"Err:532": "#DIV/0!"
}

// Error results Excel has no name for, as the nearest it has (LIBREOFFICE_ERRORS, else #N/A), reported: t="e" holds
// Excel's names alone.
function excelErrors(model: XlsxSheetModel, sheet: string, report: SheetLossyReport): void {
	const store = model.store
	let changed = 0

	for (const block of store.blocks) {
		const values = block.values as unknown as Float64Array

		for (let k = 0, end = block.rowStarts[block.rowCount] ?? 0; k < end; k++) {
			if (block.kinds[k] !== CellKind.ERROR) continue

			const text = store.strings.text(values[k] ?? 0)

			if (EXCEL_ERRORS.has(text)) continue

			values[k] = store.strings.intern(LIBREOFFICE_ERRORS[text] ?? "#N/A")
			changed++
		}
	}

	report.note("other", sheet, changed)
}

// Every row written: the writer writes the rows an edit marked.
function markRows(model: XlsxSheetModel): void {
	for (const block of model.store.blocks) {
		const flags = block.rowFlags as unknown as Uint8Array | Uint16Array | Int32Array

		for (let index = 0; index < block.rowCount; index++) flags[index] = (flags[index] ?? 0) | RowFlag.DIRTY
	}
}

function workbookXml(workbook: XlsxWorkbook): string {
	const position = new Map(workbook.sheets.map((entry, index) => [entry.id, index]))
	const protection = workbook.protection
	const names = workbook.definedNames
		.filter(name => name.sheet === null || position.has(name.sheet))
		.map(
			name =>
				`<definedName${attr("name", name.name)}${name.sheet === null ? "" : attr("localSheetId", position.get(name.sheet) ?? 0)}${name.hidden ? ' hidden="1"' : ""}>${escapeText(name.formula)}</definedName>`
		)
	const calc = workbook.calc

	return (
		`${DECLARATION}<workbook xmlns="${TRANSITIONAL.main}" xmlns:r="${TRANSITIONAL.relationships}">` +
		(workbook.date1904 ? '<workbookPr date1904="1"/>' : "<workbookPr/>") +
		(protection?.structure === true ? '<workbookProtection lockStructure="1"/>' : "") +
		`<bookViews><workbookView${attr("activeTab", workbook.activeTab)}/></bookViews><sheets>` +
		(workbook.sheets.length === 0
			? `<sheet name="Sheet1" sheetId="1"${attr("r:id", EMPTY_SHEET_RELATIONSHIP)}/>`
			: workbook.sheets
					.map(
						entry =>
							`<sheet${attr("name", entry.name)}${attr("sheetId", entry.sheetId)}${entry.state === "visible" ? "" : attr("state", entry.state)}${attr("r:id", entry.relationshipId)}/>`
					)
					.join("")) +
		"</sheets>" +
		(names.length === 0 ? "" : `<definedNames>${names.join("")}</definedNames>`) +
		`<calcPr${calc.iterate ? `${attr("iterate", 1)}${attr("iterateCount", calc.iterateCount)}${attr("iterateDelta", calc.iterateDelta)}` : ""}/>` +
		"</workbook>"
	)
}

// The features' content types with the workbook's own overrides.
function contentTypesOf(synthetic: string, overrides: readonly string[]): string {
	const end = synthetic.lastIndexOf("</Types>")

	return end < 0
		? `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`
		: `${synthetic.slice(0, end)}${overrides.join("")}</Types>`
}

function relationshipsXml(entries: readonly { id: string; type: string; target: string; external?: boolean }[]): string {
	return (
		`${DECLARATION}<Relationships xmlns="${PACKAGE_RELS}">` +
		entries
			.map(
				entry =>
					`<Relationship${attr("Id", entry.id)}${attr("Type", entry.type)}${attr("Target", entry.target)}${entry.external === true ? ' TargetMode="External"' : ""}/>`
			)
			.join("") +
		"</Relationships>"
	)
}

// The notes' legacy drawing (the shapes Excel shows notes in): one per sheet with notes, with its relationship.
function noteDrawings(parts: Map<string, Uint8Array>, overrides: string[], workbook: XlsxWorkbook, sections: Map<number, string>): void {
	workbook.sheets.forEach((entry, index) => {
		const model = entry.model

		if (model === null) return

		const comments = model.relationships.all.find(relationship => relationship.type === COMMENTS_RELATIONSHIP)

		if (comments === undefined) return

		const commentsPart = `xl/${comments.target.replace(/^\.\.\//, "")}`
		const bytes = parts.get(commentsPart)

		if (bytes === undefined) return

		const cells: { row: number; col: number }[] = []

		for (const match of decodeUtf8(bytes).matchAll(/<comment\b[^>]*?\sref="([^"]+)"/g)) {
			const ref = parseCellRef(match[1] ?? "")

			if (ref !== undefined) cells.push(ref)
		}

		if (cells.length === 0) return

		const vml = `xl/drawings/vmlDrawing${index + 1}.vml`
		const relsName = `xl/worksheets/_rels/sheet${index + 1}.xml.rels`
		const rels = parts.get(relsName)
		const listed = rels === undefined ? [] : [...parseRelationships(rels, entry.part).all]
		let n = listed.length + 1

		while (listed.some(relationship => relationship.id === `rId${n}`)) n++

		const id = `rId${n}`

		parts.set(vml, newVml(index + 1, cells))
		parts.set(
			relsName,
			encodeUtf8(
				relationshipsXml([
					...listed.map(relationship => ({
						id: relationship.id,
						type: relationship.type,
						target: relationship.target,
						external: relationship.external
					})),
					{ id, type: VML_RELATIONSHIP, target: `../drawings/vmlDrawing${index + 1}.vml` }
				])
			)
		)
		overrides.push(`<Override PartName="/${vml}" ContentType="${VML_TYPE}"/>`)
		sections.set(entry.id, `<legacyDrawing r:id="${id}"/>`)
	})
}

async function zipped(parts: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
	const sink = memorySink()

	await writeZip(
		{ items: [...parts].map(([name, bytes]) => ({ kind: "data" as const, name, bytes: BytePieces.of([bytes]), compress: false })) },
		null,
		sink
	)

	return sink.bytes()
}

export async function odsToXlsx(source: Uint8Array, options: SheetConvertOptions = {}): Promise<SheetConversion> {
	const turns = options.turns
	const clock = abortClock(options)
	const opened = await openOds(bytesSource(source), {
		...(clock !== undefined && { slicing: clock }),
		...(turns !== undefined && { signal: turns.signal }),
		...(options.inflate !== undefined && { inflate: options.inflate })
	})

	if (!opened.ok) {
		switch (opened.reason) {
			case "aborted":
				return { ok: false, reason: "aborted", message: opened.message }
			case "encrypted":
				return { ok: false, reason: "encrypted", message: opened.message }
			case "tooLarge":
				return { ok: false, reason: "tooLarge", message: opened.message }
			case "malformed":
			case "failed":
				return { ok: false, reason: "corrupt", message: opened.message }
			default:
				return { ok: false, reason: "notSource", message: opened.message }
		}
	}

	const ods = opened.workbook
	const odsFacts = odsSource(ods)

	if (odsFacts === undefined) return { ok: false, reason: "corrupt", message: "The spreadsheet has no source" }

	// Content past what the reader holds (a repeat beyond its caps) would be left out: refused, as its editor refuses
	// to save it.
	const truncated = odsFacts.tables.find(table => table.truncated)

	if (truncated !== undefined) return { ok: false, reason: "tooLarge", message: `${truncated.name} repeats past what is read` }

	// Sheet names Excel takes (at most 31 characters, none of \\ / ? * [ ] :, not History), each unique; what names a
	// renamed sheet follows it (refs/plan.ts).
	// Every name already valid and unique is kept: reserved before any sheet is renamed, so a new name never takes
	// one a later sheet still holds (whose own rename would then move what was just renamed).
	const taken = new Set<string>()
	const renamed = new Map<string, string>()
	const keeps = new Set<number>()

	for (const entry of ods.sheets) {
		if (textSheetName(entry.name) === entry.name && !taken.has(entry.name.toUpperCase())) {
			taken.add(entry.name.toUpperCase())
			keeps.add(entry.id)
		}
	}

	// Every current name is no new one either.
	const current = new Set(ods.sheets.map(entry => entry.name.toUpperCase()))

	for (const entry of ods.sheets) {
		if (keeps.has(entry.id)) continue

		const base = textSheetName(entry.name)
		let name = base

		for (let n = 2; taken.has(name.toUpperCase()) || current.has(name.toUpperCase()); n++) {
			const suffix = ` (${n})`

			name = `${base.slice(0, 31 - suffix.length)}${suffix}`
		}

		taken.add(name.toUpperCase())

		if (name === entry.name) continue

		const planned = await planRefEdit(ods, { kind: "renameSheet", sheet: entry.id, name })

		if (!planned.ok)
			return { ok: false, reason: "unsupported", message: `${entry.name} cannot be renamed for Excel: ${planned.refusal.reason}` }

		planned.plan.apply()
		renamed.set(entry.name, name)
		entry.name = name
	}

	const report = new SheetLossyReport(ods.sheets.map(entry => entry.name))

	for (const name of renamed.values()) report.note("sheetName", name)

	reportIssues(opened.issues, odsFacts, report, name => (name === undefined ? undefined : (renamed.get(name) ?? name)))

	if (ods.macros) report.note("macros", undefined)

	const budget: RunBudget = { left: RUN_CELL_BUDGET }
	const rowBudget: RunBudget = { left: RUN_ROW_BUDGET }
	const probe = new XlsxDocument(ods, new RenderStyleTable(), { kind: "ods" })
	const styles = ods.styles

	for (const entry of ods.sheets) {
		const model = entry.model

		if (model === null) return { ok: false, reason: "corrupt", message: `${entry.name} was not read` }

		excelErrors(model, entry.name, report)
		if (!placeStyleRuns(model, styles, budget, rowBudget, entry.name, report))
			return { ok: false, reason: "tooLarge", message: `${entry.name} has more formatted rows than a conversion lays out` }
		if (!placeRowRuns(model, rowBudget))
			return { ok: false, reason: "tooLarge", message: `${entry.name} has more rows of their own than a conversion lays out` }
		shiftEarlyDates(model, xf => probe.styles.numFmtCode(xf), entry.name, report, ods.date1904)

		// Content hidden on a protected sheet (style:cell-protect="hidden-and-protected", ODF 1.3 Part 3 §20.253):
		// SpreadsheetML hides a formula, never the value.
		if (model.protection !== null) {
			let hidden = 0

			for (const block of model.store.blocks)
				for (let k = 0, end = block.rowStarts[block.rowCount] ?? 0; k < end; k++)
					if (block.kinds[k] !== CellKind.EMPTY && probe.styles.protection(block.styles[k] ?? 0)?.hideAll === true) hidden++

			report.note("cellFormat", entry.name, hidden)
		}

		if (ods.standardPrecision !== undefined && ods.standardPrecision >= 0)
			reportPrecision(model, ods.standardPrecision, xf => probe.styles.numFmtCode(xf), entry.name, report)
		markRows(model)

		// A password's digest OpenDocument keeps (unsalted) is not one SpreadsheetML's hash can hold.
		if (model.protection !== null && (model.protection.hash.hashValue ?? "") !== "") {
			model.protection = { ...model.protection, hash: {} }
			report.note("protectionPassword", entry.name)
		}

		if (clock?.due === true) await clock.pause()
	}

	if ((ods.protection?.hash.hashValue ?? "") !== "") report.note("protectionPassword", undefined)

	// The package: the parts the features were read into, and the workbook's own.
	const parts = new Map<string, Uint8Array>()
	const overrides: string[] = [
		`<Override PartName="/${WORKBOOK_PART}" ContentType="${WORKBOOK_TYPE}"/>`,
		`<Override PartName="/${STYLES_PART}" ContentType="${STYLES_CONTENT_TYPE}"/>`
	]
	let synthetic = ""

	// Each part as the renames left it (a chart's ranges follow its sheet), else as it was read.
	for (const [name, bytes] of odsFacts.parts) {
		const write = ods.changes.parts.get(name)

		if (name === "[Content_Types].xml") synthetic = decodeUtf8(bytes)
		else if (write === undefined) parts.set(name, bytes)
		else if (write !== null) {
			const written = await write.write(ods)

			parts.set(name, written instanceof Uint8Array ? written : await joinedBytes(written))
		}
	}

	const legacy = new Map<number, string>()

	noteDrawings(parts, overrides, ods, legacy)

	parts.set("[Content_Types].xml", encodeUtf8(contentTypesOf(synthetic, overrides)))
	parts.set("_rels/.rels", encodeUtf8(relationshipsXml([{ id: "rId1", type: OFFICE_DOCUMENT, target: WORKBOOK_PART }])))
	parts.set(
		"xl/_rels/workbook.xml.rels",
		encodeUtf8(
			relationshipsXml([
				...ods.sheets.map(entry => ({
					id: entry.relationshipId,
					type: WORKSHEET_RELATIONSHIP,
					target: entry.part.replace(/^xl\//, "")
				})),
				{ id: `rId${ods.sheets.length + 1}`, type: STYLES_RELATIONSHIP, target: "styles.xml" },
				...(ods.sheets.length === 0
					? [{ id: EMPTY_SHEET_RELATIONSHIP, type: WORKSHEET_RELATIONSHIP, target: "worksheets/sheet1.xml" }]
					: [])
			])
		)
	)

	// A workbook of no tables (ODF allows it) as one of an empty sheet: SpreadsheetML has a sheet at least (§18.2.27).
	if (ods.sheets.length === 0) {
		parts.set(EMPTY_SHEET_PART, encodeUtf8(`${DECLARATION}<worksheet xmlns="${TRANSITIONAL.main}"><sheetData/></worksheet>`))
		overrides.push(`<Override PartName="/${EMPTY_SHEET_PART}" ContentType="${WORKSHEET_TYPE}"/>`)
		parts.set("[Content_Types].xml", encodeUtf8(contentTypesOf(synthetic, overrides)))
	}

	// workbook.xml and styles.xml are complete as written: parts of the package, not edits (the gate's checks of an
	// edit's styles are of formats appended to a file's own).
	parts.set(WORKBOOK_PART, encodeUtf8(workbookXml(ods)))

	const odsStyles = ods.styles

	// Literal spaces escaped, as LibreOffice writes them: it reads a bare space before a fill as nothing.
	for (const [id, code] of odsStyles.numFmts) odsStyles.numFmts.set(id, escapedSpaces(code))
	const extent = stylesExtent(odsStyles, odsStyles.cellXfs.length)

	parts.set(STYLES_PART, await writeStyles(odsStyles, extent, null, TRANSITIONAL.main, STYLES_PART))

	const written = new StyleTable({
		numFmts: new Map([...odsStyles.numFmts].filter(([id]) => extent.numFmts.has(id) || id < 164)),
		fonts: odsStyles.fonts.slice(0, extent.fonts),
		fills: odsStyles.fills.slice(0, extent.fills),
		borders: odsStyles.borders.slice(0, extent.borders),
		cellStyleXfs: [...odsStyles.cellStyleXfs],
		cellXfs: odsStyles.cellXfs.slice(0, extent.cellXfs),
		cellStyles: [...odsStyles.cellStyles],
		dxfs: odsStyles.dxfs.slice(0, extent.dxfs),
		indexedColors: odsStyles.indexedColors === null ? null : [...odsStyles.indexedColors]
	})

	const opc = await OpcPackage.open(bytesSource(await zipped(parts)))
	const xlsxParts = new XlsxParts(opc, await opc.contentTypes())
	const finalChanges = new ChangeLog(name => xlsxParts.loadedRelationships(name))
	const final = new XlsxWorkbook({
		format: "xlsx",
		variant: "xlsx",
		strict: false,
		parts: xlsxParts,
		workbookPart: WORKBOOK_PART,
		workbookSections: [],
		sheets: ods.sheets,
		definedNames: ods.definedNames,
		styles: written,
		sharedStrings: ods.sharedStrings,
		theme: null,
		date1904: ods.date1904,
		calc: ods.calc,
		protection: ods.protection === null ? null : { ...ods.protection, hash: {} },
		fileSharing: null,
		activeTab: ods.activeTab,
		changes: finalChanges,
		limits: ods.limits,
		macros: false,
		signatures: 0
	})

	for (const entry of final.sheets) {
		const model = entry.model

		if (model === null) continue

		finalChanges.sheetRows(entry.id)

		// Each section as the renames left it (their edits are the ODS workbook's change log), else the model's own.
		const marked = ods.changes.sheets.get(entry.id)?.sections

		for (const section of model.sections) {
			if (section.bytes === null || marked?.get(section.name) === null) continue

			const current = currentSection(ods, model, section.name)

			finalChanges.sheetSection(entry.id, section.name, () => current ?? joinSections(model, section.name))
		}

		const drawing = legacy.get(entry.id)

		if (drawing !== undefined) finalChanges.sheetSection(entry.id, "legacyDrawing", () => drawing)
	}

	finalChanges.sharedStringsAppended()

	if (aborted(options)) throw new Aborted()

	const saved = await saveXlsx({ opc, workbook: final }, clock === undefined ? {} : { slicing: clock })

	if (aborted(options)) throw new Aborted()

	if (!saved.ok)
		return { ok: false, reason: saved.reason === "write" ? "unsupported" : "verify", message: `${saved.reason}: ${saved.message}` }
	if (saved.bytes === undefined) return { ok: false, reason: "verify", message: "The save wrote no bytes" }

	return { ok: true, bytes: saved.bytes, lossy: report.list() }
}

// A number format's literal spaces as "\ " (ECMA-376 Part 1 §18.8.31): the same format, which LibreOffice 7.5 reads as
// written where a bare one before a "*" fill it does not show. In a section with a fill, a minus sign escaped and, in
// one without digits, the text after the fill one quoted string, as LibreOffice writes them.
function escapedSpaces(code: string): string {
	return splitSections(code)
		.map(section => {
			const tokens = formatTokens(section)
			const digitless = !tokens.some(token => token.kind === "digit" || token.kind === "text")
			const filled = tokens.some(token => token.kind === "fill")
			let fill = false
			let after = ""
			let out = ""

			for (const token of tokens) {
				if (digitless && fill && token.kind === "literal") {
					after += token.value

					continue
				}

				if (after !== "") {
					out += `"${after.replaceAll('"', '""')}"`
					after = ""
				}

				if (token.kind === "fill") fill = true

				// A minus sign in a section with a fill escaped, as LibreOffice writes it (bare, it reads it as a sign).
				out += filled && token.kind === "literal" && token.raw === "-" ? "\\-" : token.raw
			}

			return after === "" ? out : `${out}"${after.replaceAll('"', '""')}"`
		})
		.join(";")
}

interface FormatToken {
	readonly kind: "literal" | "fill" | "digit" | "text" | "other"
	// The character a literal shows.
	readonly value: string
	readonly raw: string
}

// A section's tokens: quoted strings and escapes as the literals they show, "*x" fills, "_x" padding, brackets,
// digit placeholders and "@".
function formatTokens(section: string): FormatToken[] {
	const tokens: FormatToken[] = []

	for (let k = 0; k < section.length; k++) {
		const c = section[k] ?? ""

		if (c === '"') {
			const end = section.indexOf('"', k + 1)
			const text = end < 0 ? section.slice(k + 1) : section.slice(k + 1, end)

			tokens.push({ kind: "literal", value: text, raw: end < 0 ? section.slice(k) : section.slice(k, end + 1) })
			k = end < 0 ? section.length : end
		} else if (c === "\\") {
			const next = section[k + 1] ?? ""

			tokens.push({ kind: "literal", value: next, raw: `\\${next}` })
			k++
		} else if (c === "*") {
			tokens.push({ kind: "fill", value: "", raw: c + (section[k + 1] ?? "") })
			k++
		} else if (c === "_") {
			tokens.push({ kind: "other", value: "", raw: c + (section[k + 1] ?? "") })
			k++
		} else if (c === "[") {
			const end = section.indexOf("]", k)
			const raw = end < 0 ? section.slice(k) : section.slice(k, end + 1)

			tokens.push({ kind: "other", value: "", raw })
			k = end < 0 ? section.length : end
		} else if (c === "0" || c === "#" || c === "?") {
			tokens.push({ kind: "digit", value: c, raw: c })
		} else if (c === "@") {
			tokens.push({ kind: "text", value: c, raw: c })
		} else if (c === " ") {
			tokens.push({ kind: "literal", value: c, raw: "\\ " })
		} else if (c === "-" || c === "(" || c === ")" || c === "$" || c === "+" || c === "/" || c === ":") {
			tokens.push({ kind: "literal", value: c, raw: c })
		} else {
			tokens.push({ kind: "other", value: c, raw: c })
		}
	}

	return tokens
}

// A format's sections, split at semicolons outside quotes, escapes and brackets.
function splitSections(code: string): string[] {
	const sections: string[] = []
	let current = ""
	let quoted = false
	let bracket = false

	for (let k = 0; k < code.length; k++) {
		const c = code[k] ?? ""

		if (quoted) {
			if (c === '"') quoted = false
		} else if (bracket) {
			if (c === "]") bracket = false
		} else if (c === "\\" || c === "*" || c === "_") {
			current += c + (code[k + 1] ?? "")
			k++

			continue
		} else if (c === '"') quoted = true
		else if (c === "[") bracket = true
		else if (c === ";") {
			sections.push(current)
			current = ""

			continue
		}

		current += c
	}

	sections.push(current)

	return sections
}

// The model's sections of a name as one: conditional formats come one section per range.
function joinSections(model: XlsxSheetModel, name: string): string {
	return model.sections
		.filter(section => section.name === name)
		.map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))
		.join("")
}

// A part's bytes written in pieces, as one array.
async function joinedBytes(pieces: ByteChunks): Promise<Uint8Array> {
	const out = new Uint8Array(pieces.length)
	let at = 0

	for await (const chunk of pieces.chunks()) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

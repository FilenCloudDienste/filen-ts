import { formatValue, type Cell, type CellStyle, type CellValue, type Sheet, type Workbook } from "hucre"
import { cellKey, type CellView, type SheetView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { StyleTable, styleView } from "@/features/spreadsheet/lib/styleTable"

// Column widths are in characters of the default font, row heights in points.
const PX_PER_CHAR = 7
const CHAR_PADDING = 5
const PX_PER_POINT = 4 / 3
const DEFAULT_FONT_SIZE = 11

function pad(value: number): string {
	return String(value).padStart(2, "0")
}

// A date without a date format, shown the way the file's own locale-free default would be.
function isoDate(date: Date): string {
	return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

// What a value shows through `numFmt`, the formatter's own rendering except where it has none.
export function displayText(value: CellValue | undefined, numFmt: string | undefined): string {
	if (value === null || value === undefined) {
		return ""
	}

	if (value instanceof Date && (numFmt === undefined || numFmt === "General")) {
		return isoDate(value)
	}

	if (typeof value === "boolean") {
		return value ? "TRUE" : "FALSE"
	}

	return formatValue(value, numFmt ?? "General")
}

// The text editing a cell starts from: its formula, or the value as typed rather than as formatted.
export function inputText(value: CellValue | undefined, cell: Cell | undefined): string {
	if (cell?.formula !== undefined) {
		return `=${cell.formula}`
	}

	if (value === null || value === undefined) {
		return ""
	}

	if (value instanceof Date) {
		return isoDate(value)
	}

	if (typeof value === "boolean") {
		return value ? "TRUE" : "FALSE"
	}

	return String(value)
}

// Builds views of one workbook's cells, keeping one style table for all of them, so the ids a first view
// hands out stay valid for every later patch of the same workbook.
export class WorkbookViews {
	readonly styles = new StyleTable()
	// The reader hands each cell a style object of its own, sharing the font, fill and alignment objects of
	// its format: those, by identity, and the number format key the drawn part of a style.
	private readonly partIds = new WeakMap<object, number>()
	private nextPartId = 1
	private readonly structuralIds = new Map<string, number | undefined>()
	// Neighbouring cells mostly share a format: the last one looked up is checked first.
	private last: { style: CellStyle; id: number | undefined } | null = null
	private readonly themeColors: readonly string[] | undefined

	constructor(themeColors: readonly string[] | undefined) {
		this.themeColors = themeColors
	}

	private partId(part: object | undefined): number {
		if (part === undefined) {
			return 0
		}

		let id = this.partIds.get(part)

		if (id === undefined) {
			id = this.nextPartId++
			this.partIds.set(part, id)
		}

		return id
	}

	private styleId(style: CellStyle | undefined): number | undefined {
		if (style === undefined) {
			return undefined
		}

		const last = this.last

		if (
			last !== null &&
			last.style.font === style.font &&
			last.style.fill === style.fill &&
			last.style.alignment === style.alignment &&
			last.style.numFmt === style.numFmt
		) {
			return last.id
		}

		const key = `${String(this.partId(style.font))},${String(this.partId(style.fill))},${String(this.partId(style.alignment))},${style.numFmt ?? ""}`

		let id: number | undefined

		if (this.structuralIds.has(key)) {
			id = this.structuralIds.get(key)
		} else {
			id = this.styles.add(styleView(style, this.themeColors, DEFAULT_FONT_SIZE))
			this.structuralIds.set(key, id)
		}

		this.last = { style, id }

		return id
	}

	// One cell's view, or null for a cell with nothing to show.
	cell(sheet: Sheet, row: number, col: number): CellView | null {
		const value = sheet.rows[row]?.[col]
		const cell = sheet.cells?.get(`${String(row)},${String(col)}`)

		if ((value === null || value === undefined) && cell === undefined) {
			return null
		}

		const shown = cell?.formula !== undefined ? (cell.formulaResult ?? value) : value
		const text = cell?.richText !== undefined ? cell.richText.map(run => run.text).join("") : displayText(shown, cell?.style?.numFmt)
		const input = inputText(cell?.formula !== undefined ? shown : value, cell)
		const styleId = this.styleId(cell?.style)
		const view: CellView = { text }

		if (input !== text) view.input = input
		if (styleId !== undefined) view.style = styleId
		if (typeof shown === "number" || typeof shown === "boolean" || shown instanceof Date) view.numeric = true
		if (cell?.type === "error" || (typeof shown === "string" && cell?.formula !== undefined && /^#[A-Z0-9/!?]+$/.test(shown))) {
			view.error = true
		}

		return text === "" && view.style === undefined && view.input === undefined ? null : view
	}

	sheet(sheet: Sheet, lockStructure: boolean): SheetView {
		return sheetView(sheet, this, lockStructure)
	}
}

// A workbook's cells, one view per non-empty or formatted cell.
function sheetView(sheet: Sheet, views: WorkbookViews, lockStructure: boolean): SheetView {
	const cells = new Map<number, CellView>()
	let colCount = 0

	for (let row = 0; row < sheet.rows.length; row++) {
		const values = sheet.rows[row] ?? []

		colCount = Math.max(colCount, values.length)

		for (let col = 0; col < values.length; col++) {
			const view = views.cell(sheet, row, col)

			if (view !== null) {
				cells.set(cellKey(row, col), view)
			}
		}
	}

	const merges = (sheet.merges ?? []).map(merge => ({
		startRow: merge.startRow,
		startCol: merge.startCol,
		endRow: merge.endRow,
		endCol: merge.endCol
	}))
	const extent = sheetExtent(sheet)

	const colWidths = new Map<number, number>()
	const hiddenCols: number[] = []

	sheet.columns?.forEach((column, index) => {
		if (column.width !== undefined) {
			colWidths.set(index, Math.round(column.width * PX_PER_CHAR + CHAR_PADDING))
		}

		if (column.hidden === true) {
			hiddenCols.push(index)
		}
	})

	const rowHeights = new Map<number, number>()
	const hiddenRows: number[] = []

	sheet.rowDefs?.forEach((def, index) => {
		if (def.height !== undefined) {
			rowHeights.set(index, Math.round(def.height * PX_PER_POINT))
		}

		if (def.hidden === true) {
			hiddenRows.push(index)
		}
	})

	return {
		name: sheet.name,
		rowCount: extent.rowCount,
		colCount: Math.max(colCount, extent.colCount),
		cells,
		merges,
		colWidths,
		rowHeights,
		hiddenCols,
		hiddenRows,
		frozenRows: sheet.freezePane?.rows ?? 0,
		frozenCols: sheet.freezePane?.columns ?? 0,
		structureLocked: lockStructure || structureLocked(sheet)
	}
}

// The used area: the value rectangle and every merge.
export function sheetExtent(sheet: Sheet): { rowCount: number; colCount: number } {
	let rowCount = sheet.rows.length
	let colCount = sheet.rows[0]?.length ?? 0

	for (const merge of sheet.merges ?? []) {
		rowCount = Math.max(rowCount, merge.endRow + 1)
		colCount = Math.max(colCount, merge.endCol + 1)
	}

	return { rowCount, colCount }
}

// Whether anything in the sheet names cell ranges the workbook model would not shift with an inserted or
// deleted row or column.
export function structureLocked(sheet: Sheet): boolean {
	return (
		(sheet.tables?.length ?? 0) > 0 ||
		(sheet.conditionalRules?.length ?? 0) > 0 ||
		(sheet.dataValidations?.length ?? 0) > 0 ||
		(sheet.images?.length ?? 0) > 0 ||
		sheet.autoFilter !== undefined ||
		(sheet.sparklines?.length ?? 0) > 0 ||
		(sheet.charts?.length ?? 0) > 0
	)
}

// Whether something names ranges on any sheet, so no sheet's rows or columns may move: defined names, and
// charts, pivot tables, slicers and timelines, whose source ranges can sit on any sheet.
export function workbookStructureLocked(workbook: Workbook): boolean {
	return (
		(workbook.namedRanges?.length ?? 0) > 0 ||
		workbook.sheets.some(
			sheet =>
				!isWorksheet(sheet) ||
				(sheet.charts?.length ?? 0) > 0 ||
				(sheet.pivotTables?.length ?? 0) > 0 ||
				(sheet.slicers?.length ?? 0) > 0 ||
				(sheet.timelines?.length ?? 0) > 0
		)
	)
}

export function workbookDoc(workbook: Workbook, views: WorkbookViews, writable: boolean): SpreadsheetDoc {
	const lockStructure = workbookStructureLocked(workbook)
	const sheets = workbook.sheets.filter(isWorksheet).map(sheet => views.sheet(sheet, lockStructure))
	// The file names its active tab among all of them; the grid counts worksheets only.
	const active = workbook.sheets.slice(0, (workbook.activeSheet ?? 0) + 1).filter(isWorksheet).length - 1

	return {
		kind: "xlsx",
		sheets,
		activeSheet: Math.min(Math.max(active, 0), Math.max(sheets.length - 1, 0)),
		styles: views.styles.styles,
		writable
	}
}

// Chart sheets and the like show as empty tabs in the workbook model; the grid lists worksheets only.
export function isWorksheet(sheet: Sheet): boolean {
	return sheet.kind === undefined || sheet.kind === "worksheet"
}

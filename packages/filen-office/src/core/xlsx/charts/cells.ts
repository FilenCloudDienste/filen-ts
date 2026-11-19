import { slotValue } from "../../sheet/cf/host"
import { FormulaError } from "../../sheet/cf/formula/values"
import { SHEET_MAX_COLS, type SheetId } from "../../sheet/protocol"
import type { XlsxDocument } from "../edit/document"
import type { SheetStore } from "../model/store"
import { ColFlag, RowFlag, rowRunAt, type XlsxSheetModel } from "../model/types"
import { usedRange } from "../write/cells"
import type { ChartCell, ChartCells, ChartSheetCells } from "./cache"
import type { ChartNameLookup } from "./refs"

// A workbook's cells as charts read them: values as the session shows them (a formula's result included), text as
// the cell shows it, the number format it has. Only parsed sheets are read (callers make the sheets ready first).

const EMPTY: ChartCell = { kind: "empty", number: Number.NaN, text: "", format: "General" }

function sheetCells(document: XlsxDocument, sheet: SheetId): ChartSheetCells | null {
	const model = document.model(sheet)

	if (model === null) return null

	const store = model.store as SheetStore
	let extent: { lastRow: number; lastCol: number } | undefined
	const used = (): { lastRow: number; lastCol: number } => {
		if (extent === undefined) {
			const range = usedRange(model)

			extent = { lastRow: range?.endRow ?? -1, lastCol: range?.endCol ?? -1 }
		}

		return extent
	}

	let hidden: HiddenAxes | undefined
	const axes = (): HiddenAxes => (hidden ??= hiddenAxes(model))

	return {
		hidden(row, col) {
			const { rows, cols } = axes()

			return rows.has(row) || cols.has(col)
		},
		hiddenRow(row) {
			return axes().rows.has(row)
		},
		hiddenCol(col) {
			return axes().cols.has(col)
		},
		get lastRow() {
			return used().lastRow
		},
		get lastCol() {
			return used().lastCol
		},
		cell(row, col) {
			const slot = store.locate(row, col)

			if (slot < 0) return EMPTY

			const value = slotValue(document, model, row, col, slot)

			if (value === null) return EMPTY

			const view = document.cellView(sheet, row, col)
			const format = document.numFmt(view.xf).code

			if (typeof value === "number") return { kind: "number", number: value, text: view.text, format }
			if (typeof value === "boolean") return { kind: "boolean", number: value ? 1 : 0, text: view.text, format }
			if (value instanceof FormulaError) return { kind: "error", number: Number.NaN, text: view.text, format }

			return { kind: value === "" ? "empty" : "text", number: Number.NaN, text: view.text, format }
		}
	}
}

export interface HiddenAxes {
	readonly rows: { has(row: number): boolean }
	readonly cols: ReadonlySet<number>
}

// The sheet's hidden rows and columns, read from its rows and column ranges (not its whole layout).
export function hiddenAxes(model: XlsxSheetModel): HiddenAxes {
	const rows = new Set<number>()
	const cols = new Set<number>()
	const store = model.store as SheetStore

	for (const block of store.blocks)
		for (let i = 0; i < block.rowCount; i++)
			if (((block.rowFlags[i] ?? 0) & RowFlag.HIDDEN) !== 0) rows.add(block.firstRow + (block.rows[i] ?? 0))

	for (const range of model.cols)
		if ((range.flags & ColFlag.HIDDEN) !== 0)
			for (let col = range.first; col <= Math.min(range.last, SHEET_MAX_COLS - 1); col++) cols.add(col)

	// Rows the store does not hold, in runs (an OpenDocument source's): looked up, not listed.
	const runs = model.rowRuns

	return {
		rows: runs === undefined ? rows : { has: row => rows.has(row) || ((rowRunAt(runs, row)?.flags ?? 0) & RowFlag.HIDDEN) !== 0 },
		cols
	}
}

// What a sheet's hidden rows and columns are, as one number: equal while they stay the same.
export function hiddenSignature(model: XlsxSheetModel): number {
	const store = model.store as SheetStore
	let hash = 0x811c9dc5
	let count = 0

	for (const block of store.blocks)
		for (let i = 0; i < block.rowCount; i++)
			if (((block.rowFlags[i] ?? 0) & RowFlag.HIDDEN) !== 0) {
				hash = Math.imul(hash ^ (block.firstRow + (block.rows[i] ?? 0)), 0x01000193)
				count++
			}

	for (const run of model.rowRuns ?? [])
		if ((run.flags & RowFlag.HIDDEN) !== 0) {
			hash = Math.imul(Math.imul(hash ^ run.first, 0x01000193) ^ run.last, 0x01000193)
			count++
		}

	hash = Math.imul(hash ^ 0x5bd1e995, 0x01000193)

	for (const range of model.cols)
		if ((range.flags & ColFlag.HIDDEN) !== 0) {
			hash = Math.imul(Math.imul(hash ^ range.first, 0x01000193) ^ range.last, 0x01000193)
			count++
		}

	return (hash >>> 0) + count * 0x1_0000_0000
}

export function chartNames(document: XlsxDocument): ChartNameLookup {
	return (name, sheet) => {
		const upper = name.toUpperCase()
		const own = sheet === null ? undefined : document.worksheets().find(entry => entry.name.toUpperCase() === sheet.toUpperCase())?.id
		const names = document.workbook.definedNames
		const local = own === undefined ? undefined : names.find(entry => entry.sheet === own && entry.name.toUpperCase() === upper)
		const global = names.find(entry => entry.sheet === null && entry.name.toUpperCase() === upper)

		return (local ?? global)?.formula
	}
}

// The workbook's cells for charts. Each sheet's reader is made once per call site's use (cheap).
export function documentCells(document: XlsxDocument): ChartCells {
	const readers = new Map<string, ChartSheetCells | null>()

	return {
		names: chartNames(document),
		sheet(name) {
			const key = name.toUpperCase()
			let reader = readers.get(key)

			if (reader === undefined) {
				const entry = document.worksheets().find(candidate => candidate.name.toUpperCase() === key)

				reader = entry === undefined ? null : sheetCells(document, entry.id)
				readers.set(key, reader)
			}

			return reader
		}
	}
}

// Parses the sheets `names` (upper case) so their cells can be read.
export async function readySheets(document: XlsxDocument, names: ReadonlySet<string>): Promise<void> {
	for (const entry of document.worksheets()) if (names.has(entry.name.toUpperCase())) await document.ready(entry.id)
}

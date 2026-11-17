import {
	DEFAULT_ROW_HEIGHT,
	SHEET_MAX_ROWS,
	type SheetLayout,
	type SheetQueryName,
	type SheetQueryRequest,
	type SheetQueryResult,
	type SheetReadSource,
	type SheetRenderStyle,
	type SheetTile,
	type SheetWorkbookInfo
} from "@filen/office/core/sheet"
import { SheetGridModel } from "@filen/office/react/sheet"
import type { SqliteCellValue } from "@/features/preview/lib/sqliteBrowser"
import type { TableColumn } from "@/features/preview/lib/sqliteBrowse.logic"

// A database table as the read-only grid's source (@filen/office's SheetReadSource): one sheet whose first row is the
// column names, frozen, and whose rows from the second on are the table's from `base` on. The grid's own queries are
// answered for the cell only; the others (navigation by data edges, copy, find) are not offered.

// What the source asks its worker (sqliteDatabase.ts names each request for the interrupt flag).
export interface SqliteTableReads {
	tiles(base: number, coordinates: Uint32Array): Promise<SheetTile[]>
	cell(base: number, row: number, col: number): Promise<SqliteCellValue>
}

const COLUMN_WIDTH = 160
// Grid rows a window shows below its header: the grid's last row is the header's.
export const SQLITE_WINDOW_ROWS = SHEET_MAX_ROWS - 1

export const SQLITE_STYLES: readonly SheetRenderStyle[] = [{}, { bold: true }, { italic: true, color: 0x8a8a8a }]

// The window's rows below the header: the table's from `base` on, at most SQLITE_WINDOW_ROWS.
export function windowRows(rows: number, base: number): number {
	return Math.max(0, Math.min(rows - base, SQLITE_WINDOW_ROWS))
}

export function sqliteLayout(columns: number, rows: number, base: number, version: number): SheetLayout {
	const axis = (defaultSize: number) => ({
		defaultSize,
		indices: new Uint32Array(0),
		sizes: new Float32Array(0),
		styles: new Uint32Array(0),
		flags: new Uint16Array(0)
	})

	return {
		sheet: 0,
		version,
		rowCount: 1 + windowRows(rows, base),
		colCount: Math.max(1, columns),
		rows: axis(DEFAULT_ROW_HEIGHT),
		cols: axis(COLUMN_WIDTH),
		merges: new Uint32Array(0),
		pane: { rows: 1, cols: 0, firstRow: 0, firstCol: 0, topRow: 1, leftCol: 0 },
		zoom: 100,
		gridLines: true,
		headings: true,
		rightToLeft: false,
		protection: null
	}
}

export function sqliteWorkbookInfo(table: string, layout: SheetLayout): SheetWorkbookInfo {
	return {
		kind: "csv",
		sheets: [{ id: 0, name: table, state: "visible", kind: "worksheet", ready: true }],
		activeSheet: 0,
		activeLayout: layout,
		styles: { from: 0, styles: [...SQLITE_STYLES] },
		writability: { state: "viewOnly", reason: "unsafe" },
		state: { version: layout.version, dirty: false, canUndo: false, canRedo: false },
		date1904: false,
		protection: null,
		fileSharing: null
	}
}

// The text a cell's value reads as in the grid's own cell query (a clipped tile text's whole value).
function cellInput(value: SqliteCellValue): string {
	return typeof value.value === "string" ? value.value : ""
}

export function sqliteReadSource(
	reads: SqliteTableReads,
	columns: readonly TableColumn[],
	base: number,
	layout: () => SheetLayout
): SheetReadSource {
	const query = async <Q extends SheetQueryName>(name: Q, request: SheetQueryRequest<Q>): Promise<SheetQueryResult<Q>> => {
		if (name !== "cell") throw new Error(`a database table answers no ${name} query`)

		const cell = request as SheetQueryRequest<"cell">
		const value = await reads.cell(base, cell.row, cell.col)
		const detail: SheetQueryResult<"cell"> = {
			input: cell.row === 0 ? (columns[cell.col]?.name ?? "") : cellInput(value),
			numFmt: "",
			style: 0,
			flags: 0
		}

		return detail
	}

	return {
		tiles: async (_sheet, coordinates) => ({ tiles: await reads.tiles(base, coordinates) }),
		release: () => {
			// Tiles are built per request: the worker holds none to let go of.
		},
		layout: () => Promise.resolve(layout()),
		query
	}
}

// A table's grid model over a window from `base`, and how it grows as counting goes on: a new row count lays the sheet
// out again (a newer layout version, as a sheet the session finished reading).
export interface SqliteTableModel {
	readonly model: SheetGridModel
	grow(rows: number): void
}

export function sqliteTableModel(
	reads: SqliteTableReads,
	name: string,
	columns: readonly TableColumn[],
	rows: number,
	base: number
): SqliteTableModel {
	let version = 0
	let layout = sqliteLayout(columns.length, rows, base, version)
	const model = new SheetGridModel({
		source: sqliteReadSource(reads, columns, base, () => layout),
		info: sqliteWorkbookInfo(name, layout)
	})

	return {
		model,
		grow: next => {
			const grown = sqliteLayout(columns.length, next, base, version + 1)

			if (grown.rowCount === layout.rowCount) return

			version++
			layout = grown
			model.handleEvent({ type: "sheetReady", sheet: { id: 0, name, state: "visible", kind: "worksheet", ready: true }, layout })
		}
	}
}

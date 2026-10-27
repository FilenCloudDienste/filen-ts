import type { ShapeRef, TableCellProps, TableModel } from "../../model"
import { areasOf, coveringRange, type CellArea } from "../apply/table"
import type { CellRange, DeckOp } from "../ops"

// The Table Layout and Table Design commands on a selection of cells (the cell the caret is in, or a range): ops out,
// each command one history step (several ops go through oneStep). Rows and columns go in beside the selection and
// take its formatting; deleting every row or column deletes the table, as PowerPoint does. The commands read a
// table's shape (sizes and merged areas): from the model in the worker, from the render's table layer on the page.

export interface TableShape {
	// Column widths and row heights, EMU.
	readonly grid: readonly number[]
	readonly heights: readonly number[]
	readonly areas: readonly CellArea[]
}

const EMU_PER_PX = 9525

export function tableShapeOf(table: TableModel): TableShape | undefined {
	const areas = areasOf(table)

	return areas === undefined ? undefined : { grid: table.grid, heights: table.rows.map(row => row.h), areas }
}

// The shape a table frame's render layer carries (SlideLayer.table: px edges, areas as row, col, rows, cols).
export function tableShapeOfLayer(layer: {
	readonly columnEdges: readonly number[]
	readonly rowEdges: readonly number[]
	readonly areas: ArrayLike<number>
}): TableShape {
	const sizes = (edges: readonly number[]): number[] => edges.slice(1).map((edge, k) => Math.round((edge - (edges[k] ?? 0)) * EMU_PER_PX))
	const areas: CellArea[] = []

	for (let k = 0; k + 3 < layer.areas.length; k += 4)
		areas.push({ r: layer.areas[k] ?? 0, c: layer.areas[k + 1] ?? 0, rows: layer.areas[k + 2] ?? 1, cols: layer.areas[k + 3] ?? 1 })

	return { grid: sizes(layer.columnEdges), heights: sizes(layer.rowEdges), areas }
}

// The cell under a point of the table (px in the layer's space), as its merged area's origin.
export function cellAt(
	shape: { readonly columnEdges: readonly number[]; readonly rowEdges: readonly number[] },
	areas: readonly CellArea[],
	x: number,
	y: number
): CellRange | undefined {
	const col = shape.columnEdges.findIndex((edge, k) => k > 0 && x < edge) - 1
	const row = shape.rowEdges.findIndex((edge, k) => k > 0 && y < edge) - 1

	if (col < 0 || row < 0) return undefined

	const area = areas.find(each => row >= each.r && row < each.r + each.rows && col >= each.c && col < each.c + each.cols)

	return area === undefined ? undefined : { row: area.r, col: area.c, rows: area.rows, cols: area.cols }
}

export type TableCommand =
	| "insertAbove"
	| "insertBelow"
	| "insertLeft"
	| "insertRight"
	| "deleteRows"
	| "deleteColumns"
	| "deleteTable"
	| "merge"
	| "split"
	| "distributeRows"
	| "distributeColumns"

// The range a selection covers in whole merged cells.
export function selectionRange(table: TableShape, range: CellRange): CellRange {
	return coveringRange(table.areas, range)
}

export function canMerge(table: TableShape, range: CellRange): boolean {
	const covering = selectionRange(table, range)

	return covering.rows > 1 || covering.cols > 1
}

// A selection of exactly one cell: a merged cell splits back, a single cell splits in two columns.
export function canSplit(table: TableShape, range: CellRange): boolean {
	const area = table.areas.find(each => each.r === range.row && each.c === range.col)

	if (area === undefined || area.rows !== range.rows || area.cols !== range.cols) return false

	return area.rows > 1 || area.cols > 1 || table.grid.length < 1000
}

// The whole table as a range.
export function wholeTable(table: TableShape): CellRange {
	return { row: 0, col: 0, rows: table.heights.length, cols: table.grid.length }
}

function evenly(values: readonly number[], at: number, count: number): number[] {
	let total = 0

	for (let k = at; k < at + count; k++) total += values[k] ?? 0

	const each = Math.round(total / count)

	return Array.from({ length: count }, (_, k) => (k === count - 1 ? total - each * (count - 1) : each))
}

export function tableCommandOps(target: ShapeRef, table: TableShape, selection: CellRange, command: TableCommand): DeckOp[] {
	const range = selectionRange(table, selection)
	const rowCount = table.heights.length
	const colCount = table.grid.length
	const deleteTable: DeckOp = { family: "shape", kind: "delete", slide: target.slide, shapes: [target.id] }

	switch (command) {
		case "insertAbove":
			return [{ family: "table", kind: "insertRows", target, at: range.row, count: range.rows }]
		case "insertBelow":
			return [{ family: "table", kind: "insertRows", target, at: range.row + range.rows, count: range.rows }]
		case "insertLeft":
			return [{ family: "table", kind: "insertColumns", target, at: range.col, count: range.cols }]
		case "insertRight":
			return [{ family: "table", kind: "insertColumns", target, at: range.col + range.cols, count: range.cols }]
		case "deleteRows":
			return range.rows >= rowCount
				? [deleteTable]
				: [{ family: "table", kind: "deleteRows", target, at: range.row, count: range.rows }]
		case "deleteColumns":
			return range.cols >= colCount
				? [deleteTable]
				: [{ family: "table", kind: "deleteColumns", target, at: range.col, count: range.cols }]
		case "deleteTable":
			return [deleteTable]
		case "merge":
			return canMerge(table, range) ? [{ family: "table", kind: "merge", target, range }] : []
		case "split":
			return [{ family: "table", kind: "split", target, row: range.row, col: range.col }]
		case "distributeRows": {
			const rows = range.rows > 1 ? range : wholeTable(table)
			const heights = evenly(table.heights, rows.row, rows.rows)

			return heights.flatMap((height, k) =>
				table.heights[rows.row + k] === height
					? []
					: [{ family: "table", kind: "setRowHeight", target, row: rows.row + k, height } as const]
			)
		}
		case "distributeColumns": {
			const cols = range.cols > 1 ? range : wholeTable(table)
			const widths = evenly(table.grid, cols.col, cols.cols)

			return widths.flatMap((width, k) =>
				table.grid[cols.col + k] === width
					? []
					: [{ family: "table", kind: "setColumnWidth", target, col: cols.col + k, width } as const]
			)
		}
	}
}

// Fill, borders, margins or alignment on every cell of the selection.
export function cellPropsOp(target: ShapeRef, table: TableShape, selection: CellRange, props: TableCellProps): DeckOp {
	return { family: "table", kind: "setCellProps", target, range: selectionRange(table, selection), props }
}

// A style of the gallery (or none, `styleId` null) and the flags as they are, or one flag set.
export function tableStyleOp(
	target: ShapeRef,
	change: {
		readonly styleId?: string | null
		readonly current?: string
		readonly flag?: keyof TableModel["flags"]
		readonly on?: boolean
	}
): DeckOp {
	const styleId = change.styleId === null ? undefined : (change.styleId ?? change.current)

	return {
		family: "table",
		kind: "setStyle",
		target,
		styleId,
		...(change.flag === undefined ? {} : { flags: { [change.flag]: change.on ?? true } })
	}
}

// The built-in styles the gallery offers (Medium Style 2 in each accent and dark; the renderer and LibreOffice draw
// them by id, render/tableStyles.ts).
export const TABLE_STYLE_GALLERY: readonly { readonly id: string; readonly accent: number | undefined }[] = [
	{ id: "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}", accent: 1 },
	{ id: "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}", accent: 2 },
	{ id: "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}", accent: 3 },
	{ id: "{00A15C55-8517-42AA-B614-E9B94910E393}", accent: 4 },
	{ id: "{7DF18680-E054-41AD-8BC1-D1AEF772440D}", accent: 5 },
	{ id: "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}", accent: 6 },
	{ id: "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", accent: undefined }
]

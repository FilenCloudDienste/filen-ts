import { SHEET_MAX_COLS, SHEET_MAX_EDIT_CELLS, SHEET_MAX_ROWS, type SheetCellInputs, type SheetRange } from "../protocol"
import { formulaTranslator } from "../refs/formulaRefs"
import { rowHidden, visibleRanges, type RowSpan } from "../visibleRows"
import type { FillMode, FillSourceCell, FillValue, SeriesRequest } from "./series"

// Fill Down and Fill Right (Ctrl+D, Ctrl+R in Excel's "Keyboard shortcuts in Excel"), and Fill Up and Left: the
// first row (column) of each range is copied into the rest of it, contents and formats, a formula's relative
// references moving with each copy as a paste moves them. A range one row high (one column wide) takes the row above
// it (the column left of it) as its source, as Excel's Ctrl+D and Ctrl+R do.

declare module "../protocol" {
	interface SheetCommandMap {
		"fill.copy": {
			readonly sheet: SheetId
			readonly ranges: readonly SheetRange[]
			readonly direction: "down" | "right" | "up" | "left"
		}
		// Ctrl+Enter: `entry`, as typed in the active cell `from`, goes into every cell of the ranges but those a merge
		// covers (its first cell takes it), a formula's relative references moving from `from` to each cell, as
		// Excel fills a selection.
		"fill.entry": {
			readonly sheet: SheetId
			readonly ranges: readonly SheetRange[]
			readonly entry: string
			readonly from: { readonly row: number; readonly col: number }
		}
		// The fill handle dragged from `source` out to `target` (the source and the cells it reaches, one way):
		// series.ts's fillSeries per line. "alternate": Ctrl held. The selection becomes `target`.
		"fill.auto": {
			readonly sheet: SheetId
			readonly source: SheetRange
			readonly target: SheetRange
			readonly mode: FillMode
		}
		// The Series dialog over `range`: each row ("rows") or column ("cols") is a line (series.ts's seriesLine). A stop
		// value that does not read as a number (or a date, in a workbook) is refused ("unsupported", detail "stop").
		"fill.series": {
			readonly sheet: SheetId
			readonly range: SheetRange
			readonly orientation: "rows" | "cols"
			readonly options: SeriesRequest
		}
	}
}

export type FillDirection = "down" | "right" | "up" | "left"

// One copy: the target cell and the source cell it takes.
export interface FillPlan {
	readonly rows: Uint32Array
	readonly cols: Uint32Array
	readonly sourceRows: Uint32Array
	readonly sourceCols: Uint32Array
	// The ranges as filled, sources included.
	readonly ranges: readonly SheetRange[]
}

// What a fill writes, or "tooLarge" past the cells one edit takes; null when it writes nothing.
export function fillPlan(ranges: readonly SheetRange[], direction: FillDirection): FillPlan | "tooLarge" | null {
	const vertical = direction === "down" || direction === "up"
	const filled: SheetRange[] = []
	let count = 0

	for (const range of ranges) {
		let { startRow, startCol, endRow, endCol } = range

		if (endRow < startRow || endCol < startCol) continue

		// One line deep: the line before it is the source.
		if (vertical && startRow === endRow) {
			if (direction === "down" ? startRow === 0 : endRow === SHEET_MAX_ROWS - 1) continue
			if (direction === "down") startRow--
			else endRow++
		} else if (!vertical && startCol === endCol) {
			if (direction === "right" ? startCol === 0 : endCol === SHEET_MAX_COLS - 1) continue
			if (direction === "right") startCol--
			else endCol++
		}

		const cells = (endRow - startRow + 1) * (endCol - startCol + 1) - (vertical ? endCol - startCol + 1 : endRow - startRow + 1)

		count += cells

		if (count > SHEET_MAX_EDIT_CELLS) return "tooLarge"

		filled.push({ startRow, startCol, endRow, endCol })
	}

	if (count === 0) return null

	const rows = new Uint32Array(count)
	const cols = new Uint32Array(count)
	const sourceRows = new Uint32Array(count)
	const sourceCols = new Uint32Array(count)
	let at = 0

	for (const range of filled) {
		for (let row = range.startRow; row <= range.endRow; row++) {
			for (let col = range.startCol; col <= range.endCol; col++) {
				const sourceRow = direction === "down" ? range.startRow : direction === "up" ? range.endRow : row
				const sourceCol = direction === "right" ? range.startCol : direction === "left" ? range.endCol : col

				if (sourceRow === row && sourceCol === col) continue

				rows[at] = row
				cols[at] = col
				sourceRows[at] = sourceRow
				sourceCols[at] = sourceCol
				at++
			}
		}
	}

	return { rows, cols, sourceRows, sourceCols, ranges: filled }
}

// fillPlan on a filtered sheet (`hidden`: visibleRows.ts): each range from its first visible row to its last, the
// visible rows taking the source as Excel fills filtered data, the hidden ones left as they are.
export function visibleFillPlan(
	ranges: readonly SheetRange[],
	direction: FillDirection,
	hidden: readonly RowSpan[]
): FillPlan | "tooLarge" | null {
	if (hidden.length === 0) return fillPlan(ranges, direction)

	const trimmed: SheetRange[] = []

	for (const range of ranges) {
		const runs = visibleRanges([range], hidden)
		const first = runs[0]
		const last = runs[runs.length - 1]

		if (first !== undefined && last !== undefined) trimmed.push({ ...range, startRow: first.startRow, endRow: last.endRow })
	}

	const plan = fillPlan(trimmed, direction)

	if (plan === null || plan === "tooLarge") return plan

	let count = 0

	for (let i = 0; i < plan.rows.length; i++) if (!rowHidden(hidden, plan.rows[i] ?? 0)) count++

	if (count === plan.rows.length) return plan
	if (count === 0) return null

	const rows = new Uint32Array(count)
	const cols = new Uint32Array(count)
	const sourceRows = new Uint32Array(count)
	const sourceCols = new Uint32Array(count)
	let at = 0

	for (let i = 0; i < plan.rows.length; i++) {
		if (rowHidden(hidden, plan.rows[i] ?? 0)) continue

		rows[at] = plan.rows[i] ?? 0
		cols[at] = plan.cols[i] ?? 0
		sourceRows[at] = plan.sourceRows[i] ?? 0
		sourceCols[at] = plan.sourceCols[i] ?? 0
		at++
	}

	return { rows, cols, sourceRows, sourceCols, ranges: plan.ranges }
}

interface Merge {
	readonly startRow: number
	readonly startCol: number
	readonly endRow: number
	readonly endCol: number
}

// The cells fill.entry writes: `merges` as the sheet holds them (startRow, startCol, endRow, endCol each); "tooLarge"
// past the cells one edit takes, decided before any is listed; null for none.
export function entryCells(
	ranges: readonly SheetRange[],
	merges: Uint32Array,
	entry: string,
	from: { readonly row: number; readonly col: number }
): SheetCellInputs | "tooLarge" | null {
	const within: Merge[][] = []
	let count = 0

	for (const range of ranges) {
		const inside: Merge[] = []
		let cells = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)

		for (let m = 0; m + 3 < merges.length; m += 4) {
			const merge = { startRow: merges[m] ?? 0, startCol: merges[m + 1] ?? 0, endRow: merges[m + 2] ?? 0, endCol: merges[m + 3] ?? 0 }
			const startRow = Math.max(merge.startRow, range.startRow)
			const startCol = Math.max(merge.startCol, range.startCol)
			const endRow = Math.min(merge.endRow, range.endRow)
			const endCol = Math.min(merge.endCol, range.endCol)

			if (startRow > endRow || startCol > endCol) continue

			// Merges never overlap: each covers its part of the range but its first cell.
			cells -=
				(endRow - startRow + 1) * (endCol - startCol + 1) - (startRow === merge.startRow && startCol === merge.startCol ? 1 : 0)
			inside.push(merge)
		}

		count += Math.max(0, cells)
		within.push(inside)
	}

	if (count > SHEET_MAX_EDIT_CELLS) return "tooLarge"
	if (count === 0) return null

	const formula = entry.length > 1 && entry.startsWith("=") ? formulaTranslator(entry.slice(1)) : null
	const rows = new Uint32Array(count)
	const cols = new Uint16Array(count)
	const inputs: string[] = []
	let at = 0

	ranges.forEach((range, index) => {
		const inside = within[index] ?? []

		for (let row = range.startRow; row <= range.endRow; row++) {
			const crossing = inside.length === 0 ? inside : inside.filter(merge => row >= merge.startRow && row <= merge.endRow)

			for (let col = range.startCol; col <= range.endCol; col++) {
				const merge = crossing.length === 0 ? undefined : crossing.find(found => col >= found.startCol && col <= found.endCol)

				// Past the cells the merge covers in this row, keeping its first.
				if (merge !== undefined && (row !== merge.startRow || col !== merge.startCol)) {
					col = merge.endCol

					continue
				}

				rows[at] = row
				cols[at] = col
				inputs.push(formula === null ? entry : `=${formula(row - from.row, col - from.col)}`)
				at++
			}
		}
	})

	return { rows, cols, inputs }
}

// --- The fill handle and the Series dialog ---

// Cells written with their source cells (whose format each takes, and content for a copy) and, where it is not a
// copy, the value of their own.
export interface FillWrites extends FillPlan {
	readonly values: readonly FillValue[]
}

// Where the handle's target lies from its source, or null when it is not the source grown one way.
export function autoFillDirection(source: SheetRange, target: SheetRange): FillDirection | null {
	const sameCols = source.startCol === target.startCol && source.endCol === target.endCol
	const sameRows = source.startRow === target.startRow && source.endRow === target.endRow

	if (source.endRow < source.startRow || source.endCol < source.startCol) return null
	if (sameCols && target.startRow === source.startRow && target.endRow > source.endRow) return "down"
	if (sameCols && target.endRow === source.endRow && target.startRow < source.startRow) return "up"
	if (sameRows && target.startCol === source.startCol && target.endCol > source.endCol) return "right"
	if (sameRows && target.endCol === source.endCol && target.startCol < source.startCol) return "left"

	return null
}

// The fill handle's writes: per line, `read` gives the source's cells (in fill order: from the far end when filling
// up or left) and fillSeries what each target takes. "tooLarge" past the cells one edit takes; null for nothing.
export function autoFillWrites(
	source: SheetRange,
	target: SheetRange,
	mode: FillMode,
	read: (row: number, col: number) => FillSourceCell,
	series: (cells: readonly FillSourceCell[], mode: FillMode, backward: boolean) => (k: number) => FillValue
): FillWrites | "tooLarge" | null {
	const direction = autoFillDirection(source, target)

	if (direction === null) return null

	const vertical = direction === "down" || direction === "up"
	const backward = direction === "up" || direction === "left"
	const lines = vertical ? source.endCol - source.startCol + 1 : source.endRow - source.startRow + 1
	const depth = vertical ? source.endRow - source.startRow + 1 : source.endCol - source.startCol + 1
	const reach = vertical ? target.endRow - target.startRow + 1 - depth : target.endCol - target.startCol + 1 - depth
	const count = lines * reach

	if (count > SHEET_MAX_EDIT_CELLS) return "tooLarge"
	if (count === 0) return null

	const rows = new Uint32Array(count)
	const cols = new Uint32Array(count)
	const sourceRows = new Uint32Array(count)
	const sourceCols = new Uint32Array(count)
	const values: FillValue[] = []
	// The source's i-th cell in fill order, and the k-th target, along a line.
	const along = (line: number, i: number, edge: number, step: number): { row: number; col: number } =>
		vertical ? { row: edge + step * i, col: source.startCol + line } : { row: source.startRow + line, col: edge + step * i }
	const sourceEdge = vertical ? (backward ? source.endRow : source.startRow) : backward ? source.endCol : source.startCol
	const targetEdge = vertical ? (backward ? source.startRow - 1 : source.endRow + 1) : backward ? source.startCol - 1 : source.endCol + 1
	const step = backward ? -1 : 1
	let at = 0

	for (let line = 0; line < lines; line++) {
		const cells: FillSourceCell[] = []

		for (let i = 0; i < depth; i++) {
			const cell = along(line, i, sourceEdge, step)

			cells.push(read(cell.row, cell.col))
		}

		const next = series(cells, mode, backward)

		for (let k = 0; k < reach; k++) {
			const cell = along(line, k, targetEdge, step)
			const from = along(line, k % depth, sourceEdge, step)

			rows[at] = cell.row
			cols[at] = cell.col
			sourceRows[at] = from.row
			sourceCols[at] = from.col
			values.push(next(k))
			at++
		}
	}

	return { rows, cols, sourceRows, sourceCols, ranges: [target], values }
}

// The Series dialog's writes over `range`: per line, `line` gives what each cell takes (null leaves it).
export function seriesWrites(
	range: SheetRange,
	orientation: "rows" | "cols",
	read: (row: number, col: number) => FillSourceCell,
	line: (cells: readonly FillSourceCell[]) => readonly ({ readonly value: FillValue; readonly source: number } | null)[]
): FillWrites | "tooLarge" | null {
	const across = orientation === "rows"
	const lines = across ? range.endRow - range.startRow + 1 : range.endCol - range.startCol + 1
	const length = across ? range.endCol - range.startCol + 1 : range.endRow - range.startRow + 1

	if (lines <= 0 || length <= 0) return null
	if (lines * length > SHEET_MAX_EDIT_CELLS) return "tooLarge"

	const rows: number[] = []
	const cols: number[] = []
	const sourceRows: number[] = []
	const sourceCols: number[] = []
	const values: FillValue[] = []
	const cell = (index: number, i: number): { row: number; col: number } =>
		across ? { row: range.startRow + index, col: range.startCol + i } : { row: range.startRow + i, col: range.startCol + index }

	for (let index = 0; index < lines; index++) {
		const cells: FillSourceCell[] = []

		for (let i = 0; i < length; i++) {
			const at = cell(index, i)

			cells.push(read(at.row, at.col))
		}

		line(cells).forEach((write, i) => {
			if (write === null) return

			const at = cell(index, i)
			const from = cell(index, write.source)

			rows.push(at.row)
			cols.push(at.col)
			sourceRows.push(from.row)
			sourceCols.push(from.col)
			values.push(write.value)
		})
	}

	if (values.length === 0) return null

	return {
		rows: Uint32Array.from(rows),
		cols: Uint32Array.from(cols),
		sourceRows: Uint32Array.from(sourceRows),
		sourceCols: Uint32Array.from(sourceCols),
		ranges: [range],
		values
	}
}

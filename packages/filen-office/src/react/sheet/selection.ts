import { expandToMerges } from "../../core/sheet/refs/cellRef"
import {
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	type SheetAxis,
	type SheetCommandOf,
	type SheetId,
	type SheetRange,
	type SheetSelectionState
} from "../../core/sheet/protocol"

// A sheet's selection as Excel keeps it: one or more ranges (Ctrl adds one), the active cell inside the last, and
// the last range's anchor and moving end (Shift extends from the anchor, the active cell staying put).

export interface GridPoint {
	readonly row: number
	readonly col: number
}

export interface GridSelection {
	readonly active: GridPoint
	readonly anchor: GridPoint
	readonly focus: GridPoint
	// Never empty; the last is the one anchor..focus spans (grown to the merges it cuts).
	readonly ranges: readonly SheetRange[]
}

export function spanOf(a: GridPoint, b: GridPoint): SheetRange {
	return {
		startRow: Math.min(a.row, b.row),
		startCol: Math.min(a.col, b.col),
		endRow: Math.max(a.row, b.row),
		endCol: Math.max(a.col, b.col)
	}
}

function grown(range: SheetRange, merges: readonly SheetRange[]): SheetRange {
	return merges.length === 0 ? range : expandToMerges(range, merges)
}

export function cellSelection(point: GridPoint, merges: readonly SheetRange[]): GridSelection {
	return { active: point, anchor: point, focus: point, ranges: [grown(spanOf(point, point), merges)] }
}

// The last range from its anchor to `focus`; the active cell stays.
export function extendSelection(selection: GridSelection, focus: GridPoint, merges: readonly SheetRange[]): GridSelection {
	return {
		active: selection.active,
		anchor: selection.anchor,
		focus,
		ranges: [...selection.ranges.slice(0, -1), grown(spanOf(selection.anchor, focus), merges)]
	}
}

// Ctrl+click: another range, starting at `point`.
export function addSelection(selection: GridSelection, point: GridPoint, merges: readonly SheetRange[]): GridSelection {
	return { active: point, anchor: point, focus: point, ranges: [...selection.ranges, grown(spanOf(point, point), merges)] }
}

// Whole rows (axis "rows") or columns from `start` to `end`; the active cell is the first shown one.
export function axisSelection(
	axis: "rows" | "cols",
	start: number,
	end: number,
	active: GridPoint,
	previous: GridSelection | null
): GridSelection {
	const range: SheetRange =
		axis === "rows"
			? { startRow: Math.min(start, end), startCol: 0, endRow: Math.max(start, end), endCol: SHEET_MAX_COLS - 1 }
			: { startRow: 0, startCol: Math.min(start, end), endRow: SHEET_MAX_ROWS - 1, endCol: Math.max(start, end) }
	const anchor = axis === "rows" ? { row: start, col: 0 } : { row: 0, col: start }
	const focus = axis === "rows" ? { row: end, col: SHEET_MAX_COLS - 1 } : { row: SHEET_MAX_ROWS - 1, col: end }

	return { active, anchor, focus, ranges: previous === null ? [range] : [...previous.ranges, range] }
}

export function selectionContains(selection: GridSelection, row: number, col: number): boolean {
	return selection.ranges.some(range => row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol)
}

// The selection holds one cell (or one merge).
export function singleCell(selection: GridSelection): boolean {
	return selection.ranges.length === 1 && selection.anchor.row === selection.focus.row && selection.anchor.col === selection.focus.col
}

function rangeAxis(range: SheetRange): "rows" | "cols" | null {
	const rows = range.startCol === 0 && range.endCol >= SHEET_MAX_COLS - 1
	const cols = range.startRow === 0 && range.endRow >= SHEET_MAX_ROWS - 1

	return rows === cols ? null : rows ? "rows" : "cols"
}

// The axis whose whole lines every range of the selection is (whole rows, or whole columns); "mixed" when some ranges
// are whole rows and the others whole columns (Excel inserts and deletes neither); null when one is cells.
export function wholeAxis(selection: GridSelection): "rows" | "cols" | "mixed" | null {
	let axis: "rows" | "cols" | "mixed" | null = null

	for (const range of selection.ranges) {
		const own = rangeAxis(range)

		if (own === null) return null

		axis = axis === null || axis === own ? own : "mixed"
	}

	return axis
}

// Rows (columns) inserted or deleted at every range of a selection, as Excel's Insert Sheet Rows and Delete Sheet
// Rows: each range's own, an insert before it (`after`: after it). Spans overlapping one another are the session's to
// refuse. One range: one span.
export function axisMove(
	type: "axis.insert" | "axis.delete",
	sheet: SheetId,
	axis: SheetAxis,
	ranges: readonly SheetRange[],
	after = false
): SheetCommandOf<"axis.insert"> | SheetCommandOf<"axis.delete"> {
	const spans = ranges.map(range => {
		const start = axis === "rows" ? range.startRow : range.startCol
		const count = (axis === "rows" ? range.endRow : range.endCol) - start + 1

		return { at: after ? start + count : start, count }
	})
	const only = spans.length === 1 ? spans[0] : undefined
	const move = only !== undefined ? { sheet, axis, ...only } : { sheet, axis, spans }

	return type === "axis.insert" ? { type, ...move } : { type, ...move }
}

export function toSelectionState(selection: GridSelection): SheetSelectionState {
	return { activeRow: selection.active.row, activeCol: selection.active.col, ranges: selection.ranges }
}

export function fromSelectionState(state: SheetSelectionState | undefined, merges: readonly SheetRange[]): GridSelection {
	if (state === undefined || state.ranges.length === 0) {
		const active = { row: state?.activeRow ?? 0, col: state?.activeCol ?? 0 }

		return cellSelection(active, merges)
	}

	const active = { row: state.activeRow, col: state.activeCol }
	const last = state.ranges[state.ranges.length - 1] as SheetRange
	const anchor = { row: last.startRow, col: last.startCol }
	const focus = { row: last.endRow, col: last.endCol }

	return { active, anchor, focus, ranges: state.ranges }
}

export function mergeRanges(merges: Uint32Array): SheetRange[] {
	const ranges: SheetRange[] = []

	for (let i = 0; i + 3 < merges.length; i += 4)
		ranges.push({ startRow: merges[i] ?? 0, startCol: merges[i + 1] ?? 0, endRow: merges[i + 2] ?? 0, endCol: merges[i + 3] ?? 0 })

	return ranges
}

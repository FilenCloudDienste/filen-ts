import type { XlsxColRange, XlsxRowRun, XlsxSheetView } from "../model/types"
import { axisLimit, inBand, shiftAxisSpan, shiftIndex, shiftRange, straddles, type AxisShift } from "./axis"
import { refuse } from "./catalogue"
import { shiftRanges } from "./sqref"

// What the model holds for the sheet's own layout, moved: merged ranges, column ranges and the first sheet view.

// Merges as quads; a merge left with one cell is no merge (ECMA-376 Part 1 §18.3.1.55). Cells shifted in a band
// refuse to move part of a merge (as LibreOffice does). The same array when nothing moved.
export function shiftMerges(merges: Uint32Array, shift: AxisShift): Uint32Array {
	const out: number[] = []
	let changed = false

	for (let k = 0; k + 3 < merges.length; k += 4) {
		const range = { startRow: merges[k] ?? 0, startCol: merges[k + 1] ?? 0, endRow: merges[k + 2] ?? 0, endCol: merges[k + 3] ?? 0 }

		if (straddles(range, shift)) refuse("merged", "mergeCells")

		if (!inBand(range, shift)) {
			out.push(range.startRow, range.startCol, range.endRow, range.endCol)

			continue
		}
		const first = shift.axis === "rows" ? range.startRow : range.startCol
		// A delete that takes the merge's first row (column), where its value is, takes the merge: as LibreOffice
		// does (Microsoft's documentation is silent); a delete further in shrinks it.
		const anchorGone = shift.type === "delete" && first >= shift.at && first < shift.at + shift.count
		const next = anchorGone ? null : shiftRange(range, shift)

		if (next !== range) changed = true
		if (next === null || (next.startRow === next.endRow && next.startCol === next.endCol)) {
			changed = true

			continue
		}

		out.push(next.startRow, next.startCol, next.endRow, next.endCol)
	}

	return changed ? Uint32Array.from(out) : merges
}

// Column ranges (widths, styles): an insert inside a range widens it, as the inserted columns take the format of
// the columns around them. The same array when nothing moved.
export function shiftCols(cols: readonly XlsxColRange[], shift: AxisShift): readonly XlsxColRange[] {
	// Cells shifted in a band leave the columns' own properties where they are.
	if (shift.axis !== "cols" || shift.band !== undefined) return cols

	let changed = false
	const out: XlsxColRange[] = []

	for (const col of cols) {
		const span = shiftAxisSpan(col.first, col.last, shift)

		if (span === null) {
			changed = true

			continue
		}

		if (span[0] !== col.first || span[1] !== col.last) {
			changed = true
			out.push({ ...col, first: span[0], last: span[1] })
		} else {
			out.push(col)
		}
	}

	return changed ? out : cols
}

// How many of the indices [from, to) a deletion takes.
function deleted(from: number, to: number, shift: AxisShift): number {
	return Math.max(0, Math.min(to, shift.at + shift.count) - Math.max(from, shift.at))
}

// A frozen split (the count of frozen rows or columns, from the view's first `first`) after the edit: rows inserted
// in it join it, rows deleted from it leave it.
export function shiftSplit(split: number, shift: AxisShift, first = 0): number {
	if (shift.type === "insert")
		return shift.at >= first && shift.at < first + split ? Math.min(split + shift.count, axisLimit(shift.axis) - 1) : split

	return split - deleted(first, first + split, shift)
}

// The view's first row (column) after the edit: an index, not a cell, so rows inserted at it show there (and join a
// frozen block it starts); rows inserted or deleted before it move it.
export function shiftViewStart(first: number, shift: AxisShift): number {
	if (shift.type === "insert") return shift.at < first ? Math.min(first + shift.count, axisLimit(shift.axis) - 1) : first

	return first - deleted(0, first, shift)
}

// A view index (active cell, top-left cell) after the edit: a deleted one goes to the first index after the run.
export function viewIndex(index: number, shift: AxisShift): number {
	const next = shiftIndex(index, shift)

	if (next >= 0) return next

	return Math.min(shift.at, axisLimit(shift.axis) - 1)
}

// Cells shifted in a band leave the view (selection, panes) as it is.
export function shiftView(view: XlsxSheetView, shift: AxisShift): XlsxSheetView {
	if (shift.band !== undefined) return view

	const rows = shift.axis === "rows"
	const activeRow = rows ? viewIndex(view.activeRow, shift) : view.activeRow
	const activeCol = rows ? view.activeCol : viewIndex(view.activeCol, shift)
	let selection = shiftRanges(view.selection, shift)

	if (selection.length === 0 && view.selection.length > 0)
		selection = [{ startRow: activeRow, startCol: activeCol, endRow: activeRow, endCol: activeCol }]

	let frozen = view.frozen
	const topRow = rows ? shiftViewStart(view.topRow, shift) : view.topRow
	const leftCol = rows ? view.leftCol : shiftViewStart(view.leftCol, shift)

	if (frozen !== null) {
		const next = {
			rows: rows ? shiftSplit(frozen.rows, shift, view.topRow) : frozen.rows,
			cols: rows ? frozen.cols : shiftSplit(frozen.cols, shift, view.leftCol),
			topLeftRow: rows ? viewIndex(frozen.topLeftRow, shift) : frozen.topLeftRow,
			topLeftCol: rows ? frozen.topLeftCol : viewIndex(frozen.topLeftCol, shift)
		}

		// The bottom-right pane starts at or after the split.
		next.topLeftRow = Math.max(next.topLeftRow, (next.rows > 0 ? topRow : 0) + next.rows)
		next.topLeftCol = Math.max(next.topLeftCol, (next.cols > 0 ? leftCol : 0) + next.cols)

		frozen =
			next.rows === 0 && next.cols === 0
				? null
				: next.rows === frozen.rows &&
					  next.cols === frozen.cols &&
					  next.topLeftRow === frozen.topLeftRow &&
					  next.topLeftCol === frozen.topLeftCol
					? frozen
					: next
	}

	if (
		activeRow === view.activeRow &&
		activeCol === view.activeCol &&
		selection === view.selection &&
		frozen === view.frozen &&
		topRow === view.topRow &&
		leftCol === view.leftCol
	)
		return view

	return { ...view, activeRow, activeCol, selection, frozen, topRow, leftCol }
}

// Runs of rows after rows inserted or deleted, as ranges move; the same runs for an edit of columns or within a band
// (whole rows do not move).
export function shiftRowRuns(runs: readonly XlsxRowRun[], shift: AxisShift): readonly XlsxRowRun[] {
	if (shift.axis !== "rows" || shift.band !== undefined || runs.length === 0) return runs

	const out: XlsxRowRun[] = []

	for (const run of runs) {
		const span = shiftAxisSpan(run.first, run.last, shift)

		if (span === null) continue

		const last = out[out.length - 1]

		if (
			last !== undefined &&
			last.last + 1 === span[0] &&
			last.flags === run.flags &&
			(last.heightPt === run.heightPt || (Number.isNaN(last.heightPt) && Number.isNaN(run.heightPt)))
		) {
			out[out.length - 1] = { ...last, last: span[1] }
		} else {
			out.push({ first: span[0], last: span[1], flags: run.flags, heightPt: run.heightPt })
		}
	}

	return out
}

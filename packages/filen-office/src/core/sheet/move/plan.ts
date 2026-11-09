import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetAxis, type SheetCommandOf, type SheetRange, type SheetRefusal } from "../protocol"
import type { SheetChangeSink, SheetEditStep, SheetHandled } from "../registry"

// Excel's drag of the selection's border (support.microsoft.com, "Move or copy cells, rows, and columns"): a drag moves
// the cells (cut and replace), Ctrl (Option on a Mac) copies them (copy and replace), Shift inserts them where the
// pointer is, the cells there shifting down or right (cut and insert; with Ctrl, copy and insert). A move over cells
// holding data asks first ("There's already data here"); a copy replaces without asking. One undo step.
//
// Declared here, beside the geometry both handlers share, so the text path stays free of the workbook's modules.

declare module "../protocol" {
	interface SheetCommandMap {
		// The cells of `range` moved (or copied) so that its top-left cell lands at `to`. `insert`: the cells at the
		// destination shift down ("rows") or right ("cols") to make room, and a moved block taken from the same columns
		// (rows) closes its gap, as Excel's Insert Cut Cells reorders a list. A move over cells holding data, outside
		// the moved cells, is refused (occupied) unless `replace`. `active` is the active cell, which keeps its place
		// in the block. The selection goes to where the block landed.
		"cells.move": {
			readonly sheet: SheetId
			readonly range: SheetRange
			readonly to: { readonly row: number; readonly col: number }
			readonly copy: boolean
			readonly insert?: SheetAxis
			readonly replace?: boolean
			readonly active?: { readonly row: number; readonly col: number }
		}
	}

	interface SheetRefusalReasons {
		// A move would replace cells holding data (Excel's "There's already data here. Do you want to replace it?"):
		// sent again with `replace` once the user agrees.
		occupied: true
	}
}

export type SheetMoveCommand = SheetCommandOf<"cells.move">

// How a drag's edit runs, in order: cells inserted at the destination (cells.shift), the block moved or copied from
// `from` (where it is once the insert is done) to `to`, then the block's old cells deleted to close the gap.
export interface CellMovePlan {
	readonly insert: SheetRange | null
	readonly from: SheetRange
	readonly to: SheetRange
	readonly close: SheetRange | null
	// Where the block is once every part ran.
	readonly landed: SheetRange
}

function rows(range: SheetRange): number {
	return range.endRow - range.startRow + 1
}

function cols(range: SheetRange): number {
	return range.endCol - range.startCol + 1
}

function offset(range: SheetRange, down: number, right: number): SheetRange {
	return {
		startRow: range.startRow + down,
		startCol: range.startCol + right,
		endRow: range.endRow + down,
		endCol: range.endCol + right
	}
}

export function sameRange(a: SheetRange, b: SheetRange): boolean {
	return a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol
}

export function overlaps(a: SheetRange, b: SheetRange): boolean {
	return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startCol <= b.endCol && b.startCol <= a.endCol
}

export function contains(outer: SheetRange, inner: SheetRange): boolean {
	return (
		inner.startRow >= outer.startRow && inner.endRow <= outer.endRow && inner.startCol >= outer.startCol && inner.endCol <= outer.endCol
	)
}

// The parts of a drag of `range` to `to`, null when it changes nothing (dropped where it was), or why it cannot run:
// off the sheet (tooLarge), or an insert that would split the block (its cells partly in the band the insert shifts:
// Excel cannot do that either).
export function planCellMove(
	range: SheetRange,
	to: { readonly row: number; readonly col: number },
	insert: SheetAxis | undefined,
	copy: boolean
): CellMovePlan | SheetRefusal | null {
	const { startRow, startCol, endRow, endCol } = range

	if (
		![startRow, startCol, endRow, endCol, to.row, to.col].every(Number.isInteger) ||
		startRow < 0 ||
		startCol < 0 ||
		startRow > endRow ||
		startCol > endCol ||
		endRow >= SHEET_MAX_ROWS ||
		endCol >= SHEET_MAX_COLS ||
		to.row < 0 ||
		to.col < 0 ||
		to.row + rows(range) > SHEET_MAX_ROWS ||
		to.col + cols(range) > SHEET_MAX_COLS
	)
		return { reason: "tooLarge" }

	const destination = offset(range, to.row - startRow, to.col - startCol)

	if (insert === undefined) {
		if (to.row === startRow && to.col === startCol) return null

		return { insert: null, from: range, to: destination, close: null, landed: destination }
	}

	const byRows = insert === "rows"
	const count = byRows ? rows(range) : cols(range)
	const at = byRows ? destination.startRow : destination.startCol
	const bandStart = byRows ? destination.startCol : destination.startRow
	const bandEnd = byRows ? destination.endCol : destination.endRow
	const crossStart = byRows ? startCol : startRow
	const crossEnd = byRows ? endCol : endRow
	const lead = byRows ? startRow : startCol
	const tail = byRows ? endRow : endCol
	const sameBand = crossStart === bandStart && crossEnd === bandEnd

	// Moved to a gridline inside or at the edge of its own place: where it is.
	if (!copy && sameBand && at >= lead && at <= tail + 1) return null

	const inBand = crossStart <= bandEnd && bandStart <= crossEnd
	const shifted = inBand && tail >= at

	// The insert would push part of the block and not the rest.
	if (shifted && (lead < at || crossStart < bandStart || crossEnd > bandEnd)) return { reason: "tooLarge", detail: "split" }

	if (at + count > (byRows ? SHEET_MAX_ROWS : SHEET_MAX_COLS)) return { reason: "tooLarge" }

	const from = shifted ? (byRows ? offset(range, count, 0) : offset(range, 0, count)) : range
	const close = !copy && sameBand ? from : null
	const after = close !== null && (byRows ? destination.startRow > from.endRow : destination.startCol > from.endCol)
	const landed = after ? (byRows ? offset(destination, -count, 0) : offset(destination, 0, -count)) : destination

	return { insert: destination, from, to: destination, close, landed }
}

// Whether a merged range (quads: startRow, startCol, endRow, endCol) lies partly inside `range`.
export function splitsMerge(merges: ArrayLike<number>, range: SheetRange): boolean {
	for (let k = 0; k + 3 < merges.length; k += 4) {
		const merge = {
			startRow: merges[k] ?? 0,
			startCol: merges[k + 1] ?? 0,
			endRow: merges[k + 2] ?? 0,
			endCol: merges[k + 3] ?? 0
		}

		if (overlaps(merge, range) && !contains(range, merge)) return true
	}

	return false
}

// A range of whole rows (columns) cut back to the cells that are there: `rowExtent` and `colExtent` are past the last
// row and column holding anything. Null when nothing is left.
export function usedPart(range: SheetRange, rowExtent: number, colExtent: number): SheetRange | null {
	let { endRow, endCol } = range

	if (range.startCol === 0 && endCol >= SHEET_MAX_COLS - 1) endCol = Math.min(endCol, colExtent - 1)
	if (range.startRow === 0 && endRow >= SHEET_MAX_ROWS - 1) endRow = Math.min(endRow, rowExtent - 1)

	return endRow < range.startRow || endCol < range.startCol ? null : { ...range, endRow, endCol }
}

// The selection a drag leaves: the landed block, the active cell at its place in it.
export function landedSelection(
	plan: CellMovePlan,
	source: SheetRange,
	active: { readonly row: number; readonly col: number } | undefined
): { activeRow: number; activeCol: number; ranges: SheetRange[] } {
	const { landed } = plan
	const inside =
		active !== undefined &&
		active.row >= source.startRow &&
		active.row <= source.endRow &&
		active.col >= source.startCol &&
		active.col <= source.endCol

	return {
		activeRow: inside ? landed.startRow + active.row - source.startRow : landed.startRow,
		activeCol: inside ? landed.startCol + active.col - source.startCol : landed.startCol,
		ranges: [landed]
	}
}

// Runs the parts in order as one step: a part refused after others ran takes theirs back (the session reports nothing
// of a refused command). Null when none changed anything.
export async function runParts(
	parts: readonly (() => SheetHandled | Promise<SheetHandled>)[],
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const steps: SheetEditStep[] = []

	for (const part of parts) {
		const handled = await part()

		if (handled === null) continue

		if ("refused" in handled) {
			for (let k = steps.length - 1; k >= 0; k--) await steps[k]?.undo(changes)

			return handled
		}

		steps.push(handled)
	}

	if (steps.length === 0) return null

	const only = steps.length === 1 ? steps[0] : undefined

	if (only !== undefined) return only

	return {
		bytes: steps.reduce((sum, step) => sum + step.bytes, 0),
		undo: async sink => {
			for (let k = steps.length - 1; k >= 0; k--) await steps[k]?.undo(sink)
		},
		redo: async sink => {
			for (const step of steps) await step.redo(sink)
		}
	}
}

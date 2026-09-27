import { DEFAULT_ROW_HEIGHT, type CellRange } from "@/features/spreadsheet/lib/model"

// Column and row sizes: the grid's pixels, the xlsx's own units, the limits both share, and the edits
// resizing makes to a sheet's size maps. Column widths are in characters of the default font, row
// heights in points.
const PX_PER_CHAR = 7
const CHAR_PADDING = 5
const PX_PER_POINT = 4 / 3

export type SizeAxis = "rows" | "cols"

// An index's new pixel size; null takes it back to the file's (or the default) size.
export type SizeEntry = readonly [index: number, px: number | null]

// Excel's own limits (255 characters, 409 points), in pixels. Never 0: resizing does not hide.
export const MIN_SIZE = 8
export const MAX_COL_WIDTH = 1790
export const MAX_ROW_HEIGHT = 545

// The most indices one resize names. A whole selection larger than this (select-all on a large sheet)
// resizes only the dragged one, so no gesture builds a size map the size of the sheet.
export const MAX_RESIZE_TARGETS = 10_000

// What autofit adds to measured content: a cell's horizontal padding (px-1.5 each side), its 1px
// border, and 1px of slack; a row's line box to the default row's height.
export const CELL_FIT_PADDING = 14
export const ROW_FIT_PADDING = 7

export function clampSize(axis: SizeAxis, px: number): number {
	return Math.round(Math.min(axis === "cols" ? MAX_COL_WIDTH : MAX_ROW_HEIGHT, Math.max(MIN_SIZE, px)))
}

export function colWidthToPx(chars: number): number {
	return Math.round(chars * PX_PER_CHAR + CHAR_PADDING)
}

// Excel keeps widths to 1/256 of a character.
export function pxToColWidth(px: number): number {
	return Math.round(((px - CHAR_PADDING) / PX_PER_CHAR) * 256) / 256
}

export function rowHeightToPx(points: number): number {
	return Math.round(points * PX_PER_POINT)
}

export function pxToRowHeight(px: number): number {
	return px / PX_PER_POINT
}

export function withSizes(sizes: ReadonlyMap<number, number>, entries: readonly SizeEntry[]): Map<number, number> {
	const next = new Map(sizes)

	for (const [index, px] of entries) {
		if (px === null) {
			next.delete(index)
		} else {
			next.set(index, px)
		}
	}

	return next
}

export function sheetWithSizes<T extends { colWidths: ReadonlyMap<number, number>; rowHeights: ReadonlyMap<number, number> }>(
	sheet: T,
	axis: SizeAxis,
	entries: readonly SizeEntry[]
): T {
	return axis === "cols"
		? { ...sheet, colWidths: withSizes(sheet.colWidths, entries) }
		: { ...sheet, rowHeights: withSizes(sheet.rowHeights, entries) }
}

// A structural edit, as sizes follow it.
export interface AxisShift {
	axis: SizeAxis
	kind: "insert" | "delete"
	at: number
	count: number
}

export function shiftSizes(
	sizes: ReadonlyMap<number, number>,
	kind: "insert" | "delete",
	at: number,
	count: number
): { sizes: Map<number, number>; removed: [number, number][] } {
	const next = new Map<number, number>()
	const removed: [number, number][] = []

	for (const [index, px] of sizes) {
		if (index < at) {
			next.set(index, px)
		} else if (kind === "insert") {
			next.set(index + count, px)
		} else if (index < at + count) {
			removed.push([index - at, px])
		} else {
			next.set(index - count, px)
		}
	}

	return { sizes: next, removed }
}

export function restoreSizes(sizes: ReadonlyMap<number, number>, at: number, removed: readonly [number, number][]): Map<number, number> {
	const next = new Map(sizes)

	for (const [offset, px] of removed) {
		next.set(at + offset, px)
	}

	return next
}

// Which columns or rows a resize of `dragged` applies to: every visible selected one when the selection
// covers whole columns or rows and holds the dragged one, else just the dragged one.
export function resizeTargets(
	axis: SizeAxis,
	dragged: number,
	range: CellRange,
	whole: boolean,
	isHidden: (index: number) => boolean
): number[] {
	const [start, end] = axis === "cols" ? [range.startCol, range.endCol] : [range.startRow, range.endRow]

	if (!whole || dragged < start || dragged > end || end - start + 1 > MAX_RESIZE_TARGETS) {
		return [dragged]
	}

	const targets: number[] = []

	for (let index = start; index <= end; index++) {
		if (!isHidden(index)) {
			targets.push(index)
		}
	}

	return targets
}

// Autofit from the measured content of an index's rendered cells: null (the default) with nothing to
// measure, or for a row whose content fits the default height.
export function fitSize(axis: SizeAxis, contents: readonly number[]): number | null {
	if (contents.length === 0) {
		return null
	}

	const largest = Math.ceil(Math.max(...contents))

	if (axis === "cols") {
		return clampSize("cols", largest + CELL_FIT_PADDING)
	}

	const height = clampSize("rows", largest + ROW_FIT_PADDING)

	return height <= DEFAULT_ROW_HEIGHT ? null : height
}

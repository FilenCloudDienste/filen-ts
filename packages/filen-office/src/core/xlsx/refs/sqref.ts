import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../../sheet/protocol"
import { cellName, columnIndex } from "../../sheet/refs/cellRef"
import { parseRange } from "../read/sheetData"
import { deletedCells, inBand, shiftRange, type AxisShift } from "./axis"
import { intersects } from "./moveRefs"

// ST_Sqref (ECMA-376 Part 1 §18.18.76): references separated by spaces. A1 cells and areas, with whole columns
// (A:C) and rows (1:3) read as the areas they name.

const WHOLE_COLUMNS = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/
const WHOLE_ROWS = /^\$?([0-9]{1,7}):\$?([0-9]{1,7})$/

export function parseRef(text: string): SheetRange | null {
	const range = parseRange(text)

	if (range !== null) return range

	const columns = WHOLE_COLUMNS.exec(text)

	if (columns !== null) {
		const a = columnIndex(columns[1] ?? "")
		const b = columnIndex(columns[2] ?? "")

		if (Math.max(a, b) >= SHEET_MAX_COLS) return null

		return { startRow: 0, startCol: Math.min(a, b), endRow: SHEET_MAX_ROWS - 1, endCol: Math.max(a, b) }
	}

	const rows = WHOLE_ROWS.exec(text)

	if (rows !== null) {
		const a = Number(rows[1]) - 1
		const b = Number(rows[2]) - 1

		if (Math.min(a, b) < 0 || Math.max(a, b) >= SHEET_MAX_ROWS) return null

		return { startRow: Math.min(a, b), startCol: 0, endRow: Math.max(a, b), endCol: SHEET_MAX_COLS - 1 }
	}

	return null
}

// null when any part does not read.
export function parseSqref(text: string): SheetRange[] | null {
	const out: SheetRange[] = []

	for (const part of text.trim().split(/\s+/)) {
		if (part === "") continue

		const range = parseRef(part)

		if (range === null) return null

		out.push(range)
	}

	return out
}

// A worksheet section whose markup carries range lists: conditional formats and validations name theirs in a sqref
// attribute, the x14 ones in extLst (and sparkline groups) in <xm:sqref> elements.
export type SqrefSection = "conditionalFormatting" | "dataValidations" | "extLst"

const SQREF_ATTRIBUTE = /\ssqref="([^"]*)"/g
const SQREF_ELEMENT = /<(?:\w+:)?sqref>([^<]*)<\/(?:\w+:)?sqref>/g

// Every range list (ST_Sqref text, for parseSqref) in a section's markup, in order.
export function sectionSqrefs(section: SqrefSection, markup: string): string[] {
	return Array.from(markup.matchAll(section === "extLst" ? SQREF_ELEMENT : SQREF_ATTRIBUTE), match => match[1] ?? "")
}

// Whether a range is whole cells of the grid, its corners in order.
export function inGrid(range: SheetRange): boolean {
	return (
		Number.isInteger(range.startRow) &&
		Number.isInteger(range.endRow) &&
		Number.isInteger(range.startCol) &&
		Number.isInteger(range.endCol) &&
		range.startRow >= 0 &&
		range.startCol >= 0 &&
		range.endRow < SHEET_MAX_ROWS &&
		range.endCol < SHEET_MAX_COLS &&
		range.startRow <= range.endRow &&
		range.startCol <= range.endCol
	)
}

export function formatRef(range: SheetRange): string {
	const start = cellName(range.startRow, range.startCol)

	return range.startRow === range.endRow && range.startCol === range.endCol ? start : `${start}:${cellName(range.endRow, range.endCol)}`
}

export function formatSqref(ranges: readonly SheetRange[]): string {
	return ranges.map(formatRef).join(" ")
}

// The ranges moved; deleted ones dropped. The same array when nothing moved.
export function shiftRanges(ranges: readonly SheetRange[], shift: AxisShift): readonly SheetRange[] {
	let changed = false
	const out: SheetRange[] = []

	for (const range of ranges) {
		const next = shiftRange(range, shift)

		if (next !== range) changed = true
		if (next !== null) out.push(next)
	}

	return changed ? out : ranges
}

// The top-left cell of the rectangle around a range list: what formulas written relative to the list (conditional
// formats, validations) are written for (Excel's files and LibreOffice agree; ECMA-376 leaves it open).
export function topLeft(ranges: readonly SheetRange[]): { row: number; col: number } {
	let row = Infinity
	let col = Infinity

	for (const range of ranges) {
		row = Math.min(row, range.startRow)
		col = Math.min(col, range.startCol)
	}

	return { row, col }
}

// The part of `range` inside `other` (they must meet).
export function overlapRange(range: SheetRange, other: SheetRange): SheetRange {
	return {
		startRow: Math.max(range.startRow, other.startRow),
		startCol: Math.max(range.startCol, other.startCol),
		endRow: Math.min(range.endRow, other.endRow),
		endCol: Math.min(range.endCol, other.endCol)
	}
}

// `range` without the cells of `cut`: the rows above and below it whole, then what is left and right of it in its
// rows. [range] when they do not meet.
export function subtractRange(range: SheetRange, cut: SheetRange): SheetRange[] {
	if (!intersects(range, cut)) return [range]

	const out: SheetRange[] = []
	const top = Math.max(range.startRow, cut.startRow)
	const bottom = Math.min(range.endRow, cut.endRow)

	if (range.startRow < cut.startRow) out.push({ ...range, endRow: cut.startRow - 1 })
	if (range.endRow > cut.endRow) out.push({ ...range, startRow: cut.endRow + 1 })
	if (range.startCol < cut.startCol) out.push({ startRow: top, endRow: bottom, startCol: range.startCol, endCol: cut.startCol - 1 })
	if (range.endCol > cut.endCol) out.push({ startRow: top, endRow: bottom, startCol: cut.endCol + 1, endCol: range.endCol })

	return out
}

// How a range list follows cells inserted or deleted in a band (whole rows and columns: shiftRanges):
// - "list" (conditional formats, protected ranges, ignored errors, sparklines): the deleted cells leave each range,
//   then each piece moves only when it lies across the band;
// - "cells" (validations, which belong to their cells): each range's part across the band moves, the rest stays.
// LibreOffice's rules for the two (Microsoft's documentation is silent). The same array when nothing moved.
export function shiftRangeList(ranges: readonly SheetRange[], shift: AxisShift, mode: "list" | "cells"): readonly SheetRange[] {
	const band = shift.band

	if (band === undefined) return shiftRanges(ranges, shift)

	let pieces: readonly SheetRange[] = ranges

	if (mode === "list") {
		const deleted = deletedCells(shift)

		if (deleted !== null && ranges.some(range => intersects(range, deleted)))
			pieces = ranges.flatMap(range => subtractRange(range, deleted))
	} else if (ranges.some(range => !inBand(range, shift) && intersects(range, strip(shift)))) {
		const across = strip(shift)

		// The piece holding the range's first cell first: formulas stay written from it.
		pieces = ranges.flatMap(range => {
			if (inBand(range, shift) || !intersects(range, across)) return [range]

			const inside = overlapRange(range, across)
			const outside = subtractRange(range, across)

			return inside.startRow === range.startRow && inside.startCol === range.startCol ? [inside, ...outside] : [...outside, inside]
		})
	}

	const moved = shiftRanges(pieces, shift)

	return moved === pieces && pieces === ranges ? ranges : moved
}

// Every cell of the band, the whole length of the edited axis.
function strip(shift: AxisShift): SheetRange {
	const band = shift.band ?? { start: 0, end: (shift.axis === "rows" ? SHEET_MAX_COLS : SHEET_MAX_ROWS) - 1 }

	return shift.axis === "rows"
		? { startRow: 0, startCol: band.start, endRow: SHEET_MAX_ROWS - 1, endCol: band.end }
		: { startRow: band.start, startCol: 0, endRow: band.end, endCol: SHEET_MAX_COLS - 1 }
}

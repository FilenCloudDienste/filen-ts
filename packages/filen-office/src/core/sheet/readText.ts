import type { SheetQueryResult, SheetRange } from "./protocol"

// A sheet's cells as text for a reader (the "text" query): tab-separated fields, a line per row from the area's first
// row, fields with a tab, line break or quote quoted as a TSV copy writes them. Cells are visited a band of rows at a
// time, so a cut at `maxChars` stops the walk instead of reading the rest of a large sheet.

// Rows visited per band.
const BAND_ROWS = 256

export interface SheetTextSource {
	// The used area: rows and columns from 0 up to past the last cell with content.
	readonly rows: number
	readonly cols: number
	// Visits the cells of `range` that hold text, row by row, columns ascending within a row.
	cells(range: SheetRange, visit: (row: number, col: number, text: string) => void): void
}

function field(text: string): string {
	return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// `text` cut to `length` units, never between the halves of a surrogate pair.
function cut(text: string, length: number): string {
	const code = text.charCodeAt(length - 1)

	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length)
}

export function sheetText(source: SheetTextSource, range: SheetRange | undefined, maxChars: number): SheetQueryResult<"text"> {
	const limit = Math.max(0, Math.trunc(maxChars))
	const startRow = Math.max(0, range?.startRow ?? 0)
	const startCol = Math.max(0, range?.startCol ?? 0)
	const endRow = Math.min(source.rows - 1, range?.endRow ?? Number.POSITIVE_INFINITY)
	const endCol = Math.min(source.cols - 1, range?.endCol ?? Number.POSITIVE_INFINITY)
	const parts: string[] = []
	let length = 0
	let truncated = false
	// The row the last field was written on, and the column after it.
	let row = startRow
	let col = startCol

	const write = (text: string): void => {
		if (truncated) return

		if (length + text.length > limit) {
			parts.push(cut(text, limit - length))
			length = limit
			truncated = true

			return
		}

		parts.push(text)
		length += text.length
	}

	for (let band = startRow; band <= endRow && !truncated; band += BAND_ROWS) {
		source.cells({ startRow: band, startCol, endRow: Math.min(endRow, band + BAND_ROWS - 1), endCol }, (at, column, text) => {
			if (truncated || text.length === 0) return

			// Blank rows and columns as line breaks and tabs, never more than the room left.
			if (at > row) {
				write("\n".repeat(Math.min(at - row, limit - length + 1)))
				row = at
				col = startCol
			}

			write("\t".repeat(Math.min(column - col, limit - length + 1)) + field(text))
			col = column
		})
	}

	return { text: parts.join(""), truncated }
}

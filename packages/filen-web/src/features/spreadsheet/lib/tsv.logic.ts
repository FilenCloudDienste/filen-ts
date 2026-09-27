import { cellKey, type CellRange, type CellView } from "@/features/spreadsheet/lib/model"

// How far a copy reaches: past this the clipboard text would run to hundreds of megabytes.
export const MAX_COPY_CELLS = 1_000_000

function tsvField(text: string): string {
	return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// A range as the tab-separated text other spreadsheets paste: what each cell shows, quoted where a tab, a
// line end or a quote would break the layout. Null past MAX_COPY_CELLS.
export function rangeToTsv(sheet: { cells: { get: (key: number) => CellView | undefined } }, range: CellRange): string | null {
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1

	if (rows * cols > MAX_COPY_CELLS) {
		return null
	}

	const lines: string[] = []

	for (let row = range.startRow; row <= range.endRow; row++) {
		const fields: string[] = []

		for (let col = range.startCol; col <= range.endCol; col++) {
			fields.push(tsvField(sheet.cells.get(cellKey(row, col))?.text ?? ""))
		}

		lines.push(fields.join("\t"))
	}

	return lines.join("\r\n")
}

// Tab-separated clipboard text back into rows of cells: quoted fields may hold tabs, line ends and doubled
// quotes, and a trailing line end (which every spreadsheet adds) is not an extra empty row.
export function parseTsv(text: string): string[][] {
	const rows: string[][] = []
	let row: string[] = []
	let field = ""
	let quoted = false
	let index = 0

	while (index < text.length) {
		const char = text.charAt(index)

		if (quoted) {
			if (char === '"' && text.charAt(index + 1) === '"') {
				field += '"'
				index += 2

				continue
			}

			if (char === '"') {
				quoted = false
			} else {
				field += char
			}

			index++

			continue
		}

		if (char === '"' && field === "") {
			quoted = true
		} else if (char === "\t") {
			row.push(field)
			field = ""
		} else if (char === "\n" || char === "\r") {
			row.push(field)
			rows.push(row)
			row = []
			field = ""

			if (char === "\r" && text.charAt(index + 1) === "\n") {
				index++
			}
		} else {
			field += char
		}

		index++
	}

	if (field !== "" || row.length > 0) {
		row.push(field)
		rows.push(row)
	}

	return rows
}

import { detectDelimiter, parseCsv, writeCsv, type CellValue } from "hucre"
import { cellKey, type CellView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"

// How a CSV file was written, so a save writes it back the same way: its separator, its line ends, a byte
// order mark, a final line end, and whether it was UTF-8 at all (a legacy Windows-1252 export is decoded as
// such, and saved as UTF-8, the only encoding the browser writes).
export interface CsvFormat {
	delimiter: string
	lineSeparator: "\r\n" | "\n"
	bom: boolean
	trailingNewline: boolean
	utf8: boolean
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]

export function decodeCsv(bytes: Uint8Array): { text: string; bom: boolean; utf8: boolean } {
	const bom = UTF8_BOM.every((byte, index) => bytes[index] === byte)
	const body = bom ? bytes.subarray(3) : bytes

	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), bom, utf8: true }
	} catch {
		return { text: new TextDecoder("windows-1252").decode(body), bom, utf8: false }
	}
}

export function parseCsvFile(bytes: Uint8Array, tabSeparated: boolean): { rows: string[][]; format: CsvFormat } {
	const { text, bom, utf8 } = decodeCsv(bytes)
	const delimiter = tabSeparated ? "\t" : text.length === 0 ? "," : detectDelimiter(text)
	const firstBreak = text.indexOf("\n")
	const lineSeparator = firstBreak > 0 && text[firstBreak - 1] === "\r" ? "\r\n" : "\n"
	// Every value stays the text it was: a CSV's "007" or "1e5" is not a number until someone says so.
	const parsed = text.length === 0 ? [] : parseCsv(text, { delimiter, typeInference: false, skipBom: false })
	const rows = parsed.map(row => row.map(value => (value === null ? "" : String(value))))

	return {
		rows,
		format: { delimiter, lineSeparator, bom, trailingNewline: text.endsWith("\n"), utf8 }
	}
}

export function serializeCsv(rows: readonly (readonly string[])[], format: CsvFormat): Uint8Array {
	// Only what the separator, a quote or a line end requires is quoted; a user's own data is never
	// rewritten against formula injection (that is for exporting other people's data, not saving a file).
	let text = writeCsv(rows as CellValue[][], {
		delimiter: format.delimiter,
		lineSeparator: format.lineSeparator,
		quoteStyle: "required",
		escapeFormulae: false
	})

	if (format.trailingNewline && rows.length > 0) {
		text += format.lineSeparator
	}

	const body = new TextEncoder().encode(text)

	if (!format.bom) {
		return body
	}

	const out = new Uint8Array(body.length + UTF8_BOM.length)

	out.set(UTF8_BOM)
	out.set(body, UTF8_BOM.length)

	return out
}

const NUMERIC = /^[-+]?(\d+([.,]\d+)?|\d{1,3}([.,]\d{3})+([.,]\d+)?)%?$/

// A CSV cell shows its text as is; one that reads as a number sits on the right, as a number does.
export function csvCellView(text: string): CellView | null {
	return text === "" ? null : NUMERIC.test(text.trim()) ? { text, numeric: true } : { text }
}

export function csvDoc(rows: readonly (readonly string[])[]): SpreadsheetDoc {
	const cells = new Map<number, CellView>()
	let colCount = 0

	rows.forEach((row, rowIndex) => {
		colCount = Math.max(colCount, row.length)
		row.forEach((value, colIndex) => {
			const view = csvCellView(value)

			if (view !== null) {
				cells.set(cellKey(rowIndex, colIndex), view)
			}
		})
	})

	return {
		kind: "csv",
		sheets: [
			{
				name: "",
				rowCount: rows.length,
				colCount,
				cells,
				merges: [],
				colWidths: new Map(),
				rowHeights: new Map(),
				hiddenCols: [],
				hiddenRows: [],
				frozenRows: 0,
				frozenCols: 0,
				structureLocked: false
			}
		],
		activeSheet: 0,
		styles: [],
		writable: true
	}
}

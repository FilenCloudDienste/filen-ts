import { readXls, writeXlsx } from "hucre/xlsx"
import { XlsxReadError } from "@filen/office/core/xlsx"
import { convertedCopyName } from "@/features/drive/lib/copyName"

// hucre's .xls reader raises its cell limit as a plain ParseError; only the message tells it from damage.
const CELL_LIMIT = /^Sheet spans \d+ cells, over the \d+ limit\./

// An .xls as an .xlsx: its sheets' values and merges, nothing else hucre's .xls reader keeps (formulas
// arrive as their results; formats, sizes and names are not read). Worker-side. A sheet past `maxTotalCells`
// throws an XlsxReadError "tooLarge", as an .xlsx past it does.
export async function xlsToXlsx(bytes: Uint8Array, maxTotalCells?: number): Promise<Uint8Array> {
	const workbook = await readXls(bytes, maxTotalCells === undefined ? {} : { maxTotalCells }).catch((error: unknown) => {
		throw error instanceof Error && error.name === "ParseError" && CELL_LIMIT.test(error.message)
			? new XlsxReadError("tooLarge", error.message)
			: error
	})

	return await writeXlsx({
		sheets: workbook.sheets.map(sheet => ({
			name: sheet.name,
			rows: sheet.rows,
			...(sheet.cells === undefined ? {} : { cells: sheet.cells }),
			...(sheet.merges === undefined ? {} : { merges: sheet.merges })
		}))
	})
}

// "budget.xls" → "budget.xlsx", or "budget (2).xlsx", "(3)"… while `taken` says the name is in use.
export function xlsxCopyName(original: string, taken: (name: string) => Promise<boolean>): Promise<string> {
	return convertedCopyName(original, "xlsx", taken)
}

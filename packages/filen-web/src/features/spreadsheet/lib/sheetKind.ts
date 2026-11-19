import type { SheetFileKind } from "@filen/office/core/sheet"
import { sniffSpreadsheetKind, spreadsheetFileKind } from "@/features/spreadsheet/lib/fileKind"

// What a file opens as: its extension when that names a spreadsheet (the templates and .xlsm open as themselves,
// so a save keeps their content type), else its first bytes; only a stored type can say tab-separated.
export function sheetKindOf(extension: string, bytes: Uint8Array, typeSaysTsv: boolean): { kind: SheetFileKind; unnamed: boolean } {
	if (spreadsheetFileKind(extension) !== null) {
		return { kind: extension as SheetFileKind, unnamed: false }
	}

	const sniffed = sniffSpreadsheetKind(bytes)

	return { kind: sniffed === "csv" && typeSaysTsv ? "tsv" : sniffed, unnamed: true }
}

// A legacy binary workbook, an .xls or its template .xlt: opened from its conversion to an .xlsx, view-only, and
// edited only as the .xlsx it is saved as.
export function isLegacySheetKind(kind: SheetFileKind): boolean {
	return kind === "xls" || kind === "xlt"
}

// A delimited text file: opened in the text worker, never the workbook worker, and saved back as text.
export function isTextSheetKind(kind: SheetFileKind): boolean {
	return kind === "csv" || kind === "tsv" || kind === "tab"
}

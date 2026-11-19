import { fileStem } from "@filen/shared"
import type { SheetRefusal } from "@filen/office/core/sheet"
import type { PreviewKey } from "@/lib/i18n"

// A spreadsheet's bytes as edited, for the overlay to store.
export interface SpreadsheetSnapshot {
	bytes: Uint8Array
	// Marks the snapshot saved: call once it is stored.
	commit: () => void
}

// What the viewer hands the overlay to save with.
export type SpreadsheetSaveSource = () => Promise<SpreadsheetSnapshot>

export { fileStem }

// Characters no file name may hold on the systems a download lands on (Windows' list is the longest).
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|]/g

// The CSV a sheet downloads as: the file's own name for its only sheet (a text file, a one-sheet workbook), else
// with the sheet's name after it, as one CSV holds one sheet.
export function csvDownloadName(fileName: string, sheetName: string, sheetCount: number): string {
	const stem = fileStem(fileName)

	return sheetCount <= 1 ? `${stem}.csv` : `${stem} - ${sheetName.replace(UNSAFE_FILE_CHARS, "_")}.csv`
}

// What a refused Save as .xlsx says.
export function saveAsRefusalKey(refusal: SheetRefusal | null): PreviewKey {
	return refusal?.reason === "tooLarge" ? "previewSheetSaveAsXlsxTooLarge" : "previewSpreadsheetSaveAsXlsxFailed"
}

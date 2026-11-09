// "preview" namespace, spreadsheet viewer — what it says beyond the spreadsheet viewer's own
// strings (preview.ts, previewSpreadsheet*). Spread into preview.ts; same catalog rules.
export const previewSheetViewer = {
	/** Spreadsheet viewer — accessible label of the name box (the selected cell or range, e.g. "B2:D7"), which also takes a cell or range to go to */
	previewSheetNameBox: "Name box",
	/** Spreadsheet viewer — toast when the name box was given something that is not a cell or range like "B4" or "A1:C3" */
	previewSheetNameBoxInvalid: "Enter a cell like B4, a range like A1:C3, a sheet's cell like Sheet2!A1 or a defined name.",
	/** Spreadsheet viewer — accessible label of the in-cell editor */
	previewSheetCellEditor: "Edit cell",
	/** Spreadsheet viewer — note beside the cell contents when a file carries a digital signature, which any edit would break */
	previewSheetReadOnlySigned: "Read-only here: this file is digitally signed, and editing it would break the signature.",
	/** Spreadsheet viewer — note beside the cell contents when the file's author recommends opening it read-only; the "Edit anyway" button beside it opens it for editing */
	previewSheetReadOnlyRecommended: "The author recommends opening this file read-only.",
	/** Spreadsheet viewer — button beside the read-only recommendation: opens the file for editing */
	previewSheetEditAnyway: "Edit anyway",
	/** Spreadsheet viewer — note beside the cell contents when the file needs its author's password to be modified */
	previewSheetReadOnlyModifyPassword: "Read-only here: this file needs a password to be modified.",
	/** Spreadsheet viewer — note beside the cell contents when a CSV or text file has more rows than a sheet holds (1,048,576, as in Excel): only its first rows are shown, and it can't be saved or copied to another format here, which would drop the rest */
	previewSheetReadOnlyIncomplete: "Read-only here: this file has more rows than a sheet holds, so only the first 1,048,576 are shown.",
	/** Toast — the sheet is protected, or the cell is locked on a protected sheet */
	previewSheetProtectedSheet: "This sheet is protected, so that can't be changed.",
	/** Toast — the workbook's structure is protected: sheets can't be added, renamed or moved */
	previewSheetProtectedWorkbook: "This workbook's structure is protected, so sheets can't be added or renamed.",
	/** Toast — the change would leave the workbook without a visible sheet */
	previewSheetLastSheet: "A workbook needs at least one visible sheet.",
	/** Toast — merged cells are in the way of the change */
	previewSheetMerged: "Merged cells are in the way of that change.",
	/** Toast — the change would move or cut through a pivot table */
	previewSheetPivot: "That would change a pivot table, which can't be edited here.",
	/** Toast — the workbook holds as many cell formats as Excel allows */
	previewSheetStyleLimit: "This workbook can't hold any more cell formats.",
	/** Toast — the file's format can't hold the change */
	previewSheetUnsupported: "That change can't be saved in this file's format.",
	/** Spreadsheet viewer — the engine behind the open spreadsheet stopped; nothing more can be edited or saved */
	previewSheetFailed: "This spreadsheet stopped working. Close it and open it again.",
	/** Spreadsheet status bar — the average of the numbers in the selected cells, shown as the first number's cell shows it */
	previewSheetStatusAverage: "Average: {{value}}",
	/** Spreadsheet status bar — how many of the selected cells hold something */
	previewSheetStatusCount: "Count: {{value}}",
	/** Spreadsheet status bar — the sum of the numbers in the selected cells, shown as the first number's cell shows it */
	previewSheetStatusSum: "Sum: {{value}}"
}

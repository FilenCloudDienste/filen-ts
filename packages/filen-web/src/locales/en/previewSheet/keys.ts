// "preview" namespace, spreadsheet viewer — find and replace, and the insert and delete
// dialogs (Ctrl+Shift+Plus, Ctrl+Minus). Spread into preview.ts; same catalog rules.
export const previewSheetKeys = {
	/** Spreadsheet find bar — the bar's accessible name */
	previewSheetFindBar: "Find in spreadsheet",
	/** Spreadsheet find bar — the button opening the find options */
	previewSheetFindOptions: "Find options",
	/** Find options — matches only cells whose whole content is the text searched */
	previewSheetFindWholeCell: "Match entire cell contents",
	/** Find options — heading of where to search */
	previewSheetFindWithin: "Within",
	/** Find options — searches the sheet shown */
	previewSheetFindWithinSheet: "Sheet",
	/** Find options — searches every visible sheet */
	previewSheetFindWithinWorkbook: "Workbook",
	/** Find options — heading of what to search in */
	previewSheetFindLookIn: "Look in",
	/** Find options — searches what the cells show */
	previewSheetFindLookInValues: "Values",
	/** Find options — searches what was typed into the cells (formulas included) */
	previewSheetFindLookInFormulas: "Formulas",
	/** Insert dialog (Ctrl+Shift+Plus on cells) — title, and its confirm button */
	previewSheetInsertDialogTitle: "Insert",
	/** Insert dialog — what it does */
	previewSheetInsertDialogBody: "Insert cells at the selection, moving the cells there aside, or insert whole rows or columns.",
	/** Delete dialog (Ctrl+Minus on cells) — title, and its confirm button */
	previewSheetDeleteDialogTitle: "Delete",
	/** Delete dialog — what it does */
	previewSheetDeleteDialogBody: "Delete the selected cells, moving the cells after them in, or delete whole rows or columns.",
	/** Insert and delete dialogs — the whole rows of the selection */
	previewSheetDialogEntireRow: "Entire row",
	/** Insert and delete dialogs — the whole columns of the selection */
	previewSheetDialogEntireColumn: "Entire column"
}

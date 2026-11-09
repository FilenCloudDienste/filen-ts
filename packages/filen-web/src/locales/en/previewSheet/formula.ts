// "preview" namespace, spreadsheet viewer — typing formulas: function suggestions, the syntax of
// the function being typed, and AutoSum. Spread into preview.ts; same catalog rules.
export const previewSheetFormula = {
	/** Spreadsheet formula typing — accessible name of the list of function names offered while a formula is typed */
	previewSheetFormulaSuggestions: "Functions",
	/** Spreadsheet formula typing — accessible name of the hint showing the arguments of the function being typed */
	previewSheetFormulaSignature: "Function arguments",
	/** Spreadsheet formula bar — button that adds up the numbers above or to the left of the selection (Excel's AutoSum) */
	previewSheetAutoSum: "AutoSum",
	/** Spreadsheet formula bar — icon and tooltip beside a formula whose result this app does not calculate: the cell shows the result saved in the file, which may be out of date after edits */
	previewSheetCachedResult: "Not recalculated here: this shows the result saved in the file",
	/** Spreadsheet status bar — while a formula on the sheet shown refers to its own cell, directly or through other cells (a circular reference); {{cell}} is the first such cell, e.g. "B1" */
	previewSheetCircularStatus: "Circular References: {{cell}}",
	/** Spreadsheet status bar — while a formula on another sheet, not the one shown, refers to its own cell (a circular reference) */
	previewSheetCircularStatusElsewhere: "Circular References",
	/** Spreadsheet circular reference warning — title of the dialog shown once an edit makes a formula refer to its own cell */
	previewSheetCircularTitle: "Circular reference",
	/** Spreadsheet circular reference warning — the dialog's message */
	previewSheetCircularBody:
		"There are one or more circular references where a formula refers to its own cell either directly or indirectly. This might cause them to calculate incorrectly.\n\nTry removing or changing these references, or moving the formulas to different cells.",
	/** Spreadsheet circular reference warning — button that closes the dialog */
	previewSheetCircularOk: "OK"
}

// "preview" namespace, spreadsheet viewer — data validation: the in-cell list, the input
// message, the alert an invalid entry shows and the Data validation dialog. Spread into preview.ts; same catalog rules.
export const previewSheetConditional = {
	/** Spreadsheet grid menu — opens the Data validation dialog for the selected cells */
	previewSheetDataValidation: "Data validation…",
	/** Data validation dialog — title */
	previewSheetDataValidationTitle: "Data validation",
	/** Data validation dialog — what it does */
	previewSheetDataValidationBody: "Choose what the selected cells accept and what they show.",
	/** Data validation dialog — the kind of values the cells accept */
	previewSheetValidationAllow: "Allow",
	/** Data validation "Allow" option — no restriction */
	previewSheetValidationAny: "Any value",
	/** Data validation "Allow" option — whole numbers */
	previewSheetValidationWhole: "Whole number",
	/** Data validation "Allow" option — numbers with decimals */
	previewSheetValidationDecimal: "Decimal",
	/** Data validation "Allow" option — a value from a list */
	previewSheetValidationList: "List",
	/** Data validation "Allow" option — dates */
	previewSheetValidationDate: "Date",
	/** Data validation "Allow" option — times of day */
	previewSheetValidationTime: "Time",
	/** Data validation "Allow" option — text of a limited length */
	previewSheetValidationTextLength: "Text length",
	/** Data validation "Allow" option — a formula decides */
	previewSheetValidationCustom: "Custom",
	/** Data validation dialog — how the value compares with the limits */
	previewSheetValidationData: "Data",
	/** Data validation "Data" option */
	previewSheetValidationBetween: "between",
	/** Data validation "Data" option */
	previewSheetValidationNotBetween: "not between",
	/** Data validation "Data" option */
	previewSheetValidationEqual: "equal to",
	/** Data validation "Data" option */
	previewSheetValidationNotEqual: "not equal to",
	/** Data validation "Data" option */
	previewSheetValidationGreater: "greater than",
	/** Data validation "Data" option */
	previewSheetValidationLess: "less than",
	/** Data validation "Data" option */
	previewSheetValidationGreaterOrEqual: "greater than or equal to",
	/** Data validation "Data" option */
	previewSheetValidationLessOrEqual: "less than or equal to",
	/** Data validation dialog — lower limit field */
	previewSheetValidationMinimum: "Minimum",
	/** Data validation dialog — upper limit field */
	previewSheetValidationMaximum: "Maximum",
	/** Data validation dialog — the single limit field (equal to, greater than, …) */
	previewSheetValidationValue: "Value",
	/** Data validation dialog — a list's items, or a reference to cells holding them */
	previewSheetValidationSource: "Source",
	/** Data validation dialog — hint under the list source field */
	previewSheetValidationSourceHint:
		"Items separated by commas (semicolons where formulas use them between arguments), or a reference such as =$A$1:$A$10",
	/** Data validation dialog — the custom rule's formula */
	previewSheetValidationFormula: "Formula",
	/** Data validation dialog — hint under a limit or formula field */
	previewSheetValidationValueHint: "A number, date or time, or a formula starting with =",
	/** Data validation dialog — empty cells and empty limits let any value through */
	previewSheetValidationIgnoreBlank: "Ignore blank",
	/** Data validation dialog — show the list's button on the cell */
	previewSheetValidationInCellDropdown: "In-cell dropdown",
	/** Data validation dialog — section and switch for the message shown when a cell is selected */
	previewSheetValidationInputMessage: "Show input message when the cell is selected",
	/** Data validation dialog — title field of a message */
	previewSheetValidationMessageTitle: "Title",
	/** Data validation dialog — text field of a message */
	previewSheetValidationMessageText: "Message",
	/** Data validation dialog — section and switch for the alert an invalid entry shows */
	previewSheetValidationErrorAlert: "Show error alert after invalid data is entered",
	/** Data validation dialog — the alert's kind */
	previewSheetValidationStyle: "Style",
	/** Data validation alert style — refuses the entry */
	previewSheetValidationStop: "Stop",
	/** Data validation alert style — asks whether to keep the entry */
	previewSheetValidationWarning: "Warning",
	/** Data validation alert style — tells, then keeps the entry */
	previewSheetValidationInformation: "Information",
	/** Data validation dialog — removes the validation from the selected cells */
	previewSheetValidationClearAll: "Clear all",
	/** Data validation dialog — a limit or formula that cannot be used */
	previewSheetValidationInvalidValue: "Enter a number, date, time or a formula starting with =.",
	/** Data validation dialog — a list source longer than Excel allows */
	previewSheetValidationListTooLong: "A typed list can be at most 255 characters long. Put the items in cells and refer to them instead.",
	/** Data validation dialog — a title or message longer than Excel allows */
	previewSheetValidationTextTooLong: "Titles can be at most 32 characters and messages 255 (225 for an error message).",
	/** Spreadsheet — the button that opens a cell's list of allowed values */
	previewSheetValidationOpenList: "Show allowed values",
	/** Spreadsheet — the list of a cell's allowed values */
	previewSheetValidationListLabel: "Allowed values",
	/** Spreadsheet — the list of entries already in the cell's column (Alt+Down on a cell) */
	previewSheetAutoCompleteListLabel: "Column entries",
	/** Spreadsheet — a list whose items could not be read */
	previewSheetValidationListUnavailable: "The allowed values can't be shown.",
	/** Invalid entry alert — default title */
	previewSheetValidationAlertTitle: "Invalid value",
	/** Invalid entry alert — default message, as Excel words it */
	previewSheetValidationAlertBody: "This value doesn't match the data validation restrictions defined for this cell.",
	/** Invalid entry alert (warning) — question after the message */
	previewSheetValidationContinue: "Continue?",
	/** Invalid entry alert (stop) — reopens the entry to correct it */
	previewSheetValidationRetry: "Retry",
	/** Invalid entry alert (warning) — keeps the entry */
	previewSheetValidationYes: "Yes",
	/** Invalid entry alert (warning) — reopens the entry to correct it */
	previewSheetValidationNo: "No",
	/** Invalid entry alert (information) — keeps the entry */
	previewSheetValidationOk: "OK"
}

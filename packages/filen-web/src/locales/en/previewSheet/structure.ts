// "preview" namespace, spreadsheet viewer — sheet structure: hiding, freezing, merging, the
// sheet tabs' menu and protection. Spread into preview.ts; same catalog rules.
export const previewSheetStructure = {
	/** Spreadsheet grid menu — hides the selected rows */
	previewSheetHideRows_one: "Hide row",
	/** Spreadsheet grid menu — hides the selected rows */
	previewSheetHideRows_other: "Hide {{count}} rows",
	/** Spreadsheet grid menu — shows again the hidden rows in and next to the selection */
	previewSheetUnhideRows: "Unhide rows",
	/** Spreadsheet grid menu — hides the selected columns */
	previewSheetHideColumns_one: "Hide column",
	/** Spreadsheet grid menu — hides the selected columns */
	previewSheetHideColumns_other: "Hide {{count}} columns",
	/** Spreadsheet grid menu — shows again the hidden columns in and next to the selection */
	previewSheetUnhideColumns: "Unhide columns",
	/** Spreadsheet toolbar — the freeze panes menu's button */
	previewSheetFreeze: "Freeze",
	/** Freeze menu — keeps the rows above and the columns left of the active cell in view while scrolling */
	previewSheetFreezePanes: "Freeze panes",
	/** Freeze menu — keeps the first row in view while scrolling */
	previewSheetFreezeTopRow: "Freeze top row",
	/** Freeze menu — keeps the first column in view while scrolling */
	previewSheetFreezeFirstColumn: "Freeze first column",
	/** Freeze menu — lets every row and column scroll again */
	previewSheetUnfreeze: "Unfreeze panes",
	/** Spreadsheet toolbar — the merge menu's button */
	previewSheetMerge: "Merge",
	/** Merge menu — merges the selection into one cell and centres its contents */
	previewSheetMergeCenter: "Merge and center",
	/** Merge menu — merges each selected row's cells on its own */
	previewSheetMergeAcross: "Merge across",
	/** Merge menu — merges the selection into one cell */
	previewSheetMergeCells: "Merge cells",
	/** Merge menu — splits merged cells in the selection back into single cells */
	previewSheetUnmerge: "Unmerge cells",
	/** Merge confirmation — title */
	previewSheetMergeLosesTitle: "Merge cells?",
	/** Merge confirmation — body, as Excel words it: only the upper-left cell's value stays */
	previewSheetMergeLosesBody: "Merging cells keeps only the upper-left value and discards the other values.",
	/** Sheet tabs — opens a sheet tab's menu (its actions) */
	previewSheetTabMenu: "Sheet actions",
	/** Sheet tab menu — adds an empty sheet after this one */
	previewSheetInsertSheet: "Insert sheet",
	/** Sheet tab menu — adds a copy of this sheet after it */
	previewSheetDuplicate: "Duplicate",
	/** Sheet tab menu — renames this sheet */
	previewSheetRename: "Rename",
	/** Sheet tab menu — deletes this sheet */
	previewSheetDelete: "Delete",
	/** Sheet delete confirmation — title */
	previewSheetDeleteTitle: "Delete sheet?",
	/** Sheet delete confirmation — body, as Excel words it; the sheet's name */
	previewSheetDeleteBody: "“{{name}}” will be permanently deleted, and anything that refers to it will show #REF!.",
	/** Sheet tab menu — moves this sheet one place to the left */
	previewSheetMoveLeft: "Move left",
	/** Sheet tab menu — moves this sheet one place to the right */
	previewSheetMoveRight: "Move right",
	/** Sheet tab menu — hides this sheet's tab */
	previewSheetHide: "Hide",
	/** Sheet tab menu — opens the list of hidden sheets to show again */
	previewSheetUnhide: "Unhide…",
	/** Unhide sheets dialog — title */
	previewSheetUnhideTitle: "Unhide sheet",
	/** Unhide sheets dialog — description above the list of hidden sheets */
	previewSheetUnhideBody: "Choose a hidden sheet to show again.",
	/** Unhide sheets dialog — the button that shows the chosen sheet */
	previewSheetUnhideAction: "Unhide",
	/** Sheet tab menu — the tab colour submenu */
	previewSheetTabColor: "Tab color",
	/** Tab colour submenu — takes the colour off the tab */
	previewSheetTabColorNone: "No color",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorDarkRed: "Dark red",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorRed: "Red",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorOrange: "Orange",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorYellow: "Yellow",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorLightGreen: "Light green",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorGreen: "Green",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorLightBlue: "Light blue",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorBlue: "Blue",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorDarkBlue: "Dark blue",
	/** Tab colour submenu — one of Excel's standard colours */
	previewSheetColorPurple: "Purple",
	/** Sheet tab menu — protects this sheet from changes */
	previewSheetProtect: "Protect sheet…",
	/** Sheet tab menu — takes this sheet's protection off */
	previewSheetUnprotect: "Unprotect sheet…",
	/** Sheet tab menu — protects the workbook's structure (adding, deleting, moving, hiding and renaming sheets) */
	previewSheetProtectWorkbook: "Protect workbook…",
	/** Sheet tab menu — takes the workbook's structure protection off */
	previewSheetUnprotectWorkbook: "Unprotect workbook…",
	/** Tooltip on a sheet action that the workbook's structure protection stops */
	previewSheetStructureProtected: "The workbook's structure is protected.",
	/** Protect sheet dialog — title */
	previewSheetProtectTitle: "Protect sheet",
	/** Protect sheet dialog — description */
	previewSheetProtectBody: "Locked cells can't be changed while the sheet is protected. Choose what everyone may still do.",
	/** Protect workbook dialog — title */
	previewSheetProtectWorkbookTitle: "Protect workbook",
	/** Protect workbook dialog — description */
	previewSheetProtectWorkbookBody:
		"Sheets can't be added, deleted, moved, hidden or renamed while the workbook's structure is protected.",
	/** Protect dialogs — the optional password field's label */
	previewSheetProtectPassword: "Password (optional)",
	/** Protect dialogs — the field repeating the password */
	previewSheetProtectConfirm: "Confirm password",
	/** Protect dialogs — inline error when the two passwords differ */
	previewSheetProtectMismatch: "The passwords don't match.",
	/** Protect dialogs — the submit button */
	previewSheetProtectAction: "Protect",
	/** Protect sheet dialog — heading above the allowed actions */
	previewSheetProtectAllows: "Everyone may",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowSelectLockedCells: "Select locked cells",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowSelectUnlockedCells: "Select unlocked cells",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowFormatCells: "Format cells",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowFormatColumns: "Format columns",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowFormatRows: "Format rows",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowInsertColumns: "Insert columns",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowInsertRows: "Insert rows",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowInsertHyperlinks: "Insert hyperlinks",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowDeleteColumns: "Delete columns",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowDeleteRows: "Delete rows",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowSort: "Sort",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowAutoFilter: "Use AutoFilter",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowPivotTables: "Use PivotTable and PivotChart",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowObjects: "Edit objects",
	/** Protect sheet dialog — allowed action */
	previewSheetAllowScenarios: "Edit scenarios",
	/** Unprotect dialogs — title (sheet) */
	previewSheetUnprotectTitle: "Unprotect sheet",
	/** Unprotect dialogs — title (workbook) */
	previewSheetUnprotectWorkbookTitle: "Unprotect workbook",
	/** Unprotect dialogs — description above the password field */
	previewSheetUnprotectBody: "Enter the password that protects it.",
	/** Unprotect dialogs — the password field's label */
	previewSheetUnprotectPassword: "Password",
	/** Unprotect dialogs — the submit button */
	previewSheetUnprotectAction: "Unprotect",
	/** Unprotect dialogs — while the password is checked */
	previewSheetUnprotectChecking: "Checking…",
	/** Unprotect dialogs — under the field after a wrong password */
	previewSheetWrongPassword: "That password isn't correct.",
	/** Toast — the protection's password uses a hash this app can't check */
	previewSheetPasswordUnsupported: "This protection's password can't be checked here.",
	/** Toast — merging was refused: other cells hold values (only reached when the confirmation is skipped) */
	previewSheetMergeLosesValues: "Merging would discard values outside the upper-left cell.",
	/** Spreadsheet formula bar — asks for the workbook's password to modify, to edit it */
	previewSheetModifyPasswordEdit: "Edit…",
	/** Password to modify prompt — title */
	previewSheetModifyPasswordTitle: "Password to edit",
	/** Password to modify prompt — body; {{name}} is the file's name */
	previewSheetModifyPasswordBody: "Enter the password to edit “{{name}}”. The workbook keeps its password.",
	/** Password to modify prompt — after a wrong password */
	previewSheetModifyPasswordWrong: "That password isn't right. Try again, or cancel to keep viewing.",
	/** Password to modify prompt — the password field's label */
	previewSheetModifyPasswordLabel: "Password",
	/** Password to modify prompt — the submit button */
	previewSheetModifyPasswordSubmit: "Edit",
	/** Password to modify prompt — while the password is checked */
	previewSheetModifyPasswordChecking: "Checking…",
	/** Spreadsheet formula bar — the workbook's password to modify cannot be checked here */
	previewSheetModifyPasswordUnsupported: "This workbook's password to edit can't be checked here. You can view it.",
	/** Spreadsheet error — rows or columns inserted or deleted on selected ranges that overlap one another */
	previewSheetOverlappingSelections: "That command can't be used on overlapping selections.",
	/** Spreadsheet error — rows or columns inserted or deleted on a selection of whole rows together with whole columns */
	previewSheetMultipleSelections: "That command can't be used on multiple selections."
}

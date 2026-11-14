// "preview" namespace, spreadsheet editor — the names of its keyboard shortcuts as Settings → Keyboard lists them
// (each one an action on the grid or the workbook). Spread into preview.ts; same catalog rules.
export const previewSheetShortcuts = {
	/** Keyboard shortcut (spreadsheet) — undoes the last change */
	previewSheetShortcutUndo: "Undo",
	/** Keyboard shortcut (spreadsheet) — redoes the last undone change */
	previewSheetShortcutRedo: "Redo",
	/** Keyboard shortcut (spreadsheet) — copies the selection's first row into the rest of it */
	previewSheetShortcutFillDown: "Fill down",
	/** Keyboard shortcut (spreadsheet) — copies the selection's first column into the rest of it */
	previewSheetShortcutFillRight: "Fill right",
	/** Keyboard shortcut (spreadsheet) — copies the selection's last row into the rest of it */
	previewSheetShortcutFillUp: "Fill up",
	/** Keyboard shortcut (spreadsheet) — copies the selection's last column into the rest of it */
	previewSheetShortcutFillLeft: "Fill left",
	/** Keyboard shortcut (spreadsheet) — opens the Series dialog */
	previewSheetShortcutFillSeries: "Fill series",
	/** Keyboard shortcut (spreadsheet) — repeats the last command (F4 in Excel) */
	previewSheetShortcutRepeat: "Repeat last action",
	/** Keyboard shortcut (spreadsheet) — redoes, or repeats the last command when there is nothing to redo */
	previewSheetShortcutRedoOrRepeat: "Redo or repeat",
	/** Keyboard shortcut (spreadsheet) — types today's date */
	previewSheetShortcutInsertDate: "Insert today's date",
	/** Keyboard shortcut (spreadsheet) — types the current time */
	previewSheetShortcutInsertTime: "Insert the current time",
	/** Keyboard shortcut (spreadsheet) — copies the formula of the cell above into the active cell */
	previewSheetShortcutFormulaFromAbove: "Copy formula from the cell above",
	/** Keyboard shortcut (spreadsheet) — copies the value of the cell above into the active cell */
	previewSheetShortcutValueFromAbove: "Copy value from the cell above",
	/** Keyboard shortcut (spreadsheet) — shows formulas in the cells instead of their results, or back */
	previewSheetShortcutShowFormulas: "Show formulas",
	/** Keyboard shortcut (spreadsheet) — inserts cells, rows or columns at the selection */
	previewSheetShortcutInsertCells: "Insert cells",
	/** Keyboard shortcut (spreadsheet) — deletes the selected cells, rows or columns */
	previewSheetShortcutDeleteCells: "Delete cells",
	/** Keyboard shortcut (spreadsheet) — pastes the clipboard's values without formats or formulas */
	previewSheetShortcutPasteValues: "Paste values",
	/** Keyboard shortcut (spreadsheet) — removes the selection's formats, keeping its contents */
	previewSheetShortcutClearFormats: "Clear formats",
	/** Keyboard shortcut (spreadsheet) — removes the selection's contents and formats */
	previewSheetShortcutClearAll: "Clear all",
	/** Keyboard shortcut (spreadsheet) — selects the whole columns of the selection */
	previewSheetShortcutSelectColumns: "Select entire column",
	/** Keyboard shortcut (spreadsheet) — selects the whole rows of the selection */
	previewSheetShortcutSelectRows: "Select entire row",
	/** Keyboard shortcut (spreadsheet) — selects the data around the active cell, then the whole sheet */
	previewSheetShortcutSelectAll: "Select all",
	/** Keyboard shortcut (spreadsheet) — selects the block of filled cells around the active cell */
	previewSheetShortcutSelectRegion: "Select current region",
	/** Keyboard shortcut (spreadsheet) — reduces the selection to the active cell */
	previewSheetShortcutCollapseSelection: "Select only the active cell",
	/** Keyboard shortcut (spreadsheet) — moves the active cell to the selection's next corner */
	previewSheetShortcutNextCorner: "Move to the next corner of the selection",
	/** Keyboard shortcut (spreadsheet) — scrolls the active cell into view */
	previewSheetShortcutRevealActive: "Show the active cell",
	/** Keyboard shortcut (spreadsheet) — moves one screen to the right */
	previewSheetShortcutScreenRight: "One screen right",
	/** Keyboard shortcut (spreadsheet) — moves one screen to the left */
	previewSheetShortcutScreenLeft: "One screen left",
	/** Keyboard shortcut (spreadsheet) — shows the next sheet of the workbook */
	previewSheetShortcutNextSheet: "Next sheet",
	/** Keyboard shortcut (spreadsheet) — shows the previous sheet of the workbook */
	previewSheetShortcutPreviousSheet: "Previous sheet",
	/** Keyboard shortcut (spreadsheet) — makes the selection bold, or not */
	previewSheetShortcutBold: "Bold",
	/** Keyboard shortcut (spreadsheet) — makes the selection italic, or not */
	previewSheetShortcutItalic: "Italic",
	/** Keyboard shortcut (spreadsheet) — underlines the selection, or not */
	previewSheetShortcutUnderline: "Underline",
	/** Keyboard shortcut (spreadsheet) — strikes the selection through, or not */
	previewSheetShortcutStrikethrough: "Strikethrough",
	/** Keyboard shortcut (spreadsheet) — makes the selection's font one size larger */
	previewSheetShortcutFontGrow: "Increase font size",
	/** Keyboard shortcut (spreadsheet) — makes the selection's font one size smaller */
	previewSheetShortcutFontShrink: "Decrease font size",
	/** Keyboard shortcut (spreadsheet) — applies the General number format */
	previewSheetShortcutFormatGeneral: "General number format",
	/** Keyboard shortcut (spreadsheet) — applies the currency format of the user's region, with two decimals */
	previewSheetShortcutFormatCurrency: "Currency format",
	/** Keyboard shortcut (spreadsheet) — applies the percentage format without decimals */
	previewSheetShortcutFormatPercent: "Percentage format",
	/** Keyboard shortcut (spreadsheet) — applies the scientific format with two decimals */
	previewSheetShortcutFormatScientific: "Scientific format",
	/** Keyboard shortcut (spreadsheet) — applies a date format with day, month and year */
	previewSheetShortcutFormatDate: "Date format",
	/** Keyboard shortcut (spreadsheet) — applies a time format with hour and minute */
	previewSheetShortcutFormatTime: "Time format",
	/** Keyboard shortcut (spreadsheet) — applies the number format with two decimals and a thousands separator */
	previewSheetShortcutFormatNumber: "Number format",
	/** Keyboard shortcut (spreadsheet) — opens the Format Cells dialog */
	previewSheetShortcutFormatCells: "Format cells",
	/** Keyboard shortcut (spreadsheet) — puts a border around the selection */
	previewSheetShortcutBorderOutline: "Outline border",
	/** Keyboard shortcut (spreadsheet) — removes the selection's borders */
	previewSheetShortcutBorderNone: "Remove borders",
	/** Keyboard shortcut (spreadsheet) — wraps the text of the selection, or not */
	previewSheetShortcutWrap: "Wrap text",
	/** Keyboard shortcut (spreadsheet) — aligns the selection's contents to the left */
	previewSheetShortcutAlignLeft: "Align left",
	/** Keyboard shortcut (spreadsheet) — centres the selection's contents */
	previewSheetShortcutAlignCenter: "Align center",
	/** Keyboard shortcut (spreadsheet) — aligns the selection's contents to the right */
	previewSheetShortcutAlignRight: "Align right",
	/** Keyboard shortcut (spreadsheet) — moves the selection's contents one indent level back */
	previewSheetShortcutIndentDecrease: "Decrease indent",
	/** Keyboard shortcut (spreadsheet) — moves the selection's contents one indent level in */
	previewSheetShortcutIndentIncrease: "Increase indent",
	/** Keyboard shortcut (spreadsheet) — shows one more decimal place */
	previewSheetShortcutDecimalsIncrease: "Increase decimal",
	/** Keyboard shortcut (spreadsheet) — shows one decimal place less */
	previewSheetShortcutDecimalsDecrease: "Decrease decimal",
	/** Keyboard shortcut (spreadsheet) — merges the selected cells into one and centres its contents */
	previewSheetShortcutMergeCenter: "Merge and center",
	/** Keyboard shortcut (spreadsheet) — splits the merged cells of the selection */
	previewSheetShortcutUnmerge: "Unmerge cells",
	/** Keyboard shortcut (spreadsheet) — hides the selected rows */
	previewSheetShortcutHideRows: "Hide rows",
	/** Keyboard shortcut (spreadsheet) — hides the selected columns */
	previewSheetShortcutHideColumns: "Hide columns",
	/** Keyboard shortcut (spreadsheet) — shows the hidden rows within the selection */
	previewSheetShortcutUnhideRows: "Unhide rows",
	/** Keyboard shortcut (spreadsheet) — shows the hidden columns within the selection */
	previewSheetShortcutUnhideColumns: "Unhide columns",
	/** Keyboard shortcut (spreadsheet) — fits the selected rows' height to their contents */
	previewSheetShortcutAutofitRows: "AutoFit row height",
	/** Keyboard shortcut (spreadsheet) — fits the selected columns' width to their contents */
	previewSheetShortcutAutofitColumns: "AutoFit column width",
	/** Keyboard shortcut (spreadsheet) — selects the first picture or chart in view; Tab then moves through them */
	previewSheetShortcutSelectObject: "Select pictures and charts",
	/** Keyboard shortcut (spreadsheet) — moves focus to the next pane (ribbon, formula bar, sheet tabs, side panel) */
	previewSheetShortcutNextPane: "Next pane",
	/** Keyboard shortcut (spreadsheet) — moves focus to the previous pane */
	previewSheetShortcutPreviousPane: "Previous pane",
	/** Keyboard shortcut (spreadsheet) — opens the menu of the active cell */
	previewSheetShortcutContextMenu: "Open the cell menu",
	/** Keyboard shortcut (spreadsheet) — opens the find bar */
	previewSheetShortcutFind: "Find",
	/** Keyboard shortcut (spreadsheet) — goes to the next match of the find bar */
	previewSheetShortcutFindNext: "Find next",
	/** Keyboard shortcut (spreadsheet) — goes to the previous match of the find bar */
	previewSheetShortcutFindPrevious: "Find previous",
	/** Keyboard shortcut (spreadsheet) — opens the find bar with its replace field */
	previewSheetShortcutReplace: "Replace",
	/** Keyboard shortcut (spreadsheet) — focuses the name box to go to a cell or range */
	previewSheetShortcutGoTo: "Go to",
	/** Keyboard shortcut (spreadsheet) — saves the file as an Excel workbook beside it (text files and older formats) */
	previewSheetShortcutSaveAs: "Save as Excel workbook",
	/** Keyboard shortcut (spreadsheet) — downloads the sheet as a CSV file */
	previewSheetShortcutExportCsv: "Download as CSV",
	/** Keyboard shortcut (spreadsheet) — downloads the workbook as a PDF file */
	previewSheetShortcutExportPdf: "Download as PDF",
	/** Keyboard shortcut (spreadsheet) — zooms the sheet in */
	previewSheetShortcutZoomIn: "Zoom in",
	/** Keyboard shortcut (spreadsheet) — zooms the sheet out */
	previewSheetShortcutZoomOut: "Zoom out",
	/** Keyboard shortcut (spreadsheet) — shows the sheet at 100 % */
	previewSheetShortcutZoomReset: "Zoom to 100%",
	/** Keyboard shortcut (spreadsheet) — freezes the rows above and the columns left of the active cell, or unfreezes them */
	previewSheetShortcutFreezePanes: "Freeze or unfreeze panes",
	/** Keyboard shortcut (spreadsheet) — turns the filter of the selection's data on or off */
	previewSheetShortcutFilter: "Filter",
	/** Keyboard shortcut (spreadsheet) — applies the sheet's filters again to its current data */
	previewSheetShortcutReapplyFilter: "Reapply filter",
	/** Keyboard shortcut (spreadsheet) — clears the sheet's filter criteria, showing every row */
	previewSheetShortcutClearFilters: "Clear filters",
	/** Keyboard shortcut (spreadsheet) — sorts the data around the selection from A to Z */
	previewSheetShortcutSortAscending: "Sort A to Z",
	/** Keyboard shortcut (spreadsheet) — sorts the data around the selection from Z to A */
	previewSheetShortcutSortDescending: "Sort Z to A",
	/** Keyboard shortcut (spreadsheet) — opens the data validation dialog */
	previewSheetShortcutDataValidation: "Data validation",
	/** Keyboard shortcut (spreadsheet) — opens the active cell's drop-down (a filter's menu, a validation list) */
	previewSheetShortcutOpenDropdown: "Open the cell's drop-down",
	/** Keyboard shortcut (spreadsheet) — inserts or edits a link in the active cell */
	previewSheetShortcutHyperlink: "Insert link",
	/** Keyboard shortcut (spreadsheet) — adds or edits the active cell's note */
	previewSheetShortcutNote: "Insert or edit note",
	/** Keyboard shortcut (spreadsheet) — shows the active cell's note all the time, or only on hover */
	previewSheetShortcutToggleNote: "Show or hide note",
	/** Keyboard shortcut (spreadsheet) — deletes the active cell's note */
	previewSheetShortcutDeleteNote: "Delete note",
	/** Keyboard shortcut (spreadsheet) — starts a new comment thread on the active cell */
	previewSheetShortcutNewComment: "New comment",
	/** Keyboard shortcut (spreadsheet) — inserts a chart of the selected data */
	previewSheetShortcutInsertChart: "Insert chart",
	/** Keyboard shortcut (spreadsheet) — inserts a picture from this device */
	previewSheetShortcutInsertPicture: "Insert picture",
	/** Keyboard shortcut (spreadsheet) — edits the alternative text of the selected picture or chart */
	previewSheetShortcutAltText: "Edit alt text",
	/** Keyboard shortcut (spreadsheet) — inserts the AutoSum formula */
	previewSheetShortcutAutoSum: "AutoSum",
	/** Keyboard shortcut (spreadsheet) — inserts a new sheet before the active one */
	previewSheetShortcutNewSheet: "Insert sheet",
	/** Keyboard shortcut (spreadsheet) — renames the active sheet */
	previewSheetShortcutRenameSheet: "Rename sheet",
	/** Keyboard shortcut (spreadsheet) — deletes the active sheet */
	previewSheetShortcutDeleteSheet: "Delete sheet",
	/** Keyboard shortcut (spreadsheet) — adds a copy of the active sheet after it */
	previewSheetShortcutDuplicateSheet: "Duplicate sheet",
	/** Keyboard shortcut (spreadsheet) — moves the active sheet's tab one place to the left */
	previewSheetShortcutMoveSheetLeft: "Move sheet left",
	/** Keyboard shortcut (spreadsheet) — moves the active sheet's tab one place to the right */
	previewSheetShortcutMoveSheetRight: "Move sheet right",
	/** Keyboard shortcut (spreadsheet) — hides the active sheet's tab */
	previewSheetShortcutHideSheet: "Hide sheet",
	/** Keyboard shortcut (spreadsheet) — opens the dialog that picks a hidden sheet to show again */
	previewSheetShortcutUnhideSheet: "Unhide sheet",
	/** Keyboard shortcut (spreadsheet) — protects the active sheet, or unprotects it */
	previewSheetShortcutProtectSheet: "Protect or unprotect sheet"
}

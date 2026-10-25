// "preview" namespace, spreadsheet editor — its ribbon's own tabs, groups and controls (the shared ones are
// previewOffice/ribbon.ts). Spread into preview.ts; same catalog rules.
export const previewSheetRibbon = {
	/** Spreadsheet editor — ribbon tab: sorting, filtering and data validation */
	previewSheetRibbonTabData: "Data",
	/** Spreadsheet editor — contextual ribbon tab shown while a chart is selected */
	previewSheetRibbonTabChart: "Chart",
	/** Spreadsheet editor — contextual ribbon tab shown while a picture or shape is selected */
	previewSheetRibbonTabPicture: "Picture",
	/** Spreadsheet editor — ribbon group: number formats and decimal places */
	previewSheetRibbonNumber: "Number",
	/** Spreadsheet editor — ribbon group: inserting, deleting and formatting cells, rows, columns and sheets */
	previewSheetRibbonCells: "Cells",
	/** Spreadsheet editor — ribbon group on the Insert tab: inserting a chart */
	previewSheetRibbonCharts: "Charts",
	/** Spreadsheet editor — ribbon group on the Insert and Review tabs: notes */
	previewSheetRibbonNotes: "Notes",
	/** Spreadsheet editor — ribbon group on the Data tab: sorting and filtering */
	previewSheetRibbonSortFilter: "Sort and filter",
	/** Spreadsheet editor — ribbon group on the Data tab: data validation */
	previewSheetRibbonDataTools: "Data tools",
	/** Spreadsheet editor — ribbon group on the Review tab: protecting the sheet or the workbook */
	previewSheetRibbonProtect: "Protect",
	/** Spreadsheet editor — ribbon group on the View tab: freezing panes */
	previewSheetRibbonWindow: "Window",
	/** Spreadsheet editor — Paste dropdown: paste the clipboard's values without their formulas or formats */
	previewSheetRibbonPasteValues: "Paste values",
	/** Spreadsheet editor — Find dropdown item: open the find bar */
	previewSheetRibbonFind: "Find",
	/** Spreadsheet editor — Find dropdown item: open the find bar with its replace field */
	previewSheetRibbonReplace: "Replace",
	/** Spreadsheet editor — ribbon button: one indent level more */
	previewSheetRibbonIndentIncrease: "Increase indent",
	/** Spreadsheet editor — ribbon button: one indent level less */
	previewSheetRibbonIndentDecrease: "Decrease indent",
	/** Spreadsheet editor — ribbon dropdown: the angle of the text in the cells */
	previewSheetRibbonOrientation: "Orientation",
	/** Spreadsheet editor — Orientation item: text at 45 degrees counterclockwise */
	previewSheetRotationCounterclockwise: "Angle counterclockwise",
	/** Spreadsheet editor — Orientation item: text at 45 degrees clockwise */
	previewSheetRotationClockwise: "Angle clockwise",
	/** Spreadsheet editor — Orientation item: letters stacked top to bottom */
	previewSheetRotationVertical: "Vertical text",
	/** Spreadsheet editor — Orientation item: text turned 90 degrees up */
	previewSheetRotationUp: "Rotate text up",
	/** Spreadsheet editor — Orientation item: text turned 90 degrees down */
	previewSheetRotationDown: "Rotate text down",
	/** Spreadsheet editor — Orientation item: text made smaller to fit the cell's width */
	previewSheetRibbonShrinkToFit: "Shrink to fit",
	/** Spreadsheet editor — Cells group dropdown: insert cells, rows, columns or a sheet */
	previewSheetRibbonInsert: "Insert",
	/** Spreadsheet editor — Cells group dropdown: delete cells, rows, columns or the sheet */
	previewSheetRibbonDelete: "Delete",
	/** Spreadsheet editor — Cells group dropdown: row heights, column widths, hiding, and the sheet's name, colour and protection */
	previewSheetRibbonFormat: "Format",
	/** Spreadsheet editor — Insert dropdown item: the insert cells dialog */
	previewSheetRibbonInsertCells: "Insert cells…",
	/** Spreadsheet editor — Insert dropdown item: whole rows above the selection */
	previewSheetRibbonInsertRows: "Insert sheet rows",
	/** Spreadsheet editor — Insert dropdown item: whole columns left of the selection */
	previewSheetRibbonInsertColumns: "Insert sheet columns",
	/** Spreadsheet editor — Delete dropdown item: the delete cells dialog */
	previewSheetRibbonDeleteCells: "Delete cells…",
	/** Spreadsheet editor — Delete dropdown item: the selection's whole rows */
	previewSheetRibbonDeleteRows: "Delete sheet rows",
	/** Spreadsheet editor — Delete dropdown item: the selection's whole columns */
	previewSheetRibbonDeleteColumns: "Delete sheet columns",
	/** Spreadsheet editor — Delete dropdown item: the sheet on show (asks first) */
	previewSheetRibbonDeleteSheet: "Delete sheet",
	/** Spreadsheet editor — Format dropdown item: rows as tall as their content */
	previewSheetRibbonAutofitRows: "AutoFit row height",
	/** Spreadsheet editor — Format dropdown item: columns as wide as their content */
	previewSheetRibbonAutofitColumns: "AutoFit column width",
	/** Spreadsheet editor — Format dropdown submenu: hiding and showing rows and columns */
	previewSheetRibbonHideUnhide: "Hide and unhide",
	/** Spreadsheet editor — Format dropdown item: rename the sheet on show */
	previewSheetRibbonRenameSheet: "Rename sheet",
	/** Spreadsheet editor — Editing group dropdown: clear what the selected cells hold */
	previewSheetRibbonClear: "Clear",
	/** Spreadsheet editor — Clear dropdown item: contents, formats, comments and notes */
	previewSheetRibbonClearAll: "Clear all",
	/** Spreadsheet editor — Insert tab dropdown: pictures from this device or the drive */
	previewSheetRibbonPictures: "Pictures",
	/** Spreadsheet editor — Insert tab button: a link on the selected cells */
	previewSheetRibbonLink: "Link",
	/** Spreadsheet editor — Data tab button: the custom sort dialog */
	previewSheetRibbonCustomSort: "Sort…",
	/** Spreadsheet editor — Review tab button: delete the note of the active cell */
	previewSheetRibbonDeleteNote: "Delete note",
	/** Spreadsheet editor — View tab button: zoom out */
	previewSheetRibbonZoomOut: "Zoom out",
	/** Spreadsheet editor — View tab button: zoom in */
	previewSheetRibbonZoomIn: "Zoom in",
	/** Spreadsheet editor — View tab button and the ribbon's zoom level: back to 100% */
	previewSheetRibbonZoom100: "Zoom to 100%",
	/** Spreadsheet editor — the zoom level at the ribbon's end */
	previewSheetRibbonZoomLevel: "{{percent}}%",
	/** Spreadsheet editor — accessible name of the zoom level at the ribbon's end, which goes back to 100% */
	previewSheetRibbonZoomReset: "Zoom {{percent}}%, back to 100%",
	/** Spreadsheet editor — View tab toggle: cells show their formulas instead of their results */
	previewSheetRibbonShowFormulas: "Show formulas"
}

// English source catalog — "preview" namespace: the full-bleed drive file-preview overlay
// (features/preview/components/*) opened from a listing's handleOpen — header chrome (prev/next, download,
// close) and per-category viewer copy. Same typed-catalog rules as the other namespaces: flat `as
// const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces, keySeparator/
// nsSeparator both ON).
export const preview = {
	// ── Header ───────────────────────────────────────────────────────────────
	/** Preview overlay header — accessible label for the button stepping to the previous previewable sibling; disabled at the first item */
	previewPreviousAction: "Previous file",
	/** Preview overlay header — accessible label for the button stepping to the next previewable sibling; disabled at the last item */
	previewNextAction: "Next file",
	/** Preview overlay header — accessible label for the button downloading the open item; hidden in trash */
	previewDownloadAction: "Download",
	/** Preview overlay header — accessible label for the button saving the editable text/code buffer; shown only while editable and dirty, also the Cmd/Ctrl+S keymap command's description */
	previewSaveAction: "Save",
	/** Shortcuts list — opens the text editor's search (file editor and note editors) */
	previewEditorFind: "Find",
	/** Shortcuts list — opens the text editor's search with its replace field */
	previewEditorReplace: "Find and replace",
	/** Shortcuts list — wraps the selection in markdown bold (markdown editors only) */
	previewEditorBold: "Bold (markdown)",
	/** Shortcuts list — wraps the selection in markdown italics (markdown editors only) */
	previewEditorItalic: "Italic (markdown)",
	/** Shortcuts list — wraps the selection in markdown strikethrough (markdown editors only) */
	previewEditorStrikethrough: "Strikethrough (markdown)",
	/** Shortcuts list — wraps the selection in markdown inline code (markdown editors only) */
	previewEditorCode: "Inline code (markdown)",
	/** Shortcuts list — turns the selection into a markdown link (markdown editors only) */
	previewEditorLink: "Insert link (markdown)",
	/** Shortcuts list — switches a markdown file between its rendered and source views, or shows/hides a markdown note's preview pane */
	previewEditorTogglePreview: "Toggle markdown preview",

	// ── Body ─────────────────────────────────────────────────────────────────
	/** Preview overlay body — shown in place of a viewer for a previewable category with no renderer built yet */
	previewUnsupportedType: "Preview isn't available for this file type yet.",
	/** Preview overlay body — a streamed image/video/audio failed mid-playback and the file is too large to safely retry buffered */
	previewStreamFailed: "This preview failed and the file is too large to retry.",
	/** Preview overlay body — a HEIC/HEIF image could not be converted for preview (corrupt or unsupported file) */
	previewTransformFailed: "This image couldn't be converted for preview.",
	/** Preview overlay body — a camera RAW file (.cr2, .nef, .arw, .dng…) embeds no preview image large enough to show, and no thumbnail could be made for it either */
	previewRawNoPreview: "This RAW image has no embedded preview to show.",
	/** Preview overlay body — shown by the scoped error boundary when a viewer throws while rendering (e.g. a parse failure) */
	previewRenderError: "This preview couldn't be displayed.",

	// ── Editable save ────────────────────────────────────────────────────────
	/** Unsaved-changes confirm dialog — title, shown on Escape/close/prev/next while the editable buffer is dirty */
	previewUnsavedChangesTitle: "Unsaved changes",
	/** Unsaved-changes confirm dialog — body */
	previewUnsavedChangesBody: "You have unsaved changes to this file. Discard them?",
	/** Unsaved-changes confirm dialog — the destructive confirm button, discards the buffer and proceeds */
	previewDiscardAction: "Discard",
	/** Toast shown after a save fails because the file's own parent directory no longer exists — the editor locks read-only for the rest of this session (mobile parity: retrying against the same broken parent would only fail again); every other save failure keeps the editor open for a retry instead */
	/** Toast — the editor's content could not be read for saving (the spreadsheet could not be written out) */
	previewSaveFailed: "This file couldn't be saved.",
	previewReadOnlyAfterSaveFailure: "This file is now read-only — saving failed and can't be retried until you reopen it.",

	// ── Changes made elsewhere ───────────────────────────────────────────────
	/** Remote-change dialog — title, shown while the open file has unsaved edits and a newer version of it is saved from another device, another tab, or restored from its version history */
	previewRemoteChangedTitle: "This file changed elsewhere",
	/** Remote-change dialog — body; {{name}} is the file name */
	previewRemoteChangedBody:
		"A newer version of {{name}} was saved while you were editing it. What should happen to your unsaved changes?",
	/** Remote-change dialog — opens a side-by-side comparison of the newer version and the unsaved changes (text, code and markdown files only) */
	previewRemoteCompare: "Compare",
	/** Remote-change dialog — leaves the comparison, back to the plain prompt */
	previewRemoteCompareBack: "Back",
	/** Remote-change dialog — writes the unsaved changes to a new file next to this one, then shows the newer version */
	previewRemoteSaveCopy: "Save mine as copy",
	/** Remote-change dialog — keeps editing the unsaved changes; saving them then makes them the newest version */
	previewRemoteKeepMine: "Keep mine",
	/** Remote-change dialog — discards the unsaved changes and shows the newer version */
	previewRemoteLoadTheirs: "Load theirs",
	/** Remote-change comparison — heading over the newer version saved elsewhere (left side) */
	previewRemoteTheirs: "Their version",
	/** Remote-change comparison — heading over the unsaved changes (right side) */
	previewRemoteMine: "Your version",
	/** Remote-change comparison on a narrow screen, where both versions are interleaved in one column */
	previewRemoteUnifiedLegend: "Red lines are only in their version, green lines only in yours.",
	/** Remote-change comparison — the newer version could not be downloaded */
	previewRemoteCompareFailed: "Their version couldn't be loaded for comparison.",
	/** Remote-deletion dialog — title, shown while the open file has unsaved edits and it is trashed or deleted elsewhere */
	previewRemoteDeletedTitle: "This file was deleted elsewhere",
	/** Remote-deletion dialog — body; {{name}} is the file name */
	previewRemoteDeletedBody: "{{name}} was moved to the trash or deleted while you were editing it. Your changes are still here.",
	/** Remote-deletion dialog — discards the unsaved changes and closes the file */
	previewRemoteDiscardMine: "Discard my changes",
	/** Remote-deletion dialog — writes the unsaved changes to a new file in the same directory */
	previewRemoteSaveAsNew: "Save as new file",
	/** Remote-change dialog, when the open viewer is read-only (the file was renamed to another type, or can't be saved): why no save is offered */
	previewRemoteSaveUnavailable: "Your changes can't be saved from this preview. Keep them on screen to copy them, or discard them.",
	/** Remote-deletion dialog, when the changes can't be saved: closes the dialog and leaves the changes on screen */
	previewRemoteKeepOpen: "Keep on screen",
	/** Name of the file the unsaved changes are written to when the original moved on; {{base}} is the original name without its extension, {{ext}} the extension with its dot (may be empty), {{date}} the current date and time */
	previewConflictCopyName: "{{base}} (conflicted copy {{date}}){{ext}}",
	/** Toast after the unsaved changes were written to a new file; {{name}} is its name */
	previewSavedAsNewFile: "Saved your changes as {{name}}.",
	/** Toast when writing the unsaved changes to a new file failed */
	previewSaveAsNewFileFailed: "Your changes couldn't be saved as a new file.",
	/** Toast when the open file, with no unsaved edits, was replaced by a newer version saved elsewhere and now shows it */
	previewUpdatedElsewhere: "Updated with changes saved elsewhere.",
	/** Toast when the open file, with unsaved edits, was moved to another directory elsewhere */
	previewMovedElsewhere: "This file was moved to another directory. Your changes will be saved there.",
	/** Toast when a save from this editor landed right after a version saved elsewhere, which it replaced */
	previewSaveReplacedNewer:
		"Your save replaced changes saved elsewhere moments before. With file versioning on, they're in the file's version history.",

	// ── Spreadsheet ──────────────────────────────────────────────────────────
	/** Spreadsheet viewer — a workbook with no sheet to show */
	previewSpreadsheetEmpty: "This spreadsheet has no sheets.",
	/** Spreadsheet viewer — the file could not be read as a spreadsheet (damaged, encrypted with a password, or too large to open) */
	previewSpreadsheetUnreadable: "This spreadsheet couldn't be opened. It may be damaged, password-protected or too large.",
	/** Spreadsheet viewer — accessible label for the box showing the selected cell or range, e.g. "B2:D7" */
	previewSpreadsheetSelectedCells: "Selected cells",
	/** Spreadsheet viewer — accessible label for the bar showing the active cell's contents or formula */
	previewSpreadsheetCellContents: "Cell contents",
	/** Spreadsheet viewer — accessible label for the row of sheet tabs */
	previewSpreadsheetSheets: "Sheets",
	/** Spreadsheet viewer — toast when the selection is too large to copy */
	previewSpreadsheetCopyTooLarge: "That selection is too large to copy.",
	/** Spreadsheet toolbar — undo the last edit (also Cmd/Ctrl+Z in the grid) */
	previewSpreadsheetUndo: "Undo",
	/** Spreadsheet toolbar — redo the last undone edit (also Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y) */
	previewSpreadsheetRedo: "Redo",
	/** Spreadsheet toolbar — toggle bold on the selected cells */
	previewSpreadsheetBold: "Bold",
	/** Spreadsheet toolbar — toggle italic on the selected cells */
	previewSpreadsheetItalic: "Italic",
	/** Spreadsheet toolbar — toggle underline on the selected cells */
	previewSpreadsheetUnderline: "Underline",
	/** Spreadsheet toolbar — toggle strikethrough on the selected cells */
	previewSpreadsheetStrikethrough: "Strikethrough",
	/** Spreadsheet toolbar — opens the palette for the selected cells' text colour */
	previewSpreadsheetTextColor: "Text colour",
	/** Spreadsheet toolbar — opens the palette for the selected cells' fill (background) colour */
	previewSpreadsheetFillColor: "Fill colour",
	/** Spreadsheet toolbar colour palette — removes the colour */
	previewSpreadsheetColorNone: "No colour",
	/** Spreadsheet toolbar — align the selected cells' content left */
	previewSpreadsheetAlignLeft: "Align left",
	/** Spreadsheet toolbar — centre the selected cells' content */
	previewSpreadsheetAlignCenter: "Centre",
	/** Spreadsheet toolbar — align the selected cells' content right */
	previewSpreadsheetAlignRight: "Align right",
	/** Spreadsheet toolbar — accessible label of the number format menu */
	previewSpreadsheetNumberFormat: "Number format",
	/** Number format menu — no particular format */
	previewSpreadsheetFormatGeneral: "General",
	/** Number format menu — 1,234.56 */
	previewSpreadsheetFormatNumber: "Number",
	/** Number format menu — $1,234.56 */
	previewSpreadsheetFormatDollar: "Currency ($)",
	/** Number format menu — 1,234.56 € */
	previewSpreadsheetFormatEuro: "Currency (€)",
	/** Number format menu — 12.34% */
	previewSpreadsheetFormatPercent: "Percent",
	/** Number format menu — 2026-09-27 */
	previewSpreadsheetFormatDate: "Date",
	/** Number format menu — the value kept as text */
	previewSpreadsheetFormatText: "Text",
	/** Number format menu — the cell carries a format not in this list */
	previewSpreadsheetFormatCustom: "Custom",
	/** Spreadsheet grid menu — insert as many rows as are selected, above them */
	previewSpreadsheetInsertRowsAbove_one: "Insert row above",
	previewSpreadsheetInsertRowsAbove_other: "Insert {{count}} rows above",
	/** Spreadsheet grid menu — insert as many rows as are selected, below them */
	previewSpreadsheetInsertRowsBelow_one: "Insert row below",
	previewSpreadsheetInsertRowsBelow_other: "Insert {{count}} rows below",
	/** Spreadsheet grid menu — delete the selected rows */
	previewSpreadsheetDeleteRows_one: "Delete row",
	previewSpreadsheetDeleteRows_other: "Delete {{count}} rows",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their left */
	previewSpreadsheetInsertColumnsLeft_one: "Insert column left",
	previewSpreadsheetInsertColumnsLeft_other: "Insert {{count}} columns left",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their right */
	previewSpreadsheetInsertColumnsRight_one: "Insert column right",
	previewSpreadsheetInsertColumnsRight_other: "Insert {{count}} columns right",
	/** Spreadsheet grid menu — delete the selected columns */
	previewSpreadsheetDeleteColumns_one: "Delete column",
	previewSpreadsheetDeleteColumns_other: "Delete {{count}} columns",
	/** Spreadsheet grid menu — empty the selected cells (formats stay) */
	previewSpreadsheetClearCells: "Clear contents",
	/** Spreadsheet grid — the size tip shown while dragging a column's edge */
	previewSpreadsheetWidthPx: "Width: {{size}} px",
	/** Spreadsheet grid — the size tip shown while dragging a row's edge */
	previewSpreadsheetHeightPx: "Height: {{size}} px",
	/** Spreadsheet grid — tooltip of a column header's resize edge */
	previewSpreadsheetResizeColumn: "Resize column",
	/** Spreadsheet grid — tooltip of a row header's resize edge */
	previewSpreadsheetResizeRow: "Resize row",
	/** Spreadsheet sheet tabs — adds a new empty sheet */
	previewSpreadsheetAddSheet: "Add sheet",
	/** Name given to a newly added sheet; {{number}} is its position */
	previewSpreadsheetNewSheetName: "Sheet {{number}}",
	/** Rename-sheet dialog — title and submit button */
	previewSpreadsheetRenameSheet: "Rename sheet",
	/** Rename-sheet dialog — body */
	previewSpreadsheetRenameSheetBody: "Formulas that refer to this sheet are updated to the new name.",
	/** Rename-sheet dialog — field label */
	previewSpreadsheetSheetName: "Sheet name",
	/** Toast — rows or columns can't be inserted or deleted, or a sheet renamed, in this workbook */
	previewSpreadsheetStructureLocked:
		"This can't be changed here: the workbook has charts, tables, conditional formats, validations or named ranges that depend on its rows, columns and sheet names.",
	/** Toast — a sheet name is taken or has characters Excel doesn't allow (\ / ? * [ ] :, at most 31 characters) */
	previewSpreadsheetSheetNameInvalid: "That sheet name is already used or isn't allowed.",
	/** Toast — an edit covers only part of an array formula's range */
	previewSpreadsheetArrayFormula: "Part of an array formula can't be changed. Select its whole range to replace it.",
	/** Toast — the file keeps a legacy text encoding that can't hold a character in the edit */
	previewSpreadsheetEncodingUnsupported:
		"This file uses an older text encoding that can't hold one of those characters, so the change wasn't made.",
	/** Toast — an edit would change the text of a table's header cell */
	previewSpreadsheetTableHeader: "A table's header can't be renamed here: formulas that refer to the column by name would break.",
	/** Toast — an edit reaches past what can be changed at once, or past a sheet's size */
	previewSpreadsheetTooLarge: "That's more than can be changed at once.",
	/** Toast — an edit failed unexpectedly */
	previewSpreadsheetEditFailed: "That change couldn't be made.",
	/** Spreadsheet viewer — note beside the cell contents when an editable file opens read-only because it holds parts (e.g. chart sheets) a save could damage */
	previewSpreadsheetReadOnlyUnsafe: "Read-only here: this file has parts that can't be saved safely.",
	/** Spreadsheet viewer — note beside the cell contents when a file opens read-only because its name has no spreadsheet extension */
	previewSpreadsheetReadOnlyUnnamed: "Read-only here: the file name doesn't say which spreadsheet format it is.",
	/** Spreadsheet viewer — note beside the cell contents when an open file was renamed to another format's extension, so saving it under that name would mislabel it */
	previewSpreadsheetReadOnlyRenamed: "Read-only here: the file name no longer matches its format.",
	/** Spreadsheet viewer — status beside the cell contents while an Excel file opens view-only until it is confirmed that saving it keeps everything in it */
	previewSpreadsheetCheckingWritable: "Checking this file can be saved…",
	/** Spreadsheet viewer — note beside the cell contents when an Excel file stays read-only because saving it here would lose some of its content */
	previewSpreadsheetReadOnlyLossy: "Read-only here: this file has content this app can't save without losing it.",
	/** Spreadsheet grid — below a sheet too tall to show whole; {{rows}} is the number of rows shown, already formatted */
	previewSpreadsheetRowsTruncated: "Showing the first {{rows}} rows. Rows further down can't be shown here.",

	// ── PDF ──────────────────────────────────────────────────────────────────
	/** PDF viewer — password dialog title, shown both on the first prompt and on a wrong-password retry */
	previewPdfPasswordTitle: "Password required",
	/** PDF viewer — password dialog body on the first prompt, before any attempt */
	previewPdfPasswordBody: "This PDF is password-protected. Enter the password to view it.",
	/** PDF viewer — password dialog body after a submitted password was rejected */
	previewPdfPasswordRetryBody: "That password was incorrect. Try again.",
	/** PDF viewer — password dialog field label */
	previewPdfPasswordLabel: "Password",
	/** PDF viewer — password dialog submit button */
	previewPdfPasswordSubmit: "Unlock",
	/** PDF viewer — button shown after the password prompt is dismissed, reopens it */
	previewPdfPasswordReopen: "Enter password",
	/** PDF viewer — shown in place of the document when it fails to load or render (corrupt file, decode error) */
	previewPdfLoadFailed: "This PDF couldn't be rendered.",
	/** PDF viewer — accessible label for the page-nav button stepping to the previous page; distinct from the overlay's own file-level previous/next */
	previewPdfPreviousPageAction: "Previous page",
	/** PDF viewer — accessible label for the page-nav button stepping to the next page */
	previewPdfNextPageAction: "Next page",
	/** PDF viewer — page-nav indicator and per-page canvas label; {{current}} = the page in view, {{total}} = page count */
	previewPdfPageIndicator: "Page {{current}} of {{total}}",
	/** PDF viewer — accessible label for the toolbar button stepping the zoom level down */
	previewPdfZoomOutAction: "Zoom out",
	/** PDF viewer — accessible label for the toolbar button stepping the zoom level up */
	previewPdfZoomInAction: "Zoom in",
	/** PDF viewer — zoom-level indicator between the zoom out/in buttons; {{percent}} = current zoom relative to the document's own default render scale */
	previewPdfZoomIndicator: "{{percent}}%",

	// ── Docx ─────────────────────────────────────────────────────────────────
	/** Docx viewer — shown in place of the document when it fails to load or render */
	previewDocxLoadFailed: "This document couldn't be rendered.",

	// ── Markdown ─────────────────────────────────────────────────────────────
	/** Markdown viewer — toolbar button shown while viewing the rendered output; switches to the raw-text source view */
	previewMarkdownViewSourceAction: "View source",
	/** Markdown viewer — toolbar button shown while viewing the raw-text source; switches back to the rendered output */
	previewMarkdownViewRenderedAction: "View rendered",
	/** Markdown viewer — native tooltip on the disabled rendered/source toggle: switching views unmounts the editor buffer, so the toggle is locked until the edit is saved or discarded */
	previewMarkdownToggleDirtyHint: "Save or discard your changes before switching views."
} as const

// English source catalog — "preview" namespace: the full-bleed drive file-preview overlay
// (features/preview/components/*) opened from a listing's handleOpen — header chrome (prev/next, download,
// close) and per-category viewer copy. Same typed-catalog rules as the other namespaces: flat `as
// const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces, keySeparator/
// nsSeparator both ON).
import { previewDocxEditor } from "@/locales/en/previewDocx/editor"
import { previewDocxReview } from "@/locales/en/previewDocx/review"
import { previewDocxInsert } from "@/locales/en/previewDocx/insert"
import { previewDocxTable } from "@/locales/en/previewDocx/table"
import { previewDocxFormat } from "@/locales/en/previewDocx/format"
import { previewDocxForms } from "@/locales/en/previewDocx/forms"
import { previewDocxFields } from "@/locales/en/previewDocx/fields"
import { previewDocxLegacy } from "@/locales/en/previewDocx/legacy"
import { previewDocxLegacyPassword } from "@/locales/en/previewDocx/legacyPassword"
import { previewDocxPdf } from "@/locales/en/previewDocx/pdf"
import { previewDocxSections } from "@/locales/en/previewDocx/sections"
import { previewDocxMath } from "@/locales/en/previewDocx/math"
import { previewDocxReflow } from "@/locales/en/previewDocx/reflow"
import { previewDocxRibbon } from "@/locales/en/previewDocx/ribbon"
import { previewOfficeShared } from "@/locales/en/previewOffice/shared"
import { previewOfficeRibbon } from "@/locales/en/previewOffice/ribbon"
import { previewCommandBar } from "@/locales/en/previewOffice/commandBar"
import { previewSheetViewer } from "@/locales/en/previewSheet/viewer"
import { previewPptxViewer } from "@/locales/en/previewPptx/viewer"
import { previewPptxLegacy } from "@/locales/en/previewPptx/legacy"
import { previewPptxRibbon } from "@/locales/en/previewPptx/ribbon"
import { previewPptxEditor } from "@/locales/en/previewPptx/editor"
import { previewPptxArrange } from "@/locales/en/previewPptx/arrange"
import { previewPptxText } from "@/locales/en/previewPptx/text"
import { previewPptxFind } from "@/locales/en/previewPptx/find"
import { previewPptxObjects } from "@/locales/en/previewPptx/objects"
import { previewPptxMedia } from "@/locales/en/previewPptx/media"
import { previewPptxMediaTiming } from "@/locales/en/previewPptx/mediaTiming"
import { previewPptxShow } from "@/locales/en/previewPptx/show"
import { previewPptxExport } from "@/locales/en/previewPptx/export"
import { previewImageEditor } from "@/locales/en/previewImage/editor"
import { previewImageSave } from "@/locales/en/previewImage/save"
import { previewImageView } from "@/locales/en/previewImage/view"
import { previewSlideshowBar } from "@/locales/en/previewSlideshow/bar"
import { previewRichShell } from "@/locales/en/previewRich/shell"
import { previewRichFont } from "@/locales/en/previewRich/font"
import { previewRichSqlite } from "@/locales/en/previewRich/sqlite"
import { previewRichGeo } from "@/locales/en/previewRich/geo"
import { previewRichModel3d } from "@/locales/en/previewRich/model3d"
import { previewRichCad } from "@/locales/en/previewRich/cad"
import { previewRichDicom } from "@/locales/en/previewRich/dicom"
import { previewTextMetadata } from "@/locales/en/previewText/metadata"
import { previewEbookReader } from "@/locales/en/previewEbook/reader"
import { previewTextEncoding } from "@/locales/en/previewText/encoding"
import { previewTextMarkdown } from "@/locales/en/previewText/markdown"
import { previewTextHtml } from "@/locales/en/previewText/html"
import { previewTextTorrent } from "@/locales/en/previewText/torrent"
import { previewTextSubtitles } from "@/locales/en/previewText/subtitles"
import { previewTextCalendar } from "@/locales/en/previewText/calendar"
import { previewTextContacts } from "@/locales/en/previewText/contacts"
import { previewTextBinary } from "@/locales/en/previewText/binary"
import { previewTextEmail } from "@/locales/en/previewText/email"
import { previewTextNotebook } from "@/locales/en/previewText/notebook"
import { previewTextMermaid } from "@/locales/en/previewText/mermaid"
import { previewTextMailbox } from "@/locales/en/previewText/mailbox"
import { previewTextLargeText } from "@/locales/en/previewText/largeText"
import { previewTextCodeEditor } from "@/locales/en/previewText/codeEditor"
import { previewVideoEditKeys } from "@/locales/en/previewVideoEdit/keys"
import { previewVideoEditor } from "@/locales/en/previewVideoEdit/editor"
import { previewVideoSave } from "@/locales/en/previewVideoEdit/save"
import { previewPptxPresenter } from "@/locales/en/previewPptx/presenter"
import { previewPptxInk } from "@/locales/en/previewPptx/ink"
import { previewPptxSmartArt } from "@/locales/en/previewPptx/smartart"
import { previewPptxGalleryA } from "@/locales/en/previewPptx/galleryA"
import { previewPptxGalleryB } from "@/locales/en/previewPptx/galleryB"
import { previewPptxTransitions } from "@/locales/en/previewPptx/transitions"
import { previewPptxAnimations } from "@/locales/en/previewPptx/animations"
import { previewPptxMotionPaths } from "@/locales/en/previewPptx/motionPaths"
import { previewPptxReview } from "@/locales/en/previewPptx/review"
import { previewPptxConvert } from "@/locales/en/previewPptx/convert"
import { previewPptxDesign } from "@/locales/en/previewPptx/design"
import { previewPptxCharts } from "@/locales/en/previewPptx/charts"
import { previewSheetFormat } from "@/locales/en/previewSheet/format"
import { previewSheetSave } from "@/locales/en/previewSheet/save"
import { previewSheetStructure } from "@/locales/en/previewSheet/structure"
import { previewSheetKeys } from "@/locales/en/previewSheet/keys"
import { previewSheetShift } from "@/locales/en/previewSheet/shift"
import { previewSheetConditional } from "@/locales/en/previewSheet/conditional"
import { previewSheetNotes } from "@/locales/en/previewSheet/notes"
import { previewSheetClipboard } from "@/locales/en/previewSheet/clipboard"
import { previewSheetSortFilter } from "@/locales/en/previewSheet/sortFilter"
import { previewSheetFormula } from "@/locales/en/previewSheet/formula"
import { previewSheetTouch } from "@/locales/en/previewSheet/touch"
import { previewSheetPrint } from "@/locales/en/previewSheet/print"
import { previewSheetFormats } from "@/locales/en/previewSheet/formats"
import { previewSheetObjects } from "@/locales/en/previewSheet/objects"
import { previewSheetCharts } from "@/locales/en/previewSheet/charts"
import { previewSheetRibbon } from "@/locales/en/previewSheet/ribbon"
import { previewKeysShortcuts } from "@/locales/en/previewKeys/shortcuts"
import { previewSheetShortcuts } from "@/locales/en/previewSheet/shortcuts"
// PDF viewer and editor: one area file per feature, each spread below.
import { previewPdfView } from "@/locales/en/previewPdf/view"
import { previewPdfPrint } from "@/locales/en/previewPdf/print"
import { previewPdfSignatures } from "@/locales/en/previewPdf/signatures"
import { previewPdfAnnotations } from "@/locales/en/previewPdf/annotations"
import { previewPdfSecurity } from "@/locales/en/previewPdf/security"
import { previewPdfComments } from "@/locales/en/previewPdf/comments"
import { previewPdfForms } from "@/locales/en/previewPdf/forms"
import { previewPdfFillSign } from "@/locales/en/previewPdf/fillSign"
import { previewPdfTextEdit } from "@/locales/en/previewPdf/textEdit"
import { previewPdfSigning } from "@/locales/en/previewPdf/signing"
import { previewPdfOcr } from "@/locales/en/previewPdf/ocr"
import { previewPdfRedaction } from "@/locales/en/previewPdf/redaction"
import { previewPdfShell } from "@/locales/en/previewPdf/shell"
import { previewPdfNotices } from "@/locales/en/previewPdf/notices"
import { previewPdfPages } from "@/locales/en/previewPdf/pages"

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
	/** Shortcuts list — opens the search of the text editors (file editor and note editors) and the find field of the Word document viewer */
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
	/** Shortcuts list — switches a markdown document between its rendered (Read) view and its editing view */
	previewEditorTogglePreview: "Toggle markdown preview",
	/** Shortcuts list — switches a markdown document's editing view between live preview and source */
	previewEditorToggleLivePreview: "Toggle markdown live preview",

	// ── Body ─────────────────────────────────────────────────────────────────
	/** Preview overlay body — shown in place of a viewer for a previewable category with no renderer built yet */
	previewUnsupportedType: "Preview isn't available for this file type yet.",
	/** Preview overlay body — a file opened as text (by its type, or through "Open as text") turned out to be binary, so it is not shown unless the user asks */
	previewNotText: "This file isn't text.",
	/** Preview overlay button — beside "This file isn't text.": shows the file's bytes as text anyway, without editing */
	previewShowAnyway: "Show anyway (read-only)",
	/** Preview overlay body — a streamed image/video/audio failed mid-playback and the file is too large to safely retry buffered */
	previewStreamFailed: "This preview failed and the file is too large to retry.",
	/** Preview overlay body — a large image this browser cannot stream right now (no inline type it may be served as, or the page has no service worker yet), and too large to load whole */
	previewTooLargeToShowHere: "This file is too large to show here.",
	/** Preview overlay body — a HEIC/HEIF image could not be converted for preview (corrupt or unsupported file) */
	previewTransformFailed: "This image couldn't be converted for preview.",
	/** Preview overlay body — the browser could not decode an image it received whole (a HEIC this browser normally shows by itself), and the file is too large to convert here instead */
	previewImageNotDisplayable: "This image can't be displayed in this browser.",
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
	/** Toast — the editor's content could not be read for saving (the spreadsheet could not be written out) */
	previewSaveFailed: "This file couldn't be saved.",
	/** Toast shown after a save fails because the file's own parent directory no longer exists — the editor locks read-only for the rest of this session (mobile parity: retrying against the same broken parent would only fail again); every other save failure keeps the editor open for a retry instead */
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
	/** Spreadsheet toolbar — opens the palette for the selected cells' text color */
	previewSpreadsheetTextColor: "Text color",
	/** Spreadsheet toolbar — opens the palette for the selected cells' fill (background) color */
	previewSpreadsheetFillColor: "Fill color",
	/** Spreadsheet toolbar color palette — removes the color */
	previewSpreadsheetColorNone: "No color",
	/** Spreadsheet toolbar — accessible label of the number format menu */
	previewSpreadsheetNumberFormat: "Number format",
	/** Spreadsheet grid menu — insert as many rows as are selected, above them */
	previewSpreadsheetInsertRowsAboveSingle: "Insert row above",
	/** Spreadsheet grid menu — insert as many rows as are selected, above them */
	previewSpreadsheetInsertRowsAbove_one: "Insert {{count}} row above",
	/** Spreadsheet grid menu — insert as many rows as are selected, above them */
	previewSpreadsheetInsertRowsAbove_other: "Insert {{count}} rows above",
	/** Spreadsheet grid menu — insert as many rows as are selected, below them */
	previewSpreadsheetInsertRowsBelowSingle: "Insert row below",
	/** Spreadsheet grid menu — insert as many rows as are selected, below them */
	previewSpreadsheetInsertRowsBelow_one: "Insert {{count}} row below",
	/** Spreadsheet grid menu — insert as many rows as are selected, below them */
	previewSpreadsheetInsertRowsBelow_other: "Insert {{count}} rows below",
	/** Spreadsheet grid menu — delete the selected rows */
	previewSpreadsheetDeleteRowsSingle: "Delete row",
	/** Spreadsheet grid menu — delete the selected rows */
	previewSpreadsheetDeleteRows_one: "Delete {{count}} row",
	/** Spreadsheet grid menu — delete the selected rows */
	previewSpreadsheetDeleteRows_other: "Delete {{count}} rows",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their left */
	previewSpreadsheetInsertColumnsLeftSingle: "Insert column left",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their left */
	previewSpreadsheetInsertColumnsLeft_one: "Insert {{count}} column left",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their left */
	previewSpreadsheetInsertColumnsLeft_other: "Insert {{count}} columns left",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their right */
	previewSpreadsheetInsertColumnsRightSingle: "Insert column right",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their right */
	previewSpreadsheetInsertColumnsRight_one: "Insert {{count}} column right",
	/** Spreadsheet grid menu — insert as many columns as are selected, to their right */
	previewSpreadsheetInsertColumnsRight_other: "Insert {{count}} columns right",
	/** Spreadsheet grid menu — delete the selected columns */
	previewSpreadsheetDeleteColumnsSingle: "Delete column",
	/** Spreadsheet grid menu — delete the selected columns */
	previewSpreadsheetDeleteColumns_one: "Delete {{count}} column",
	/** Spreadsheet grid menu — delete the selected columns */
	previewSpreadsheetDeleteColumns_other: "Delete {{count}} columns",
	/** Spreadsheet grid menu — empty the selected cells (formats stay) */
	previewSpreadsheetClearCells: "Clear contents",
	/** Spreadsheet grid menu — give the selected columns back their default (or file's own) width */
	previewSpreadsheetResetColumnWidthSingle: "Reset column width",
	/** Spreadsheet grid menu — give the selected columns back their default (or file's own) width */
	previewSpreadsheetResetColumnWidth_one: "Reset {{count}} column width",
	/** Spreadsheet grid menu — give the selected columns back their default (or file's own) width */
	previewSpreadsheetResetColumnWidth_other: "Reset {{count}} column widths",
	/** Spreadsheet grid menu — give the selected rows back their default (or file's own) height */
	previewSpreadsheetResetRowHeightSingle: "Reset row height",
	/** Spreadsheet grid menu — give the selected rows back their default (or file's own) height */
	previewSpreadsheetResetRowHeight_one: "Reset {{count}} row height",
	/** Spreadsheet grid menu — give the selected rows back their default (or file's own) height */
	previewSpreadsheetResetRowHeight_other: "Reset {{count}} row heights",
	/** Spreadsheet viewer note — a legacy .xls opens read-only */
	previewSpreadsheetReadOnlyXls: "Old .xls format — view only.",
	/** Spreadsheet viewer note — an OpenDocument spreadsheet (.ods, .ots) opens read-only */
	previewSheetReadOnlyOds: "OpenDocument spreadsheet — view only.",
	/** Spreadsheet viewer — converts a read-only .xls into an editable .xlsx copy beside it */
	previewSpreadsheetSaveAsXlsx: "Save as .xlsx",
	/** Spreadsheet viewer — confirm dialog title before converting an .xls */
	previewSpreadsheetSaveAsXlsxTitle: "Save as .xlsx?",
	/** Spreadsheet viewer — confirm dialog body: what the .xls to .xlsx conversion keeps and loses */
	previewSpreadsheetSaveAsXlsxBody:
		"An editable .xlsx copy is saved in the same directory, and the .xls stays as it is. Only the values come along: formulas become their results, and formatting, column widths, row heights and named ranges are not kept.",
	/** Spreadsheet viewer — toast once the .xlsx copy is saved */
	previewSpreadsheetSavedAsXlsx: "Saved as {{name}}",
	/** Spreadsheet viewer — toast when the .xls could not be converted */
	previewSpreadsheetSaveAsXlsxFailed: "This file could not be saved as .xlsx",
	/** Spreadsheet grid — the size tip shown while dragging a column's edge */
	previewSpreadsheetWidthPx: "Width: {{size}} px",
	/** Spreadsheet grid — the size tip shown while dragging a row's edge */
	previewSpreadsheetHeightPx: "Height: {{size}} px",
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
	/** Toast — inserting dragged cells here would shift only part of the selection */
	previewSheetMoveSplit: "These cells can't be inserted here: it would move only part of the selection.",
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
	/** Spreadsheet viewer — note beside the cell contents when an Excel file opens read-only because it is too large to check that saving it keeps everything in it */
	previewSpreadsheetReadOnlyTooLarge: "Read-only here: this file is too large to edit.",
	/** Spreadsheet viewer — shown beside the formula bar (and as a toast for a paste) when an entry starts with "=" but isn't a formula Excel can read, e.g. a parenthesis left open or ";" between arguments */
	previewSpreadsheetFormulaInvalid: "This formula can't be read. Check its parentheses and quotes, and separate arguments with commas.",

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
	/** Document viewers (PDF, Word) — accessible label for the command bar button stepping to the previous page; distinct from the overlay's own file-level previous/next */
	previewPdfPreviousPageAction: "Previous page",
	/** Document viewers (PDF, Word) — accessible label for the command bar button stepping to the next page */
	previewPdfNextPageAction: "Next page",
	/** PDF viewer — page-nav indicator and per-page canvas label; {{current}} = the page in view, {{total}} = page count */
	previewPdfPageIndicator: "Page {{current}} of {{total}}",
	/** Document viewers (PDF, Word) — accessible label for the command bar button stepping the zoom level down */
	previewPdfZoomOutAction: "Zoom out",
	/** Document viewers (PDF, Word) — accessible label for the command bar button stepping the zoom level up */
	previewPdfZoomInAction: "Zoom in",
	/** Document viewers — a zoom level ({{percent}}): the zoom menu button, its steps and the status */
	previewPdfZoomIndicator: "{{percent}}%",
	/** Shortcuts list — the PDF viewer's zoom in key */
	previewPdfKeyZoomIn: "Zoom in (PDF)",
	/** Shortcuts list — the PDF viewer's zoom out key */
	previewPdfKeyZoomOut: "Zoom out (PDF)",
	/** Shortcuts list — the PDF viewer's key back to 100 % zoom */
	previewPdfKeyZoomReset: "Reset zoom to 100% (PDF)",
	/** Shortcuts list — the PDF viewer's key switching between fit to width and fit to page */
	previewPdfKeyToggleFit: "Switch between fit to width and fit to page (PDF)",
	/** Shortcuts list — the PDF viewer's key rotating the pages 90° clockwise */
	previewPdfKeyRotateCw: "Rotate clockwise (PDF)",
	/** Shortcuts list — the PDF viewer's key rotating the pages 90° counterclockwise */
	previewPdfKeyRotateCcw: "Rotate counterclockwise (PDF)",

	// ── Docx ─────────────────────────────────────────────────────────────────
	/** Docx viewer — shown in place of the document when it fails to load or render */
	previewDocxLoadFailed: "This document couldn't be rendered.",
	/** Docx viewer — in place of a password-protected Word document, behind its password prompt (and when the prompt was dismissed) */
	previewDocxNeedsPassword: "This document is password-protected.",
	/** Docx viewer — reopens a dismissed password prompt */
	previewDocxEnterPassword: "Enter password",
	/** Docx password prompt — title */
	previewDocxPasswordTitle: "Password-protected document",
	/** Docx password prompt — body; {{name}} is the document's name */
	previewDocxPasswordBody: "Enter the password to open “{{name}}”.",
	/** Docx password prompt — the field's label */
	previewDocxPasswordLabel: "Password",
	/** Docx password prompt — submit button */
	previewDocxPasswordSubmit: "Open",
	/** Docx password prompt — the submit button and a status while the password is checked (a few seconds on slower browsers); Cancel stops it */
	previewDocxPasswordUnlocking: "Unlocking…",
	/** Docx password prompt — under the field after a wrong password; the field is cleared for another try */
	previewDocxPasswordWrong: "That password isn't right. Try again.",
	/** Docx viewer — in place of a document protected with rights management (IRM, a sensitivity label), which is never asked a password */
	previewDocxRightsManaged: "This document is protected with rights management (IRM) and can't be opened in Filen.",
	/** Docx viewer — in place of a document encrypted with a scheme Filen doesn't implement (certificate-only, non-AES, extensible) */
	previewDocxUnsupportedEncryption: "This document uses an encryption method Filen can't open.",
	/** Docx viewer — in place of an encrypted document whose container is malformed or failed its integrity check */
	previewDocxDamagedEncryption: "This document is damaged or was modified after it was encrypted.",
	/** Docx viewer and editor — toolbar badge (and its popover's title) for a document opened with its password */
	previewDocxPasswordProtected: "Password-protected",
	/** Docx viewer — the Password-protected badge's popover: the document was decrypted with its password in this browser, in memory only */
	previewDocxPasswordOpened: "Opened with its password, on this device only.",
	/** Docx editor and spreadsheet editor — the Password-protected badge's popover: every save (explicit or autosave) is encrypted again with the password the file was opened with. In preview.ts, not previewDocx/*: the spreadsheet editor shows it too */
	previewDocxPasswordSaved: "Saved with the same password.",
	/** Docx viewer and editor, spreadsheet — the Password-protected badge's warning (popover and screen-reader description) for a file whose encryption carries no integrity check (Standard encryption, or an Agile file without one): its content may have been changed after it was encrypted */
	previewDocxPasswordUnchecked: "Its integrity can't be verified: it may have been changed after it was encrypted.",
	/** Docx viewer — shown in place of an older binary Word document (.doc) saved with a .docx name */
	previewDocxLegacyFormat: "This document uses an older Word format that can't be opened here.",
	/** Docx viewer — shown when the file is not a Word document at all (another Office file, or not a document) */
	previewDocxNotDocument: "This file isn't a Word document.",
	/** Docx viewer — page-nav indicator and each page's accessible label; {{current}} = the page in view, {{total}} = page count */
	previewDocxPageIndicator: "Page {{current}} of {{total}}",
	/** Docx viewer — accessible name of a form check box drawn on a page; whether it is ticked is announced separately */
	previewDocxCheckBox: "Check box",
	/** Docx viewer — accessible label for the toolbar button stepping the zoom level down */
	previewDocxZoomOutAction: "Zoom out",
	/** Docx viewer — accessible label for the toolbar button stepping the zoom level up */
	previewDocxZoomInAction: "Zoom in",
	/** Docx viewer — zoom-level indicator between the zoom out/in buttons; {{percent}} = zoom relative to the document's actual size */
	previewDocxZoomIndicator: "{{percent}}%",
	/** Docx viewer — tooltip of the zoom-level indicator, which is a button: clicking it fits the page to the window's width again */
	previewDocxFitWidth: "Fit to width",
	/** Docx viewer — accessible label of the zoom-level button; {{percent}} = the current zoom */
	previewDocxFitWidthAction: "Zoom {{percent}}%, fit to width",
	/** Docx viewer — toolbar button (and its tooltip) opening the find field in the toolbar; also the Cmd/Ctrl+F shortcut */
	previewDocxFindAction: "Find in document",
	/** Docx viewer — placeholder and accessible label of the find field in the toolbar */
	previewDocxFindPlaceholder: "Find",
	/** Docx viewer — match counter beside the find field; {{current}} = the selected match, {{total}} = how many the document holds */
	previewDocxFindCount: "{{current, number}}/{{total, number}}",
	/** Docx viewer — as previewDocxFindCount when there are more matches than a find shows ({{total}}, the most it shows) */
	previewDocxFindCountCapped: "{{current, number}}/{{total, number}}+",
	/** Docx viewer — announced to screen readers as the find results change; {{current}} = the selected match, {{total}} = all matches */
	previewDocxFindStatus: "Match {{current, number}} of {{total, number}}",
	/** Docx viewer — as previewDocxFindStatus when there are more matches than a find shows ({{total}}, the most it shows) */
	previewDocxFindStatusCapped: "Match {{current, number}} of more than {{total, number}}",
	/** Docx viewer — announced to screen readers when the search text is nowhere in the document */
	previewDocxFindNoMatches: "No matches",
	/** Docx viewer — find bar button selecting the previous match (also Shift+Enter in the field) */
	previewDocxFindPrevious: "Previous match",
	/** Docx viewer — find bar button selecting the next match (also Enter in the field) */
	previewDocxFindNext: "Next match",
	/** Docx viewer — find bar toggle: only matches with the same upper and lower case */
	previewDocxFindMatchCase: "Match case",
	/** Docx viewer — find bar toggle: only matches that are whole words, not part of a longer word (Word's "Find whole words only") */
	previewDocxFindWholeWords: "Find whole words only",
	/** Docx viewer — find bar button closing the field (also Escape) */
	previewDocxFindClose: "Close find",
	/** Docx viewer — toolbar menu (and its tooltip) choosing how comments and tracked changes show, as Word's "Display for Review" */
	previewDocxMarkup: "Markup",
	/** Docx viewer — markup menu option: changes shown inline (insertions underlined, deletions struck through), comments and formatting changes in the margin */
	previewDocxMarkupAll: "All markup",
	/** Docx viewer — markup menu option: the document with every change accepted, changed lines marked by a bar, comments in the margin */
	previewDocxMarkupSimple: "Simple markup",
	/** Docx viewer — markup menu option: the document with every change accepted and nothing marked */
	previewDocxMarkupNone: "No markup",
	/** Docx viewer — markup menu option: the document as it was before any tracked change */
	previewDocxMarkupOriginal: "Original",
	/** Docx viewer — accessible name of the margin column holding the comment and change balloons */
	previewDocxComments: "Comments and changes",
	/** Docx viewer — a comment's author when the document records none */
	previewDocxUnknownAuthor: "Unknown author",
	/** Docx viewer — button in a comment or change balloon showing its whole text (the balloon is shortened otherwise) */
	previewDocxBalloonExpand: "Show all",
	/** Docx viewer — button in an expanded balloon shortening it again */
	previewDocxBalloonCollapse: "Show less",
	/** Docx viewer — control at the bottom of a page's balloon column standing for the balloons that do not fit beside the page; opens them in a popover; {{count}} = how many */
	previewDocxMoreBalloons_one: "+{{count}} more",
	/** Docx viewer — as previewDocxMoreBalloons_one, for several */
	previewDocxMoreBalloons_other: "+{{count}} more",
	/** Docx viewer — label on a resolved comment thread (marked done in Word) */
	previewDocxCommentResolved: "Resolved",
	/** Docx viewer — accessible label of the small comment marker shown at the page edge when there is no room for balloons; {{author}} = who wrote it */
	previewDocxCommentMarker: "Comment by {{author}}",
	/** Docx viewer — accessible label of a comment balloon; {{author}} = who wrote it */
	previewDocxCommentLabel: "Comment by {{author}}",
	/** Docx viewer — balloon of a formatting change whose changed properties are not named */
	previewDocxFormatted: "Formatted",
	/** Docx viewer — balloon of a formatting change; {{properties}} = the changed properties, comma-separated (e.g. "Bold, Font size") */
	previewDocxFormattedProperties: "Formatted: {{properties}}",
	/** Docx viewer — formatting change property: bold */
	previewDocxPropertyBold: "Bold",
	/** Docx viewer — formatting change property: italic */
	previewDocxPropertyItalic: "Italic",
	/** Docx viewer — formatting change property: underline */
	previewDocxPropertyUnderline: "Underline",
	/** Docx viewer — formatting change property: strikethrough (single or double) */
	previewDocxPropertyStrikethrough: "Strikethrough",
	/** Docx viewer — formatting change property: the font (typeface) */
	previewDocxPropertyFont: "Font",
	/** Docx viewer — formatting change property: font size */
	previewDocxPropertyFontSize: "Font size",
	/** Docx viewer — formatting change property: font color */
	previewDocxPropertyFontColor: "Font color",
	/** Docx viewer — formatting change property: text highlight color */
	previewDocxPropertyHighlight: "Highlight",
	/** Docx viewer — formatting change property: background shading */
	previewDocxPropertyShading: "Shading",
	/** Docx viewer — formatting change property: superscript or subscript */
	previewDocxPropertyPosition: "Superscript/subscript",
	/** Docx viewer — formatting change property: all caps or small caps */
	previewDocxPropertyCaps: "Caps",
	/** Docx viewer — formatting change property: the paragraph or character style */
	previewDocxPropertyStyle: "Style",
	/** Docx viewer — formatting change property: paragraph alignment */
	previewDocxPropertyAlignment: "Alignment",
	/** Docx viewer — formatting change property: paragraph indentation */
	previewDocxPropertyIndent: "Indent",
	/** Docx viewer — formatting change property: paragraph or character spacing */
	previewDocxPropertySpacing: "Spacing",
	/** Docx viewer — formatting change property: list numbering or bullets */
	previewDocxPropertyNumbering: "Numbering",
	/** Docx viewer — formatting change property: tab stops */
	previewDocxPropertyTabs: "Tabs",
	/** Docx viewer — formatting change property: borders */
	previewDocxPropertyBorders: "Borders",
	/** Docx viewer — formatting change property: keep with next / keep lines together / page break before */
	previewDocxPropertyPagination: "Line and page breaks",
	/** Docx viewer — formatting change property: anything about a table (width, borders, layout, rows, cells) */
	previewDocxPropertyTable: "Table",
	/** Docx viewer — toolbar badge shown when the document can only be viewed; opens a popover explaining why */
	previewDocxViewOnly: "View only",
	/** Docx viewer — heading of the popover opened from the "View only" badge */
	previewDocxViewOnlyTitle: "This document can only be viewed",
	/** Docx viewer — view-only reason: the document is restricted with Word's "Restrict Editing" */
	previewDocxViewOnlyProtected: "It's protected against editing in Word.",
	/** Docx viewer — view-only reason: the document asks for a password before it can be changed */
	previewDocxViewOnlyWriteProtected: "It needs a password to be changed.",
	/** Docx viewer — view-only reason: the document is digitally signed, and any change would break the signature */
	previewDocxViewOnlySigned: "It's digitally signed; a change would break the signature.",
	/** Docx viewer — view-only reason: the document is saved in the "Strict Open XML" variant of the format */
	previewDocxViewOnlyStrict: "It's saved as Strict Open XML.",
	/** Docx viewer — view-only reason: parts of the file are damaged, so it is only shown, to keep it intact */
	previewDocxViewOnlyMalformed: "Parts of it are damaged, so it's left as it is.",
	/** Docx viewer — view-only reason: the file was opened from a public link */
	previewDocxViewOnlyPublicLink: "It was opened from a public link.",
	/** Docx viewer — view-only reason: someone else's file, opened through a link they sent (e.g. a link card in a chat) */
	previewDocxViewOnlyLinkedFile: "It's someone else's file, opened through their link.",
	/** Docx viewer — view-only reason: the file is inside an archive (zip and similar) */
	previewDocxViewOnlyArchive: "It's inside an archive.",
	/** Docx viewer — view-only reason: the file is in the trash */
	previewDocxViewOnlyTrash: "It's in the trash.",
	/** Docx viewer — view-only reason: someone else shared the file with you */
	previewDocxViewOnlySharedIn: "It was shared with you.",
	/** Docx editor — view-only reason: the text box being edited continues its text in another text box */
	previewDocxViewOnlyLinkedTextbox: "Its text continues in another text box, so it can't be edited here.",
	/** Docx editor — view-only reason: the text box's copy kept for older versions of Word doesn't match it */
	previewDocxViewOnlyTextboxFallback: "Its copy for older versions of Word doesn't match it, so it's left as it is.",
	/** Docx editor — view-only reason: the text box sits in a part of the document that's kept exactly as it is */
	previewDocxViewOnlyLockedTextbox: "It's in a part of the document that's kept as it is.",
	/** Docx editor — view-only reason: the file was renamed to another format while open */
	previewDocxViewOnlyRenamed: "It was renamed to another format while open, so changes can't be saved to it.",
	/** Docx editor — view-only reason: changes can no longer be saved to this file (its directory is gone) */
	previewDocxViewOnlyNotWritable: "Changes can't be saved to this file any more.",
	/** Docx editor — overflow menu: zoom submenu label */
	previewDocxZoom: "Zoom",
	/** Docx editor — find bar toggle showing or hiding the replace field */
	previewDocxShowReplace: "Toggle replace",
	/** Docx editor — find bar: placeholder and accessible name of the replacement field */
	previewDocxReplacePlaceholder: "Replace with",
	/** Docx editor — find bar button: replace the current match */
	previewDocxReplace: "Replace",
	/** Docx editor — find bar button: replace every match */
	previewDocxReplaceAll: "Replace all",

	// ── Markdown ─────────────────────────────────────────────────────────────
	/** Markdown viewer — toolbar button shown while viewing the rendered output; switches to the raw-text source view */
	previewMarkdownViewSourceAction: "View source",
	/** Markdown viewer — toolbar button shown while viewing the raw-text source; switches back to the rendered output */
	previewMarkdownViewRenderedAction: "View rendered",
	/** Markdown viewer — native tooltip on the disabled rendered/source toggle: switching views unmounts the editor buffer, so the toggle is locked until the edit is saved or discarded */
	previewMarkdownToggleDirtyHint: "Save or discard your changes before switching views.",

	// ── Video player ─────────────────────────────────────────────────────────
	/** Video/audio preview — the browser can't decode the file; {{codecs}} lists the formats it reported it can't play, e.g. "HEVC, AC-3" (format names, not translated). Shown with a Download button */
	previewMediaFormatUnsupportedCodecs: "This file's format can't be played here ({{codecs}}).",
	/** Video preview — nothing in this browser reads the file's container, whatever it holds; {{container}} is the container format's name, e.g. Ogg or AVI (not translated). Shown with a Download button */
	previewMediaContainerUnsupported: "This browser can't play {{container}} files.",
	/** Video player — notice over a video that plays without sound because the browser can't decode its audio; {{codec}} is the audio format's name, e.g. AC-3 */
	previewMediaNoSound: "No sound: this video's {{codec}} audio can't be played here.",
	/** Video player — notice over a video that plays its sound without a picture because the browser can't decode its video; {{codec}} is the video format's name, e.g. HEVC */
	previewMediaNoPicture: "No picture: this video's {{codec}} video can't be played here.",
	/** Toast when a long video opens where an earlier session left it; {{time}} is the position, e.g. 12:34 */
	videoResumedAt: "Resumed at {{time}}",
	/** Action on the resumed toast: play the video from the beginning */
	videoStartOver: "Start over",
	/** Video player — accessible label of the button closing the no-sound/no-picture notice */
	previewMediaNoticeDismiss: "Dismiss",
	/** Video player — accessible label of the floating control bar */
	previewMediaControls: "Playback controls",
	/** Video player — heading of the playback-speed menu */
	previewMediaPlaybackSpeed: "Playback speed",
	/** Video player — accessible label of the playback-speed button; {{rate}} is the current speed as shown on the button, e.g. 1.5× */
	previewMediaPlaybackSpeedLabel: "Playback speed {{rate}}",
	/** Video player — one playback speed, e.g. 1.5× */
	previewMediaSpeedRate: "{{rate}}×",
	/** Video player — the 1× entry of the playback-speed menu */
	previewMediaNormalSpeed: "Normal",
	/** Video player — enters picture-in-picture */
	previewMediaPictureInPicture: "Picture in picture",
	/** Video player — leaves picture-in-picture */
	previewMediaExitPictureInPicture: "Exit picture in picture",
	/** Video player — fullscreens the player */
	previewMediaFullscreen: "Full screen",
	/** Video player — leaves full screen */
	previewMediaExitFullscreen: "Exit full screen",
	/** Preview overlay body — a `.ts` file that turned out to be TypeScript, too large to load as text */
	previewTextTooLarge: "This file is too large to show as text.",
	/** Preview overlay body — the browser has no way to stream this video or audio file (no service worker, no MediaSource); the Download button sits below */
	previewMediaCannotStream: "This file can't be streamed here.",
	/** Video player — chapters menu button and its heading */
	previewMediaChapters: "Chapters",
	/** Video player — audio menu: a track this browser plays converted (its tooltip says how) */
	previewMediaAudioConverted: "Converted",
	/** Video player — subtitles menu button and its heading */
	previewMediaSubtitles: "Subtitles",
	/** Video player — subtitles menu: no subtitles */
	previewMediaSubtitlesOff: "Off",
	/** Video player — a subtitle track whose language is not known */
	previewMediaSubtitleUnknownLanguage: "Unknown language",
	/** Video player — marks a forced subtitle track (only foreign-language lines) */
	previewMediaSubtitleForced: "Forced",
	/** Video player — marks a subtitle track for the deaf and hard of hearing */
	previewMediaSubtitleSdh: "SDH",
	/** Video player — marks a subtitle track stored inside the video file, as opposed to a file beside it */
	previewMediaSubtitleEmbedded: "Embedded",
	/** Video player — a chosen subtitle track that could not be read; {{name}} is the track's label */
	previewMediaSubtitleUnreadable: "{{name}} (couldn't be loaded)",
	/** Video player — a subtitle track inside the file that this browser could only show by converting the video, which it can't do for this file; {{name}} is the track's label */
	previewMediaSubtitleUnplayable: "{{name}} (can't be shown in this browser)",
	/** Video player — announced to screen readers when the chosen subtitle file could not be read */
	previewMediaSubtitleUnreadableNotice: "The subtitles couldn't be loaded.",

	// ── Archive browser ──────────────────────────────────────────────────────
	/** Archive browser — accessible label of the entry list; {{name}} is the directory shown (the archive's name at its root) */
	previewArchiveListLabel: "Contents of {{name}}",
	/** Archive browser gate (a tarball or single compressed file over 8 MiB) — listing it downloads all of it; {{size}} is the archive's size */
	previewArchiveGateBody: "Listing its contents reads the whole {{size}} archive.",
	/** Archive browser gate — a listing that would start by itself (a zip, a 7z, a small tarball) was cancelled before it read anything */
	previewArchiveNotListed: "Its contents weren't listed.",
	/** Archive browser gate — starts the listing */
	previewArchiveBrowse: "Browse contents",
	/** Archive browser — extracts the whole archive; the footer's button and the gate's */
	previewArchiveExtractAll: "Extract all",
	/** Archive browser footer — opens the menu of where the selected entries go */
	previewArchiveExtractSelected: "Extract selected",
	/** Archive browser — a public link's owner allows no downloads, so the archive can be browsed but not extracted */
	previewArchiveExtractNotAllowed: "The link's owner doesn't allow downloads, so nothing can be extracted from it.",
	/** Archive browser footer — accessible label of the arrow beside Extract all that opens its other destinations */
	previewArchiveExtractAllMore: "More places to extract to",
	/** Archive browser extract menu — into a new directory next to the archive; {{name}} is that directory's name */
	previewArchiveExtractBesideNewFolder: "Extract to “{{name}}/” next to the archive",
	/** Archive browser extract menu — straight into the directory the archive is in */
	previewArchiveExtractBeside: "Extract next to the archive",
	/** Archive browser — another compress, extract or listing holds the page's one archive slot, so this listing waits */
	previewArchiveWaiting: "Waiting for another archive job",
	/** Archive browser waiting state — the job holding the slot is paused, so it never frees it by itself */
	previewArchiveWaitingPaused: "A paused job is holding it — resume or cancel it in Transfers.",
	/** Archive browser — shown while the archive is being read */
	previewArchiveReading: "Reading the archive…",
	/** Archive browser reading progress — {{read}} and {{total}} are formatted sizes */
	previewArchiveReadingBytes: "{{read}} of {{total}}",
	/** Archive browser reading progress — entries listed so far */
	previewArchiveEntryCount_one: "{{count}} entry",
	/** Archive browser reading progress — entries listed so far */
	previewArchiveEntryCount_other: "{{count}} entries",
	/** Archive browser reading progress — time left; {{eta}} is a clock like 1:05 */
	previewArchiveEta: "{{eta}} left",
	/** Archive browser — stops a running listing; what was read stays browsable */
	previewArchiveStop: "Stop",

	// ── iWork documents ──────────────────────────────────────────────────────
	/** iWork preview banner — the document shows as the image of its first page it carries; {{app}} is Pages, Numbers or Keynote */
	previewIworkFirstPageImage: "Preview image of the first page. Open in {{app}} for the full document.",
	/** iWork preview banner — an older document shows as the PDF copy it carries; {{app}} is Pages, Numbers or Keynote */
	previewIworkSavedCopy: "Preview copy saved in the document. Open in {{app}} for the full document.",
	/** iWork preview — the document carries no preview of itself (or is no iWork package) */
	previewIworkNoPreview: "No preview inside this file.",
	/** iWork preview — the document is held where its package can't be read (bytes already loaded, such as an attachment) */
	previewIworkUnavailableHere: "This document can't be previewed here yet.",
	/** iWork document inside an archive, confirm dialog title — previewing it means unpacking all of it first (its contents list sits at its end) */
	previewIworkInflateTitle: "Unpack this document first?",
	/** iWork document inside an archive, confirm dialog body; {{name}} is the document, {{size}} its unpacked size */
	previewIworkInflateBody: "“{{name}}” is compressed inside this archive. Previewing it unpacks all {{size}} of it first.",
	/** iWork document inside an archive, confirm dialog — previews it anyway */
	previewIworkInflateOpen: "Preview",
	/** Archive browser — the user stopped the listing */
	previewArchiveStopped_one: "Listing stopped after {{count}} entry.",
	/** Archive browser — the user stopped the listing */
	previewArchiveStopped_other: "Listing stopped after {{count}} entries.",
	/** Archive browser — lists the archive again from the start */
	previewArchiveListAgain: "List again",
	/** Archive browser — nothing can be listed without the password (a 7-Zip archive whose file names are encrypted) */
	previewArchiveNeedsPassword: "This archive's contents are encrypted.",
	/** Archive password prompt — title */
	previewArchivePasswordTitle: "Archive password",
	/** Archive password prompt — body; {{name}} is the archive's name */
	previewArchivePasswordBody: "Enter the password for “{{name}}”.",
	/** Archive password prompt — body after a wrong password; {{name}} is the archive's name */
	previewArchivePasswordWrongBody: "That password didn't open “{{name}}”. Try again.",
	/** Archive password prompt — the field's label */
	previewArchivePasswordLabel: "Password",
	/** Archive password prompt — submit button */
	previewArchivePasswordSubmit: "Unlock",
	/** Archive browser — reopens a dismissed password prompt, or opens it from the encrypted-entries banner */
	previewArchiveEnterPassword: "Enter password",
	/** Archive browser banner — some listed entries are encrypted and no password has been given */
	previewArchiveEncryptedBanner: "Some entries are encrypted. Extracting them needs the password.",
	/** Archive browser banner — the password given didn't open the encrypted entries */
	previewArchiveWrongPasswordBanner: "That password didn't open the encrypted entries.",
	/** Archive browser banner — the password is being checked against the encrypted entries */
	previewArchiveCheckingPassword: "Checking the password…",
	/** Archive browser banner — the password check waits until another archive job frees the page's one archive slot */
	previewArchiveCheckingPasswordWaiting: "Waiting for another archive job to check the password",
	/** Archive browser — the listing failed: the format isn't supported */
	previewArchiveFailedUnsupported: "This archive's format isn't supported.",
	/** Archive browser — the listing failed: the archive is damaged */
	previewArchiveFailedCorrupt: "This archive is damaged.",
	/** Archive browser — the listing failed: too many entries to list in the browser, it unpacks to an implausible size, or an entry's header in a compressed tarball is implausibly large */
	previewArchiveFailedTooLarge: "This archive is too large to list here.",
	/** Archive browser — a damaged archive whose first entries could be read */
	previewArchivePartial_one: "Showing the {{count}} entry read before the damage.",
	/** Archive browser — a damaged archive whose first entries could be read */
	previewArchivePartial_other: "Showing the {{count}} entries read before the damage.",
	/** Archive browser — a listing that failed for another reason than damage (too large, a dropped connection) after its first entries were read */
	previewArchivePartialListed_one: "Showing the {{count}} entry listed before that.",
	/** Archive browser — a listing that failed for another reason than damage (too large, a dropped connection) after its first entries were read */
	previewArchivePartialListed_other: "Showing the {{count}} entries listed before that.",
	/** Archive browser note — entries the listing found but could not hand to the page */
	previewArchiveUndelivered_one: "{{count}} entry couldn't be shown; Extract all still extracts everything.",
	/** Archive browser note — entries the listing found but could not hand to the page */
	previewArchiveUndelivered_other: "{{count}} entries couldn't be shown; Extract all still extracts everything.",
	/** Archive browser note — a zip names some entries more than once; only the last of each name is listed and extracted. {{count}} is how many were left out; the names follow in a list */
	previewArchiveDuplicates_one: "{{count}} entry is left out because a later entry has the same name.",
	/** Archive browser note — a zip names some entries more than once; only the last of each name is listed and extracted. {{count}} is how many were left out; the names follow in a list */
	previewArchiveDuplicates_other: "{{count}} entries are left out because a later entry has the same name.",
	/** Archive browser — the whole archive holds nothing */
	previewArchiveEmpty: "This archive is empty.",
	/** Archive browser, in the list's place — a compressed tarball is being read and no entry is known yet; {{read}} and {{total}} are sizes */
	previewArchiveReadingFirst: "Reading the first file… {{read}} of {{total}} read so far.",
	/** Archive browser row, after the listed entries — the entry (a file, a directory or a link) the listing is reading right now, listed once read; {{name}} is its name */
	previewArchiveReadingMember: "Reading {{name}}…",
	/** Archive browser, in the list's place — the listing was stopped before its first entry was read, so nothing is listed (the archive isn't empty) */
	previewArchiveStoppedBeforeFirst: "Stopped before the first entry was read, so nothing is listed yet.",
	/** Archive browser — the directory shown holds nothing */
	previewArchiveDirectoryEmpty: "This directory is empty.",
	/** Archive browser search — nothing below the directory shown matches; {{query}} is the search text */
	previewArchiveNoResults: "Nothing here matches “{{query}}”.",
	/** Archive browser search — only the first {{count}} matches are shown */
	previewArchiveSearchTruncated: "Showing the first {{count}} matches — refine your search.",
	/** Archive browser search field — placeholder and accessible label */
	previewArchiveSearchPlaceholder: "Search this directory",
	/** Archive browser — accessible label of the breadcrumbs */
	previewArchiveBreadcrumbs: "Location in the archive",
	/** Archive browser breadcrumbs — accessible label of the "…" menu holding the levels not shown */
	previewArchiveHiddenLevels: "Show the directories above",
	/** Archive browser column header — sorts by name */
	previewArchiveColumnName: "Name",
	/** Archive browser column header — sorts by size */
	previewArchiveColumnSize: "Size",
	/** Archive browser column header — sorts by date modified */
	previewArchiveColumnModified: "Modified",
	/** Archive browser — the header checkbox selecting everything in the directory shown, or every search match */
	previewArchiveSelectAll: "Select all",
	/** Archive browser row — a directory's size column: how many entries it directly holds */
	previewArchiveDirItems_one: "{{count}} item",
	/** Archive browser row — a directory's size column: how many entries it directly holds */
	previewArchiveDirItems_other: "{{count}} items",
	/** Archive browser footer — files selected and their size; {{size}} is formatted */
	previewArchiveSelectedFiles_one: "{{count}} file selected · {{size}}",
	/** Archive browser footer — files selected and their size; {{size}} is formatted */
	previewArchiveSelectedFiles_other: "{{count}} files selected · {{size}}",
	/** Archive browser footer — only directories selected (no files in them) */
	previewArchiveSelectedItems_one: "{{count}} item selected",
	/** Archive browser footer — only directories selected (no files in them) */
	previewArchiveSelectedItems_other: "{{count}} items selected",
	/** Archive browser row — an encrypted entry */
	previewArchiveEncrypted: "Encrypted",
	/** Archive browser row — the name holds invisible or direction-changing characters */
	previewArchiveMisleading: "This name has invisible or direction-changing characters; it may not be what it looks like.",
	/** Archive browser row — the name was changed to be usable in the drive; {{path}} is the name as the archive stores it */
	previewArchiveStoredAs: "Stored as {{path}}",
	/** Archive browser row — a link's target; {{target}} is the path it points to */
	previewArchiveLinkTarget: "Points to {{target}}",
	/** Archive browser row — a symbolic link, which the drive cannot hold */
	previewArchiveSkip_symlink: "Symbolic link · not extracted",
	/** Archive browser row — a tar hard link whose file is not in the archive */
	previewArchiveSkip_hardlink: "Hard link to a missing file · not extracted",
	/** Archive browser row — a device node or pipe */
	previewArchiveSkip_device: "Device or pipe · not extracted",
	/** Archive browser row — a sparse file */
	previewArchiveSkip_sparse: "Sparse file · not extracted",
	/** Archive browser row — an entry of a kind that is not extracted */
	previewArchiveSkip_unsupportedType: "Unsupported entry · not extracted",
	/** Archive browser row — a path longer than the drive allows */
	previewArchiveSkip_pathTooLong: "Path too long · not extracted",
	/** Archive browser row — a path nested too deeply */
	previewArchiveSkip_pathTooDeep: "Nested too deeply · not extracted",
	/** Archive browser row — a path leading out of the extract's directory, or not usable as a drive name */
	previewArchiveSkip_unsafePath: "Unsafe path · not extracted",
	/** Archive browser row — a ZIP entry whose data overlaps another's (a damaged or crafted archive) */
	previewArchiveSkip_overlappingData: "Damaged entry · not extracted",
	/** Archive browser row — compressed or encrypted in a way that cannot be read */
	previewArchiveSkip_unsupportedMethod: "Unsupported compression or encryption · not extracted",
	/** Archive browser row — a 7-Zip deletion marker */
	previewArchiveSkip_antiItem: "Deletion marker · not extracted",
	/** Archive browser row — macOS metadata, left out like an extract leaves it out */
	previewArchiveSkip_macMetadata: "macOS metadata · not extracted",
	/** Hard-link dialog — title: selected hard links point to files outside the directory shown */
	previewArchiveLinkTargetsTitle: "Linked files outside this directory",
	/** Hard-link dialog — body; {{base}} is the directory shown */
	previewArchiveLinkTargetsBody_one:
		"{{count}} selected hard link points to a file outside “{{base}}”, which an extract from here can't include.",
	/** Hard-link dialog — body; {{base}} is the directory shown */
	previewArchiveLinkTargetsBody_other:
		"{{count}} selected hard links point to files outside “{{base}}”, which an extract from here can't include.",
	/** Hard-link dialog — extracts the selection without those links */
	previewArchiveLinkTargetsLeaveOut: "Leave those links out",
	/** Hard-link dialog — extracts with paths taken from a directory higher up that holds the link targets too; {{name}} is that directory */
	previewArchiveLinkTargetsFromParent: "Extract from “{{name}}” instead",
	/** Archive entry viewer — leaves the file shown for the archive's contents again (Escape does too) */
	previewArchiveEntryBack: "Back to the archive",
	/** Solid archive cost dialog title (a solid 7z or RAR, a compressed tarball) — opening or saving one file means reading the files stored before it first; asked once while the archive is open */
	previewArchiveEntryCostTitle: "Read part of the archive first?",
	/** Solid archive cost dialog body, opening; {{name}} is the file, {{download}} roughly how much of the archive is downloaded, {{skipped}} how much of the files stored before it is decoded and thrown away. Later files are not asked about again while the archive stays open */
	previewArchiveEntryCostOnceOpenBody:
		"This archive stores its files together. Opening “{{name}}” downloads about {{download}} of it and unpacks {{skipped}} of the files stored before it. Files further in cost more. You won't be asked again while this archive is open.",
	/** Solid archive cost dialog body, saving; same placeholders as the opening one */
	previewArchiveEntryCostOnceDownloadBody:
		"This archive stores its files together. Saving “{{name}}” downloads about {{download}} of it and unpacks {{skipped}} of the files stored before it. Files further in cost more. You won't be asked again while this archive is open.",
	/** Solid archive cost dialog — opens the file anyway */
	previewArchiveEntryCostOpen: "Open",
	/** Solid archive cost dialog — saves the file anyway */
	previewArchiveEntryCostDownload: "Download",
	/** Comic reader gate — lists a big comic book archive (its listing reads the whole archive, which the line above says) */
	previewComicRead: "Read",
	/** Comic reader — the comic book archive holds no page image the reader shows */
	previewComicNoPages: "No pages to show in this comic.",
	/** Comic reader — its pages lie in one solid block too large to read page by page */
	previewComicTooLarge: "This comic is packed too large to read page by page here. Extract it to read it.",
	/** Comic reader — extracts the comic into the user's drive, to read its pages as files */
	previewComicExtractToRead: "Extract to read",
	/** Comic reader — the user declined reading the archive's earlier pages first */
	previewComicNotOpened: "The comic wasn't opened.",
	/** Comic reader — on-screen button turning to the previous page (or spread) */
	previewComicPrevious: "Previous page",
	/** Comic reader — on-screen button turning to the next page (or spread) */
	previewComicNext: "Next page",
	/** Comic reader — the page slider's accessible name */
	previewComicPageSlider: "Page",
	/** Comic reader — the counter; {{pages}} is a page ("7") or a spread ("6–7"), {{total}} the page count */
	previewComicCounter: "{{pages}} / {{total}}",
	/** Comic reader — toggle showing two pages side by side */
	previewComicSpread: "Two-page spread",
	/** Comic reader — toggle reading right to left (manga) */
	previewComicRightToLeft: "Right to left",
	/** Comic reader — a page image's text alternative, and the page slider's spoken value; {{page}} is its number, {{total}} the page count */
	previewComicPageOf: "Page {{page}} of {{total}}",
	/** Comic reader — in place of a page whose image is too large to show here; {{page}} is its number, {{size}} its size */
	previewComicPageTooLarge: "Page {{page}} is too large to show here ({{size}}).",
	/** Comic reader — shows the comic book archive's files as an archive's, when it holds no page the reader shows */
	previewComicBrowseArchive: "Browse as archive",
	/** Archive entry card — a video or audio file the archive stores so it can't be played from here (compressed so it reads only front to back, or read whole and above 64 MiB); {{name}} is the file */
	previewArchiveEntryExtractToPlayBody: "“{{name}}” can't be played from inside this archive. Extract the archive to play it.",
	/** Archive entry card — extracts the archive to play the file */
	previewArchiveEntryExtractToPlay: "Extract to play",
	/** Archive entry card — a camera RAW photo the archive stores so its preview can't be read from here, or an archive inside the archive stored so it can't be browsed from here (compressed so it reads only whole or front to back); {{name}} is the file */
	previewArchiveEntryExtractToOpenBody: "“{{name}}” can't be opened from inside this archive. Extract the archive to open it.",
	/** Archive entry card — extracts the archive to open the file */
	previewArchiveEntryExtractToOpen: "Extract to open",
	/** Archive inside an archive, confirm dialog title — browsing it means unpacking all of it first (its contents list sits at its end) */
	previewArchiveNestedInflateTitle: "Unpack this archive first?",
	/** Archive inside an archive, confirm dialog body; {{name}} is the inner archive, {{size}} its unpacked size */
	previewArchiveNestedInflateBody: "“{{name}}” is compressed inside this archive. Browsing it unpacks all {{size}} of it first.",
	/** Archive inside an archive, confirm dialog — browses it anyway */
	previewArchiveNestedInflateOpen: "Browse",
	/** Archive browser — an archive held three archives deep can't be opened here; {{name}} is the inner archive */
	previewArchiveNestedTooDeep: "“{{name}}” is nested too deep to open here. Extract the outer archive to open it.",
	/** Archive inside an archive — in place of the crossing glyph in the location trail, for screen readers */
	previewArchiveNestedBoundary: "inside",
	/** Archive entry card inside an archive held in another — the file can't be shown from here, and only the outermost archive can be extracted; {{name}} is the file */
	previewArchiveEntryNestedCardBody:
		"“{{name}}” can't be shown from inside an archive held in another. Extract the outermost archive to get it.",
	/** Archive browser, inside an archive held in another — why its Extract buttons are off */
	previewArchiveExtractNestedNote: "This archive is inside another. Extract the outer archive to get its files.",
	/** Under an archive entry's player — the entry is compressed, so a seek decodes up to the new position */
	previewArchiveMediaSeekNote: "Compressed in the archive · seeking may pause while it reads",
	/** Toast — the file lies in a solid block of the archive too large to read it from here (above 512 MiB); {{name}} is the file */
	previewArchiveEntryExtractToRead: "“{{name}}” is packed with too much of the archive to read here. Extract the archive to read it.",
	/** Toast when a browser can't stream one file of an archive to disk (no File System Access and no transferable streams) */
	previewArchiveEntryDownloadUnsupported: "A single file can't be saved from this archive here. Extract it to your drive instead.",

	// ── Spreadsheet formula signature help: one argument label per catalogue ArgumentId (filen-office ARGUMENT_LABELS)
	/** Formula signature help — the label of a function argument, shown in the call's syntax (e.g. VLOOKUP(lookup value; …)) */
	previewSheetArg_a: "lower bound",
	previewSheetArg_a1: "A1 style",
	previewSheetArg_abs_num: "reference type",
	previewSheetArg_actual_range: "actual range",
	previewSheetArg_aggregation: "aggregation",
	previewSheetArg_alpha: "alpha",
	previewSheetArg_alt_text: "alt text",
	previewSheetArg_angle: "angle",
	previewSheetArg_area_num: "area number",
	previewSheetArg_argument: "argument",
	previewSheetArg_array: "array",
	previewSheetArg_array1: "first array",
	previewSheetArg_array2: "second array",
	previewSheetArg_array_x: "x array",
	previewSheetArg_array_y: "y array",
	previewSheetArg_average_range: "average range",
	previewSheetArg_b: "upper bound",
	previewSheetArg_base: "base",
	previewSheetArg_basis: "basis",
	previewSheetArg_beta: "beta",
	previewSheetArg_bins_array: "bins array",
	previewSheetArg_bottom: "bottom",
	previewSheetArg_by_array: "by array",
	previewSheetArg_by_col: "by column",
	previewSheetArg_calc_method: "accrual method",
	previewSheetArg_calculation: "calculation",
	previewSheetArg_caption: "caption",
	previewSheetArg_case_sensitivity: "case sensitivity",
	previewSheetArg_coefficients: "coefficients",
	previewSheetArg_col_delimiter: "column delimiter",
	previewSheetArg_col_fields: "column fields",
	previewSheetArg_col_index_num: "column number",
	previewSheetArg_col_num: "column number",
	previewSheetArg_col_sort_order: "column sort order",
	previewSheetArg_col_total_depth: "column total depth",
	previewSheetArg_cols: "columns",
	previewSheetArg_column_num: "column number",
	previewSheetArg_columns: "columns",
	previewSheetArg_confidence_level: "confidence level",
	previewSheetArg_connection: "connection",
	previewSheetArg_const: "fit intercept",
	previewSheetArg_cost: "cost",
	previewSheetArg_coupon: "coupon",
	previewSheetArg_criteria: "criteria",
	previewSheetArg_criteria_range: "criteria range",
	previewSheetArg_cumulative: "cumulative",
	previewSheetArg_data_all: "data all",
	previewSheetArg_data_array: "data array",
	previewSheetArg_data_completion: "fill missing points",
	previewSheetArg_data_field: "data field",
	previewSheetArg_data_subset: "data subset",
	previewSheetArg_database: "database",
	previewSheetArg_date: "date",
	previewSheetArg_date_purchased: "purchase date",
	previewSheetArg_date_text: "date text",
	previewSheetArg_dates: "dates",
	previewSheetArg_day: "day",
	previewSheetArg_days: "days",
	previewSheetArg_decimal_dollar: "decimal dollar",
	previewSheetArg_decimal_separator: "decimal separator",
	previewSheetArg_decimals: "decimal places",
	previewSheetArg_default: "default",
	previewSheetArg_deg_freedom: "degrees of freedom",
	previewSheetArg_deg_freedom1: "numerator degrees of freedom",
	previewSheetArg_deg_freedom2: "denominator degrees of freedom",
	previewSheetArg_delimiter: "delimiter",
	previewSheetArg_denominator: "denominator",
	previewSheetArg_dimension: "dimension",
	previewSheetArg_discount: "discount",
	previewSheetArg_divisor: "divisor",
	previewSheetArg_effect_rate: "effect rate",
	previewSheetArg_end_date: "end date",
	previewSheetArg_end_period: "end period",
	previewSheetArg_error_val: "error value",
	previewSheetArg_exactly_once: "exactly once",
	previewSheetArg_expected_range: "expected range",
	previewSheetArg_expression: "expression",
	previewSheetArg_factor: "factor",
	previewSheetArg_field: "field",
	previewSheetArg_field_headers: "field headers",
	previewSheetArg_field_relationship: "field relationship",
	previewSheetArg_filter_array: "filter array",
	previewSheetArg_finance_rate: "finance rate",
	previewSheetArg_find_text: "text to find",
	previewSheetArg_first_coupon: "first coupon date",
	previewSheetArg_first_interest: "first interest date",
	previewSheetArg_first_period: "first period end",
	previewSheetArg_form: "form",
	previewSheetArg_format: "format",
	previewSheetArg_format_text: "format",
	previewSheetArg_fraction: "fraction",
	previewSheetArg_fractional_dollar: "fractional dollar",
	previewSheetArg_frequency: "frequency",
	previewSheetArg_friendly_name: "link text",
	previewSheetArg_from_unit: "from unit",
	previewSheetArg_full_precision: "full precision",
	previewSheetArg_function: "function",
	previewSheetArg_function_num: "function number",
	previewSheetArg_fv: "future value",
	previewSheetArg_group_separator: "group separator",
	previewSheetArg_guess: "guess",
	previewSheetArg_headers: "headers",
	previewSheetArg_height: "height",
	previewSheetArg_holidays: "holidays",
	previewSheetArg_hour: "hour",
	previewSheetArg_i_num: "imaginary part",
	previewSheetArg_if_empty: "if empty",
	previewSheetArg_if_not_found: "if not found",
	previewSheetArg_ignore: "ignore",
	previewSheetArg_ignore_empty: "skip empty",
	previewSheetArg_include: "include",
	previewSheetArg_index_num: "index",
	previewSheetArg_info_type: "information type",
	previewSheetArg_initial_value: "initial value",
	previewSheetArg_instance_num: "occurrence",
	previewSheetArg_interval: "interval",
	previewSheetArg_inumber: "complex number",
	previewSheetArg_inumber1: "first complex number",
	previewSheetArg_inumber2: "second complex number",
	previewSheetArg_investment: "investment",
	previewSheetArg_issue: "issue",
	previewSheetArg_item: "item",
	previewSheetArg_k: "k",
	previewSheetArg_known_xs: "known x values",
	previewSheetArg_known_ys: "known y values",
	previewSheetArg_kpi_name: "KPI name",
	previewSheetArg_kpi_property: "KPI property",
	previewSheetArg_lambda: "lambda",
	previewSheetArg_last_interest: "last interest date",
	previewSheetArg_life: "life",
	previewSheetArg_link_location: "link",
	previewSheetArg_logical: "logical",
	previewSheetArg_logical_test: "logical test",
	previewSheetArg_lookup_array: "lookup array",
	previewSheetArg_lookup_value: "lookup value",
	previewSheetArg_lookup_vector: "lookup vector",
	previewSheetArg_lower_limit: "lower limit",
	previewSheetArg_m: "m",
	previewSheetArg_match_end: "match at end",
	previewSheetArg_match_mode: "match mode",
	previewSheetArg_match_type: "match type",
	previewSheetArg_maturity: "maturity",
	previewSheetArg_max: "max",
	previewSheetArg_max_range: "max range",
	previewSheetArg_mean: "mean",
	previewSheetArg_member_expression: "member expression",
	previewSheetArg_method: "method",
	previewSheetArg_min: "min",
	previewSheetArg_min_length: "minimum length",
	previewSheetArg_min_range: "min range",
	previewSheetArg_minute: "minute",
	previewSheetArg_mode: "mode",
	previewSheetArg_module_text: "module",
	previewSheetArg_month: "month",
	previewSheetArg_months: "months",
	previewSheetArg_multiple: "multiple",
	previewSheetArg_n: "n",
	previewSheetArg_name: "name",
	previewSheetArg_name_value: "value",
	previewSheetArg_new_text: "new text",
	previewSheetArg_new_xs: "new x values",
	previewSheetArg_no_commas: "no separators",
	previewSheetArg_no_switch: "no straight-line switch",
	previewSheetArg_nominal_rate: "nominal rate",
	previewSheetArg_nper: "number of periods",
	previewSheetArg_npery: "periods per year",
	previewSheetArg_num_bytes: "number of bytes",
	previewSheetArg_num_chars: "number of characters",
	previewSheetArg_num_digits: "digits",
	previewSheetArg_number: "number",
	previewSheetArg_number1: "first number",
	previewSheetArg_number2: "second number",
	previewSheetArg_number_chosen: "number chosen",
	previewSheetArg_number_f: "failures",
	previewSheetArg_number_pop: "population size",
	previewSheetArg_number_s: "successes",
	previewSheetArg_number_s2: "upper successes",
	previewSheetArg_number_sample: "sample size",
	previewSheetArg_number_times: "repeat count",
	previewSheetArg_numerator: "numerator",
	previewSheetArg_occurrence: "occurrence",
	previewSheetArg_old_text: "old text",
	previewSheetArg_options: "options",
	previewSheetArg_order: "order",
	previewSheetArg_pad_with: "padding",
	previewSheetArg_par: "par value",
	previewSheetArg_parameter: "parameter",
	previewSheetArg_pattern: "pattern",
	previewSheetArg_per: "period",
	previewSheetArg_percent: "percent",
	previewSheetArg_period: "period",
	previewSheetArg_pivot_table: "pivot table",
	previewSheetArg_places: "places",
	previewSheetArg_pmt: "payment",
	previewSheetArg_population_s: "population successes",
	previewSheetArg_power: "power",
	previewSheetArg_pr: "price",
	previewSheetArg_principal: "principal",
	previewSheetArg_prob_range: "probability range",
	previewSheetArg_probability: "probability",
	previewSheetArg_probability_s: "success probability",
	previewSheetArg_procedure: "procedure",
	previewSheetArg_progid: "program ID",
	previewSheetArg_property: "property",
	previewSheetArg_property0: "property 1",
	previewSheetArg_property1: "property 2",
	previewSheetArg_property2: "property 3",
	previewSheetArg_property3: "property 4",
	previewSheetArg_property4: "property 5",
	previewSheetArg_property5: "property 6",
	previewSheetArg_pv: "present value",
	previewSheetArg_quart: "quartile",
	previewSheetArg_radix: "radix",
	previewSheetArg_range: "range",
	previewSheetArg_range_lookup: "approximate match",
	previewSheetArg_rank: "rank",
	previewSheetArg_rate: "rate",
	previewSheetArg_real_num: "real part",
	previewSheetArg_redemption: "redemption",
	previewSheetArg_ref: "reference",
	previewSheetArg_ref_text: "reference text",
	previewSheetArg_reference: "reference",
	previewSheetArg_register_id: "registration ID",
	previewSheetArg_reinvest_rate: "reinvest rate",
	previewSheetArg_relative_to: "relative to",
	previewSheetArg_replacement: "replacement",
	previewSheetArg_result: "result",
	previewSheetArg_result_vector: "result vector",
	previewSheetArg_return_array: "return array",
	previewSheetArg_return_mode: "return mode",
	previewSheetArg_return_type: "return type",
	previewSheetArg_row_delimiter: "row delimiter",
	previewSheetArg_row_fields: "row fields",
	previewSheetArg_row_index_num: "row number",
	previewSheetArg_row_num: "row number",
	previewSheetArg_row_sort_order: "row sort order",
	previewSheetArg_row_total_depth: "row total depth",
	previewSheetArg_rows: "rows",
	previewSheetArg_salvage: "salvage",
	previewSheetArg_sample_s: "sample successes",
	previewSheetArg_scan_by_column: "by column",
	previewSheetArg_schedule: "schedule",
	previewSheetArg_search_mode: "search mode",
	previewSheetArg_seasonality: "seasonality",
	previewSheetArg_second: "second",
	previewSheetArg_serial_number: "date value",
	previewSheetArg_server: "server",
	previewSheetArg_set: "set",
	previewSheetArg_set_expression: "set expression",
	previewSheetArg_settlement: "settlement",
	previewSheetArg_sheet_text: "sheet name",
	previewSheetArg_shift_amount: "shift",
	previewSheetArg_sigma: "standard deviation",
	previewSheetArg_significance: "significance",
	previewSheetArg_size: "size",
	previewSheetArg_sizing: "sizing",
	previewSheetArg_sort_by: "sort by",
	previewSheetArg_sort_index: "sort index",
	previewSheetArg_sort_order: "sort order",
	previewSheetArg_source: "source",
	previewSheetArg_source_language: "source language",
	previewSheetArg_standard_dev: "standard deviation",
	previewSheetArg_start: "start",
	previewSheetArg_start_date: "start date",
	previewSheetArg_start_num: "start position",
	previewSheetArg_start_period: "start period",
	previewSheetArg_statistic_type: "statistic",
	previewSheetArg_stats: "statistics",
	previewSheetArg_step: "step",
	previewSheetArg_stock: "stock",
	previewSheetArg_suffix: "suffix",
	previewSheetArg_sum_range: "sum range",
	previewSheetArg_table_array: "table",
	previewSheetArg_tails: "tails",
	previewSheetArg_target: "target",
	previewSheetArg_target_date: "target date",
	previewSheetArg_target_language: "target language",
	previewSheetArg_text: "text",
	previewSheetArg_text1: "first text",
	previewSheetArg_text2: "second text",
	previewSheetArg_time_text: "time text",
	previewSheetArg_timeline: "timeline",
	previewSheetArg_to_unit: "to unit",
	previewSheetArg_top: "top",
	previewSheetArg_topic: "topic",
	previewSheetArg_total_depth: "total depth",
	previewSheetArg_trials: "trials",
	previewSheetArg_triangulation_precision: "triangulation precision",
	previewSheetArg_trim_cols: "trim columns",
	previewSheetArg_trim_rows: "trim rows",
	previewSheetArg_type: "type",
	previewSheetArg_type_text: "information type",
	previewSheetArg_unit: "unit",
	previewSheetArg_upper_limit: "upper limit",
	previewSheetArg_url: "URL",
	previewSheetArg_value: "value",
	previewSheetArg_value_if_error: "value if error",
	previewSheetArg_value_if_false: "value if false",
	previewSheetArg_value_if_na: "value if #N/A",
	previewSheetArg_value_if_true: "value if true",
	previewSheetArg_values: "values",
	previewSheetArg_vector: "vector",
	previewSheetArg_weekend: "weekend",
	previewSheetArg_whole_number: "whole numbers",
	previewSheetArg_width: "width",
	previewSheetArg_within_text: "text to search",
	previewSheetArg_wrap_count: "wrap count",
	previewSheetArg_x: "x",
	previewSheetArg_x_num: "x",
	previewSheetArg_x_range: "x range",
	previewSheetArg_xml: "XML",
	previewSheetArg_xpath: "XPath",
	previewSheetArg_y: "y",
	previewSheetArg_y_num: "y",
	previewSheetArg_year: "year",
	previewSheetArg_yld: "yield",
	previewSheetArg_z: "z",

	// ── Word document editor features (locales/en/previewDocx/*) ─────────────
	...previewDocxEditor,
	...previewDocxReview,
	...previewDocxInsert,
	...previewDocxTable,
	...previewDocxFormat,
	...previewDocxForms,
	...previewDocxFields,
	...previewDocxLegacy,
	...previewDocxLegacyPassword,
	...previewDocxPdf,
	...previewDocxSections,
	...previewDocxMath,
	...previewDocxReflow,
	...previewDocxRibbon,
	...previewOfficeShared,
	...previewOfficeRibbon,
	...previewCommandBar,
	...previewSheetViewer,
	...previewPptxViewer,
	...previewPptxLegacy,
	...previewPptxRibbon,
	...previewPptxEditor,
	...previewPptxArrange,
	...previewPptxText,
	...previewPptxFind,
	...previewPptxObjects,
	...previewPptxMedia,
	...previewPptxMediaTiming,
	...previewPptxShow,
	...previewPptxExport,
	...previewPptxPresenter,
	...previewPptxInk,
	...previewPptxSmartArt,
	...previewPptxGalleryA,
	...previewPptxGalleryB,
	...previewPptxTransitions,
	...previewPptxAnimations,
	...previewPptxMotionPaths,
	...previewPptxReview,
	...previewPptxConvert,
	...previewPptxDesign,
	...previewPptxCharts,
	...previewSheetSave,
	...previewSheetFormat,
	...previewSheetKeys,
	...previewSheetStructure,
	...previewSheetShift,
	...previewSheetConditional,
	...previewSheetNotes,
	...previewSheetClipboard,
	...previewSheetSortFilter,
	...previewSheetFormula,
	...previewSheetTouch,
	...previewSheetPrint,
	...previewSheetFormats,
	...previewSheetObjects,
	...previewSheetCharts,
	...previewSheetRibbon,
	...previewSheetShortcuts,
	...previewImageEditor,
	...previewImageSave,
	...previewImageView,
	...previewSlideshowBar,
	...previewVideoEditKeys,
	...previewVideoEditor,
	...previewVideoSave,
	...previewKeysShortcuts,
	...previewPdfView,
	...previewPdfPrint,
	...previewPdfSignatures,
	...previewPdfAnnotations,
	...previewPdfSecurity,
	...previewPdfComments,
	...previewPdfForms,
	...previewPdfFillSign,
	...previewPdfTextEdit,
	...previewPdfSigning,
	...previewPdfOcr,
	...previewPdfRedaction,
	...previewPdfShell,
	...previewPdfNotices,
	...previewPdfPages,
	...previewRichShell,
	...previewRichFont,
	...previewRichSqlite,
	...previewRichGeo,
	...previewRichModel3d,
	...previewRichCad,
	...previewRichDicom,
	...previewTextMetadata,
	...previewEbookReader,
	...previewTextEncoding,
	...previewTextMarkdown,
	...previewTextHtml,
	...previewTextTorrent,
	...previewTextSubtitles,
	...previewTextCalendar,
	...previewTextContacts,
	...previewTextBinary,
	...previewTextEmail,
	...previewTextNotebook,
	...previewTextMermaid,
	...previewTextMailbox,
	...previewTextLargeText,
	...previewTextCodeEditor
} as const

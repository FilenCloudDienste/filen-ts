// "preview" namespace — the shortcuts list's names for the preview's keyboard actions: the overlay, the image viewer
// and editor, the PDF viewer, the code and text editors, the find field and the archive browser. Spread into preview.ts;
// same catalog rules.
export const previewKeysShortcuts = {
	// ── Preview overlay ──────────────────────────────────────────────────────
	/** Shortcuts list — the preview's key showing the previous file of the listing it was opened from */
	previewKeyPrevious: "Previous file",
	/** Shortcuts list — the preview's key showing the next file */
	previewKeyNext: "Next file",
	/** Shortcuts list — the preview's key showing the first file */
	previewKeyFirst: "First file",
	/** Shortcuts list — the preview's key showing the last file */
	previewKeyLast: "Last file",
	/** Shortcuts list — the preview's key closing it */
	previewKeyClose: "Close the preview",
	/** Shortcuts list — the preview's key downloading the file shown (one that cannot be edited) */
	previewKeyDownload: "Download the file",
	/** Shortcuts list — the preview's key renaming the file shown */
	previewKeyRename: "Rename the file",
	/** Shortcuts list — the preview's key moving the file shown to another directory */
	previewKeyMove: "Move the file",
	/** Shortcuts list — the preview's key opening the file's versions */
	previewKeyVersions: "Show the file's versions",
	/** Shortcuts list — the preview's key showing the file's info */
	previewKeyInfo: "Show the file's info",
	/** Shortcuts list — the preview's key sharing the file with a contact */
	previewKeyShare: "Share the file",
	/** Shortcuts list — the preview's key moving the file to the trash */
	previewKeyTrash: "Move the file to the trash",
	/** Shortcuts list — the preview's key adding the file to favorites, or removing it */
	previewKeyFavorite: "Favorite or unfavorite the file",
	/** Shortcuts list — the preview's key opening the file's menu (the ⋯ button) */
	previewKeyOpenMenu: "Open the file's menu",

	// ── Image viewer ─────────────────────────────────────────────────────────
	/** Shortcuts list — the image viewer's zoom in key */
	previewKeyImageZoomIn: "Zoom in (image)",
	/** Shortcuts list — the image viewer's zoom out key */
	previewKeyImageZoomOut: "Zoom out (image)",
	/** Shortcuts list — the image viewer's key fitting the image to the screen */
	previewKeyImageZoomFit: "Fit the image to the screen",
	/** Shortcuts list — the image viewer's key showing the image at its actual size (one image pixel per screen pixel) */
	previewKeyImageActualSize: "Show the image at actual size",
	/** Shortcuts list — the image viewer's key scrolling a zoomed-in image to show more of its left side */
	previewKeyImagePanLeft: "Scroll the image left",
	/** Shortcuts list — the image viewer's key scrolling a zoomed-in image to show more of its right side */
	previewKeyImagePanRight: "Scroll the image right",
	/** Shortcuts list — the image viewer's key scrolling a zoomed-in image to show more of its top */
	previewKeyImagePanUp: "Scroll the image up",
	/** Shortcuts list — the image viewer's key scrolling a zoomed-in image to show more of its bottom */
	previewKeyImagePanDown: "Scroll the image down",

	// ── Image editor ─────────────────────────────────────────────────────────
	/** Shortcuts list — the image editor's key saving the edited image as a copy beside the file */
	previewKeyImageSaveCopy: "Save the edited image as a copy",
	/** Shortcuts list — the image editor's key leaving it (asks first over unsaved edits) */
	previewKeyImageCancel: "Leave the image editor",
	/** Shortcuts list — the image editor's key undoing every edit, back to the image as it is saved */
	previewKeyImageRevert: "Revert all image edits",
	/** Shortcuts list — the image editor's key showing the original image while held */
	previewKeyImageCompare: "Show the original (hold)",
	/** Shortcuts list — the image editor's key opening its Adjust tab */
	previewKeyImageTabAdjust: "Adjust tab",
	/** Shortcuts list — the image editor's key opening its Crop tab */
	previewKeyImageTabCrop: "Crop tab",
	/** Shortcuts list — the image editor's key opening its Filters tab */
	previewKeyImageTabFilters: "Filters tab",
	/** Shortcuts list — the image editor's key opening its Markup tab */
	previewKeyImageTabMarkup: "Markup tab",
	/** Shortcuts list — the image editor's key turning the image a quarter turn counterclockwise */
	previewKeyImageRotateLeft: "Rotate the image left",
	/** Shortcuts list — the image editor's key turning the image a quarter turn clockwise */
	previewKeyImageRotateRight: "Rotate the image right",
	/** Shortcuts list — the image editor's key mirroring the image left to right */
	previewKeyImageFlipHorizontal: "Flip the image horizontally",
	/** Shortcuts list — the image editor's key mirroring the image top to bottom */
	previewKeyImageFlipVertical: "Flip the image vertically",
	/** Shortcuts list — the image editor's key resetting every light and colour slider */
	previewKeyImageResetAdjustments: "Reset the adjustments",
	/** Shortcuts list — the image editor's key resetting the crop, rotation, straightening and flips */
	previewKeyImageResetGeometry: "Reset the crop and rotation",
	/** Shortcuts list — the image editor's key choosing the markup pen */
	previewKeyImageToolPen: "Markup pen",
	/** Shortcuts list — the image editor's key choosing the markup highlighter */
	previewKeyImageToolHighlighter: "Markup highlighter",
	/** Shortcuts list — the image editor's key choosing the markup arrow */
	previewKeyImageToolArrow: "Markup arrow",
	/** Shortcuts list — the image editor's key choosing the markup text tool */
	previewKeyImageToolText: "Markup text",
	/** Shortcuts list — the image editor's key choosing the markup eraser */
	previewKeyImageToolEraser: "Markup eraser",

	// ── PDF viewer ───────────────────────────────────────────────────────────
	/** Shortcuts list — the PDF viewer's key showing the next page */
	previewKeyPdfNextPage: "Next page (PDF)",
	/** Shortcuts list — the PDF viewer's key showing the previous page */
	previewKeyPdfPreviousPage: "Previous page (PDF)",
	/** Shortcuts list — the PDF viewer's key showing the first page */
	previewKeyPdfFirstPage: "First page (PDF)",
	/** Shortcuts list — the PDF viewer's key showing the last page */
	previewKeyPdfLastPage: "Last page (PDF)",
	/** Shortcuts list — the PDF viewer's key moving focus to the page number field */
	previewKeyPdfGoToPage: "Go to page (PDF)",
	/** Shortcuts list — the PDF viewer's key fitting the page to the view's width */
	previewKeyPdfFitWidth: "Fit to width (PDF)",
	/** Shortcuts list — the PDF viewer's key fitting the whole page in the view */
	previewKeyPdfFitPage: "Fit to page (PDF)",
	/** Shortcuts list — the PDF viewer's key entering or leaving full screen */
	previewKeyPdfFullScreen: "Full screen (PDF)",
	/** Shortcuts list — the PDF viewer's key showing the document's properties */
	previewKeyPdfProperties: "Document properties (PDF)",

	// ── Code and text editors ────────────────────────────────────────────────
	/** Shortcuts list — the code and text editors' undo key */
	previewKeyEditorUndo: "Undo (code and text)",
	/** Shortcuts list — the code and text editors' redo key */
	previewKeyEditorRedo: "Redo (code and text)",
	/** Shortcuts list — the key moving to the next match of a find (also in the find field) */
	previewKeyFindNext: "Find next",
	/** Shortcuts list — the key moving to the previous match of a find (also in the find field) */
	previewKeyFindPrevious: "Find previous",
	/** Shortcuts list — the find field's key switching between matching letter case or not */
	previewKeyFindMatchCase: "Match case",
	/** Shortcuts list — the find field's key switching between matching whole words only or not */
	previewKeyFindWholeWord: "Match whole words",
	/** Shortcuts list — the find field's key replacing every match */
	previewKeyReplaceAll: "Replace all",
	/** Shortcuts list — the code and text editors' key asking for a line to move the cursor to */
	previewKeyGoToLine: "Go to line",
	/** Shortcuts list — the code editor's key commenting or uncommenting the selected lines */
	previewKeyToggleComment: "Toggle comment",
	/** Shortcuts list — the code editor's key folding (collapsing) the block at the cursor */
	previewKeyFold: "Fold",
	/** Shortcuts list — the code editor's key unfolding the block at the cursor */
	previewKeyUnfold: "Unfold",
	/** Shortcuts list — the code editor's key folding every block */
	previewKeyFoldAll: "Fold all",
	/** Shortcuts list — the code editor's key unfolding every block */
	previewKeyUnfoldAll: "Unfold all",
	/** Shortcuts list — the code and text viewers' key wrapping long lines or not */
	previewKeyToggleWordWrap: "Toggle word wrap",
	/** Shortcuts list — the code and text viewers' key showing the line numbers or not */
	previewKeyToggleLineNumbers: "Toggle line numbers",
	/** Shortcuts list — the code and text viewers' key making the text larger */
	previewKeyFontSizeIncrease: "Increase font size",
	/** Shortcuts list — the code and text viewers' key making the text smaller */
	previewKeyFontSizeDecrease: "Decrease font size",
	/** Shortcuts list — the code and text viewers' key back to the default text size */
	previewKeyFontSizeReset: "Reset font size",
	/** Shortcuts list — the code and text editors' key comparing the unsaved edits with the file as opened */
	previewKeyViewChanges: "View changes",

	// ── Archive browser ──────────────────────────────────────────────────────
	/** Shortcuts list — the archive browser's key opening the directory or file under the cursor */
	previewKeyArchiveOpen: "Open",
	/** Shortcuts list — the archive browser's key going up to the parent directory */
	previewKeyArchiveParent: "Go to the parent directory",
	/** Shortcuts list — the archive browser's key selecting or deselecting the row under the cursor */
	previewKeyArchiveToggle: "Select or deselect",
	/** Shortcuts list — the archive browser's key clearing the selection */
	previewKeyArchiveClearSelection: "Clear the selection",
	/** Shortcuts list — the archive browser's key moving focus to its search field (also the Find key) */
	previewKeyArchiveSearch: "Search the archive",
	/** Shortcuts list — the archive browser's key saving the file under the cursor to the device */
	previewKeyArchiveDownload: "Download the file",
	/** Shortcuts list — the archive browser's key opening the menu of the file under the cursor */
	previewKeyArchiveOpenMenu: "Open the file's menu",
	/** Shortcuts list — the archive browser's key extracting the selection beside the archive */
	previewKeyArchiveExtractSelected: "Extract the selection",
	/** Shortcuts list — the archive browser's key extracting everything beside the archive */
	previewKeyArchiveExtractAll: "Extract all",
	/** Shortcuts list — the key leaving a file opened from an archive, back to the archive's list */
	previewKeyArchiveBack: "Back to the archive"
} as const

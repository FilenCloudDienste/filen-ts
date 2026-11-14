// "preview" namespace, PDF editor — page organisation and crop: the pages rail and Organise grid, their toolbar and
// Insert menu, the Extract and Split dialogs, names of the files they make, what the screen reader hears after a page
// change, and the crop bar and handles. Spread into preview.ts; same catalog rules.
export const previewPdfPages = {
	/** PDF pages rail and Organise grid — accessible name of the list of page thumbnails */
	previewPdfPagesRailLabel: "Pages",
	/** PDF ribbon, Pages tab — toggle button that shows or hides the column of page thumbnails beside the document; also names that column */
	previewPdfPagesRailToggle: "Page thumbnails",
	/** PDF pages rail — accessible name of one page thumbnail; {{page}} is its number, {{count}} the number of pages */
	previewPdfPagesItemLabel: "Page {{page}} of {{count}}",
	/** PDF Organise grid — title of the full-screen view of every page, where pages are moved, rotated, deleted and inserted */
	previewPdfPagesOrganise: "Organise pages",
	/** PDF Organise grid — button that closes the grid and returns to the document */
	previewPdfPagesOrganiseDone: "Done",
	/** PDF Organise grid — accessible name of the toolbar above the pages */
	previewPdfPagesToolbarLabel: "Page actions",
	/** PDF pages toolbar — menu button that inserts pages after the current one */
	previewPdfPagesInsert: "Insert",
	/** PDF Insert menu — inserts an empty page the size of the current one */
	previewPdfPagesInsertBlank: "Blank page",
	/** PDF Insert menu — inserts pages of another PDF chosen from the user's Filen drive */
	previewPdfPagesInsertFromFilen: "From a file in Filen…",
	/** PDF Insert menu — inserts pages of another PDF chosen from this computer or phone */
	previewPdfPagesInsertFromDevice: "From a file on this device…",
	/** PDF Insert menu — inserts a picture as a new page */
	previewPdfPagesInsertImage: "Image…",
	/** PDF pages toolbar — opens the dialog that copies pages into a new PDF */
	previewPdfPagesExtract: "Extract…",
	/** PDF pages toolbar — opens the dialog that cuts the PDF into several new PDFs */
	previewPdfPagesSplit: "Split…",
	/** PDF pages toolbar and page hover button — turns the selected pages a quarter turn to the right */
	previewPdfPagesRotateCw: "Rotate clockwise",
	/** PDF pages toolbar and page hover button — turns the selected pages a quarter turn to the left */
	previewPdfPagesRotateCcw: "Rotate counterclockwise",
	/** PDF pages toolbar and page hover button — deletes the selected pages */
	previewPdfPagesDelete: "Delete",
	/** PDF pages context action — adds a copy of each selected page after it */
	previewPdfPagesDuplicate: "Duplicate",
	/** PDF pages toolbar — how many pages are selected */
	previewPdfPagesSelected_one: "{{count}} page selected",
	/** PDF pages toolbar — how many pages are selected */
	previewPdfPagesSelected_other: "{{count}} pages selected",
	/** Notice when every page is selected for deletion */
	previewPdfPagesLastPage: "A PDF needs at least one page, so not every page can be deleted.",
	/** Screen reader announcement after a page was moved; {{page}} is its old number, {{position}} its new one */
	previewPdfPagesMoved_one: "Page {{page}} moved to position {{position}}",
	/** Screen reader announcement after several pages were moved together; {{position}} is where the first of them now is */
	previewPdfPagesMoved_other: "{{count}} pages moved to position {{position}}",
	/** Screen reader announcement after pages were rotated; {{page}} is the page's number */
	previewPdfPagesRotated_one: "Page {{page}} rotated",
	/** Screen reader announcement after pages were rotated */
	previewPdfPagesRotated_other: "{{count}} pages rotated",
	/** Screen reader announcement after pages were deleted; {{page}} is the page's number */
	previewPdfPagesDeleted_one: "Page {{page}} deleted",
	/** Screen reader announcement after pages were deleted */
	previewPdfPagesDeleted_other: "{{count}} pages deleted",
	/** Screen reader announcement after pages were duplicated; {{page}} is the page's number */
	previewPdfPagesDuplicated_one: "Page {{page}} duplicated",
	/** Screen reader announcement after pages were duplicated */
	previewPdfPagesDuplicated_other: "{{count}} pages duplicated",
	/** Screen reader announcement after pages were inserted; {{position}} is the number of the first new page */
	previewPdfPagesInserted_one: "Page inserted at position {{position}}",
	/** Screen reader announcement after pages were inserted; {{position}} is the number of the first new page */
	previewPdfPagesInserted_other: "{{count}} pages inserted at position {{position}}",
	/** Error toast: the picture could not be read as an image */
	previewPdfPagesInsertImageFailed: "This image couldn't be inserted.",
	/** Error toast: the chosen file could not be opened as a PDF */
	previewPdfPagesInsertFileFailed: "This file couldn't be inserted. It may not be a PDF.",
	/** PDF Insert — title of the picker for a PDF in the user's Filen drive whose pages are inserted */
	previewPdfPagesInsertPickerTitle: "Insert pages from a PDF",
	/** PDF Insert — description of that picker */
	previewPdfPagesInsertPickerDescription: "Every page of the PDF you choose goes in after the current page.",
	/** PDF Insert — the password prompt's text when the PDF chosen to insert from is password-protected */
	previewPdfPagesInsertPasswordBody: "The PDF to insert from is password-protected. Enter its password.",
	/** Screen reader announcement after pages were cropped; {{page}} is the page's number */
	previewPdfPagesCropped_one: "Page {{page}} cropped",
	/** Screen reader announcement after pages were cropped */
	previewPdfPagesCropped_other: "{{count}} pages cropped",
	/** Button that closes a one-line notice under the ribbon */
	previewPdfPagesNoticeDismiss: "Dismiss",
	/** PDF Organise grid — button on a signed PDF: saves a copy of it without its signatures, whose pages can then be organised */
	previewPdfPagesCopyWithoutSignatures: "Edit a copy without signatures",
	/** Name of that copy, in parentheses after the original name: "contract (without signatures).pdf" */
	previewPdfPagesUnsignedSuffix: "without signatures",
	/** Keyboard shortcuts — the PDF editor's crop tool */
	previewPdfKeyCrop: "Crop (PDF)",

	/** PDF Extract dialog — title */
	previewPdfExtractTitle: "Extract pages",
	/** PDF Extract dialog — description under the title: the pages open as a new, unsaved PDF */
	previewPdfExtractDescription: "The pages open as a new PDF. Review it, then save it beside this one.",
	/** PDF Extract and Split dialogs — label of the choice of pages */
	previewPdfExtractPages: "Pages",
	/** PDF Extract dialog — extracts the pages selected in the pages rail; {{pages}} lists them, like "2-4, 7" */
	previewPdfExtractSelected: "Selected pages ({{pages}})",
	/** PDF Extract dialog — extracts the pages typed in the field next to it */
	previewPdfExtractRange: "Pages",
	/** PDF Extract dialog — accessible name of the field for the pages to extract */
	previewPdfExtractRangeLabel: "Pages to extract",
	/** PDF pages fields (print, extract, split, crop, text recognition) — placeholder: single pages and ranges, separated by commas */
	previewPdfPageRangePlaceholder: "e.g. 1-3, 7, 10-",
	/** PDF pages fields — error under the field when it cannot be read; {{last}} is the last page's number */
	previewPdfPageRangeInvalid: "Enter pages from 1 to {{last}}, such as 1-3, 7, 10-",
	/** PDF editor — a page named in a list (a comment's page, a search match, a redaction mark, a page being recognised); {{page}} is its 1-based number */
	previewPdfPageNumber: "Page {{page}}",
	/** PDF Extract dialog — switch: make a separate PDF of each page */
	previewPdfExtractSeparate: "One file per page",
	/** PDF Extract dialog — note under the one-file-per-page switch: those files are saved at once, not opened */
	previewPdfExtractSeparateNote: "Each page is saved straight away as a PDF of its own.",
	/** PDF Extract dialog — switch: remove the extracted pages from this PDF afterwards */
	previewPdfExtractDelete: "Delete pages after extracting",
	/** PDF Extract dialog — note under the delete switch: the pages are removed from this PDF only once the new PDF is saved */
	previewPdfExtractDeleteNote: "They're removed from this PDF once the new one is saved.",
	/** PDF Extract dialog — note under the delete switch when every page is chosen */
	previewPdfExtractDeleteAll: "Every page is chosen, so they can't all be deleted.",
	/** PDF Extract and Split dialogs — switch, shown for a password-protected PDF: the new files open with the same password */
	previewPdfExtractKeepPassword: "Password-protect the new files",
	/** PDF Extract and Split dialogs — note under the password switch */
	previewPdfExtractKeepPasswordNote: "They open with this PDF's password.",
	/** PDF Extract and Split dialogs — note for a protected PDF opened without its owner password: the new files cannot go without its protection */
	previewPdfExtractKeepsProtection: "The new files keep this PDF's password and restrictions.",
	/** PDF Extract and Split dialogs — error: the password cannot be given to new files, and without the owner password they cannot go without it */
	previewPdfExtractPasswordUnsupportedLocked: "This PDF's password can't be given to new files, so they can't be made.",
	/** PDF Extract and Split dialogs — error: the password cannot be given to new files */
	previewPdfExtractPasswordUnsupported: "This PDF's password can't be given to new files. Turn off password protection to continue.",
	/** PDF Extract and Split dialogs — note for a signed PDF */
	previewPdfExtractSignatures: "Signatures aren't copied. Where a signature shows on a page, its picture stays.",
	/** PDF Extract and Split dialogs — the name of the file that will be made; {{name}} is a file name */
	previewPdfExtractOutput_one: "Saves {{name}}",
	/** PDF Extract and Split dialogs — the files that will be made; {{name}} is the first file's name */
	previewPdfExtractOutput_other: "Saves {{count}} files, starting with {{name}}",
	/** PDF Extract dialog — what extracting opens; {{name}} is the name the new PDF gets when it is saved */
	previewPdfExtractOpens: "Opens {{name}}, not saved yet",
	/** PDF Extract dialog — the submit button while the new PDF is made */
	previewPdfExtractPreparing: "Extracting…",
	/** PDF Extract dialog — the button that extracts */
	previewPdfExtractSubmit: "Extract",
	/** PDF Extract and Split dialogs — the submit button while files are saved: files done of all */
	previewPdfExtractProgress: "Saving {{done}} of {{count}}…",
	/** Success toast after extracting or splitting; {{name}} is a file name */
	previewPdfExtractSaved_one: "Saved {{name}}",
	/** Success toast after extracting or splitting */
	previewPdfExtractSaved_other: "Saved {{count}} files",
	/** Error toast: extracting pages failed */
	previewPdfExtractFailed: "The pages couldn't be extracted.",

	/** New PDF of extracted pages — note beside its name in the header: it is not a file yet */
	previewPdfDraftUnsaved: "Not saved",
	/** New PDF of extracted pages — title of the confirm shown on closing or discarding it unsaved */
	previewPdfDraftDiscardTitle: "Discard the new PDF?",
	/** New PDF of extracted pages — body of that confirm */
	previewPdfDraftDiscardBody: "It hasn't been saved, so its pages and changes are lost. The PDF they came from doesn't change.",

	/** PDF Split dialog — title */
	previewPdfSplitTitle: "Split PDF",
	/** PDF Split dialog — description under the title */
	previewPdfSplitDescription: "The parts are saved as new PDFs beside this one. This PDF doesn't change.",
	/** PDF Split dialog — label of the choice of where to cut */
	previewPdfSplitBy: "Split",
	/** PDF Split dialog — cut after every given number of pages */
	previewPdfSplitByCount: "By page count",
	/** PDF Split dialog — accessible name of the number of pages per file */
	previewPdfSplitCountLabel: "Pages per file",
	/** PDF Split dialog — cut before each page selected in the pages rail */
	previewPdfSplitBySelection: "Before each selected page",
	/** PDF Split dialog — cut where each top-level bookmark begins */
	previewPdfSplitByBookmarks: "By bookmarks",
	/** PDF Split dialog — note when the PDF has no bookmarks to split by */
	previewPdfSplitNoBookmarks: "This PDF has no bookmarks.",
	/** PDF Split dialog — one file for each typed range */
	previewPdfSplitByRanges: "By ranges",
	/** PDF Split dialog — accessible name of the field of ranges, one file each */
	previewPdfSplitRangesLabel: "Ranges, one file each",
	/** PDF Split dialog — placeholder of the ranges field */
	previewPdfSplitRangesPlaceholder: "e.g. 1-3, 4-8, 9-",
	/** PDF Split dialog — note when the choice makes a single file holding every page */
	previewPdfSplitNothing: "This makes one file with every page. Choose where to split.",
	/** PDF Split dialog — the button that splits */
	previewPdfSplitSubmit: "Split",
	/** Error toast: splitting the PDF failed */
	previewPdfSplitFailed: "The PDF couldn't be split.",

	/** Name of an extracted PDF, in parentheses after the original name: "report (page 3).pdf"; {{pages}} is the page */
	previewPdfPagesCopySuffix_one: "page {{pages}}",
	/** Name of an extracted PDF, in parentheses after the original name: "report (pages 3-5).pdf"; {{pages}} lists the pages */
	previewPdfPagesCopySuffix_other: "pages {{pages}}",
	/** Name of a split part, in parentheses after the original name: "report (part 1).pdf" */
	previewPdfPagesPartSuffix: "part {{part}}",
	/** A name suffix again when the first name is taken: "report (pages 3-5 2).pdf"; {{suffix}} is the suffix, {{number}} counts up from 2 */
	previewPdfPagesSuffixNumbered: "{{suffix}} {{number}}",

	/** PDF crop bar — label of the crop tool */
	previewPdfCrop: "Crop",
	/** PDF crop bar — label of the choice of pages the crop applies to */
	previewPdfCropScope: "Apply to",
	/** PDF crop bar — the crop applies to the page in view */
	previewPdfCropScopeCurrent: "This page",
	/** PDF crop bar — the crop applies to the pages selected in the pages rail */
	previewPdfCropScopeSelected: "Selected pages",
	/** PDF crop bar — the crop applies to every page */
	previewPdfCropScopeAll: "All pages",
	/** PDF crop bar — the crop applies to pages 1, 3, 5… */
	previewPdfCropScopeOdd: "Odd pages",
	/** PDF crop bar — the crop applies to pages 2, 4, 6… */
	previewPdfCropScopeEven: "Even pages",
	/** PDF crop bar — the crop applies to the pages typed in the field next to it */
	previewPdfCropScopeRange: "Pages",
	/** PDF crop bar — accessible name of the field for the pages to crop */
	previewPdfCropRangeLabel: "Pages to crop",
	/** PDF crop bar — button that fits the crop to what is drawn on each page, without its white margins */
	previewPdfCropRemoveMargins: "Remove white margins",
	/** PDF crop bar — switch: delete what lies outside the crop instead of only hiding it */
	previewPdfCropRemoveOutside: "Remove content outside the crop",
	/** PDF crop bar — applies the crop */
	previewPdfCropApply: "Apply",
	/** PDF crop bar — leaves the crop tool without cropping */
	previewPdfCropCancel: "Cancel",
	/** PDF crop bar — short note beside the buttons */
	previewPdfCropNote: "Cropping hides content; it isn't removed.",
	/** PDF crop — the full explanation of what cropping does */
	previewPdfCropNotice:
		"Cropping hides everything outside the crop box. That content stays in the file, and anyone can restore it. To delete it, choose Remove content outside the crop.",
	/** PDF crop — accessible name of the crop rectangle on the page, moved with the arrow keys */
	previewPdfCropArea: "Crop area",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleTop: "Top edge of the crop",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleBottom: "Bottom edge of the crop",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleLeft: "Left edge of the crop",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleRight: "Right edge of the crop",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleTopLeft: "Top left corner of the crop",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleTopRight: "Top right corner of the crop",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleBottomLeft: "Bottom left corner of the crop",
	/** PDF crop — accessible name of a crop handle */
	previewPdfCropHandleBottomRight: "Bottom right corner of the crop",
	/** PDF crop — how to place the crop with the keyboard, read with the crop area */
	previewPdfCropKeys: "Arrow keys move it, Shift moves it farther, Tab goes to its edges and corners, Enter applies, Escape cancels.",
	/** PDF crop — screen reader announcement of the crop's place, in points (1/72 inch) */
	previewPdfCropPosition: "Crop {{width}} by {{height}} points, {{left}} from the left and {{top}} from the top"
} as const

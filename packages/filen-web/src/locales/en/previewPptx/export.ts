// "preview" namespace, presentations: exports from the File menu (PDF of slides, notes pages or handouts; images of
// slides) and Print. Spread into preview.ts; same catalog rules.
export const previewPptxExport = {
	/** Presentation File menu submenu: exports the presentation as a PDF, as it is now (unsaved changes included) */
	previewPptxExportPdf: "Export as PDF",
	/** Export as PDF submenu item: one slide per page */
	previewPptxExportPdfSlides: "Slides",
	/** Export as PDF submenu item: each slide with its speaker notes below it */
	previewPptxExportPdfNotes: "Notes pages",
	/** Export as PDF submenu: handouts, several slides per page (opens the choice of how many) */
	previewPptxExportPdfHandouts: "Handouts",
	/** Export as PDF ▸ Handouts item: the number of slides on each page; count is 1, 2, 3, 4, 6 or 9 */
	previewPptxExportPerPage_one: "{{count}} slide per page",
	/** Export as PDF ▸ Handouts item: the number of slides on each page; count is 1, 2, 3, 4, 6 or 9 */
	previewPptxExportPerPage_other: "{{count}} slides per page",
	/** Export as PDF submenu check item: hidden slides go into the PDF too */
	previewPptxExportIncludeHidden: "Include hidden slides",
	/** Export as PDF submenu note for a password-protected presentation */
	previewPptxExportProtected: "Protected with the presentation's password",
	/** Presentation File menu submenu: exports slides as PNG or JPEG images */
	previewPptxExportImages: "Export as images",
	/** Export as images submenu item: the slide on show as one image; format is PNG or JPEG */
	previewPptxExportImageCurrent: "Current slide as {{format}}",
	/** Export as images submenu item: every slide as an image, saved together in one .zip file; format is PNG or JPEG */
	previewPptxExportImageAll: "All slides as {{format}} (.zip)",
	/** Export as images submenu: label of the image width choices */
	previewPptxExportWidth: "Image width",
	/** Export as images submenu: one image width choice, in pixels */
	previewPptxExportWidthOption: "{{width}} px",
	/** Presentation File menu item: prints the slides with the browser's print dialog */
	previewPptxExportPrint: "Print…",
	/** Export toast while the export starts */
	previewPptxExportPreparing: "Preparing export…",
	/** Export as PDF toast: progress by page */
	previewPptxExportPdfProgress: "Making PDF… page {{done}} of {{total}}",
	/** Export as images toast: progress by slide */
	previewPptxExportImagesProgress: "Making images… slide {{done}} of {{total}}",
	/** Export and print toasts: action cancelling the work */
	previewPptxExportCancel: "Cancel",
	/** Error toast: the export failed */
	previewPptxExportFailed: "The export couldn't be made.",
	/** Error toast: the presentation's password cannot be used to protect a PDF */
	previewPptxExportPasswordUnsupported: "The PDF couldn't be made: this presentation's password can't protect a PDF.",
	/** Print toast while the slides are prepared for the browser's print dialog */
	previewPptxPrintPreparing: "Preparing slides to print… {{done}} of {{total}}",
	/** Error toast: printing failed */
	previewPptxPrintFailed: "The slides couldn't be printed.",
	/** Notice when the print shortcut is pressed on a shared link whose owner turned off downloads */
	previewPptxPrintNotAllowed: "The link's owner doesn't allow downloads, so the slides can't be printed."
}

// "preview" namespace, PDF viewer: reading the file on demand. Composed by previewPdf/index.ts; same catalog rules as
// preview.ts.
export const previewPdfView = {
	/** PDF viewer — error shown when part of the file could not be downloaded while the document was open or opening (a dropped connection); a Retry button follows */
	previewPdfReadFailed: "This PDF couldn't be read. Check your connection and try again.",
	/** PDF viewer — title of the confirmation asked before an action that downloads the whole (large) file, such as searching every page or printing every page */
	previewPdfFullReadTitle: "Read the whole file?",
	/** PDF viewer — body of the confirmation before searching a large PDF: the viewer otherwise downloads only the pages shown. {{size}} is the file size, e.g. "612 MB" */
	previewPdfFullReadFind: "Searching all pages reads the whole file ({{size}}).",
	/** PDF viewer — body of the confirmation before printing every page of a large PDF: the viewer otherwise downloads only the pages shown. {{size}} is the file size, e.g. "612 MB" */
	previewPdfFullReadPrint: "Printing all pages reads the whole file ({{size}}).",
	/** PDF viewer — confirmation button: go ahead and download the whole file */
	previewPdfFullReadContinue: "Continue",
	/** PDF viewer — confirmation button: do not download the whole file */
	previewPdfFullReadCancel: "Cancel"
} as const

// "preview" namespace, PDF viewer — printing: the print dialog (pages, quality, annotations) and its messages. Composed
// by previewPdf/index.ts; same catalog rules.
export const previewPdfPrint = {
	/** PDF viewer — File menu item that opens the print dialog */
	previewPdfPrintMenu: "Print…",
	/** PDF print dialog — title */
	previewPdfPrintTitle: "Print",
	/** PDF print dialog — description under the title */
	previewPdfPrintDescription: "Choose which pages print and at what quality.",
	/** PDF print dialog — label of the choice of which pages print */
	previewPdfPrintPages: "Pages",
	/** PDF print dialog — prints every page */
	previewPdfPrintAll: "All",
	/** PDF print dialog — prints only the page in view; {{page}} is its number */
	previewPdfPrintCurrent: "Current page ({{page}})",
	/** PDF print dialog — prints the pages typed in the field next to it */
	previewPdfPrintRange: "Pages",
	/** PDF print dialog — accessible name of the field for the pages to print */
	previewPdfPrintRangeLabel: "Pages to print",
	/** PDF print dialog — label of the print quality choice */
	previewPdfPrintQuality: "Quality",
	/** PDF print dialog — quality: pages drawn at 150 dots per inch */
	previewPdfPrintStandard: "Standard (150 dpi)",
	/** PDF print dialog — quality: pages drawn at 300 dots per inch, sharper but slower and using more memory */
	previewPdfPrintHigh: "High (300 dpi)",
	/** PDF print dialog — note under High when the document's author allows printing only at low quality */
	previewPdfPrintHighRestricted: "The document's author allows only low-quality printing.",
	/** PDF print dialog — switch: also print the document's comments, markups and filled-in form fields */
	previewPdfPrintAnnotations: "Annotations and form fields",
	/** PDF print dialog — warning when the print may need more memory than the browser allows; {{size}} is an amount like "740 MB" */
	previewPdfPrintMemory_one:
		"Printing {{count}} page at this quality needs about {{size}} of memory. Choose Standard quality or fewer pages if printing fails.",
	/** PDF print dialog — warning when the print may need more memory than the browser allows; {{size}} is an amount like "740 MB" */
	previewPdfPrintMemory_other:
		"Printing {{count}} pages at this quality needs about {{size}} of memory. Choose Standard quality or fewer pages if printing fails.",
	/** PDF print dialog — the print button */
	previewPdfPrintButton: "Print…",
	/** PDF print dialog — the print button while pages are prepared: pages done of all */
	previewPdfPrintProgress: "Preparing page {{done}} of {{pages}}…",
	/** Error toast: printing the PDF failed */
	previewPdfPrintFailed: "The PDF couldn't be printed.",
	/** Notice when the print shortcut is pressed on a shared link whose owner turned off downloads */
	previewPdfPrintNotAllowed: "The link's owner doesn't allow downloads, so this PDF can't be printed.",
	/** Notice when the print shortcut or menu item is used on a PDF whose author turned printing off */
	previewPdfPrintRestricted: "The document's author doesn't allow printing it."
} as const

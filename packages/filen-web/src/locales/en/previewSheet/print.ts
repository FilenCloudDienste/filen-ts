// "preview" namespace, spreadsheet viewer — printing: the print dialog (what prints, paper,
// orientation, scaling, gridlines and headings, with a page preview) and its messages. Spread into preview.ts; same
// catalog rules.
export const previewSheetPrint = {
	/** Spreadsheet viewer — file menu item and print dialog title */
	previewSheetPrint: "Print",
	/** Spreadsheet viewer — file menu item that opens the print dialog */
	previewSheetPrintMenu: "Print…",
	/** Print dialog — description under the title */
	previewSheetPrintDescription: "Choose what prints and how it fits on the paper.",
	/** Print dialog — label of the choice of what prints */
	previewSheetPrintWhat: "Print what",
	/** Print dialog — prints the sheet on show (its print area when it has one) */
	previewSheetPrintActiveSheet: "Active sheet",
	/** Print dialog — prints every visible sheet of the workbook */
	previewSheetPrintWorkbook: "Entire workbook",
	/** Print dialog — prints only the selected cells */
	previewSheetPrintSelection: "Selection",
	/** Print dialog — checkbox: print the whole used range even where the sheet sets a print area */
	previewSheetPrintIgnoreArea: "Ignore print area",
	/** Print dialog — label of the paper size choice */
	previewSheetPrintPaper: "Paper",
	/** Print dialog — paper size the file gives in its own measurements (not a standard size) */
	previewSheetPrintPaperCustom: "Custom size",
	/** Print dialog — paper size: US Letter, 8.5 × 11 in */
	previewSheetPrintPaperLetter: "Letter (8.5 × 11 in)",
	/** Print dialog — paper size: US Legal, 8.5 × 14 in */
	previewSheetPrintPaperLegal: "Legal (8.5 × 14 in)",
	/** Print dialog — paper size: Tabloid, 11 × 17 in */
	previewSheetPrintPaperTabloid: "Tabloid (11 × 17 in)",
	/** Print dialog — paper size: Executive, 7.25 × 10.5 in */
	previewSheetPrintPaperExecutive: "Executive (7.25 × 10.5 in)",
	/** Print dialog — paper size: A4, 210 × 297 mm */
	previewSheetPrintPaperA4: "A4 (210 × 297 mm)",
	/** Print dialog — paper size: A3, 297 × 420 mm */
	previewSheetPrintPaperA3: "A3 (297 × 420 mm)",
	/** Print dialog — paper size: A5, 148 × 210 mm */
	previewSheetPrintPaperA5: "A5 (148 × 210 mm)",
	/** Print dialog — paper size: B5, 176 × 250 mm */
	previewSheetPrintPaperB5: "B5 (176 × 250 mm)",
	/** Print dialog — paper size the file names that is not in the list above; {{size}} is its number in the file */
	previewSheetPrintPaperOther: "Paper size {{size}}",
	/** Print dialog — label of the orientation choice */
	previewSheetPrintOrientation: "Orientation",
	/** Print dialog — portrait orientation */
	previewSheetPrintPortrait: "Portrait",
	/** Print dialog — landscape orientation */
	previewSheetPrintLandscape: "Landscape",
	/** Print dialog — label of the scaling choice */
	previewSheetPrintScaling: "Scaling",
	/** Print dialog — scaling: print at actual size (100 %) */
	previewSheetPrintNoScaling: "No scaling",
	/** Print dialog — scaling: shrink so the whole sheet fits on one page */
	previewSheetPrintFitSheet: "Fit sheet on one page",
	/** Print dialog — scaling: shrink so all columns fit on one page wide */
	previewSheetPrintFitColumns: "Fit all columns on one page",
	/** Print dialog — scaling: shrink so all rows fit on one page tall */
	previewSheetPrintFitRows: "Fit all rows on one page",
	/** Print dialog — scaling: a percentage the user types */
	previewSheetPrintCustomScale: "Custom scale",
	/** Print dialog — scaling: fit to the page counts the file sets; {{wide}} and {{tall}} are numbers, or "any" */
	previewSheetPrintFitPages: "Fit to {{wide}} wide by {{tall}} tall",
	/** Print dialog — stands for an automatic number of pages in "Fit to … wide by … tall" */
	previewSheetPrintFitAny: "any",
	/** Print dialog — label of the percentage input for a custom scale */
	previewSheetPrintScalePercent: "Scale (%)",
	/** Print dialog — the percentage is not a whole number from 10 to 400 */
	previewSheetPrintScaleInvalid: "Enter a whole number from 10 to 400.",
	/** Print dialog — checkbox: print the cell gridlines */
	previewSheetPrintGridlines: "Gridlines",
	/** Print dialog — checkbox: print row numbers and column letters */
	previewSheetPrintHeadings: "Row and column headings",
	/** Print dialog — button downloading the pages as they would print as a PDF file instead of printing them */
	previewSheetPrintSaveAsPdf: "Save as PDF",
	/** Print dialog — the button that prints */
	previewSheetPrintButton: "Print",
	/** Print dialog — accessible label of the page preview */
	previewSheetPrintPreview: "Page preview",
	/** Print dialog — the page shown in the preview; {{page}} and {{pages}} are numbers */
	previewSheetPrintPageOf: "Page {{page}} of {{pages}}",
	/** Print dialog — previous page button */
	previewSheetPrintPreviousPage: "Previous page",
	/** Print dialog — next page button */
	previewSheetPrintNextPage: "Next page",
	/** Print dialog — nothing on the chosen sheets or selection prints */
	previewSheetPrintNothing: "There's nothing to print.",
	/** Print dialog — shown while the pages are prepared */
	previewSheetPrintPreparing: "Preparing pages…",
	/** Print dialog — progress while pages are prepared for the printer; {{done}} and {{pages}} are numbers */
	previewSheetPrintProgress: "Preparing page {{done}} of {{pages}}…",
	/** Print dialog — the print is cut short at the page limit; {{pages}} is the number that prints */
	previewSheetPrintTooMany: "Only the first {{pages}} pages print. Set a print area or scale to print fewer.",
	/** Print dialog — sheets without cells or a chart (dialog and macro sheets) are not printed; {{names}} lists the sheet names */
	previewSheetPrintSkipped: "These sheets don't print here: {{names}}",
	/** Print dialog — the settings are not saved into the file (read-only, or a CSV or TSV file) */
	previewSheetPrintNotSaved: "These settings apply to this print only.",
	/** Print dialog preview and toast — one page holds more cells than a page can be drawn with; {{page}} is its number */
	previewSheetPrintPageTooLarge: "Page {{page}} holds too many cells to print. Set a print area, a larger scale or a smaller paper size.",
	/** Toast — the pages could not be prepared */
	previewSheetPrintFailed: "This spreadsheet couldn't be printed.",
	/** Printed page listing a sheet's notes at the end — the line naming a note's cell; {{cell}} is a cell reference such as B2 */
	previewSheetPrintNoteCell: "Cell: {{cell}}",
	/** Printed page listing a sheet's notes at the end — the line with a note's text; {{note}} is the note */
	previewSheetPrintNoteText: "Note: {{note}}",
	/** Saved PDF — text a screen reader reads for a chart that has no description of its own */
	previewSheetPrintChartAlt: "Chart",
	/** Saved PDF — text a screen reader reads for a picture that has no description of its own */
	previewSheetPrintPictureAlt: "Picture",
	/** Saved PDF — text a screen reader reads for a chart sheet's chart; {{name}} is the sheet's name */
	previewSheetPrintChartSheetAlt: "Chart: {{name}}"
}

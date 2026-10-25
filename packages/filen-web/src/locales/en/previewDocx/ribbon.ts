// "preview" namespace, Word document editor — its ribbon's own tabs, groups and controls (the shared ones are
// previewOffice/ribbon.ts). Spread into preview.ts; same catalog rules.
export const previewDocxRibbon = {
	/** Docx editor — ribbon tab: page setup, breaks, paragraph spacing */
	previewDocxRibbonTabLayout: "Layout",
	/** Docx editor — ribbon tab: table of contents, footnotes and endnotes, updating fields */
	previewDocxRibbonTabReferences: "References",
	/** Docx editor — Paste dropdown: paste the clipboard's text without its formatting or pictures */
	previewDocxRibbonPasteText: "Keep text only",
	/** Docx editor — ribbon group: lists, indents, alignment and line spacing */
	previewDocxRibbonParagraph: "Paragraph",
	/** Docx editor — ribbon group: the paragraph style picker */
	previewDocxRibbonStyles: "Styles",
	/** Docx editor — ribbon group on the Insert tab: page break */
	previewDocxRibbonPages: "Pages",
	/** Docx editor — ribbon group on the Insert tab: inserting a table */
	previewDocxRibbonTables: "Tables",
	/** Docx editor — ribbon group on the Insert tab: header, footer and page numbers */
	previewDocxRibbonHeaderFooter: "Header and footer",
	/** Docx editor — ribbon group on the Insert tab: date, field and form controls */
	previewDocxRibbonText: "Text",
	/** Docx editor — ribbon group on the Insert tab: equation, symbol and horizontal line */
	previewDocxRibbonSymbols: "Symbols",
	/** Docx editor — ribbon group on the Layout tab: the page setup dialog */
	previewDocxRibbonPageSetup: "Page setup",
	/** Docx editor — ribbon group on the References tab: inserting and updating a table of contents */
	previewDocxRibbonToc: "Table of contents",
	/** Docx editor — ribbon group on the References tab: updating every field */
	previewDocxRibbonFields: "Fields",
	/** Docx editor — ribbon group on the Review tab: track changes and the markup shown */
	previewDocxRibbonTracking: "Tracking",
	/** Docx editor — ribbon group on the Review tab: stepping through, accepting and rejecting tracked changes */
	previewDocxRibbonChanges: "Changes",
	/** Docx editor — Review tab dropdown: accept the change at the cursor, or all changes */
	previewDocxRibbonAccept: "Accept",
	/** Docx editor — Review tab dropdown: reject the change at the cursor, or all changes */
	previewDocxRibbonReject: "Reject",
	/** Docx editor — ribbon group on the View tab: page view or Mobile view */
	previewDocxRibbonViews: "Views",
	/** Docx editor — ribbon group on the Table tab: inserting and deleting rows and columns */
	previewDocxRibbonRowsColumns: "Rows and columns",
	/** Docx editor — ribbon group on the Table tab: merging, splitting and distributing cells */
	previewDocxRibbonMerge: "Merge",
	/** Docx editor — ribbon group on the Table tab: header row, shading and table style */
	previewDocxRibbonTableDesign: "Design",
	/** Docx editor — Table tab dropdown: delete the selected rows, columns or the whole table */
	previewDocxRibbonTableDelete: "Delete"
}

// "preview" namespace, PDF editor — annotations: the annotation tools, the annotation popover, keyboard placement and
// attachments. Spread into preview.ts; same catalog rules.
export const previewPdfAnnotations = {
	/** Annotation tool: select, move and resize annotations on a PDF page */
	previewPdfAnnotToolSelect: "Select",
	/** Annotation tool: a box of typed text on a PDF page */
	previewPdfAnnotToolTextBox: "Text box",
	/** Annotation tool: freehand drawing on a PDF page */
	previewPdfAnnotToolDraw: "Draw",
	/** Annotation tool: highlight text on a PDF page */
	previewPdfAnnotToolHighlight: "Highlight",
	/** Annotation tool: underline text on a PDF page */
	previewPdfAnnotToolUnderline: "Underline",
	/** Annotation tool: strike through text on a PDF page */
	previewPdfAnnotToolStrikeOut: "Strikethrough",
	/** Annotation tool: a wavy underline under text on a PDF page */
	previewPdfAnnotToolSquiggly: "Squiggly underline",
	/** Annotation tool: a rectangle shape on a PDF page */
	previewPdfAnnotToolRectangle: "Rectangle",
	/** Annotation tool: an ellipse shape on a PDF page */
	previewPdfAnnotToolEllipse: "Ellipse",
	/** Annotation tool: a straight line on a PDF page */
	previewPdfAnnotToolLine: "Line",
	/** Annotation tool: a straight line with an arrowhead on a PDF page */
	previewPdfAnnotToolArrow: "Arrow",
	/** Annotation tool: place a picture (from the device or from Filen) on a PDF page */
	previewPdfAnnotToolImage: "Image",
	/** Annotation tool: place a standard stamp ("Approved", "Draft", …) on a PDF page */
	previewPdfAnnotToolStamp: "Stamp",
	/** Annotation tool: a sticky note (an icon with a comment) on a PDF page */
	previewPdfAnnotToolNote: "Note",
	/** Accessible name of the floating toolbar of the selected annotation */
	previewPdfAnnotPopover: "Annotation",
	/** Button in the annotation toolbar opening the colour picker */
	previewPdfAnnotColor: "Color",
	/** Label of the annotation's opacity slider */
	previewPdfAnnotOpacity: "Opacity",
	/** The opacity slider's value read by assistive technology. {{percent}}: 0 to 100 */
	previewPdfAnnotOpacityValue: "{{percent}}%",
	/** Label of the slider setting the width of an annotation's lines, in points */
	previewPdfAnnotWidth: "Line width",
	/** The line width slider's value read by assistive technology. {{width}}: a number of points (1 pt = 1/72 inch) */
	previewPdfAnnotWidthValue: "{{width}} pt",
	/** Button in the annotation toolbar opening the annotation's comment thread */
	previewPdfAnnotComment: "Comment",
	/** Button in the annotation toolbar deleting the annotation */
	previewPdfAnnotDelete: "Delete",
	/** Shown in the annotation toolbar when the annotation can't be changed */
	previewPdfAnnotLocked: "This annotation is locked.",
	/** Accessible name of the field for typing a text box's text on a PDF page */
	previewPdfAnnotTextBoxEditor: "Text box text",
	/** Live region while placing an annotation from the keyboard. {{tool}}: the tool's name; positions and sizes in points from the page's top-left corner */
	previewPdfAnnotPlacement: "{{tool}} at {{x}}, {{y}}, {{width}} by {{height}} points",
	/** How keyboard placement works, read once when it starts */
	previewPdfAnnotPlacementHint: "Arrow keys move it, Alt and arrow keys resize it, Enter places it, Escape cancels.",
	/** Save option: draw every annotation into its page, so it can no longer be changed or removed */
	previewPdfAnnotFlatten: "Flatten annotations",
	/** Explains the flatten save option */
	previewPdfAnnotFlattenBody: "Draws the annotations into the pages. They can't be changed or removed afterwards.",
	/** Button downloading a file attached to the PDF. {{name}}: the file name as stored in the PDF */
	previewPdfAnnotAttachmentDownload: "Download {{name}}",
	/** Standard stamp name */
	previewPdfAnnotStampApproved: "Approved",
	/** Standard stamp name */
	previewPdfAnnotStampExperimental: "Experimental",
	/** Standard stamp name */
	previewPdfAnnotStampNotApproved: "Not approved",
	/** Standard stamp name */
	previewPdfAnnotStampAsIs: "As is",
	/** Standard stamp name */
	previewPdfAnnotStampExpired: "Expired",
	/** Standard stamp name */
	previewPdfAnnotStampNotForPublicRelease: "Not for public release",
	/** Standard stamp name */
	previewPdfAnnotStampConfidential: "Confidential",
	/** Standard stamp name */
	previewPdfAnnotStampFinal: "Final",
	/** Standard stamp name */
	previewPdfAnnotStampSold: "Sold",
	/** Standard stamp name */
	previewPdfAnnotStampDepartmental: "Departmental",
	/** Standard stamp name */
	previewPdfAnnotStampForComment: "For comment",
	/** Standard stamp name */
	previewPdfAnnotStampTopSecret: "Top secret",
	/** Standard stamp name */
	previewPdfAnnotStampDraft: "Draft",
	/** Standard stamp name */
	previewPdfAnnotStampForPublicRelease: "For public release"
} as const

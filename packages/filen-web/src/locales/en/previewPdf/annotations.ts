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
	previewPdfAnnotStampForPublicRelease: "For public release",
	/** Annotation tool: drag the pages to move around them */
	previewPdfAnnotToolHand: "Hand",
	/** Annotation tool with a menu of shapes (rectangle, ellipse, line, arrow) to draw on a PDF page */
	previewPdfAnnotToolShapes: "Shapes",
	/** Ribbon: the button opening a tool's menu of variants. {{tool}}: the tool's name, e.g. "Highlight" */
	previewPdfToolVariants: "{{tool}} options",
	/** Ribbon group of the PDF annotation tools (select, hand, text box, draw, highlight, shapes, image and stamps) */
	previewPdfRibbonGroupAnnotate: "Annotate",
	/** Ribbon group of the PDF comment tools (new comment, the Comments panel, attachments) */
	previewPdfRibbonGroupComment: "Comment",
	/** Shortcuts list — the PDF editor's key choosing the Select tool */
	previewPdfKeyToolSelect: "Select tool (PDF)",
	/** Shortcuts list — the PDF editor's key choosing the Hand tool (drag to move around the pages) */
	previewPdfKeyToolHand: "Hand tool (PDF)",
	/** Shortcuts list — the PDF editor's key choosing the Text box tool */
	previewPdfKeyToolTextBox: "Text box tool (PDF)",
	/** Shortcuts list — the PDF editor's key choosing the Draw tool (freehand) */
	previewPdfKeyToolDraw: "Draw tool (PDF)",
	/** Shortcuts list — the PDF editor's key choosing the Highlight tool (and its underline, strikethrough and squiggly variants) */
	previewPdfKeyToolHighlight: "Highlight tool (PDF)",
	/** Shortcuts list — the PDF editor's key choosing the Comment tool (places a sticky note) */
	previewPdfKeyToolNote: "Comment tool (PDF)",
	/** Image stamp: a picture from the user's Filen drive, placed on a PDF page */
	previewPdfAnnotImageFromFilen: "Image from Filen",
	/** Image stamp: the description of the Filen picture picker */
	previewPdfAnnotImageFromFilenBody: "Choose a picture to place on the page.",
	/** Image stamp: the picture could not be read or is too large */
	previewPdfAnnotImageFailed: "This picture couldn't be added.",
	/** Ribbon button and dialog title listing the files attached to a PDF */
	previewPdfAnnotAttachments: "Attachments",
	/** Attachments dialog: what it lists and what it does with them */
	previewPdfAnnotAttachmentsBody: "Files attached to this PDF. They are downloaded, never opened here.",
	/** Attachments dialog: while the list is read */
	previewPdfAnnotAttachmentsLoading: "Reading attachments…",
	/** Attachments dialog: the PDF has no attached files */
	previewPdfAnnotAttachmentsEmpty: "This PDF has no attachments.",
	/** Annotation toolbar: downloads the file a file attachment annotation carries */
	previewPdfAnnotAttachmentDownloadAny: "Download attachment"
} as const

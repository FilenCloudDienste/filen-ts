// "preview" namespace, PDF editor — editing existing text and adding text: the in-place editor over a text block, its
// font chip, and the one-line notices when text can't be edited or an edit wasn't applied. New text is set in a font
// that ships with Filen; the notices say so plainly. Spread directly into preview.ts; same catalog rules.
export const previewPdfTextEdit = {
	/** Ribbon button (Tools tab) that lets the user click a text block of the PDF to change its words */
	previewPdfTextEditTool: "Edit text",
	/** Ribbon button (Tools tab) that places new text on the PDF page */
	previewPdfTextAddTool: "Add text",
	/** Undo/redo history entry for a change to existing text */
	previewPdfTextEditHistory: "Edit text",
	/** Undo/redo history entry for text added to a page */
	previewPdfTextAddHistory: "Add text",
	/** Accessible name of the text box that edits a text block in place on the PDF page */
	previewPdfTextEditField: "Text",
	/** Font chip on the in-place text editor: "Aa" followed by the name of the font the new text is set in. {{font}} is a font family name such as "Arimo" */
	previewPdfTextEditFontChip: "Aa {{font}}",
	/** Appended to the font chip when that font only stands in for the document's own font */
	previewPdfTextEditSubstituteMark: "(substitute)",
	/** Accessible name of the ⓘ button on the font chip of a substitute font, which explains why it is shown */
	previewPdfTextEditFontInfo: "About this font",
	/** Explanation behind the ⓘ button when the document's font is replaced. {{font}} is the font the text is shown in (exact wording) */
	previewPdfTextEditSubstitute: "Shown in {{font}} because the original font can't be reused. Spacing may differ.",
	/** Button finishing the in-place text edit and applying it to the page */
	previewPdfTextEditDone: "Done",
	/** Shown while an edit is being applied to the page */
	previewPdfTextEditApplying: "Applying…",
	/** One-line notice when the clicked text can't be edited (exact wording) */
	previewPdfTextEditNotPossible:
		"This text can't be edited here. It may be drawn as shapes, use a Type 3 font, be vertical or follow a curve.",
	/** One-line notice when an edit was refused because it would have removed text next to it (exact wording) */
	previewPdfTextEditUnsafe: "This change would also remove nearby text, so it wasn't applied.",
	/** Button closing a text-editing notice */
	previewPdfTextEditDismiss: "Dismiss"
}

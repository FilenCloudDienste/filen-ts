// "preview" namespace, PDF editor — Fill & Sign: text and marks placed on the page, and the visual signature dialog
// (draw, type or pick an image; saved signatures and initials). A visual signature is a picture of a signature, not a
// certificate signature: nothing here says it is verified. Spread into preview.ts; same catalog rules.
export const previewPdfFillSign = {
	/** Fill & Sign — tool placing typed text on the page */
	previewPdfFillText: "Add text",
	/** Fill & Sign — tool placing a check mark */
	previewPdfFillCheck: "Check mark",
	/** Fill & Sign — tool placing a cross */
	previewPdfFillCross: "Cross",
	/** Fill & Sign — tool placing a filled dot */
	previewPdfFillDot: "Dot",
	/** Fill & Sign — tool adding a visual signature */
	previewPdfFillSignature: "Signature",
	/** Fill & Sign — tool adding initials */
	previewPdfFillInitials: "Initials",
	/** Fill & Sign — undo step label: text placed */
	previewPdfFillStepText: "Add text",
	/** Fill & Sign — undo step label: a mark placed */
	previewPdfFillStepMark: "Add mark",
	/** Fill & Sign — undo step label: a signature placed */
	previewPdfFillStepSignature: "Add signature",
	/** Fill & Sign — undo step label: initials placed */
	previewPdfFillStepInitials: "Add initials",
	/** Fill & Sign — undo step label: a form field filled in */
	previewPdfFillStepField: "Fill in field",

	/** Signature dialog — title when adding a signature */
	previewPdfSignatureDialogTitle: "Add signature",
	/** Signature dialog — title when adding initials */
	previewPdfInitialsDialogTitle: "Add initials",
	/** Signature dialog — description under the title */
	previewPdfSignatureDialogDescription: "A picture of your signature placed on the page. It isn't a certificate signature.",
	/** Signature dialog — label of the row of saved signatures to pick from */
	previewPdfSignatureSaved: "Saved signatures",
	/** Signature dialog — label of the row of saved initials to pick from */
	previewPdfInitialsSaved: "Saved initials",
	/** Signature dialog — accessible name of one saved signature in that row. {{index}} counts from 1 */
	previewPdfSignatureSavedItem: "Saved signature {{index}}",
	/** Signature dialog — accessible name of one saved set of initials in that row. {{index}} counts from 1 */
	previewPdfInitialsSavedItem: "Saved initials {{index}}",
	/** Signature dialog — accessible name of the button deleting one saved signature or initials */
	previewPdfSignatureSavedDelete: "Delete",
	/** Signature dialog — button starting a new signature instead of a saved one */
	previewPdfSignatureNew: "New",
	/** Signature dialog — tab: draw with a mouse, pen or finger */
	previewPdfSignatureDraw: "Draw",
	/** Signature dialog — tab: type the name in a handwriting-style font */
	previewPdfSignatureType: "Type",
	/** Signature dialog — tab: use a picture from this device */
	previewPdfSignatureImage: "Image",
	/** Signature dialog — accessible name of the drawing area */
	previewPdfSignaturePad: "Signature drawing area. Draw with a mouse, pen or finger.",
	/** Signature dialog — hint shown in the empty drawing area */
	previewPdfSignaturePadHint: "Sign here",
	/** Signature dialog — undo the last drawn stroke */
	previewPdfSignatureUndoStroke: "Undo stroke",
	/** Signature dialog — redo a stroke */
	previewPdfSignatureRedoStroke: "Redo stroke",
	/** Signature dialog — label of the text field on the Type tab when adding a signature */
	previewPdfSignatureTypeLabel: "Your name",
	/** Signature dialog — label of the text field on the Type tab when adding initials */
	previewPdfInitialsTypeLabel: "Your initials",
	/** Signature dialog — button on the Image tab opening the device's file picker */
	previewPdfSignatureChooseImage: "Choose image…",
	/** Signature dialog — the chosen file could not be read as an image */
	previewPdfSignatureImageFailed: "This image couldn't be read. Choose a PNG, JPEG, WebP or HEIC image.",
	/** Signature dialog — checkbox keeping the new signature for later, on every device */
	previewPdfSignatureSaveForReuse: "Save for reuse",
	/** Signature dialog — saving for reuse is not possible because the saved signatures were written by a newer app version */
	previewPdfSignatureSaveReadOnly: "Saved signatures were changed by a newer version of Filen and can't be updated here.",
	/** Signature dialog — clears the drawing, the typed text or the chosen image */
	previewPdfSignatureClear: "Clear",
	/** Signature dialog — places the signature on the page */
	previewPdfSignaturePlace: "Place",
	/** Toast when the signature was placed but saving it for reuse failed */
	previewPdfSignatureSaveFailed: "The signature was placed, but it couldn't be saved for reuse.",
	/** Toast when deleting a saved signature failed */
	previewPdfSignatureDeleteFailed: "The saved signature couldn't be deleted."
} as const

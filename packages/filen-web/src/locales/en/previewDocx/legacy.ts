// "preview" namespace, Word document viewer — Word 97–2003 documents (.doc, .dot), converted to view. Spread into
// preview.ts; same catalog rules.
export const previewDocxLegacy = {
	/** Docx viewer — toolbar badge on a Word 97–2003 document (.doc/.dot), which is converted to be shown and is read-only */
	previewDocxLegacyBadge: "Word 97–2003",
	/** Docx viewer — the Word 97–2003 badge's popover title */
	previewDocxLegacyTitle: "Word 97–2003 document",
	/** Docx viewer — the Word 97–2003 badge's popover: what the viewer shows and how to edit it (where Save as .docx is offered) */
	previewDocxLegacyBody: "Converted so it can be shown here, read-only. Save it as .docx to get a copy you can edit.",
	/** Docx viewer — the Word 97–2003 badge's popover where no copy can be saved (a shared or public file, the trash) */
	previewDocxLegacyBodyReadOnly: "Converted so it can be shown here, read-only.",
	/** Docx viewer — the Word 97–2003 badge's popover: heading of the list of what the conversion could not carry over */
	previewDocxLegacyNotConverted: "Shown differently from the original:",
	/** Docx viewer — not-converted list item: floating shapes shown as placeholder boxes ({{count}} of them) */
	previewDocxLegacyShapes_one: "{{count}} drawing shape, shown as a placeholder",
	/** Docx viewer — as previewDocxLegacyShapes_one, for several */
	previewDocxLegacyShapes_other: "{{count}} drawing shapes, shown as placeholders",
	/** Docx viewer — not-converted list item: curved parts of freeform drawing shapes drawn as straight lines */
	previewDocxLegacyGeometry_one: "{{count}} curved shape outline, drawn with straight lines",
	/** Docx viewer — as previewDocxLegacyGeometry_one, for several */
	previewDocxLegacyGeometry_other: "{{count}} curved shape outlines, drawn with straight lines",
	/** Docx viewer — not-converted list item: WordArt (decorative text, e.g. a "DRAFT" watermark) shown as plain text in a box */
	previewDocxLegacyWordArt_one: "{{count}} WordArt item, shown as plain text",
	/** Docx viewer — as previewDocxLegacyWordArt_one, for several */
	previewDocxLegacyWordArt_other: "{{count}} WordArt items, shown as plain text",
	/** Docx viewer — not-converted list item: embedded objects (spreadsheets, charts…) of which only the picture is kept */
	previewDocxLegacyObjects_one: "{{count}} embedded object, shown as its picture",
	/** Docx viewer — as previewDocxLegacyObjects_one, for several */
	previewDocxLegacyObjects_other: "{{count}} embedded objects, shown as their pictures",
	/** Docx viewer — not-converted list item: pictures that could not be read */
	previewDocxLegacyPictures_one: "{{count}} picture, shown as a placeholder",
	/** Docx viewer — as previewDocxLegacyPictures_one, for several */
	previewDocxLegacyPictures_other: "{{count}} pictures, shown as placeholders",
	/** Docx viewer — not-converted list item: decorative (art) borders drawn as plain lines */
	previewDocxLegacyArtBorders_one: "{{count}} art border, drawn as a line",
	/** Docx viewer — as previewDocxLegacyArtBorders_one, for several */
	previewDocxLegacyArtBorders_other: "{{count}} art borders, drawn as lines",
	/** Docx viewer — not-converted list item: special characters of old Word versions that are left out */
	previewDocxLegacyCharacters_one: "{{count}} special character, left out",
	/** Docx viewer — as previewDocxLegacyCharacters_one, for several */
	previewDocxLegacyCharacters_other: "{{count}} special characters, left out",
	/** Docx viewer — not-converted list item: the document's editing restrictions had a password that could not be carried over */
	previewDocxLegacyPassword: "The password on its editing restrictions, which could not be kept",
	/** Docx viewer — not-converted list item: parts of a damaged file that could not be read */
	previewDocxLegacyDamaged: "Some damaged content could not be read",
	/** Docx viewer — not-converted list item: the document's macros (a VBA project), which a .docx cannot contain */
	previewDocxLegacyMacros: "Its macros (a VBA project), which a .docx can't hold",
	/** Docx viewer — not-converted list item: a Word 97–2003 template's AutoText entries (reusable text), not carried over */
	previewDocxLegacyAutoText: "Its AutoText entries, which a .docx copy doesn't keep",
	/** Docx viewer — toolbar button and confirm button: save a Word 97–2003 document as a .docx copy next to it */
	previewDocxSaveAsDocx: "Save as .docx",
	/** Docx viewer — the Save as .docx confirm dialog's title */
	previewDocxSaveAsDocxTitle: "Save as .docx?",
	/** Docx viewer — the Save as .docx confirm dialog's body */
	previewDocxSaveAsDocxBody: "A copy in the current Word format is saved next to this file and opened. This file stays as it is.",
	/** Docx viewer — the Save as .docx confirm dialog, added when the document's editing password could not be carried over */
	previewDocxSaveAsDocxNoPassword: "Its editing restrictions are kept without their password: anyone can lift them in the copy.",
	/** Docx viewer — the Save as .docx confirm dialog, added when the document has macros (a VBA project) the copy cannot hold */
	previewDocxSaveAsDocxNoMacros: "The copy has no macros.",
	/** Docx viewer — the Save as .docx confirm dialog, added when a template's AutoText entries are not carried over */
	previewDocxSaveAsDocxNoAutoText: "It doesn't keep the template's AutoText entries.",
	/** Docx viewer — toast after Save as .docx; {{name}} is the new file's name */
	previewDocxSavedAsDocx: "Saved as {{name}}",
	/** Docx viewer — toast when Save as .docx failed */
	previewDocxSaveAsDocxFailed: "This document could not be saved as .docx"
} as const

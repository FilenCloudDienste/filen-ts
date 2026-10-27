// "preview" namespace, PowerPoint 97–2003 decks (.ppt, .pps, .pot): what the viewer says about a deck in the legacy
// binary format, which opens to be looked at only, and its Save as .pptx. Spread into preview.ts; same catalog rules.
export const previewPptxLegacy = {
	/** Presentation viewer — note over a PowerPoint 97–2003 deck (.ppt, .pps, .pot): it is shown, not edited */
	previewPptxLegacyViewOnly: "PowerPoint 97–2003 presentation. It can be viewed but not edited here.",
	/** Presentation viewer — note over a PowerPoint 97–2003 deck where a .pptx copy can be saved (the way to edit it) */
	previewPptxLegacyViewOnlySaveAs: "PowerPoint 97–2003 presentation. It can be viewed here; save it as .pptx to get a copy you can edit.",
	/** Presentation viewer — accessible name of the note about the legacy PowerPoint 97–2003 format */
	previewPptxLegacyLabel: "Legacy format",
	/** Presentation viewer — button in the legacy note and confirm button: save a PowerPoint 97–2003 deck as a .pptx copy next to it */
	previewPptxSaveAsPptx: "Save as .pptx",
	/** Presentation viewer — the Save as .pptx confirm dialog's title */
	previewPptxSaveAsPptxTitle: "Save as .pptx?",
	/** Presentation viewer — the Save as .pptx confirm dialog's body */
	previewPptxSaveAsPptxBody: "A copy in the current PowerPoint format is saved next to this file and opened. This file stays as it is.",
	/** Presentation viewer — the Save as .pptx confirm dialog, added for a deck opened with its password */
	previewPptxSaveAsPptxPassword: "The copy is protected with the same password.",
	/** Presentation viewer — toast, and the title of the dialog listing what the copy holds differently, after Save as .pptx; {{name}} is the new file's name */
	previewPptxSavedAsPptx: "Saved as {{name}}",
	/** Presentation viewer — the dialog after Save as .pptx: heading of the list of what the copy holds differently from the original */
	previewPptxSavedDifferently: "Kept differently in the copy:",
	/** Presentation viewer — the dialog after Save as .pptx: button that opens the saved copy */
	previewPptxOpenCopy: "Open the copy",
	/** Presentation viewer — toast when Save as .pptx failed */
	previewPptxSaveAsPptxFailed: "This presentation could not be saved as .pptx",
	/** Save as .pptx — kept differently: embedded objects that are linked, are controls or are damaged; the copy shows their pictures where they have one */
	previewPptxLossOleObject_one: "{{count}} embedded object that can't be opened in the copy",
	/** Save as .pptx — as previewPptxLossOleObject_one, for several */
	previewPptxLossOleObject_other: "{{count}} embedded objects that can't be opened in the copy",
	/** Save as .pptx — kept differently: sounds or movies that could not be carried over; the copy shows their pictures where they have one */
	previewPptxLossMedia_one: "{{count}} sound or movie that won't play in the copy",
	/** Save as .pptx — as previewPptxLossMedia_one, for several */
	previewPptxLossMedia_other: "{{count}} sounds or movies that won't play in the copy",
	/** Save as .pptx — kept differently: slides whose animations were too large, damaged, or held values the current format cannot */
	previewPptxLossAnimation_one: "Animations on {{count}} slide, not kept in full",
	/** Save as .pptx — as previewPptxLossAnimation_one, for several */
	previewPptxLossAnimation_other: "Animations on {{count}} slides, not kept in full",
	/** Save as .pptx — kept differently: slide transitions of a kind the current format does not have */
	previewPptxLossTransition_one: "{{count}} slide transition, left out",
	/** Save as .pptx — as previewPptxLossTransition_one, for several */
	previewPptxLossTransition_other: "{{count}} slide transitions, left out",
	/** Save as .pptx — kept differently: slides whose comments could not be read (damaged) */
	previewPptxLossComment_one: "Comments on {{count}} slide, left out",
	/** Save as .pptx — as previewPptxLossComment_one, for several */
	previewPptxLossComment_other: "Comments on {{count}} slides, left out",
	/** Save as .pptx — kept differently: the deck's macros (a VBA project), which a .pptx cannot hold */
	previewPptxLossMacros: "Its macros (a VBA project), which a .pptx can't hold",
	/** Save as .pptx — kept differently: click or hover actions the copy cannot carry */
	previewPptxLossAction_one: "{{count}} click or hover action, left out",
	/** Save as .pptx — as previewPptxLossAction_one, for several */
	previewPptxLossAction_other: "{{count}} click or hover actions, left out",
	/** Save as .pptx — kept differently: WordArt (decorative text) kept as plain text in a box */
	previewPptxLossWordArt_one: "{{count}} WordArt item, kept as plain text",
	/** Save as .pptx — as previewPptxLossWordArt_one, for several */
	previewPptxLossWordArt_other: "{{count}} WordArt items, kept as plain text",
	/** Save as .pptx — kept differently: curved parts of custom shapes drawn with straight lines */
	previewPptxLossCustomGeometry_one: "{{count}} custom shape, drawn with straight lines",
	/** Save as .pptx — as previewPptxLossCustomGeometry_one, for several */
	previewPptxLossCustomGeometry_other: "{{count}} custom shapes, drawn with straight lines",
	/** Save as .pptx — kept differently: pictures that could not be read or shown */
	previewPptxLossPicture_one: "{{count}} picture that could not be read",
	/** Save as .pptx — as previewPptxLossPicture_one, for several */
	previewPptxLossPicture_other: "{{count}} pictures that could not be read",
	/** Save as .pptx — kept differently: slides with a colour scheme of their own whose master shapes keep the master's colours */
	previewPptxLossSlideColorScheme_one: "{{count}} slide's own colours, not used on its master's shapes",
	/** Save as .pptx — as previewPptxLossSlideColorScheme_one, for several */
	previewPptxLossSlideColorScheme_other: "{{count}} slides' own colours, not used on their master's shapes",
	/** Save as .pptx — kept differently: pattern fills drawn as an even mix of their two colours */
	previewPptxLossPatternFill_one: "{{count}} pattern fill, drawn as a pattern of its two colours",
	/** Save as .pptx — as previewPptxLossPatternFill_one, for several */
	previewPptxLossPatternFill_other: "{{count}} pattern fills, drawn as patterns of their two colours",
	/** Save as .pptx — kept differently: parts of a damaged file that could not be read */
	previewPptxLossDamaged: "Some damaged content could not be read"
} as const

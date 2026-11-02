// "preview" namespace, presentation conversions: the File menu's Download as and Save a copy, the legacy deck's Save as
// .odp, and what a converted copy holds differently. Spread into preview.ts; same catalog rules.
export const previewPptxConvert = {
	/** Presentation editor — File menu: submenu of the formats the open presentation can be downloaded as (a converted copy, unsaved changes included) */
	previewPptxConvertDownloadAs: "Download as",
	/** Presentation editor — File menu: saves a copy in the current PowerPoint format next to a presentation that can only be viewed here (Strict format, signed, or protected from changes) */
	previewPptxConvertSaveCopy: "Save a copy as .pptx",
	/** Presentation editor — toast while the copy is written and uploaded */
	previewPptxConvertSavingCopy: "Saving a copy…",
	/** Presentation editor — toast when Save a copy as .pptx failed */
	previewPptxConvertSaveCopyFailed: "A copy of this presentation could not be saved",
	/** Dialog after a copy was saved in full — body: the copy can be edited, the original is unchanged */
	previewPptxConvertSavedWhole: "The copy can be edited here. This file stays as it is.",
	/** PowerPoint 97–2003 note — button and confirm button: save the presentation as an OpenDocument copy next to it */
	previewPptxConvertSaveAsOdp: "Save as .odp",
	/** PowerPoint 97–2003 note — the Save as .odp confirm dialog's title */
	previewPptxConvertSaveAsOdpTitle: "Save as .odp?",
	/** PowerPoint 97–2003 note — the Save as .odp confirm dialog's body */
	previewPptxConvertSaveAsOdpBody: "An OpenDocument copy is saved next to this file and opened. This file stays as it is.",
	/** PowerPoint 97–2003 note — toast when Save as .odp failed */
	previewPptxConvertSaveAsOdpFailed: "This presentation could not be saved as .odp",
	/** Download as error — a ".pot" file that turned out to be a text file (a gettext template), not a PowerPoint template */
	previewPptxConvertNotPresentation: "This file is a text file, not a PowerPoint template",
	/** Download as warning — heading before the list of what the converted copy holds differently */
	previewPptxConvertDifferently: "Kept differently in the copy: {{list}}",
	/** Converted copy — kept differently: the deck's macros (a VBA project), which the copy cannot hold */
	previewPptxConvertLossMacros: "Its macros (a VBA project), which the copy can't hold",
	/** Converted copy — kept differently: gradient, pattern or picture fills written in the nearest form the copy's format has */
	previewPptxConvertLossFill_one: "{{count}} fill, drawn in the nearest form",
	/** Converted copy — as previewPptxConvertLossFill_one, for several */
	previewPptxConvertLossFill_other: "{{count}} fills, drawn in the nearest form",
	/** Converted copy — kept differently: dashed lines or line ends the copy's format has no form for */
	previewPptxConvertLossLine_one: "{{count}} line style, drawn in the nearest form",
	/** Converted copy — as previewPptxConvertLossLine_one, for several */
	previewPptxConvertLossLine_other: "{{count}} line styles, drawn in the nearest form",
	/** Converted copy — kept differently: shape outlines the copy's format has no preset for */
	previewPptxConvertLossGeometry_one: "{{count}} shape outline, drawn as its nearest",
	/** Converted copy — as previewPptxConvertLossGeometry_one, for several */
	previewPptxConvertLossGeometry_other: "{{count}} shape outlines, drawn as their nearest",
	/** Converted copy — kept differently: the outline level (depth in the outline) of a paragraph without a bullet, which the copy's format keeps only on bulleted paragraphs; written as the paragraph's indent */
	previewPptxConvertLossOutlineLevel_one: "{{count}} paragraph outline level, written as its indent",
	/** Converted copy — as previewPptxConvertLossOutlineLevel_one, for several */
	previewPptxConvertLossOutlineLevel_other: "{{count}} paragraph outline levels, written as their indents",
	/** Converted copy — kept differently: text settings (vertical text, line breaking, spacing, bullets, numbering) written in a nearer form */
	previewPptxConvertLossText_one: "{{count}} text setting, written in the nearest form",
	/** Converted copy — as previewPptxConvertLossText_one, for several */
	previewPptxConvertLossText_other: "{{count}} text settings, written in the nearest form",
	/** Converted copy — kept differently: table styles written as the cells' own formatting */
	previewPptxConvertLossTableStyle_one: "{{count}} table style, kept as the cells' own formatting",
	/** Converted copy — as previewPptxConvertLossTableStyle_one, for several */
	previewPptxConvertLossTableStyle_other: "{{count}} table styles, kept as the cells' own formatting",
	/** Converted copy — kept differently: charts that could not be carried over */
	previewPptxConvertLossChart_one: "{{count}} chart, left out",
	/** Converted copy — as previewPptxConvertLossChart_one, for several */
	previewPptxConvertLossChart_other: "{{count}} charts, left out",
	/** Converted copy — kept differently: charts kept without some of what they hold (a number format, a trend line) */
	previewPptxConvertLossChartDetail_one: "{{count}} chart, kept without some of its settings",
	/** Converted copy — as previewPptxConvertLossChartDetail_one, for several */
	previewPptxConvertLossChartDetail_other: "{{count}} charts, kept without some of their settings",
	/** Converted copy — kept differently: fields the format has no kind for (a page count, the file name), kept as their text */
	previewPptxConvertLossField_one: "{{count}} field, kept as the text it shows",
	/** Converted copy — as previewPptxConvertLossField_one, for several */
	previewPptxConvertLossField_other: "{{count}} fields, kept as the text they show",
	/** Converted copy — kept differently: SmartArt diagrams written as groups of their shapes */
	previewPptxConvertLossSmartArt_one: "{{count}} SmartArt diagram, kept as a group of shapes",
	/** Converted copy — as previewPptxConvertLossSmartArt_one, for several */
	previewPptxConvertLossSmartArt_other: "{{count}} SmartArt diagrams, kept as groups of shapes",
	/** Converted copy — kept differently: 3D scenes shown as their pictures */
	previewPptxConvertLossThreeD_one: "{{count}} 3D object, kept as a picture",
	/** Converted copy — as previewPptxConvertLossThreeD_one, for several */
	previewPptxConvertLossThreeD_other: "{{count}} 3D objects, kept as pictures",
	/** Converted copy — kept differently: ink drawings that could not be carried over */
	previewPptxConvertLossInk_one: "{{count}} ink drawing, left out",
	/** Converted copy — as previewPptxConvertLossInk_one, for several */
	previewPptxConvertLossInk_other: "{{count}} ink drawings, left out",
	/** Converted copy — kept differently: shapes the copy's format could not hold */
	previewPptxConvertLossShape_one: "{{count}} shape, left out",
	/** Converted copy — as previewPptxConvertLossShape_one, for several */
	previewPptxConvertLossShape_other: "{{count}} shapes, left out",
	/** Converted copy — kept differently: slide backgrounds written in a nearer form */
	previewPptxConvertLossBackground_one: "{{count}} slide background, drawn in the nearest form",
	/** Converted copy — as previewPptxConvertLossBackground_one, for several */
	previewPptxConvertLossBackground_other: "{{count}} slide backgrounds, drawn in the nearest form",
	/** Converted copy — kept differently: a slide size the copy's format cannot hold, set to the nearest it can (the content keeps its place) */
	previewPptxConvertLossSlideSize: "The slide size, set to the nearest the copy can hold",
	/** Converted copy — kept differently: slide show settings the copy's format has no form for */
	previewPptxConvertLossShowSettings: "Some slide show settings, left out",
	/** Converted copy — kept differently: the file's digital signature, which a new file cannot keep */
	previewPptxConvertLossSignature: "Its digital signature, which a new file can't keep",
	/** Converted copy — kept differently: the password asked before changes, which the copy does not keep */
	previewPptxConvertLossWriteReservation: "The password asked before changing it, which the copy doesn't keep"
} as const

// "preview" namespace, presentation slideshow: drawing on slides during a show (pen, highlighter, laser pointer,
// eraser) and keeping the ink afterwards. Spread into preview.ts; same catalog rules.
export const previewPptxInk = {
	/** Presentation slideshow — accessible name of the toolbar with the pen, highlighter, laser pointer and eraser */
	previewPptxInkTools: "Pointer and ink",
	/** Presentation slideshow — the normal pointer: clicks go to the next slide, nothing is drawn */
	previewPptxInkArrow: "Arrow",
	/** Presentation slideshow — draw on the slide */
	previewPptxInkPen: "Pen",
	/** Presentation slideshow — draw translucent highlights on the slide */
	previewPptxInkHighlighter: "Highlighter",
	/** Presentation slideshow — a red dot that follows the pointer, for the audience to see */
	previewPptxInkLaser: "Laser pointer",
	/** Presentation slideshow — remove ink strokes by touching them */
	previewPptxInkEraser: "Eraser",
	/** Presentation slideshow — remove every ink stroke on the current slide */
	previewPptxInkEraseAll: "Erase all ink on slide",
	/** Presentation slideshow — accessible name of the ink colour choices */
	previewPptxInkColor: "Ink color",
	/** Presentation slideshow — ink colour */
	previewPptxInkColorRed: "Red",
	/** Presentation slideshow — ink colour */
	previewPptxInkColorBlue: "Blue",
	/** Presentation slideshow — ink colour */
	previewPptxInkColorGreen: "Green",
	/** Presentation slideshow — ink colour */
	previewPptxInkColorYellow: "Yellow",
	/** Presentation slideshow — ink colour */
	previewPptxInkColorBlack: "Black",
	/** Presentation slideshow — ink colour */
	previewPptxInkColorWhite: "White",
	/** Presentation slideshow — accessible name of the drawing surface over the slide while the pen or eraser is on */
	previewPptxInkLayer: "Drawing on the slide",
	/** Presentation slideshow — name of the group of ink shapes added to a slide when ink is kept (it appears in the file and the selection pane) */
	previewPptxInkGroupName: "Ink annotations",
	/** Presentation slideshow — question after a slideshow in which the presenter drew on slides */
	previewPptxInkKeepTitle: "Keep ink annotations?",
	/** Presentation slideshow — explains the question after a slideshow with ink */
	previewPptxInkKeepDescription: "The ink you drew during the slide show can be added to the slides as shapes.",
	/** Presentation slideshow — button: add the ink to the slides */
	previewPptxInkKeep: "Keep",
	/** Presentation slideshow — button: throw the ink away */
	previewPptxInkDiscard: "Discard",
	/** Presentation slideshow — error when the ink could not be added to the slides */
	previewPptxInkKeepFailed: "The ink could not be added to the slides.",
	/** Presentation slideshow — error when the ink of some slides could not be added; that ink stays for the next slideshow */
	previewPptxInkKeepPartial_one: "The ink on {{count}} slide could not be added. It stays for the next slide show.",
	/** Presentation slideshow — error when the ink of some slides could not be added; that ink stays for the next slideshow */
	previewPptxInkKeepPartial_other: "The ink on {{count}} slides could not be added. It stays for the next slide show."
}

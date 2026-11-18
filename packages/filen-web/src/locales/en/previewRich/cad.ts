// "preview" namespace, rich viewers — the CAD drawing viewer (dxf). Spread into preview.ts; same catalog rules.
export const previewRichCad = {
	/** CAD viewer — accessible name of the drawing's canvas */
	previewCadCanvasLabel: "Drawing",
	/** CAD viewer — toolbar: fit the whole drawing into view */
	previewCadFit: "Fit",
	/** CAD viewer — toolbar toggle: draw on a dark background instead of a light one */
	previewCadDarkBackground: "Dark background",
	/** CAD viewer — toolbar: show the file as text */
	previewCadShowSource: "View source",
	/** CAD viewer — back from the source to the drawing */
	previewCadShowDrawing: "View drawing",
	/** CAD viewer — toolbar: show or hide the layers panel */
	previewCadLayers: "Layers",
	/** CAD viewer — layers panel: accessible name of the list of the drawing's layers, each with a show/hide checkbox */
	previewCadLayerList: "Drawing layers",
	/** CAD viewer — layers panel: the layers past those listed, which are always shown */
	previewCadMoreLayers_one: "and {{count, number}} more layer",
	previewCadMoreLayers_other: "and {{count, number}} more layers",
	/** CAD viewer — notice over the drawing: some text uses characters none of the bundled fonts has */
	previewCadMissingGlyphs: "Some characters can't be shown.",
	/** CAD viewer — notice over the drawing: entities left out because they are malformed */
	previewCadSkipped_one: "{{count, number}} malformed object left out",
	previewCadSkipped_other: "{{count, number}} malformed objects left out",
	/** CAD viewer — the file is not a readable DXF drawing; shown with Download and View source */
	previewCadUnreadable: "This file couldn't be read as a drawing.",
	/** CAD viewer — the drawing has nothing to draw; shown with Download and View source */
	previewCadEmpty: "There's nothing to draw in this file.",
	/** CAD viewer — the drawing would take more geometry than the viewer builds; shown with Download and View source */
	previewCadTooComplex: "This drawing is too complex to display.",
	/** CAD viewer — the browser gives the viewer no WebGL; shown with Download and View source */
	previewCadNoWebgl: "This browser can't display drawings here."
} as const

export { paintMatches, type PaintedMatches } from "./highlight"
export {
	PdfPageColumn,
	PdfPages,
	pdfTextLayerVars,
	PDF_MAX_PAGE_CANVAS_BYTES,
	type PdfPageOverlay,
	type PdfPagesBinding,
	type PdfPagesClassNames,
	type PdfPagesFind,
	type PdfPagesProps
} from "./PdfPages"
export type { PdfDomDocument, PdfJsDom, PdfTextLayer, PdfTextLayerParams } from "./types"
export { usePdfDocument, type PdfDocumentHandle, type PdfDocumentOptions, type PdfDocumentState } from "./usePdfDocument"
export { usePdfViewer, type PdfViewer } from "./usePdfViewer"

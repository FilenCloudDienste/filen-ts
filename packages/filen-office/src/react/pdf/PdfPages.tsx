import { PdfPageColumn } from "./pageColumn"

// The viewer's page column over a pdf.js document: the shared column (pageColumn.tsx), which the editor's MuPDF pages
// (react/pdfedit PdfEditPages) use too.
export const PdfPages = PdfPageColumn

export {
	PdfPageColumn,
	pdfTextLayerVars,
	PDF_MAX_PAGE_CANVAS_BYTES,
	type PdfPageOverlay,
	type PdfPagesBinding,
	type PdfPagesClassNames,
	type PdfPagesFind,
	type PdfPagesProps
} from "./pageColumn"

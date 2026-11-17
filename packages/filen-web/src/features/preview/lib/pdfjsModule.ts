import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer } from "pdfjs-dist"
import type { PdfJsDom } from "@filen/office/react/pdf"

// Only what the viewer uses, so the rest of pdf.js's exports stay out of the bundle.
export const PDFJS: PdfJsDom = { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer }

import { lazy, Suspense, type ReactNode } from "react"
import { PreviewLoading } from "@/features/preview/components/previewErrorState"

// Lazy chunks: pdf.js (~1MB+), docx-preview, CodeMirror (+ its per-language grammar chunks) and
// react-markdown only ever download once a file needing them is actually opened, never on the app's
// own initial bundle (image/video/audio all stream or buffer directly, no heavy renderer library
// involved). markdownViewer.tsx's own "view source" toggle lazy-imports CodeMirrorSource — the module
// TextViewer's chunk also pulls in, deduped by the bundler.
export const PdfViewer = lazy(() => import("@/features/preview/components/pdfViewer"))
export const DocxViewer = lazy(() => import("@/features/preview/components/docxViewer"))
export const TextViewer = lazy(() => import("@/features/preview/components/textViewer"))
export const MarkdownViewer = lazy(() => import("@/features/preview/components/markdownViewer"))
export const SpreadsheetViewer = lazy(() => import("@/features/spreadsheet/components/spreadsheetViewer"))

export function ViewerSuspense({ children }: { children: ReactNode }) {
	return <Suspense fallback={<PreviewLoading />}>{children}</Suspense>
}

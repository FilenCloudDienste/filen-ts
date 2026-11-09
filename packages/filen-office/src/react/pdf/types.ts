import type { PdfDocument, PdfJs, PdfViewport } from "../../dom/pdf/index"

// A document whose pages stream their text for the text layer.
export type PdfDomDocument = PdfDocument<ReadableStream>

// The pdf.js text layer: one span per text item, in item order (pdfjs-dist TextLayer).
export interface PdfTextLayer {
	render(): Promise<unknown>
	cancel(): void
	// Lays the spans out again for a new scale or turn, without reading the text again.
	update(params: { readonly viewport: PdfViewport }): void
	readonly textDivs: readonly HTMLElement[]
	readonly textContentItemsStr: readonly string[]
}

export interface PdfTextLayerParams {
	readonly textContentSource: ReadableStream
	readonly container: HTMLElement
	readonly viewport: PdfViewport
}

// The host's pdf.js module as the pages use it: the loader's part plus the text layer.
export interface PdfJsDom extends PdfJs<ReadableStream> {
	readonly TextLayer: new (params: PdfTextLayerParams) => PdfTextLayer
}

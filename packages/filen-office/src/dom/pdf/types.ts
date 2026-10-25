// The part of pdf.js (pdfjs-dist 6.3) the PDF viewer uses, typed structurally. The host passes its own pdf.js
// module in: the browser build with a real worker on web, the legacy build with an in-thread worker in a
// mobile WebView. This package never imports pdf.js, so neither build is bundled where the other is used,
// and a host's module is checked against these shapes where it is passed.

// pdf.js's PageViewport member for member, so a viewport passed back into pdf.js (the text layer) is accepted.
export interface PdfViewport {
	viewBox: number[]
	userUnit: number
	scale: number
	rotation: number
	offsetX: number
	offsetY: number
	transform: number[]
	width: number
	height: number
	// pdf.js types it Object, which this matches both ways.
	readonly rawDims: NonNullable<unknown>
	clone(params?: {
		scale?: number | undefined
		rotation?: number | undefined
		offsetX?: number | undefined
		offsetY?: number | undefined
		dontFlip?: boolean | undefined
	}): PdfViewport
	// [x, y]; pdf.js types the pair as any[].
	convertToViewportPoint(x: number, y: number): unknown[]
	convertToPdfPoint(x: number, y: number): unknown[]
}

export interface PdfRenderTask {
	readonly promise: Promise<unknown>
	cancel(): void
}

export interface PdfRenderParams {
	// An HTMLCanvasElement (typed loosely: this layer has no DOM types).
	readonly canvas?: unknown
	readonly viewport: PdfViewport
	readonly transform?: readonly number[] | undefined
}

export interface PdfTextContent {
	readonly items: readonly unknown[]
}

// `S` is what streamTextContent returns: a ReadableStream where the host has DOM types.
export interface PdfPage<S = unknown> {
	readonly userUnit: number
	// The page's own /Rotate (0, 90, 180 or 270).
	readonly rotate: number
	// `rotation` replaces the page's own /Rotate rather than adding to it.
	getViewport(params: { scale: number; rotation?: number }): PdfViewport
	render(params: PdfRenderParams): PdfRenderTask
	// The text content as a stream, for the text layer.
	streamTextContent(): S
	getTextContent(): Promise<PdfTextContent>
	getAnnotations(params: { intent: "display" }): Promise<unknown[]>
	cleanup(): unknown
}

export interface PdfDocument<S = unknown> {
	readonly numPages: number
	getPage(pageNumber: number): Promise<PdfPage<S>>
	getDestination(id: string): Promise<unknown[] | null>
	getPageIndex(ref: unknown): Promise<number>
	// The bookmarks tree (pdfOutline reads it); null without one.
	getOutline(): Promise<readonly unknown[] | null>
	// The Info dictionary as `info` (pdfDocumentInfo reads it).
	getMetadata(): Promise<{ readonly info: unknown }>
}

export interface PdfLoadingTask<S = unknown> {
	readonly promise: Promise<PdfDocument<S>>
	// (updatePassword: (password: string) => void, reason: number) => void; pdf.js types it as Function.
	onPassword: unknown
	destroy(): Promise<void>
}

export interface PdfRangeTransport {
	requestDataRange(begin: number, end: number): void
	onDataRange(begin: number, chunk: Uint8Array | null): void
	abort(): void
}

// getDocument's parameters this package sets (pdfDocumentParams).
export interface PdfDocumentParams {
	readonly data?: Uint8Array
	readonly range?: PdfRangeTransport
	readonly rangeChunkSize?: number
	readonly disableStream?: boolean
	readonly disableAutoFetch?: boolean
	readonly cMapUrl?: string
	readonly cMapPacked?: boolean
	readonly standardFontDataUrl?: string
	readonly wasmUrl?: string
	readonly iccUrl?: string
	readonly BinaryDataFactory?: unknown
	readonly useWorkerFetch?: boolean
	readonly useSystemFonts?: boolean
	readonly maxImageSize?: number
	readonly canvasMaxAreaInBytes?: number
	readonly enableXfa?: boolean
	readonly verbosity?: number
}

export interface PdfJs<S = unknown> {
	// Called with PdfDocumentParams only. Typed `unknown` as pdf.js's own parameter type names DOM classes this
	// layer cannot (its range transport); a method, so any pdf.js signature is accepted.
	getDocument(params: unknown): PdfLoadingTask<S>
	readonly GlobalWorkerOptions: { workerSrc: string }
	readonly PDFDataRangeTransport: new (length: number, initialData: Uint8Array | null) => PdfRangeTransport
}

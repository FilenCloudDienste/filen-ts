import type * as Mupdf from "mupdf"
import type { MupdfModule, PdfBitmapLike, PdfEngineFailure, PdfEngineRole } from "./protocol"
import type { TileRenderer } from "./render"
import type { SyncRangeReader } from "./stream"

// What a request handler works with: the engine's one open document and its byte reader. Handlers run one at a
// time on the worker's thread.

// A refusal a handler throws: answered with its failure, the engine stays usable.
export class PdfEngineRefusal extends Error {
	override readonly name = "PdfEngineRefusal"
	readonly failure: PdfEngineFailure

	constructor(failure: PdfEngineFailure, message: string = failure) {
		super(message)
		this.failure = failure
	}
}

export interface PdfEngineHost {
	// An ImageBitmap of RGBA pixels (createImageBitmap(new ImageData(...)) in a worker).
	toBitmap(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<PdfBitmapLike>
	// How long a byte read may wait in all (the range ports' stall timeout).
	readonly readDeadlineMs: number
	readonly now: () => number
	// Lets queued messages (cancels) in between requests.
	readonly yieldTask?: () => Promise<void>
	// Tiles' display lists kept.
	readonly maxDisplayLists?: number
}

export interface OpenDocument {
	readonly document: Mupdf.PDFDocument
	readonly reader: SyncRangeReader
	readonly renderer: TileRenderer
	readonly role: PdfEngineRole
}

export interface PdfEngineContext {
	readonly mupdf: MupdfModule
	readonly host: PdfEngineHost
	// The open document, or a "closed" refusal.
	open(): OpenDocument
	readonly current: OpenDocument | null
	setCurrent(open: OpenDocument | null): void
	// Bytes [offset, offset + length) of the open file, read through the same reader MuPDF uses (a fresh copy). For
	// checks of the raw file (a signature's byte ranges), in runs of a few MiB.
	readBytes(offset: number, length: number): Uint8Array
	// The wasm memory's size in bytes.
	heapBytes(): number
}

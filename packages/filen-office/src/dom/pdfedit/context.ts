import type * as Mupdf from "mupdf"
import type { PdfMemoryProfile } from "../../core/pdfedit/budget"
import type { MupdfFormat } from "./formats"
import type { ReadFontSource } from "./readFonts"
import type { MupdfModule, PdfBitmapLike, PdfEngineFailure, PdfEngineRole } from "./protocol"
import type { PdfEditSession } from "./editSession"
import type { TileRenderer } from "./render"
import type { SyncRangeReader } from "./stream"

// What a request handler works with: the engine's one open document and its byte reader. Handlers run one at a
// time on the worker's thread.

// Errors that leave MuPDF's heap untrustworthy: a wasm trap or abort, allocation failure, a stack overflow.
export function isFatalEngineError(error: unknown): boolean {
	if (error === "ABORT") return true
	if (!(error instanceof Error)) return false
	if (error.name === "RuntimeError" || error instanceof RangeError) return true

	return /out of memory|malloc|memory access out of bounds|cannot create mupdf context/i.test(error.message)
}

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
	// Where the read role's fallback faces come from (readFonts.ts); without it, text no embedded face covers shows as
	// missing glyphs.
	readonly readFonts?: ReadFontSource
}

export interface OpenDocument {
	readonly document: Mupdf.PDFDocument
	readonly reader: SyncRangeReader
	readonly renderer: TileRenderer
	readonly role: PdfEngineRole
	// The editor's bookkeeping (role "edit", once the document is unlocked).
	readonly edit: PdfEditSession | null
	// A written save the document was opened on in place (its bytes live in the heap, not behind the reader).
	readonly heap: Mupdf.Buffer | null
	// The file the editor's history starts at, when it is a written save in the heap; null: the file behind the reader.
	readonly base: Mupdf.Buffer | null
	// The bytes `document` reads from, when they are a buffer in the heap (a written save opened in place, or the base
	// a step back rebuilt it from); absent or null: the file behind the reader.
	readonly source?: Mupdf.Buffer | null
	// The edit role's memory profile, as the open asked (the editor's bookkeeping takes it once the document unlocks).
	readonly memory?: PdfMemoryProfile
}

// A document the read role opened (formats.ts). Its renderer and generation change with each layout.
export interface ReadDocument {
	readonly document: Mupdf.Document
	readonly format: MupdfFormat
	// The byte reader of a document read through a channel; null for one opened from its whole bytes.
	readonly reader: SyncRangeReader | null
	readonly renderer: TileRenderer
	// The layout generation every read request names (0 after open).
	readonly generation: number
	readonly memory: PdfMemoryProfile
	readonly maxImagePixels: number
	// Undoes what the open installed in the module (the font hook).
	readonly release: () => void
}

export interface PdfEngineContext {
	readonly mupdf: MupdfModule
	readonly host: PdfEngineHost
	// The open PDF, or a refusal: "closed" when nothing is open, "badRequest" when a read document is.
	open(): OpenDocument
	readonly current: OpenDocument | null
	setCurrent(open: OpenDocument | null): void
	// The open read document, or a refusal: "closed" when nothing is open, "badRequest" when a PDF is.
	openRead(): ReadDocument
	readonly reading: ReadDocument | null
	setReading(read: ReadDocument | null): void
	// Bytes [offset, offset + length) of the open file, read through the same reader MuPDF uses (a fresh copy). For
	// checks of the raw file (a signature's byte ranges), in runs of a few MiB.
	readBytes(offset: number, length: number): Uint8Array
	// The wasm memory's size in bytes.
	heapBytes(): number
}

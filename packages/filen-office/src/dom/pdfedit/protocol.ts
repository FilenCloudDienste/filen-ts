import type * as Mupdf from "mupdf"
import type { SyncRangePort } from "./syncRange"

// What a page and a PDF engine worker (MuPDF) say to each other. Requests carry an id and get exactly one answer;
// the worker also posts events (a render started, the engine was poisoned). Everything is plain data; bitmaps and
// ports are transferred and typed structurally (the module builds without the DOM library).

// The MuPDF module as the host imports it and passes in; this package only imports its types.
export type MupdfModule = typeof Mupdf

// "edit": the document a user changes. "verify": opened read-only to check a file (signatures, a saved output);
// it never saves and never changes the document.
export type PdfEngineRole = "edit" | "verify"

// The bytes the engine reads: a sync range buffer (syncRange.ts) and the port its server listens on.
export interface PdfByteChannel {
	readonly buffer: SharedArrayBuffer
	readonly port: SyncRangePort
	readonly length: number
}

// An ImageBitmap, transferred; whoever holds it last closes it.
export interface PdfBitmapLike {
	readonly width: number
	readonly height: number
	close(): void
}

export type PdfEngineFailure =
	// The file is not a PDF MuPDF can open.
	| "notPdf"
	// The document is encrypted and no correct password was given.
	| "needsPassword"
	// A byte read failed, timed out or was aborted; the document stays open for the next request.
	| "readFailed"
	// A wasm trap, out of memory or an internal abort: the engine refuses everything from now on.
	| "poisoned"
	// Cancelled by the page before it ran.
	| "cancelled"
	// No document is open, or the engine is closing.
	| "closed"
	// The request was malformed or not allowed in this role.
	| "badRequest"
	// MuPDF refused it (a damaged object, an unsupported feature).
	| "failed"

export type PdfPermission = "print" | "printHq" | "copy" | "edit" | "annotate" | "form" | "assemble" | "accessibility"

export interface PdfDocumentSummary {
	readonly pageCount: number
	// Revisions in the file (incremental updates add one each).
	readonly versions: number
	// MuPDF rebuilt a broken cross-reference table (it read the whole file to do so).
	readonly repaired: boolean
	// "PDF 1.7" and the like.
	readonly format: string
	// "None", or the method ("Standard V5 R6 256-bit AES" and the like).
	readonly encryption: string
	readonly permissions: Readonly<Record<PdfPermission, boolean>>
}

export type PdfOpenResult =
	{ readonly status: "open"; readonly document: PdfDocumentSummary; readonly access: PdfAccess } | { readonly status: "password" }

// What the accepted password unlocked: an owner password lifts the document's restrictions.
export type PdfAccess = "none" | "user" | "owner"

export interface PdfPageInfo {
	// Points, after the page's own /Rotate (MuPDF's page space).
	readonly width: number
	readonly height: number
	readonly label: string
}

// A rectangle in device pixels of the page at the render's scale and rotation: [x0, y0, x1, y1].
export type PdfTile = readonly [number, number, number, number]

export type PdfRenderPriority = "visible" | "overlay" | "thumbnail" | "prefetch"

export interface PdfRenderArgs {
	readonly page: number
	// Device pixels per point.
	readonly scale: number
	// View rotation added to the page's own, clockwise: 0, 90, 180 or 270.
	readonly rotation: 0 | 90 | 180 | 270
	readonly tile: PdfTile
	readonly priority: PdfRenderPriority
}

export interface PdfRenderValue {
	readonly bitmap: PdfBitmapLike
	// The tile drawn, clamped to the page.
	readonly tile: PdfTile
}

export interface PdfHeapReport {
	// The wasm memory's size: its high-water mark, as wasm memory never shrinks.
	readonly heapBytes: number
}

// Every request: its arguments and its answer's value. A new request is one entry here and one in the server's
// request table (requests.ts).
export interface PdfEngineOps {
	open: {
		readonly args: { readonly channel: PdfByteChannel; readonly role: PdfEngineRole; readonly password?: string }
		readonly value: PdfOpenResult
	}
	authenticate: { readonly args: { readonly password: string }; readonly value: PdfOpenResult }
	pages: { readonly args: { readonly from: number; readonly count: number }; readonly value: readonly PdfPageInfo[] }
	render: { readonly args: PdfRenderArgs; readonly value: PdfRenderValue }
	// Drops a page's cached display list (the page left the view).
	evict: { readonly args: { readonly pages: readonly number[] }; readonly value: null }
	heap: { readonly args: Record<string, never>; readonly value: PdfHeapReport }
	close: { readonly args: Record<string, never>; readonly value: PdfHeapReport }
}

export type PdfEngineOp = keyof PdfEngineOps
export type PdfEngineArgs<K extends PdfEngineOp> = PdfEngineOps[K]["args"]
export type PdfEngineValue<K extends PdfEngineOp> = PdfEngineOps[K]["value"]

export type ToPdfEngine =
	| { readonly t: "call"; readonly id: number; readonly op: PdfEngineOp; readonly args: unknown }
	// Cancels requests still queued (a render scrolled out of view); one already running finishes.
	| { readonly t: "cancel"; readonly ids: readonly number[] }

export type FromPdfEngine =
	| { readonly t: "ok"; readonly id: number; readonly value: unknown }
	| { readonly t: "error"; readonly id: number; readonly failure: PdfEngineFailure; readonly message: string }
	// A render began: the page's watchdog times it from here.
	| { readonly t: "started"; readonly id: number }
	| { readonly t: "poisoned"; readonly message: string }

export function isFromPdfEngine(data: unknown): data is FromPdfEngine {
	if (typeof data !== "object" || data === null) return false

	const t: unknown = Reflect.get(data, "t")

	return t === "ok" || t === "error" || t === "started" || t === "poisoned"
}

export function isToPdfEngine(data: unknown): data is ToPdfEngine {
	if (typeof data !== "object" || data === null) return false

	const t: unknown = Reflect.get(data, "t")

	if (t === "cancel") return Array.isArray(Reflect.get(data, "ids"))

	return t === "call" && typeof Reflect.get(data, "id") === "number" && typeof Reflect.get(data, "op") === "string"
}

// The compiled MuPDF module handed to a starting engine worker (posted before anything else).
export const PDF_ENGINE_WASM = "filen.pdfEngine.wasm"

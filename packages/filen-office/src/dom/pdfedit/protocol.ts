import type * as Mupdf from "mupdf"
import type { PdfMemoryProfile } from "../../core/pdfedit/budget"
import type { PdfSavePlan, PdfSaveRefusal } from "../../core/pdfedit/savePlan"
import type { PdfCommandResult, PdfEditState, PdfPageWidgets } from "../../core/pdfedit/state"
import type { PdfSignatureReport } from "../../core/pdfsign/types"
import type { PdfSignatureFieldHint } from "../pdf/signatureFields"
import type { SyncRangePort } from "./syncRange"
import type { PdfPageText } from "./text"

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
	// The document does not allow the change (a read-only or signature-locked field, the author's restrictions).
	| "notAllowed"
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
	// The open document's signatures checked on its raw bytes. `fields` are what a second parser (pdf.js) found, null
	// when it could not tell. Served by a worker that registers verifySignaturesRequest (verifyRequest.ts).
	verifySignatures: {
		readonly args: { readonly fields: readonly PdfSignatureFieldHint[] | null }
		readonly value: PdfSignatureReport
	}
	// --- The edit role ---
	// The document as the editor reports it.
	state: { readonly args: Record<string, never>; readonly value: PdfEditState }
	// The widgets of these 0-based pages.
	widgets: { readonly args: { readonly pages: readonly number[] }; readonly value: readonly PdfPageWidgets[] }
	// One command (commands/index.ts) as one journal operation.
	dispatch: {
		readonly args: { readonly command: string; readonly args: unknown; readonly op?: PdfCommandOp }
		readonly value: PdfCommandResult
	}
	undo: { readonly args: Record<string, never>; readonly value: PdfCommandResult }
	redo: { readonly args: Record<string, never>; readonly value: PdfCommandResult }
	// A save: planned (core/pdfedit/savePlan.ts), then written into the heap and held there until saveEnd.
	saveBegin: {
		readonly args: {
			readonly inputBytes: number
			readonly memory: PdfMemoryProfile
			readonly invalidateConfirmed: boolean
		}
		readonly value: PdfSaveBegun
	}
	// Serves the held output's bytes on a sync range channel (to a verifying engine), until saveEnd.
	serveOutput: { readonly args: { readonly buffer: SharedArrayBuffer; readonly port: SyncRangePort }; readonly value: null }
	// Streams the held output to an upload over a save port (@filen/shared/savePort) and answers whether the upload
	// made the file.
	writeOutput: { readonly args: { readonly port: unknown }; readonly value: { readonly uploaded: boolean } }
	// Ends a save: the upload made the file a new version of the document's file ("saved"), a new file beside it
	// ("copied"), or nothing ("failed"). The held output is dropped, or adopted as the document after "saved".
	saveEnd: { readonly args: { readonly outcome: PdfSaveOutcome; readonly next: PdfAfterSave }; readonly value: PdfSaveEnded }
	// --- Any role ---
	// A page's text lines and links (the text layer, find, links after the swap).
	text: { readonly args: { readonly page: number }; readonly value: PdfPageText }
	// Where a named destination or a page object leads: a 0-based page and a point in its bottom-left user space; null
	// when nowhere.
	destination: {
		readonly args: { readonly name: string } | { readonly pageObject: number }
		readonly value: PdfDestinationPoint | null
	}
	// --- The verify role, on a written file (opened, and unlocked with the document's password) ---
	checkSaved: { readonly args: PdfSaveExpectation; readonly value: PdfSaveCheck }
}

// A step of a drag or another gesture: the steps sharing an id are one journal operation, ended by the step with
// `final` (or by any other change, undo, redo or save).
export interface PdfCommandOp {
	readonly id: string
	readonly final: boolean
}

// A save, written into the engine's heap before anything leaves it.
export type PdfSaveBegun =
	// `versions`: the revisions the written file has (what checkSaved expects).
	| { readonly status: "written"; readonly plan: PdfSavePlan; readonly size: number; readonly versions: number }
	| { readonly status: "refused"; readonly plan: PdfSavePlan; readonly reason: PdfSaveRefusal }

// What a written file must be: verification after a save opens it in another engine and checks it.
export interface PdfSaveExpectation {
	readonly pageCount: number
	readonly versions: number
	// The encryption method, as PdfDocumentSummary gives it ("None" when not encrypted).
	readonly encryption: string
}

export type PdfSaveCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

// How the session goes on after a save: with its undo history ("continue": a step back past the save opens the file the
// history starts at again, which must stay readable), or starting again on the written file held in the heap ("adopt":
// where the old file may go). An incremental save always goes on on the written file, opened in place.
export type PdfAfterSave = "continue" | "adopt"

export type PdfSaveOutcome = "saved" | "copied" | "failed"

export interface PdfDestinationPoint {
	readonly page: number
	readonly left: number | null
	readonly top: number | null
}

export interface PdfSaveEnded {
	readonly state: PdfEditState
	// The heap's high-water mark: a caller replaces an engine past its respawn threshold.
	readonly heapBytes: number
	// Whether the undo history survived.
	readonly history: "kept" | "reset"
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

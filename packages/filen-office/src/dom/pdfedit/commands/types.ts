import type * as Mupdf from "mupdf"
import type { PdfSignatureState, PdfToolClass } from "../../../core/pdfedit/signaturePolicy"
import type { MupdfModule } from "../protocol"

// The editor's commands: each feature module exports a table of them (commands/<feature>.ts), composed in
// commands/index.ts. A command is one journal operation (the dispatch request opens and ends it around `run`, and
// abandons it when `run` throws), so one undo step reverts it whole. It changes the document only through MuPDF,
// checks its own arguments (they arrive as structured-cloned data), refuses what the document does not allow with a
// PdfEngineRefusal, and reports the 0-based pages whose rendering changed.

export interface PdfCommandContext {
	readonly mupdf: MupdfModule
	readonly document: Mupdf.PDFDocument
	readonly signatures: PdfSignatureState
	// The page at `index`, loaded once per command (MuPDF keeps its annotations' objects with it).
	page(index: number): Mupdf.PDFPage
	// The 0-based index of the page with object number `pageObject`.
	pageOf(pageObject: number): number | undefined
	readonly now: () => Date
}

export interface PdfCommand<A> {
	// The kind of change, for the signature policy and the save planner.
	readonly tool: PdfToolClass
	// The arguments when well-formed, else null (answered "badRequest").
	parse(args: unknown): A | null
	run(context: PdfCommandContext, args: A): readonly number[]
}

// A feature's commands, by name ("<feature>.<command>"), from its argument map.
export type PdfCommandTable<M> = { readonly [K in keyof M]: PdfCommand<M[K]> }

// --- Argument checks shared by the feature modules ---

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
}

// A string of at most `max` UTF-16 code units.
export function isText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max
}

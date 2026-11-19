import type * as Mupdf from "mupdf"
import type { PdfSignatureState, PdfToolClass } from "../../../core/pdfedit/signaturePolicy"
import { PdfEngineRefusal } from "../context"
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

// A command that makes an object the page then selects (an annotation) reports it beside the pages it touched.
export interface PdfCommandOutcome {
	readonly pages: readonly number[]
	readonly created: { readonly page: number; readonly id: number }
}

// The pages a command's outcome touched.
export function outcomePages(outcome: readonly number[] | PdfCommandOutcome): readonly number[] {
	return "created" in outcome ? outcome.pages : outcome
}

export interface PdfCommand<A> {
	// The kind of change, for the signature policy and the save planner.
	readonly tool: PdfToolClass
	// The kind of change the save planner counts it as, when other than `tool` (which decides whether it may run).
	readonly saves?: PdfToolClass
	// It removes content from the file (deleted pages, redacted, cropped-away or replaced content, ...): a save in place
	// leaves the removed content in the file's earlier versions, which the user is told.
	readonly removesContent?: true
	// The argument holding the object number of the annotation (or widget) on the arguments' `page` it works on: the
	// history logs it by name instead (stepKeys.ts), and a run again finds it by that name.
	readonly target?: "id" | "widget"
	// The bytes it adds to the document (a picture, a page's file): counted against the size the editor edits.
	bytes?(args: A, mupdf: MupdfModule): number
	// The arguments when well-formed, else null (answered "badRequest").
	parse(args: unknown): A | null
	run(context: PdfCommandContext, args: A): readonly number[] | PdfCommandOutcome
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

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

// An array of `length` finite numbers, each within `min`..`max`.
export function isFiniteTuple(value: unknown, length: number, min = -Infinity, max = Infinity): value is readonly number[] {
	return Array.isArray(value) && value.length === length && value.every(item => isFiniteNumber(item) && item >= min && item <= max)
}

export function parseRect(value: unknown, min?: number, max?: number): [number, number, number, number] | null {
	if (!isFiniteTuple(value, 4, min, max)) return null

	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = value

	return [x0, y0, x1, y1]
}

export function parseQuad(value: unknown): [number, number, number, number, number, number, number, number] | null {
	if (!isFiniteTuple(value, 8)) return null

	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = value

	return [a, b, c, d, e, f, g, h]
}

// A colour: three components, each 0..1.
export function parseRgb(value: unknown): [number, number, number] | null {
	if (!isFiniteTuple(value, 3, 0, 1)) return null

	const [r = 0, g = 0, b = 0] = value

	return [r, g, b]
}

// The most pages one command names.
export const MAX_PAGES = 100_000

// A non-empty list of at most MAX_PAGES page indices.
export function isPageList(value: unknown): value is readonly number[] {
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_PAGES && value.every(isIndex)
}

// The arguments of a command that takes none: an empty record.
export function parseNoArgs(args: unknown): Record<string, never> | null {
	return isRecord(args) && Object.keys(args).length === 0 ? {} : null
}

// Whether `page` is the index of one of the document's pages.
export function isPageOf(document: { countPages(): number }, page: unknown): page is number {
	return isIndex(page) && page < document.countPages()
}

// Refuses ("badRequest", with `message` when given) a page the document does not have.
export function checkPage(document: { countPages(): number }, page: unknown, message?: string): asserts page is number {
	if (!isPageOf(document, page)) throw new PdfEngineRefusal("badRequest", message)
}

// A command's page check: refused as "no such page".
export function requirePage(context: PdfCommandContext, page: number): void {
	checkPage(context.document, page, "no such page")
}

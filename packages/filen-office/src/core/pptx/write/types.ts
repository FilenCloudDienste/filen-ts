import type { ByteSink, OpcPackage, PartBytes, Slicing, WriteZipReport, ZipArchive, ZipChanges } from "../../opc/index"
import type { XmlDocument, XmlEditor } from "../../xml/index"
import type { DeckChanges, Touch } from "../../presentation/edit/apply"
import type { Deck, Refused, ShapeNode, SlideNode, SlideRef } from "../../presentation/model"

// The interfaces of the pptx writers: the splice writer (same-format source, write/splice.ts), the parts it adds
// and removes (write/parts.ts), the fresh writer (write/fresh.ts) and the save (write/save.ts). Every touched part
// gets one XmlEditor; untouched parts are copied as their raw zip entries.

// What a family may add to the package.
export type PptxPartKind =
	| "slide"
	| "notesSlide"
	| "slideLayout"
	| "slideMaster"
	| "theme"
	| "image"
	| "media"
	| "chart"
	| "chartStyle"
	| "chartColors"
	| "embeddedWorkbook"
	| "diagramData"
	| "diagramLayout"
	| "diagramStyle"
	| "diagramColors"
	| "diagramDrawing"
	| "comments"
	| "commentAuthors"
	| "font"
	| "other"

// The package as the writer edits it, scoped to the part being emitted: added parts are related from it.
export interface PartsApi {
	// The part the emit is for.
	readonly owner: string
	// A new part with a non-colliding name for its kind (slideN with the next free N…), its content type in
	// [Content_Types].xml, and a relationship from `owner` with the next free rId.
	addPart(kind: PptxPartKind, content: PartBytes, contentType: string): { readonly part: string; readonly rId: string }
	// A relationship from `owner` to an existing part (or an external target), reused when one exists.
	relate(target: string, type: string, external?: boolean): string
	// The part `rId` of `owner` names, undefined when none.
	target(rId: string): string | undefined
	// Removes a part with its relationships; references to it are the integrity graph's (edit/integrity.ts).
	removePart(part: string): void
	// The one editor of a touched part (opened on first use).
	editor(part: string): XmlEditor
}

// One piece of emitted markup: text, bytes, or a source node copied by span (a hole: unknown children of an edited
// element keep their bytes and their order).
export type EmitPiece = string | Uint8Array | { readonly hole: number }

export type EmitResult = { readonly kind: "markup"; readonly pieces: readonly EmitPiece[] } | { readonly kind: "unchanged" } | Refused

// What one emit writes: the element of `shape` (or the slide node itself without one) as the model now holds it,
// the touch saying how much of it is dirty.
export interface EmitRequest {
	readonly slide: SlideNode
	readonly shape?: ShapeNode
	readonly touch: Touch
}

export interface PptxEmitContext {
	readonly deck: Deck
	// The source part the element is spliced into; undefined for a new part.
	readonly document: XmlDocument | undefined
	readonly parts: PartsApi
}

export interface PptxEmitFamily {
	emit(request: EmitRequest, context: PptxEmitContext): EmitResult
}

// The source a save copies from: the archive over the base ByteSource and its package.
// What the writer needs of the open deck's part map (PptxParts has it): a node's part ("/ppt/slides/slide3.xml"),
// a slide's p:sldId, the node a part is, and the base source's generation.
export interface PptxPartIndex {
	partOf(ref: SlideRef): string | undefined
	slideId(ref: SlideRef): number | undefined
	refOf(part: string): SlideRef | undefined
	readonly epoch: number
}

export interface PptxSource {
	readonly archive: ZipArchive
	readonly package: OpcPackage
	// The open deck's part map (engine: session.parts); without it only parsed slides are known.
	readonly index?: PptxPartIndex
}

// A save at revision R: the changes against the saved state, and the deck they apply to.
export interface PptxSaveInput {
	readonly deck: Deck
	readonly source: PptxSource
	readonly changes: DeckChanges
	readonly revision: number
}

export interface PptxSaveOptions {
	readonly slicing?: Slicing
	// Entries over this size are planned as streamed copies (the 64 MiB in-memory proof threshold).
	readonly inMemoryLimit?: number
	// Raw deflate for new content where the host has a faster one.
	readonly deflate?: (data: Uint8Array) => Promise<Uint8Array>
}

export type PptxSaveOutcome =
	{ readonly kind: "unchanged" } | { readonly kind: "written"; readonly report: WriteZipReport; readonly revision: number } | Refused

// The splice writer: the `data` parts of a save serialized at the snapshot (before any copy streams), then the zip.
export interface SpliceWriter {
	// Serializes every changed part at revision R (bounded by the changed parts' size). Async, so the engine runs it with
	// commands queued until it ends: a snapshot never interleaves with an op.
	snapshot(input: PptxSaveInput): Promise<PptxSnapshot | Refused>
	write(snapshot: PptxSnapshot, sink: ByteSink, options: PptxSaveOptions): Promise<PptxSaveOutcome>
}

export interface PptxSnapshot {
	readonly revision: number
	// Parts replaced, removed and added (PartBytes, so an inserted stored medium streams with its expected CRC-32).
	readonly changes: ZipChanges
	// Copies the plan expects (n − changed), checked against WriteZipReport.copies.
	readonly copies: number
}

export type SavePptx = (input: PptxSaveInput, sink: ByteSink, options: PptxSaveOptions) => Promise<PptxSaveOutcome>

// The whole package from the model, in deterministic order (conversions, templates, ppt and strict Save as).
export type FreshPptx = (deck: Deck, source: PptxSource | undefined, sink: ByteSink, options: PptxSaveOptions) => Promise<PptxSaveOutcome>

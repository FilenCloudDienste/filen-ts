import type { PartBytes } from "../../opc/index"
import type { XmlDocument, XmlEditor } from "../../xml/index"
import type { DeckOpFamily } from "../../presentation/edit/ops"
import type { Deck } from "../../presentation/model"
import type { EmitRequest, EmitResult } from "../../pptx/write/types"
import { emitOdpSlide } from "./emit/slide"
import { emitOdpShape } from "./emit/shape"
import { emitOdpText } from "./emit/text"
import { emitOdpTable } from "./emit/table"
import { emitOdpPicture } from "./emit/picture"
import { emitOdpChart } from "./emit/chart"
import { emitOdpMedia } from "./emit/media"
import { emitOdpNotes } from "./emit/notes"
import { emitOdpComment } from "./emit/comment"
import { emitOdpTiming } from "./emit/timing"
import { emitOdpTransition } from "./emit/transition"
import { emitOdpMotionPath } from "./emit/motionPath"
import { emitOdpDesign } from "./emit/design"
import { emitOdpSmartArt } from "./emit/smartart"
import { emitOdpInk } from "./emit/ink"
import { emitOdpMediaTiming } from "./emit/mediaTiming"
import { emitOdpPresentation } from "./emit/presentation"

// ODF presentation markup out of the model, by family, as the pptx emit (core/pptx/write/emit.ts): a touched
// draw:page is parsed as a fragment and spliced per element, so only edited shapes are written again.

// The automatic styles of the save (content.xml's office:automatic-styles, styles.xml's for master edits).
export interface OdpStylesApi {
	// A style holding `properties` (serialized style:*-properties markup), reused when one with the same markup exists;
	// new names never collide with the document's, and only styles something uses are written.
	automatic(
		family: "graphic" | "presentation" | "paragraph" | "text" | "drawing-page" | "table" | "table-cell",
		properties: string
	): string
	// A Pictures/ or media entry of the package, with its manifest entry; stored when `compress` is false (media),
	// streamed (PartBytes) and checked against `crc32` when given. Returns the entry's path.
	addEntry(
		path: string,
		content: PartBytes,
		mediaType: string,
		options?: { readonly compress?: boolean; readonly crc32?: number }
	): string
	// Whether the package written holds an entry at `path` (a source entry, or one this save added).
	hasEntry?(path: string): boolean
	// Replaces a source entry's bytes whole (a chart object's content.xml written again); false, changing nothing, when
	// the package has no such entry.
	replaceEntry?(path: string, content: PartBytes): boolean
}

export interface OdpEmitContext {
	readonly deck: Deck
	// The page fragment the element is spliced into (undefined for a new page) and its editor.
	readonly document: XmlDocument | undefined
	readonly editor: XmlEditor | undefined
	readonly styles: OdpStylesApi
	// The page's animated shapes that had no xml:id/draw:id, with the document-unique id the save gives them.
	readonly targetIds?: ReadonlyMap<number, string>
	// The text:p elements a by-paragraph effect targets that had no xml:id, with the document-unique id the save gives
	// them (by odpParagraphKey).
	readonly paragraphIds?: ReadonlyMap<string, string>
}

export interface OdpEmitFamily {
	emit(request: EmitRequest, context: OdpEmitContext): EmitResult
}

export const ODP_EMIT_FAMILIES: { readonly [F in DeckOpFamily]: OdpEmitFamily } = {
	slide: emitOdpSlide,
	shape: emitOdpShape,
	text: emitOdpText,
	table: emitOdpTable,
	picture: emitOdpPicture,
	chart: emitOdpChart,
	media: emitOdpMedia,
	notes: emitOdpNotes,
	comment: emitOdpComment,
	timing: emitOdpTiming,
	transition: emitOdpTransition,
	motionPath: emitOdpMotionPath,
	design: emitOdpDesign,
	smartart: emitOdpSmartArt,
	ink: emitOdpInk,
	mediaTiming: emitOdpMediaTiming,
	presentation: emitOdpPresentation
}

export function emitOdp(family: DeckOpFamily, request: EmitRequest, context: OdpEmitContext): EmitResult {
	return ODP_EMIT_FAMILIES[family].emit(request, context)
}

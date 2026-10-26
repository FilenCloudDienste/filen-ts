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
	// A Pictures/ or media entry of the package, with its manifest entry.
	addEntry(path: string, content: Uint8Array, mediaType: string): string
}

export interface OdpEmitContext {
	readonly deck: Deck
	// The page fragment the element is spliced into (undefined for a new page) and its editor.
	readonly document: XmlDocument | undefined
	readonly editor: XmlEditor | undefined
	readonly styles: OdpStylesApi
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
	mediaTiming: emitOdpMediaTiming
}

export function emitOdp(family: DeckOpFamily, request: EmitRequest, context: OdpEmitContext): EmitResult {
	return ODP_EMIT_FAMILIES[family].emit(request, context)
}

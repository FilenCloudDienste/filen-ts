import type { DeckOpFamily } from "../../presentation/edit/ops"
import type { EmitRequest, EmitResult, PptxEmitContext, PptxEmitFamily } from "./types"
import { emitPptxSlide } from "./emit/slide"
import { emitPptxShape } from "./emit/shape"
import { emitPptxText } from "./emit/text"
import { emitPptxTable } from "./emit/table"
import { emitPptxPicture } from "./emit/picture"
import { emitPptxChart } from "./emit/chart"
import { emitPptxMedia } from "./emit/media"
import { emitPptxNotes } from "./emit/notes"
import { emitPptxComment } from "./emit/comment"
import { emitPptxTiming } from "./emit/timing"
import { emitPptxTransition } from "./emit/transition"
import { emitPptxMotionPath } from "./emit/motionPath"
import { emitPptxDesign } from "./emit/design"
import { emitPptxSmartArt } from "./emit/smartart"
import { emitPptxInk } from "./emit/ink"
import { emitPptxMediaTiming } from "./emit/mediaTiming"

// PresentationML out of the model, by family: the splice writer asks the family that owns a dirty element
// (emitFamilyOf) for its markup, and proof gate 1 asks the same for an unedited one and compares it with the source.
// Each family's file is owned by one slice. Nested markup (a shape's text, a motion path inside p:timing, media
// timing inside p:pic's nvPr extLst) is written by calling emitPptx for the inner family at call time, never at
// module initialisation, so family files never depend on each other's evaluation order.

export const PPTX_EMIT_FAMILIES: { readonly [F in DeckOpFamily]: PptxEmitFamily } = {
	slide: emitPptxSlide,
	shape: emitPptxShape,
	text: emitPptxText,
	table: emitPptxTable,
	picture: emitPptxPicture,
	chart: emitPptxChart,
	media: emitPptxMedia,
	notes: emitPptxNotes,
	comment: emitPptxComment,
	timing: emitPptxTiming,
	transition: emitPptxTransition,
	motionPath: emitPptxMotionPath,
	design: emitPptxDesign,
	smartart: emitPptxSmartArt,
	ink: emitPptxInk,
	mediaTiming: emitPptxMediaTiming
}

export function emitPptx(family: DeckOpFamily, request: EmitRequest, context: PptxEmitContext): EmitResult {
	return PPTX_EMIT_FAMILIES[family].emit(request, context)
}

// The family whose emit writes `request`'s element: by shape kind and frame for a shape, by slide part for a slide.
export function emitFamilyOf(request: EmitRequest): DeckOpFamily {
	const { shape, touch } = request

	if (shape === undefined) {
		if (touch.kind !== "slide" || touch.dirt.kind !== "slidePart") return "slide"

		switch (touch.dirt.part) {
			case "timing":
				return "timing"
			case "transition":
				return "transition"
			case "background":
				return "design"
			default:
				return "slide"
		}
	}

	switch (shape.kind) {
		case "pic":
			return shape.media === undefined ? "picture" : "media"
		case "ink":
			return "ink"
		case "frame":
			switch (shape.frame?.kind) {
				case "table":
					return "table"
				case "chart":
					return "chart"
				case "smartart":
					return "smartart"
				case "media":
					return "media"
				default:
					return "shape"
			}
		default:
			return "shape"
	}
}

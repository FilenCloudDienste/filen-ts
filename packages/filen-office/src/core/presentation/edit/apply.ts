import type { Deck, Refused, SlideRef, SourceRef } from "../model"
import type { BatchOp, DeckOp, DeckOpFamily, FamilyOp, OpOf } from "./ops"
import { applyChart } from "./apply/chart"
import { applyComment } from "./apply/comment"
import { applyDesign } from "./apply/design"
import { applyInk } from "./apply/ink"
import { applyMedia } from "./apply/media"
import { applyMediaTiming } from "./apply/mediaTiming"
import { applyMotionPath } from "./apply/motionPath"
import { applyNotes } from "./apply/notes"
import { applyPicture } from "./apply/picture"
import { applyPresentation, SLIDE_LIST_SHOW_TOUCH, withFittedShowRange } from "./apply/presentation"
import { applyShape } from "./apply/shape"
import { applySlide } from "./apply/slide"
import { applySmartArt } from "./apply/smartart"
import { applyTable } from "./apply/table"
import { applyText } from "./apply/text"
import { applyTiming } from "./apply/timing"
import { applyTransition } from "./apply/transition"

// Applying ops to the model, in place, by family: each family's apply file owns its ops. The history
// (edit/history.ts) keeps each op's inverse; changes (edit/changes.ts) recomputes what differs from the saved state
// from the touches of the ops between them.

// How much of a node an op dirtied: its xfrm only, one property group, its text, one part of a slide (its background,
// p:timing, p:transition, header/footer flags, clrMapOvr, or its own attributes: show, hidden, name, showMasterSp),
// or the whole node. On a slide, `node` means only add, duplicate, restore and setLayout: a whole-p:sld rewrite.
export type Dirt =
	| { readonly kind: "xfrm" }
	| { readonly kind: "props"; readonly group: "geometry" | "fill" | "ln" | "effects" | "bodyPr" | "style" }
	| { readonly kind: "text" }
	| { readonly kind: "slidePart"; readonly part: "background" | "timing" | "transition" | "hf" | "clrMapOvr" | "attributes" }
	| { readonly kind: "node" }

// What an op touches: a shape of a slide, a slide node, a presentation-level part, or a part added or removed.
export type Touch =
	| { readonly kind: "shape"; readonly slide: SlideRef; readonly shape: number; readonly dirt: Dirt }
	| { readonly kind: "slide"; readonly slide: SlideRef; readonly dirt: Dirt }
	| { readonly kind: "presentation"; readonly what: "slideList" | "sections" | "customShows" | "size" | "defaults" | "show" | "authors" }
	| { readonly kind: "part"; readonly part: string; readonly change: "added" | "removed" | "changed" }

// What an op held back to undo it: the ops that restore the state before it, in order, and the bytes they hold
// (source subtrees serialized at apply time, never node ids into a parsed part) for history accounting.
export interface Inverse {
	readonly ops: readonly DeckOp[]
	readonly bytes: number
}

// `op` is the op as applied: the refs and ids apply allocated filled in (slide.add's ref, a new shape's id, an addNode
// modelId), so history redoes exactly it and later ops in history still name what it made.
export type ApplyResult<O extends DeckOp = DeckOp> = { readonly kind: "applied"; readonly inverse: Inverse; readonly op: O } | Refused

export interface ApplyContext {
	// The source subtree `src` names, serialized now (an inverse holds bytes so it survives a rebase); refused as stale
	// when `src` is of another epoch than the base source's.
	sourceBytes(src: SourceRef): Uint8Array | Refused
	// A cNvPr id not used on `slide`.
	newShapeId(slide: SlideRef): number
	// A slide reference never used in the session.
	newSlideRef(): SlideRef
}

export interface ApplyFamily<O extends DeckOp> {
	// Every node the op touches is parsed (model.ts: parse before touch).
	apply(deck: Deck, op: O, context: ApplyContext): ApplyResult<O>
	// What the op touches, without applying it (for changes and for the page's invalidation).
	touches(op: O): readonly Touch[]
}

// What differs between the current history node and the saved state, recomputed from the net effect of the ops
// between them (an op followed by its inverse cancels out): per touched part, its nodes and their dirt.
export interface DeckChanges {
	readonly empty: boolean
	readonly parts: ReadonlyMap<string, PartChanges>
	readonly presentation: ReadonlySet<Extract<Touch, { kind: "presentation" }>["what"]>
}

export interface PartChanges {
	readonly change: "added" | "removed" | "changed"
	// Shape id → its dirt (the largest wins: node > text > props > xfrm).
	readonly shapes: ReadonlyMap<number, Dirt>
	// The slide node itself (background, timing, transition, hidden…).
	readonly slide?: Dirt
}

type Families = { readonly [F in DeckOpFamily]: ApplyFamily<OpOf<F>> }

export const APPLY_FAMILIES: Families = {
	slide: applySlide,
	shape: applyShape,
	text: applyText,
	table: applyTable,
	picture: applyPicture,
	chart: applyChart,
	media: applyMedia,
	notes: applyNotes,
	comment: applyComment,
	timing: applyTiming,
	transition: applyTransition,
	motionPath: applyMotionPath,
	design: applyDesign,
	smartart: applySmartArt,
	ink: applyInk,
	mediaTiming: applyMediaTiming,
	presentation: applyPresentation
}

export function applyOp(deck: Deck, op: DeckOp, context: ApplyContext): ApplyResult {
	if (op.family === "batch") return applyBatch(deck, op, context)

	const family: ApplyFamily<FamilyOp> = APPLY_FAMILIES[op.family]

	const result = family.apply(deck, op, context)

	// A slide op keeps the show's slide range inside the deck.
	return op.family === "slide" ? withFittedShowRange(deck, result) : result
}

// Applies ops in order; on a refusal, what applied is undone in reverse and the refusal returned.
export function applyAll(
	deck: Deck,
	ops: readonly DeckOp[],
	context: ApplyContext
): { readonly inverses: Inverse[]; readonly applied: DeckOp[] } | Refused {
	const inverses: Inverse[] = []
	const applied: DeckOp[] = []

	for (const op of ops) {
		const result = applyOp(deck, op, context)

		if (result.kind === "refused") {
			for (let index = inverses.length - 1; index >= 0; index--) {
				for (const back of (inverses[index] as Inverse).ops) applyOp(deck, back, context)
			}

			return result
		}

		inverses.push(result.inverse)
		applied.push(result.op)
	}

	return { inverses, applied }
}

// A batch, all or nothing. Its inverse is its ops' inverses, the last op's first; as applied, it holds each op as
// applied.
function applyBatch(deck: Deck, op: BatchOp, context: ApplyContext): ApplyResult<BatchOp> {
	const result = applyAll(deck, op.ops, context)

	if ("kind" in result) return result

	const ops: DeckOp[] = []
	let bytes = 0

	for (let index = result.inverses.length - 1; index >= 0; index--) {
		const inverse = result.inverses[index] as Inverse

		ops.push(...inverse.ops)
		bytes += inverse.bytes
	}

	return { kind: "applied", inverse: { ops, bytes }, op: { family: "batch", kind: "batch", ops: result.applied } }
}

export function opTouches(op: DeckOp): readonly Touch[] {
	if (op.family === "batch") return op.ops.flatMap(each => opTouches(each))

	const family: ApplyFamily<FamilyOp> = APPLY_FAMILIES[op.family]

	const touches = family.touches(op)

	return op.family === "slide" ? [...touches, SLIDE_LIST_SHOW_TOUCH] : touches
}

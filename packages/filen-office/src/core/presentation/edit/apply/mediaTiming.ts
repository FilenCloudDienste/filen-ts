import {
	bookmarkProblem,
	bookmarkTriggers,
	holdsP14Media,
	normalizedMediaTiming,
	validFade,
	validTrim,
	withBookmark,
	writableBookmark,
	writableTrim,
	type MediaTiming
} from "../../../anim/media"
import { refused, type Deck, type MediaRef, type Refused, type ShapeNode, type SlideNode } from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Inverse, Touch } from "../apply"
import { cloneModel, digestOf, findShape } from "../changes"
import type { DeckOp, MediaTimingOp, OpOf } from "../ops"
import { type SourceReading } from "./shape"
import { isRefused } from "../../refusal"

// The media timing ops on the model, in place: a medium's trim, fade and bookmarks (MS-PPTX p14:media, written by
// core/pptx/write/emit/mediaTiming.ts). Each op replaces one group of the shape's MediaRef.timing. Its inverse is the
// shape's source markup (shape.restore) while the shape is still what that markup reads as, so an undo writes the
// source back byte for byte across saves; otherwise the op that sets the group back to its prior value. ODF has no
// form for any of them, and a PowerPoint 2007 medium (no p14:media) nowhere to hold them: both refuse.

interface Found {
	readonly node: SlideNode
	readonly shape: ShapeNode
	readonly media: MediaRef
}

function mediaShape(deck: Deck, target: { readonly slide: SlideNode["ref"]; readonly id: number }, context: ApplyContext): Found | Refused {
	if (deck.format === "odp") return refused("unsupported", "an OpenDocument presentation has no media trim, fade or bookmarks")

	const node = deck.nodes.get(target.slide)

	if (node === undefined) return refused("notFound", `slide ${String(target.slide)} is not parsed`)

	const shape = findShape(node.shapes, target.id)?.shape

	if (shape === undefined) return refused("notFound", `shape ${String(target.id)}`)

	const media = shape.media ?? (shape.frame?.kind === "media" ? shape.frame.media : undefined)

	if (media === undefined) return refused("unsupported", `shape ${String(target.id)} plays no medium`)
	if (media.part === undefined) return refused("unsupported", "a linked medium is never played here")
	if (shape.kind !== "pic") return refused("unsupported", "the timing of a medium in a graphic frame")
	if (shape.lock !== undefined) return refused("locked", shape.lock)

	if (shape.src !== undefined) {
		const raw = context.sourceBytes(shape.src)

		if (isRefused(raw)) return raw
		if (!holdsP14Media(raw)) return refused("unsupported", "a medium without p14:media holds no trim, fade or bookmarks")
	}

	return { node, shape, media }
}

// The shape's source markup when the shape is exactly what it reads as (no edit since), else undefined.
function sourceInverse(found: Found, context: ApplyContext): Inverse | Refused | undefined {
	const src = found.shape.src

	if (src === undefined || !("readShape" in context)) return undefined

	const raw = context.sourceBytes(src)

	if (isRefused(raw)) return raw

	const read = (context as SourceReading).readShape(found.node, raw)

	if (
		isRefused(read) ||
		digestOf({ ...read, id: found.shape.id, sourceId: undefined }) !== digestOf({ ...found.shape, sourceId: undefined })
	)
		return undefined

	const copy = raw.slice()

	return {
		ops: [{ family: "shape", kind: "restore", target: { slide: found.node.ref, id: found.shape.id }, raw: copy }],
		bytes: copy.length
	}
}

function setTiming(found: Found, timing: MediaTiming): void {
	const next = normalizedMediaTiming(timing)
	const media: MediaRef = { ...found.media }

	if (next === undefined) delete media.timing
	else media.timing = next

	found.shape.media = media
	found.node.revision++
}

function apply(deck: Deck, op: MediaTimingOp, context: ApplyContext): ApplyResult<MediaTimingOp> {
	const found = mediaShape(deck, op.target, context)

	if (isRefused(found)) return found

	const prior: MediaTiming = found.media.timing ?? {}
	let next: MediaTiming
	let back: DeckOp

	switch (op.kind) {
		case "setTrim":
			if (!(op.restore === true ? writableTrim(op.startMs, op.endMs) : validTrim(op.startMs, op.endMs)))
				return refused("malformed", "a trim out of range")

			next = { ...prior, trim: { startMs: op.startMs, endMs: op.endMs } }
			back = {
				family: "mediaTiming",
				kind: "setTrim",
				target: op.target,
				startMs: prior.trim?.startMs ?? 0,
				endMs: prior.trim?.endMs ?? 0,
				restore: true
			}
			break
		case "setFade":
			if (!validFade(op.inMs, op.outMs)) return refused("malformed", "a fade out of range")

			next = { ...prior, fade: { inMs: op.inMs, outMs: op.outMs } }
			back = {
				family: "mediaTiming",
				kind: "setFade",
				target: op.target,
				inMs: prior.fade?.inMs ?? 0,
				outMs: prior.fade?.outMs ?? 0,
				restore: true
			}
			break
		case "addBookmark": {
			const problem =
				op.restore === true
					? writableBookmark(op.name, op.timeMs)
						? undefined
						: "name"
					: bookmarkProblem(prior.bookmarks, op.name, op.timeMs, prior.unread)

			if (problem !== undefined)
				return problem === "duplicateName" || problem === "duplicateTime"
					? refused("unsupported", `a second bookmark of the same ${problem === "duplicateName" ? "name" : "time"}`)
					: problem === "full"
						? refused("tooLarge", "bookmarks")
						: refused("malformed", `a bookmark ${problem}`)

			next = { ...prior, bookmarks: withBookmark(prior.bookmarks, { name: op.name, timeMs: op.timeMs }) }
			back = { family: "mediaTiming", kind: "removeBookmark", target: op.target, name: op.name }
			break
		}
		case "removeBookmark": {
			const bookmark = prior.bookmarks?.find(candidate => candidate.name === op.name)

			if (bookmark === undefined) return refused("notFound", `bookmark ${op.name}`)
			// A trigger names it (MS-PPTX §2.3.3.13: the name MUST exist in the medium's list): the trigger goes first.
			if (bookmarkTriggers(found.node.timing).some(trigger => trigger.shape === found.shape.id && trigger.bookmark === op.name))
				return refused("unsupported", "a bookmark an animation's trigger names")

			next = { ...prior, bookmarks: (prior.bookmarks ?? []).filter(candidate => candidate !== bookmark) }
			back = {
				family: "mediaTiming",
				kind: "addBookmark",
				target: op.target,
				name: bookmark.name,
				timeMs: bookmark.timeMs,
				restore: true
			}
			break
		}
	}

	const source = sourceInverse(found, context)

	if (source !== undefined && isRefused(source)) return source

	const inverse: Inverse = source ?? { ops: [cloneModel(back)], bytes: 0 }

	setTiming(found, next)

	return { kind: "applied", inverse, op }
}

export const applyMediaTiming: ApplyFamily<MediaTimingOp> = {
	apply,
	touches: (op: OpOf<"mediaTiming">): readonly Touch[] => [
		{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } }
	]
}

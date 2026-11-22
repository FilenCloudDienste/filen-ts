import { estimateTokens, transformData, transformFits, transformInputCap, type TransformKind } from "@filen/shared/assistant"
import { oneStep, type DeckOp, type ShapeBodyKind, type ShapeRef, type SlideRender } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { bodyPlainText, replaceBodyText } from "@filen/office/react/presentation"

// The selection transform on whole text bodies (shapes selected as objects, or every text body of the slide): each
// body's text read from its seed, transformed on its own (one generation per body: the model never has to keep
// separators between shapes), and applied as one batch, so one undo takes every body back.

// The most bodies one request takes (a whole slide of them runs one short generation each, one after another).
export const SHAPE_TRANSFORM_MAX_BODIES = 12

// The most text all bodies of one request hold together, as a share of one transform's input cap (a whole slide's run
// stays near a minute on the CPU path).
const TOTAL_INPUT_CAPS = 2

export interface ShapeTransformTarget {
	readonly shape: ShapeRef
	readonly body: Exclude<ShapeBodyKind, "table">
}

// The bodies a request acts on: the selected shapes holding text (`selected`, ids on the slide), else every top-level
// text body of the slide; placeholders, text boxes and shapes only (tables, charts, SmartArt, groups and pictures are
// left out), none the editor may not change.
export function shapeTransformTargets(render: SlideRender, selected: readonly number[]): ShapeTransformTarget[] {
	const chosen = new Set(selected)
	const seen = new Set<number>()
	const targets: ShapeTransformTarget[] = []

	for (const layer of render.layers) {
		const box = layer.box
		const body = box?.body

		if (box === undefined || body === undefined || body === "table" || seen.has(box.id)) continue
		if (layer.role !== "placeholder" && layer.role !== "shape") continue
		if (layer.lock !== undefined || (chosen.size > 0 && !chosen.has(box.id))) continue

		seen.add(box.id)
		targets.push({ shape: { slide: render.ref, id: box.id }, body })
	}

	return targets
}

export interface ShapeTransformItem extends ShapeTransformTarget {
	// The body's text as it was read (what Accept checks it still holds).
	readonly text: string
}

// "field": it holds a slide number, a date or math, which plain text would lose; "too-long": past one transform's
// input, or past what the request takes in all; "empty": no text; "unreadable": its body could not be read.
export type ShapeTransformSkip = ShapeTransformTarget & { readonly reason: "field" | "too-long" | "empty" | "unreadable" }

export type ShapeTransformRead =
	| { readonly ok: true; readonly items: readonly ShapeTransformItem[]; readonly skipped: readonly ShapeTransformSkip[] }
	| { readonly ok: false; readonly count: number }

// Reads the targets' text: one seed per body. More than SHAPE_TRANSFORM_MAX_BODIES is refused with the count.
export async function readShapeTexts(
	session: Pick<PresentationSessionApi, "textSeed">,
	targets: readonly ShapeTransformTarget[],
	kind: TransformKind
): Promise<ShapeTransformRead> {
	if (targets.length > SHAPE_TRANSFORM_MAX_BODIES) {
		return { ok: false, count: targets.length }
	}

	const items: ShapeTransformItem[] = []
	const skipped: ShapeTransformSkip[] = []
	let room = transformInputCap(kind) * TOTAL_INPUT_CAPS

	for (const target of targets) {
		const seed = await session.textSeed(target.shape).catch(() => null)
		const text = seed === null ? undefined : bodyPlainText(seed.body)

		if (text === undefined) {
			skipped.push({ ...target, reason: "unreadable" })
		} else if (text === null) {
			skipped.push({ ...target, reason: "field" })
		} else if (text.trim().length === 0) {
			skipped.push({ ...target, reason: "empty" })
		} else if (!transformFits(kind, text) || estimateTokens(transformData(text, [])) > room) {
			skipped.push({ ...target, reason: "too-long" })
		} else {
			room -= estimateTokens(transformData(text, []))
			items.push({ ...target, text })
		}
	}

	return { ok: true, items, skipped }
}

// The bodies with their results as one op (a batch of setText, one undo step): each body read again and checked it still
// holds the text that was transformed. "changed" when any does not (all or nothing).
export async function shapeTransformOp(
	session: Pick<PresentationSessionApi, "textSeed">,
	results: readonly { readonly item: ShapeTransformItem; readonly text: string }[]
): Promise<DeckOp | "changed"> {
	const ops: DeckOp[] = []

	for (const { item, text } of results) {
		const seed = await session.textSeed(item.shape).catch(() => null)
		const body = seed === null || bodyPlainText(seed.body) !== item.text ? null : replaceBodyText(seed.body, text)

		if (seed === null || body === null) {
			return "changed"
		}

		ops.push({ family: "text", kind: "setText", target: item.shape, body })
	}

	return oneStep(ops)[0] ?? "changed"
}

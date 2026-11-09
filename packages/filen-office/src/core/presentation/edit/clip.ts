import { EMU_PER_PX } from "../../drawingml/reader"
import type { Format, ShapeNode, SlideNode, SlideRef, TextBody, Xfrm } from "../model"
import { oneStep } from "./commands/batch"
import { inDeckOrder } from "./commands/slide"
import type { CarriedRelationship, DeckOp, OpOf, PastedShape, RawPart } from "./ops"

// Cut, Copy and Paste of shapes and slides, as PowerPoint does them. A clip is what the worker hands the page for a
// copy (dom/presentation engine/clip.ts); the page keeps it (one app-wide clipboard, so a paste reaches another open
// deck) and builds the paste from it here, as one op (one undo step). A cut is the delete of what was copied, its own
// step.
//
// Shapes: on the slide they came from (or wherever a shape of the same box sits), a paste lands one step down and right
// of the last one; anywhere else at the copied place. Their markup carries the relationships it names (pictures,
// media, links), given to the slide it lands on.
//
// Slides: pasted after the current slide, in their order; copied slides are duplicated from the deck as it is, cut ones
// come back from the parts their cut held (and are duplicated on a second paste).

// A relationship a clip's markup names, as the clip holds it: a part of the deck by name (its bytes asked for only when
// a paste goes into another deck, clipParts), a part the copy made (an image an edit inserted and no save stored yet:
// its `bytes`), or an external target. `jump`: a link to a slide of the clip's deck.
export interface ClipRelationship {
	readonly id: string
	readonly type: string
	readonly target: string
	readonly external?: boolean
	readonly contentType?: string
	readonly size?: number
	readonly bytes?: Uint8Array
	readonly jump?: true
}

export interface ShapeClip {
	readonly kind: "shapes"
	readonly format: Format
	readonly slide: SlideRef
	// In z-order, back to front.
	readonly shapes: readonly PastedShape[]
	// Their boxes as copied (undefined for one with none of its own: a placeholder in its layout's place).
	readonly boxes: readonly (Xfrm | undefined)[]
	readonly relationships: readonly ClipRelationship[]
	// Each shape's paragraphs as text (a table's by cell, a group's by child), for other apps.
	readonly text: readonly (readonly string[])[]
	// The picture a lone copied picture shows (its part), for other apps.
	readonly picture?: string
}

export interface SlideClip {
	readonly kind: "slides"
	readonly format: Format
	// In deck order.
	readonly slides: readonly SlideRef[]
	// A cut's slides as their delete held them: what a paste puts back while they are not in the deck.
	readonly held?: readonly { readonly ref: SlideRef; readonly parts: readonly RawPart[]; readonly nodes?: readonly SlideNode[] }[]
	// Each slide's paragraphs as text, for other apps.
	readonly text: readonly (readonly string[])[]
}

export type PresentationClip = ShapeClip | SlideClip

// The step a paste onto the shapes' own place moves them: the editor's Duplicate step.
export const PASTE_STEP = 10 * EMU_PER_PX
// Past this many steps a paste lands where the last one would (a slide filled with copies).
const MAX_PASTE_STEPS = 64

function sameBox(a: Xfrm, b: Xfrm, dx: number, dy: number): boolean {
	return a.x + dx === b.x && a.y + dy === b.y && a.cx === b.cx && a.cy === b.cy
}

// The offset of a paste onto a slide whose shapes have `boxes`: the first multiple of PASTE_STEP (from none) where no
// copied shape would cover a shape of the same box, so pastes in a row cascade and one onto another slide, or after a
// cut, lands where the shapes were.
export function pasteOffset(clip: Pick<ShapeClip, "boxes">, boxes: readonly Xfrm[]): { readonly dx: number; readonly dy: number } {
	const copied = clip.boxes.filter((box): box is Xfrm => box !== undefined)

	if (copied.length === 0) return { dx: 0, dy: 0 }

	for (let step = 0; step < MAX_PASTE_STEPS; step++) {
		const d = step * PASTE_STEP

		if (!copied.some(box => boxes.some(other => sameBox(box, other, d, d)))) return { dx: d, dy: d }
	}

	return { dx: MAX_PASTE_STEPS * PASTE_STEP, dy: MAX_PASTE_STEPS * PASTE_STEP }
}

export type PasteRefusal = "notFound" | "unsupported"

// Where a paste goes: the slide, its shapes' boxes, and whether the clip came from this deck. `parts`: the bytes of the
// parts the clip names, for a clip of another deck (clipParts answered them).
export interface ShapePasteTarget {
	readonly slide: SlideRef
	readonly boxes: readonly Xfrm[]
	readonly sameDeck: boolean
	readonly format: Format
	readonly parts?: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly contentType: string }>
}

// The parts of its deck a clip names (their bytes a paste into another deck brings along).
export function clipPartNames(clip: ShapeClip): string[] {
	return [
		...new Set(
			clip.relationships
				.filter(relationship => relationship.external !== true && relationship.bytes === undefined)
				.map(relationship => relationship.target)
		)
	]
}

// Paste of copied shapes: one op. A clip from another deck pastes only between PresentationML decks (an ODP clip's
// markup names its own document's styles), never with a link to one of its own slides, and with the bytes of every
// part it names.
export function pasteShapesOp(clip: ShapeClip, target: ShapePasteTarget): OpOf<"shape"> | PasteRefusal {
	if (clip.shapes.length === 0) return "notFound"

	const relationships: CarriedRelationship[] = []

	if (!target.sameDeck) {
		if (clip.format !== "pptx" || target.format !== "pptx") return "unsupported"
		if (clip.shapes.some(shape => shape.raw === undefined || shape.shape !== undefined)) return "unsupported"

		for (const relationship of clip.relationships) {
			if (relationship.jump === true) return "unsupported"

			if (relationship.external === true) {
				relationships.push({ id: relationship.id, type: relationship.type, target: relationship.target, external: true })

				continue
			}

			const part =
				relationship.bytes === undefined
					? target.parts?.get(relationship.target)
					: { bytes: relationship.bytes, contentType: relationship.contentType ?? "application/octet-stream" }

			if (part === undefined) return "notFound"

			relationships.push({
				id: relationship.id,
				type: relationship.type,
				target: relationship.target,
				bytes: part.bytes,
				contentType: part.contentType
			})
		}
	} else {
		for (const relationship of clip.relationships)
			relationships.push({
				id: relationship.id,
				type: relationship.type,
				target: relationship.target,
				...(relationship.external === true ? { external: true } : {}),
				...(relationship.bytes === undefined
					? {}
					: { bytes: relationship.bytes, contentType: relationship.contentType ?? "application/octet-stream" })
			})
	}

	const { dx, dy } = pasteOffset(clip, target.boxes)

	return {
		family: "shape",
		kind: "paste",
		slide: target.slide,
		shapes: clip.shapes,
		...(relationships.length === 0 ? {} : { relationships }),
		dx,
		dy
	}
}

// Paste of copied slides after the slide at `after` (-1: first), as one step: slides of the deck duplicated, a cut's
// slides that are no longer in it put back from what the cut held. A clip of another deck is not pasted here.
export function pasteSlidesOps(clip: SlideClip, order: readonly SlideRef[], after: number, sameDeck: boolean): DeckOp[] | PasteRefusal {
	if (!sameDeck) return "unsupported"
	if (clip.slides.length === 0) return "notFound"

	const present = new Set(order)
	const held = new Map((clip.held ?? []).map(entry => [entry.ref, entry] as const))
	const at = Math.max(0, Math.min(order.length, after + 1))
	const ops: DeckOp[] = []

	for (const [k, ref] of clip.slides.entries()) {
		if (present.has(ref)) {
			ops.push({ family: "slide", kind: "duplicate", slide: ref, at: at + k })

			continue
		}

		const entry = held.get(ref)

		if (entry === undefined) return "notFound"

		ops.push({
			family: "slide",
			kind: "restore",
			slides: [{ ref, at: at + k, parts: entry.parts, ...(entry.nodes === undefined ? {} : { nodes: entry.nodes }) }]
		})
	}

	return oneStep(ops)
}

// The slides a Cut or Copy in the slide list takes: the selection in deck order.
export function clippedSlides(order: readonly SlideRef[], selection: Iterable<SlideRef>): SlideRef[] {
	return inDeckOrder(order, selection)
}

// --- Text for other apps ---

function bodyText(body: TextBody | undefined, out: string[]): void {
	for (const paragraph of body?.paragraphs ?? []) {
		let line = ""

		for (const run of paragraph.runs) line += run.kind === "br" ? "\v" : run.text

		out.push(line.replace(/\v/gu, "\n"))
	}
}

// A shape's paragraphs as text: its body, a table's cells row by row, a group's children in order.
export function shapeText(shape: ShapeNode, out: string[] = []): string[] {
	bodyText(shape.text, out)

	if (shape.frame?.kind === "table")
		for (const row of shape.frame.table.rows)
			for (const cell of row.cells) if (cell.hMerge !== true && cell.vMerge !== true) bodyText(cell.text, out)

	for (const child of shape.children ?? []) shapeText(child, out)

	return out
}

// What a copy gives other apps as plain text: each shape's paragraphs, a line each (CRLF, as PowerPoint writes it).
export function clipPlainText(text: readonly (readonly string[])[]): string {
	return text
		.flat()
		.map(line => line.replace(/\n/gu, "\r\n"))
		.join("\r\n")
}

function escapeHtml(text: string): string {
	return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;")
}

// The attribute naming this app's clip in the HTML a copy writes: a paste reading it back pastes the clip itself.
export const CLIP_ATTRIBUTE = "data-filen-presentation-clip"

// What a copy gives other apps as HTML: a paragraph per line, the clip named by its id.
export function clipHtml(id: string, text: readonly (readonly string[])[]): string {
	const blocks = text
		.map(lines => `<div>${lines.map(line => `<p>${escapeHtml(line).replace(/\n/gu, "<br>") || "<br>"}</p>`).join("")}</div>`)
		.join("")

	return `<div ${CLIP_ATTRIBUTE}="${escapeHtml(id)}">${blocks}</div>`
}

// The clip id the HTML on the clipboard names, if this app wrote it.
export function clipIdOf(html: string): string | undefined {
	const match = new RegExp(`${CLIP_ATTRIBUTE}="([^"]*)"`, "u").exec(html)

	return match?.[1]
}

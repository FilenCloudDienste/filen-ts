import type { Mark, Node } from "prosemirror-model"
import type { DocxEditContext } from "./context"
import { NO_SOURCE } from "./schema"

// The part a source identity (a node's attributes, a mark with a `src`) was built from, by object: content
// pasted into a story of another part carries item numbers that are not that part's. Nodes and marks are
// immutable and shared by copies, so the object says where it came from.
const origins = new WeakMap<object, number>()

function hasSource(attrs: Readonly<Record<string, unknown>>): boolean {
	const src = attrs["src"]

	return typeof src === "number" && src !== NO_SOURCE
}

// Blocks the builder made for each context, recorded only once a paste needs to know (a walk of every story
// at open would cost every document its time): until then they wait here.
interface Built {
	waiting: { node: Node; part: number }[] | null
}

const built = new WeakMap<DocxEditContext, Built>()

// Top-level blocks as the builder made them, by their attributes object, which every copy an edit makes of a
// block shares (until its attributes change; one with a source is its block's own): see asBuilt.
const builtBlocks = new WeakMap<object, Node>()

// A block (or story) the builder made from `part`. `eager`: its origins are recorded now, never queued (a
// document built for a while only, such as Find's, is not held until a paste).
export function builtFrom(context: DocxEditContext, node: Node, part: number, eager = false): void {
	if (hasSource(node.attrs)) builtBlocks.set(node.attrs, node)

	if (eager) {
		tagOrigin(node, part)

		return
	}

	let state = built.get(context)

	if (state === undefined) {
		state = { waiting: [] }
		built.set(context, state)
	}

	if (state.waiting === null) tagOrigin(node, part)
	else state.waiting.push({ node, part })
}

// Records the origins of everything the builder made for `context` so far, and of what it makes from now on.
export function knowOrigins(context: DocxEditContext): void {
	const state = built.get(context)

	if (state === undefined) {
		built.set(context, { waiting: null })

		return
	}

	if (state.waiting === null) return

	for (const { node, part } of state.waiting) tagOrigin(node, part)

	state.waiting = null
}

// Records `part` as the origin of what `node` and its descendants hold with a source.
function tagOrigin(node: Node, part: number): void {
	const attrs = node.attrs
	const src = attrs["src"]

	if (typeof src === "number" && src !== NO_SOURCE) origins.set(attrs, part)

	const marks = node.marks

	for (let k = 0; k < marks.length; k++) {
		const mark = marks[k] as Mark
		const markSrc = mark.attrs["src"]

		if (typeof markSrc === "number" && markSrc !== NO_SOURCE) origins.set(mark, part)
	}

	const content = node.content

	for (let k = 0; k < content.childCount; k++) tagOrigin(content.child(k), part)
}

// Records `part` as the origin of a node's own attributes when nothing recorded one (an edit's new copy).
export function claimOrigin(node: Node, part: number): void {
	if (hasSource(node.attrs) && !origins.has(node.attrs)) origins.set(node.attrs, part)
}

// The part a node's attributes or a mark came from, or undefined when unknown.
export function originOf(value: Node | object): number | undefined {
	return origins.get("attrs" in value && "type" in value && "content" in value ? (value as Node).attrs : value)
}

// The top-level block the builder made with the attributes object `attrs` (an edit's copy of a block keeps it).
export function builtBlock(attrs: object): Node | undefined {
	return builtBlocks.get(attrs)
}

// `next`, a block an edit rebuilt, as the builder made it when it equals `built` (what the builder made in its
// place: builtBlock, or the matching child of such a block): the very node, so the document shares it again
// instead of holding a copy (a format applied to the whole document and undone would otherwise double it).
// `attrs` is the attributes object `next` stands for: a copy keeps the built block's (an undo of an attribute
// step gives it back), so another block of equal content never matches.
export function asBuilt(next: Node, built: Node | undefined, attrs: object = next.attrs): Node {
	if (built === undefined || built === next || built.attrs !== attrs || built.childCount !== next.childCount) return next
	if (built.type !== next.type || !sameMarks(built.marks, next.marks)) return next

	if (next.inlineContent) return built.content.eq(next.content) ? built : next

	for (let k = 0; k < next.childCount; k++) if (next.child(k) !== built.child(k)) return next

	return built
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
	return a === b || (a.length === b.length && a.every((mark, k) => mark === b[k] || mark.eq(b[k] as Mark)))
}

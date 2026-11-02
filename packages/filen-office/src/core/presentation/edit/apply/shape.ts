import { refitGroups } from "../../groupBounds"
import type { TimeNode } from "../../../anim/model"
import { holdMarkup, timingTargets, withoutShapes } from "../../../anim/prune"
import { matchShapes } from "./match"
import { applyMotionPath, lockedPathOps } from "./motionPath"
import { classifyHref } from "../../actions"
import { motionBehaviors } from "../../../anim/motionEdit"
import { inheritLevels, resolveShape } from "../../inherit"
import {
	refused,
	type Deck,
	type Refused,
	type ShapeNode,
	type ShapePropsEdit,
	type ShapeRef,
	type SlideNode,
	type SlideRef,
	type Xfrm
} from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Inverse, Touch } from "../apply"
import { cloneModel, digestOf, findShape } from "../changes"
import type { DeckOp, OpOf, ShapeOp } from "../ops"
import { xmlSafeText } from "../xmlText"

// The shape ops on the model, in place. Inverses follow ops.ts: typed values where the prior state was an edit
// (a local xfrm, `props`), bytes where it was source. A content op on a shape backed by source is undone by
// replacing the shape with a copy of its prior typed state plus its source markup (delete, then insert with
// `raw`): the insert keeps the live source ref while it still names those bytes, and re-reads the bytes after a
// save's rebase made it stale, so the inverse survives the rebase. Group, ungroup and z-order are undone the same
// way, shape by shape at its old index.

// What the engine adds to ApplyContext: re-reading source markup an inverse holds (the deck's format reader).
export interface SourceReading extends ApplyContext {
	// `raw` (one shape element, as an inverse holds it) read as a shape of `slide`; its src names a document the
	// session keeps for it.
	readShape(slide: SlideNode, raw: Uint8Array): ShapeNode | Refused
	// Whether a shape locked by proof gate 1 still moves (its xfrm proves on its own).
	movable(shape: ShapeNode): boolean
}

function reading(context: ApplyContext): SourceReading | undefined {
	return "readShape" in context ? (context as SourceReading) : undefined
}

export function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refused"
}

type At = { readonly shape: ShapeNode; readonly parent: number; readonly index: number }

function nodeOf(deck: Deck, slide: SlideRef): SlideNode | Refused {
	const node = deck.nodes.get(slide)

	return node === undefined ? refused("notFound", `slide ${String(slide)} is not parsed`) : node
}

function siblingsOf(node: SlideNode, parent: number): ShapeNode[] | undefined {
	if (parent === 0) return node.shapes

	const group = findShape(node.shapes, parent)?.shape

	return group?.kind === "grpSp" ? (group.children ??= []) : undefined
}

function eachShape(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		if (shape.children !== undefined) eachShape(shape.children, visit)
	}
}

function idsOf(shapes: readonly ShapeNode[]): Set<number> {
	const ids = new Set<number>()

	eachShape(shapes, shape => ids.add(shape.id))

	return ids
}

// Content edits (anything that rewrites a shape's markup other than its xfrm) are refused on a locked shape.
function contentLock(shape: ShapeNode): Refused | undefined {
	return shape.lock === undefined ? undefined : refused("locked", shape.lock)
}

// A move rewrites only a:xfrm (in both branches of an mc:AlternateContent; p:xfrm of an unknown frame).
function moveLock(shape: ShapeNode, context: ApplyContext): Refused | undefined {
	switch (shape.lock) {
		case undefined:
		case "alternateContent":
		case "unknownFrame":
			return undefined
		case "proofFailed":
			return reading(context)?.movable(shape) === true ? undefined : refused("locked", "proofFailed")
		default:
			return refused("locked", shape.lock)
	}
}

// A graphic frame (a table, chart, embedded object or diagram, ODF's draw:frame) and a medium have no flip either
// format draws (ECMA-376 §19.3.1.21), and a group holding one would mirror it: a box that changes their flips is
// refused as the command. An ODF 3D scene (an unknown frame of an ODP) is written mirrored, as LibreOffice mirrors it.
function unflippable(shape: ShapeNode): boolean {
	if (shape.kind === "frame") return !(shape.frame?.kind === "unknown" && shape.src?.format === "odp")

	return shape.media !== undefined || (shape.children ?? []).some(unflippable)
}

function frameFlip(shape: ShapeNode, xfrm: Xfrm | undefined): Refused | undefined {
	if (xfrm === undefined || !unflippable(shape)) return undefined
	if (xfrm.flipH === (shape.xfrm?.flipH ?? false) && xfrm.flipV === (shape.xfrm?.flipV ?? false)) return undefined

	return refused("unsupported", "a table, chart, object, medium or diagram cannot be flipped")
}

// Delete, reorder and group keep the element's bytes; only a deck-level lock refuses them, and a master's field (the
// slide does not hold it).
function structureLock(shape: ShapeNode): Refused | undefined {
	return shape.lock === "gate" || shape.lock === "budget" || shape.lock === "master" ? refused("locked", shape.lock) : undefined
}

function bump(node: SlideNode): void {
	node.revision++
}

function nodeTouch(slide: SlideRef, shape: number): Touch {
	return { kind: "shape", slide, shape, dirt: { kind: "node" } }
}

function clone<T>(value: T): T {
	return cloneModel(value)
}

// The source markup of a shape, for an inverse; undefined when it has none (a shape an op made).
function rawOf(shape: ShapeNode, context: ApplyContext): Uint8Array | Refused | undefined {
	if (shape.src === undefined) return undefined

	const bytes = context.sourceBytes(shape.src)

	return isRefused(bytes) ? bytes : bytes.slice()
}

// The op that puts `shape` back as it is now at (parent, index): its typed state, and its source bytes when it has
// any. Applied after the shape was removed.
function reinsert(slide: SlideRef, shape: ShapeNode, parent: number, index: number, context: ApplyContext): DeckOp | Refused {
	const raw = rawOf(shape, context)

	if (isRefused(raw)) return raw

	return {
		family: "shape",
		kind: "insert",
		slide,
		shape: clone(shape),
		index,
		...(parent === 0 ? {} : { parent }),
		...(raw === undefined ? {} : { raw })
	}
}

function inverseOf(ops: readonly DeckOp[]): Inverse {
	let bytes = 0

	for (const op of ops) {
		if (op.family === "shape" && (op.kind === "insert" || op.kind === "restore") && op.raw !== undefined) bytes += op.raw.length
	}

	return { ops, bytes }
}

// The inverse of a content op on one shape: replace it by its prior state.
function replaceInverse(slide: SlideRef, at: At, context: ApplyContext): Inverse | Refused {
	const back = reinsert(slide, at.shape, at.parent, at.index, context)

	if (isRefused(back)) return back

	return inverseOf([{ family: "shape", kind: "delete", slide, shapes: [at.shape.id] }, back])
}

// A re-read shape takes the typed state it had (children matched by matchShapes); the source backing comes from the bytes. Text and
// frames equal to what the bytes read keep the fresh read (its source refs are live).
function overlay(typed: ShapeNode, read: ShapeNode): ShapeNode {
	const out: ShapeNode = { ...typed }

	if (read.src === undefined) delete out.src
	else out.src = read.src

	if (typed.text !== undefined && read.text !== undefined && digestOf(typed.text) === digestOf(read.text)) out.text = read.text
	if (typed.frame !== undefined && read.frame !== undefined && digestOf(typed.frame) === digestOf(read.frame)) out.frame = read.frame

	if (typed.children !== undefined) {
		const matches = matchShapes(typed.children, read.children ?? [])

		out.children = typed.children.map((child, k) => {
			const match = matches[k]

			return match === undefined ? child : overlay(child, match)
		})
	}

	return out
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false

	return true
}

// The shape an insert puts in: a copy of the op's, its source backing checked against `raw`.
function insertedShape(node: SlideNode, op: OpOf<"shape"> & { kind: "insert" }, context: ApplyContext): ShapeNode | Refused {
	const shape = clone(op.shape)

	if (op.raw === undefined) {
		// A shape the page made names no source; one that does must still be live.
		if (op.shape.src !== undefined) {
			const live = context.sourceBytes(op.shape.src)

			if (isRefused(live)) return live
		}

		return shape
	}

	if (op.shape.src !== undefined) {
		const live = context.sourceBytes(op.shape.src)

		if (!isRefused(live) && sameBytes(live, op.raw)) return shape
	}

	const reader = reading(context)

	if (reader === undefined) return refused("stale", "source markup cannot be read back here")

	const read = reader.readShape(node, op.raw)

	if (isRefused(read)) return read

	return overlay(shape, read)
}

function rotatedBounds(xfrm: Xfrm): { x: number; y: number; cx: number; cy: number } {
	const angle = (((xfrm.rot / 60000) % 360) + 360) % 360

	// A shape turned by 45°–135° or 225°–315° is bounded by its swapped box (PowerPoint's selection bounds).
	if ((angle >= 45 && angle < 135) || (angle >= 225 && angle < 315)) {
		return { x: xfrm.x + (xfrm.cx - xfrm.cy) / 2, y: xfrm.y + (xfrm.cy - xfrm.cx) / 2, cx: xfrm.cy, cy: xfrm.cx }
	}

	return { x: xfrm.x, y: xfrm.y, cx: xfrm.cx, cy: xfrm.cy }
}

function boxOf(deck: Deck, slide: SlideRef, shape: ShapeNode): Xfrm | undefined {
	return shape.xfrm ?? resolveShape(deck, slide, shape).xfrm
}

interface Placed extends At {
	readonly xfrm: Xfrm
}

// Shapes by id that share one parent, each with its box; refused when one is missing, locked or has no box.
function placedSiblings(
	deck: Deck,
	node: SlideNode,
	ids: readonly number[],
	lock: (shape: ShapeNode) => Refused | undefined
): Placed[] | Refused {
	const out: Placed[] = []
	let parent: number | undefined

	if (ids.length === 0) return refused("malformed", "no shapes")

	for (const id of new Set(ids)) {
		const at = findShape(node.shapes, id)

		if (at === undefined) return refused("notFound", `shape ${String(id)}`)

		const locked = lock(at.shape)

		if (locked !== undefined) return locked
		if (parent !== undefined && at.parent !== parent) return refused("unsupported", "shapes of different groups")

		parent = at.parent

		const xfrm = boxOf(deck, node.ref, at.shape)

		if (xfrm === undefined) return refused("unsupported", `shape ${String(id)} has no box`)

		out.push({ ...at, xfrm })
	}

	return out
}

// Moves to new boxes in place; the inverse sets each prior xfrm back (undefined for an inherited box).
function moveAll(node: SlideNode, moves: readonly { shape: ShapeNode; xfrm: Xfrm }[]): Inverse {
	const ops: DeckOp[] = []

	for (const { shape, xfrm } of moves) {
		ops.push({
			family: "shape",
			kind: "setXfrm",
			target: { slide: node.ref, id: shape.id },
			xfrm: shape.xfrm === undefined ? undefined : { ...shape.xfrm }
		})
		shape.xfrm = { ...xfrm }
	}

	bump(node)

	return { ops: ops.reverse(), bytes: 0 }
}

const NOTHING: Inverse = { ops: [], bytes: 0 }

function align(deck: Deck, node: SlideNode, op: OpOf<"shape"> & { kind: "align" }, context: ApplyContext): ApplyResult<typeof op> {
	const placed = placedSiblings(deck, node, op.shapes, shape => moveLock(shape, context))

	if (isRefused(placed)) return placed
	if (placed.length === 0 || (op.relativeTo === "selection" && placed.length < 2)) return { kind: "applied", inverse: NOTHING, op }
	if (op.relativeTo === "slide" && (placed[0]?.parent ?? 0) !== 0) return refused("unsupported", "align a group's shapes to the slide")

	const bounds = placed.map(item => rotatedBounds(item.xfrm))
	const frame =
		op.relativeTo === "slide"
			? { x: 0, y: 0, r: deck.size.cx, b: deck.size.cy }
			: {
					x: Math.min(...bounds.map(box => box.x)),
					y: Math.min(...bounds.map(box => box.y)),
					r: Math.max(...bounds.map(box => box.x + box.cx)),
					b: Math.max(...bounds.map(box => box.y + box.cy))
				}
	const moves = placed.map((item, index) => {
		const box = bounds[index] as (typeof bounds)[number]
		let dx = 0
		let dy = 0

		switch (op.edge) {
			case "left":
				dx = frame.x - box.x
				break
			case "center":
				dx = Math.round((frame.x + frame.r) / 2 - (box.x + box.cx / 2))
				break
			case "right":
				dx = frame.r - (box.x + box.cx)
				break
			case "top":
				dy = frame.y - box.y
				break
			case "middle":
				dy = Math.round((frame.y + frame.b) / 2 - (box.y + box.cy / 2))
				break
			case "bottom":
				dy = frame.b - (box.y + box.cy)
				break
		}

		return { shape: item.shape, xfrm: { ...item.xfrm, x: Math.round(item.xfrm.x + dx), y: Math.round(item.xfrm.y + dy) } }
	})

	return { kind: "applied", inverse: moveAll(node, moves), op }
}

// Equal gaps between the shapes along an axis: within the selection's span (the outer two stay; three or more), or
// across the slide (one shape is centred).
function distribute(
	deck: Deck,
	node: SlideNode,
	op: OpOf<"shape"> & { kind: "distribute" },
	context: ApplyContext
): ApplyResult<typeof op> {
	const placed = placedSiblings(deck, node, op.shapes, shape => moveLock(shape, context))

	if (isRefused(placed)) return placed
	if (placed.length === 0 || (op.relativeTo === "selection" && placed.length < 3)) return { kind: "applied", inverse: NOTHING, op }
	if (op.relativeTo === "slide" && (placed[0]?.parent ?? 0) !== 0)
		return refused("unsupported", "distribute a group's shapes on the slide")

	const horizontal = op.axis === "horizontal"
	const items = placed.map(item => {
		const box = rotatedBounds(item.xfrm)

		return { item, start: horizontal ? box.x : box.y, size: horizontal ? box.cx : box.cy }
	})

	items.sort((a, b) => a.start - b.start || a.item.index - b.item.index)

	const first = items[0] as (typeof items)[number]
	const last = items[items.length - 1] as (typeof items)[number]
	const spanStart = op.relativeTo === "slide" ? 0 : first.start
	const spanEnd = op.relativeTo === "slide" ? (horizontal ? deck.size.cx : deck.size.cy) : last.start + last.size
	const total = items.reduce((sum, entry) => sum + entry.size, 0)
	const shifted = (entry: (typeof items)[number], delta: number): Xfrm =>
		horizontal ? { ...entry.item.xfrm, x: entry.item.xfrm.x + delta } : { ...entry.item.xfrm, y: entry.item.xfrm.y + delta }
	const moves: { shape: ShapeNode; xfrm: Xfrm }[] = []

	if (items.length === 1) {
		moves.push({
			shape: first.item.shape,
			xfrm: shifted(first, Math.round(spanStart + (spanEnd - spanStart - first.size) / 2 - first.start))
		})
	} else {
		const gap = (spanEnd - spanStart - total) / (items.length - 1)
		let cursor = spanStart

		for (const entry of items) {
			moves.push({ shape: entry.item.shape, xfrm: shifted(entry, Math.round(cursor - entry.start)) })
			cursor += entry.size + gap
		}
	}

	return { kind: "applied", inverse: moveAll(node, moves), op }
}

// A group of sibling shapes: a grpSp at the first one's place whose child space is its own box (chOff/chExt equal
// to off/ext), so the children keep their coordinates.
function group(deck: Deck, node: SlideNode, op: OpOf<"shape"> & { kind: "group" }, context: ApplyContext): ApplyResult<typeof op> {
	if (new Set(op.shapes).size < 2) return refused("unsupported", "a group needs two shapes")

	const placed = placedSiblings(deck, node, op.shapes, structureLock)

	if (isRefused(placed)) return placed
	// PowerPoint groups no placeholders; ODF presentation objects (presentation:class) may sit in a draw:g (ODF 1.3
	// Part 3 §10.3.14 allows any shape there), as LibreOffice groups them.
	if (deck.format !== "odp" && placed.some(item => item.shape.ph !== undefined))
		return refused("unsupported", "placeholders cannot be grouped")
	if (placed.some(item => item.shape.xfrm === undefined)) return refused("unsupported", "a shape without its own box")

	const parent = placed[0]?.parent ?? 0
	const siblings = siblingsOf(node, parent)

	if (siblings === undefined) return refused("notFound", `group ${String(parent)}`)

	const used = idsOf(node.shapes)
	const id = op.id !== undefined && op.id > 0 && !used.has(op.id) ? op.id : context.newShapeId(node.ref)
	const ordered = [...placed].sort((a, b) => a.index - b.index)
	const bounds = ordered.map(item => rotatedBounds(item.xfrm))
	const x = Math.round(Math.min(...bounds.map(box => box.x)))
	const y = Math.round(Math.min(...bounds.map(box => box.y)))
	const cx = Math.round(Math.max(...bounds.map(box => box.x + box.cx))) - x
	const cy = Math.round(Math.max(...bounds.map(box => box.y + box.cy))) - y
	const back: DeckOp[] = [{ family: "shape", kind: "delete", slide: node.ref, shapes: [id] }]

	for (const item of ordered) {
		const put = reinsert(node.ref, item.shape, item.parent, item.index, context)

		if (isRefused(put)) return put

		back.push(put)
	}

	const at = (ordered[0] as Placed).index
	const children = ordered.map(item => item.shape)
	const grouped = new Set(children)

	for (let index = siblings.length - 1; index >= 0; index--) if (grouped.has(siblings[index] as ShapeNode)) siblings.splice(index, 1)

	const name = op.name ?? `Group ${String(id - 1)}`

	siblings.splice(at, 0, {
		id,
		name,
		hidden: false,
		kind: "grpSp",
		xfrm: { x, y, cx, cy, rot: 0, flipH: false, flipV: false, chX: x, chY: y, chCx: cx, chCy: cy },
		children
	})
	bump(node)

	return { kind: "applied", inverse: inverseOf(back), op: { ...op, id, name } }
}

// A point of a group's child space in its parent's space: scaled, mirrored, then turned about the group's centre.
function toParent(group: Xfrm, px: number, py: number): { x: number; y: number } {
	const sx = group.chCx === undefined || group.chCx === 0 ? 1 : group.cx / group.chCx
	const sy = group.chCy === undefined || group.chCy === 0 ? 1 : group.cy / group.chCy
	let x = group.x + (px - (group.chX ?? group.x)) * sx
	let y = group.y + (py - (group.chY ?? group.y)) * sy
	const cx = group.x + group.cx / 2
	const cy = group.y + group.cy / 2

	if (group.flipH) x = 2 * cx - x
	if (group.flipV) y = 2 * cy - y

	if (group.rot !== 0) {
		const angle = ((group.rot / 60000) * Math.PI) / 180
		const dx = x - cx
		const dy = y - cy

		x = cx + dx * Math.cos(angle) - dy * Math.sin(angle)
		y = cy + dx * Math.sin(angle) + dy * Math.cos(angle)
	}

	return { x, y }
}

const FULL_TURN = 21_600_000

function childInParent(group: Xfrm, child: Xfrm): Xfrm {
	const sx = group.chCx === undefined || group.chCx === 0 ? 1 : group.cx / group.chCx
	const sy = group.chCy === undefined || group.chCy === 0 ? 1 : group.cy / group.chCy
	const centre = toParent(group, child.x + child.cx / 2, child.y + child.cy / 2)
	const cx = Math.round(child.cx * sx)
	const cy = Math.round(child.cy * sy)
	// A mirrored group mirrors its children: each flips too, and its turn runs the other way.
	const mirrored = group.flipH !== group.flipV
	const rot = ((((mirrored ? -child.rot : child.rot) + group.rot) % FULL_TURN) + FULL_TURN) % FULL_TURN
	const out: Xfrm = {
		x: Math.round(centre.x - cx / 2),
		y: Math.round(centre.y - cy / 2),
		cx,
		cy,
		rot,
		flipH: group.flipH !== child.flipH,
		flipV: group.flipV !== child.flipV
	}

	if (child.chX !== undefined) out.chX = child.chX
	if (child.chY !== undefined) out.chY = child.chY
	if (child.chCx !== undefined) out.chCx = child.chCx
	if (child.chCy !== undefined) out.chCy = child.chCy

	return out
}

const GROUP_FILL = new TextEncoder().encode("grpFill")

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
	const first = needle[0]

	for (let i = bytes.indexOf(first ?? 0); i >= 0 && i + needle.length <= bytes.length; i = bytes.indexOf(first ?? 0, i + 1)) {
		let match = true

		for (let j = 1; j < needle.length && match; j++) match = bytes[i + j] === needle[j]

		if (match) return true
	}

	return false
}

function ungroup(node: SlideNode, op: OpOf<"shape"> & { kind: "ungroup" }, context: ApplyContext): ApplyResult<typeof op> {
	const at = findShape(node.shapes, op.group)

	if (at === undefined) return refused("notFound", `group ${String(op.group)}`)
	if (at.shape.kind !== "grpSp") return refused("unsupported", "not a group")

	const locked = contentLock(at.shape)

	if (locked !== undefined) return locked

	const xfrm = at.shape.xfrm
	const children = at.shape.children ?? []

	if (xfrm === undefined) return refused("unsupported", "a group without its own box")

	for (const child of children) {
		const childLocked = moveLock(child, context)

		if (childLocked !== undefined) return childLocked
		if (child.xfrm === undefined) return refused("unsupported", "a group child without its own box")

		// A child filled with its group's fill (a:grpFill) would lose the fill outside the group.
		const fill = child.props?.fill

		if (fill !== undefined && fill !== "none" && fill.kind === "group") return refused("unsupported", "a child takes the group's fill")

		if (child.src !== undefined && fill === undefined) {
			const raw = context.sourceBytes(child.src)

			if (isRefused(raw)) return raw
			if (contains(raw, GROUP_FILL)) return refused("unsupported", "a child takes the group's fill")
		}
	}

	const siblings = siblingsOf(node, at.parent)

	if (siblings === undefined) return refused("notFound", `group ${String(at.parent)}`)

	const back: DeckOp[] = children.map(child => ({ family: "shape", kind: "delete", slide: node.ref, shapes: [child.id] }))
	const put = reinsert(node.ref, at.shape, at.parent, at.index, context)

	if (isRefused(put)) return put

	back.push(put)

	// A child group without a child space keeps the one its own children were placed in (its box) as it scales.
	for (const child of children) {
		const own = child.xfrm as Xfrm

		child.xfrm = childInParent(xfrm, child.kind === "grpSp" ? withChildSpace(own, own) : own)
	}

	siblings.splice(at.index, 1, ...children)
	bump(node)

	return { kind: "applied", inverse: inverseOf(back), op }
}

function zOrder(node: SlideNode, op: OpOf<"shape"> & { kind: "zOrder" }, context: ApplyContext): ApplyResult<typeof op> {
	const ids = new Set(op.shapes)
	const placed: At[] = []

	if (ids.size === 0) return refused("malformed", "no shapes")

	for (const id of ids) {
		const at = findShape(node.shapes, id)

		if (at === undefined) return refused("notFound", `shape ${String(id)}`)

		const locked = structureLock(at.shape)

		if (locked !== undefined) return locked

		placed.push(at)
	}

	const parent = placed[0]?.parent ?? 0

	if (placed.some(item => item.parent !== parent)) return refused("unsupported", "shapes of different groups")

	const siblings = siblingsOf(node, parent)

	if (siblings === undefined || placed.length === 0) return { kind: "applied", inverse: NOTHING, op }

	// The inverse takes the moved shapes out and puts each back at its index, lowest first.
	const ascending = [...placed].sort((a, b) => a.index - b.index)
	const back: DeckOp[] = ascending.map(item => ({ family: "shape", kind: "delete", slide: node.ref, shapes: [item.shape.id] }))

	for (const item of ascending) {
		const put = reinsert(node.ref, item.shape, item.parent, item.index, context)

		if (isRefused(put)) return put

		back.push(put)
	}

	let order: ShapeNode[]

	if (op.to === "front") order = [...siblings.filter(shape => !ids.has(shape.id)), ...siblings.filter(shape => ids.has(shape.id))]
	else if (op.to === "back") order = [...siblings.filter(shape => ids.has(shape.id)), ...siblings.filter(shape => !ids.has(shape.id))]
	else {
		// One place past the nearest sibling not moving; moved shapes keep their order among themselves.
		const step = op.to === "forward" ? 1 : -1

		order = [...siblings]

		const indices = order.map((shape, index) => (ids.has(shape.id) ? index : -1)).filter(index => index >= 0)

		if (step === 1) indices.reverse()

		for (const index of indices) {
			const target = index + step
			const neighbour = order[target]

			if (neighbour === undefined || ids.has(neighbour.id)) continue

			order[target] = order[index] as ShapeNode
			order[index] = neighbour
		}
	}

	siblings.splice(0, siblings.length, ...order)
	bump(node)

	return { kind: "applied", inverse: inverseOf(back), op }
}

function setProps(node: SlideNode, op: OpOf<"shape"> & { kind: "setProps" }, context: ApplyContext): ApplyResult<typeof op> {
	const at = findShape(node.shapes, op.target.id)

	if (at === undefined) return refused("notFound", `shape ${String(op.target.id)}`)

	const locked = contentLock(at.shape)

	if (locked !== undefined) return locked

	const groups = Object.keys(op.props) as (keyof ShapePropsEdit)[]
	// Prior groups that were edits (or a shape with no source) are put back as values; a source group by bytes.
	const typed = at.shape.src === undefined || groups.every(group => at.shape.props?.[group] !== undefined)
	let back: Inverse | Refused

	if (typed) {
		const prior: Record<string, unknown> = {}

		for (const group of groups) prior[group] = at.shape.props?.[group] === undefined ? undefined : clone(at.shape.props[group])

		back = { ops: [{ family: "shape", kind: "setProps", target: op.target, props: prior as ShapePropsEdit }], bytes: 0 }
	} else {
		back = replaceInverse(node.ref, at, context)
	}

	if (isRefused(back)) return back

	const props: Record<string, unknown> = { ...at.shape.props }

	for (const group of groups) {
		const value = op.props[group]

		if (value === undefined) delete props[group]
		else props[group] = clone(value)
	}

	if (Object.keys(props).length === 0) delete at.shape.props
	else at.shape.props = props as ShapePropsEdit

	bump(node)

	return { kind: "applied", inverse: back, op }
}

// setStyle, setAlt and setAction: a typed inverse for a shape an op made, a replacement for one backed by source.
// `typed`: the field's prior value is the whole of what the op changes (alt text, one action), so its typed value
// puts the shape back as it was even when it is backed by source (it fingerprints equal, so it is not re-written),
// without holding a copy of the shape and its markup.
function setField(
	node: SlideNode,
	target: ShapeRef,
	context: ApplyContext,
	typedBack: (shape: ShapeNode) => DeckOp,
	write: (shape: ShapeNode) => void,
	typed = false
): Inverse | Refused {
	const at = findShape(node.shapes, target.id)

	if (at === undefined) return refused("notFound", `shape ${String(target.id)}`)

	const locked = contentLock(at.shape)

	if (locked !== undefined) return locked

	const back = typed || at.shape.src === undefined ? { ops: [typedBack(at.shape)], bytes: 0 } : replaceInverse(node.ref, at, context)

	if (isRefused(back)) return back

	write(at.shape)
	bump(node)

	return back
}

function insert(node: SlideNode, op: OpOf<"shape"> & { kind: "insert" }, context: ApplyContext): ApplyResult<typeof op> {
	const siblings = siblingsOf(node, op.parent ?? 0)

	if (siblings === undefined) return refused("notFound", `group ${String(op.parent)}`)

	const shape = insertedShape(node, op, context)

	if (isRefused(shape)) return shape

	const used = idsOf(node.shapes)
	// newShapeId reads the slide as it is (the new shape not in it yet): ids handed out here skip those already taken.
	let next = context.newShapeId(node.ref)
	const fresh = (): number => {
		while (used.has(next)) next++

		return next
	}

	if (shape.id <= 0 || used.has(shape.id)) shape.id = fresh()

	used.add(shape.id)

	// An inserted group's children keep ids unique on the slide.
	if (shape.children !== undefined) {
		eachShape(shape.children, child => {
			if (child.id <= 0 || used.has(child.id)) child.id = fresh()

			used.add(child.id)
		})
	}

	siblings.splice(Math.max(0, Math.min(op.index ?? siblings.length, siblings.length)), 0, shape)
	bump(node)

	const applied = shape.id === op.shape.id ? op : { ...op, shape: { ...op.shape, id: shape.id } }

	return {
		kind: "applied",
		inverse: { ops: [{ family: "shape", kind: "delete", slide: node.ref, shapes: [shape.id] }], bytes: 0 },
		op: applied
	}
}

function remove(node: SlideNode, op: OpOf<"shape"> & { kind: "delete" }, context: ApplyContext): ApplyResult<typeof op> {
	const found: At[] = []

	if (op.shapes.length === 0) return refused("malformed", "no shapes")

	for (const id of new Set(op.shapes)) {
		const at = findShape(node.shapes, id)

		if (at === undefined) return refused("notFound", `shape ${String(id)}`)

		const locked = structureLock(at.shape)

		if (locked !== undefined) return locked

		found.push(at)
	}

	// A shape inside a group also deleted goes with its group.
	const removed = found.filter(
		item =>
			!found.some(
				other =>
					other !== item && other.shape.children !== undefined && findShape(other.shape.children, item.shape.id) !== undefined
			)
	)
	const back: DeckOp[] = []

	for (const item of [...removed].sort((a, b) => a.index - b.index)) {
		const put = reinsert(node.ref, item.shape, item.parent, item.index, context)

		if (isRefused(put)) return put

		back.push(put)
	}

	// The effects that animate the removed shapes (or that a click on one of them triggers) go with them, as in
	// PowerPoint; the inverse puts the slide's timing back first, so a refusal there leaves nothing half undone.
	const gone = new Set<number>()

	for (const item of removed) collectIds(item.shape, gone)

	const timing = node.timing
	let heldBytes = 0

	if (timing !== undefined && timingTargets(timing, gone)) {
		const roots: TimeNode[] = []
		const pruned = withoutShapes(timing, gone, roots)
		// The inverse keeps a copy of its own (the live tree shares the nodes the pruning kept). In it, each removed
		// subtree carries its source markup as bytes (empty for one an edit made): the mark of what the undo puts back
		// into the slide's timing as it then is, written as it was even once a save took its source out.
		const prior = cloneModel(timing)
		const removedRoots = new Set(roots)
		const mark = (live: TimeNode, held: TimeNode): void => {
			delete held.ctn.raw

			if (removedRoots.has(live)) {
				const bytes = live.ctn.src === undefined ? undefined : context.sourceBytes(live.ctn.src)
				const raw = bytes instanceof Uint8Array ? bytes : (live.ctn.raw ?? new Uint8Array(0))

				holdMarkup(held.ctn, raw)
				heldBytes += raw.length

				return
			}

			live.ctn.children.forEach((child, k) => {
				const copy = held.ctn.children[k]

				if (copy !== undefined) mark(child, copy)
			})
		}

		mark(timing.root, prior.root)

		back.unshift({ family: "timing", kind: "setTiming", slide: node.ref, timing: prior })

		if (pruned === undefined) delete node.timing
		else node.timing = pruned
	}

	for (const item of removed) {
		const siblings = siblingsOf(node, item.parent)
		const index = siblings?.indexOf(item.shape) ?? -1

		if (siblings !== undefined && index >= 0) siblings.splice(index, 1)
	}

	bump(node)

	const inverse = inverseOf(back)

	return { kind: "applied", inverse: { ops: inverse.ops, bytes: inverse.bytes + heldBytes }, op }
}

function collectIds(shape: ShapeNode, into: Set<number>): void {
	into.add(shape.id)

	for (const child of shape.children ?? []) collectIds(child, into)
}

// The element replaced by `raw` exactly (no typed overlay): the shape as that markup reads.
function restore(node: SlideNode, op: OpOf<"shape"> & { kind: "restore" }, context: ApplyContext): ApplyResult<typeof op> {
	const at = findShape(node.shapes, op.target.id)

	if (at === undefined) return refused("notFound", `shape ${String(op.target.id)}`)

	const reader = reading(context)

	if (reader === undefined) return refused("stale", "source markup cannot be read back here")

	const read = reader.readShape(node, op.raw)

	if (isRefused(read)) return read

	const back = replaceInverse(node.ref, at, context)

	if (isRefused(back)) return back

	const siblings = siblingsOf(node, at.parent)

	if (siblings === undefined) return refused("notFound", `group ${String(at.parent)}`)

	read.id = at.shape.id
	siblings[at.index] = read
	bump(node)

	return { kind: "applied", inverse: back, op }
}

// A group's box without a child space (no a:chOff/a:chExt) maps its children one to one (ECMA-376 §20.1.7.5): a new
// box takes the child space the children were placed in, the old box (or the new one when it had none), so they
// move and scale with the group.
function withChildSpace(xfrm: Xfrm, prior: Xfrm | undefined): Xfrm {
	if (xfrm.chX !== undefined || xfrm.chY !== undefined || xfrm.chCx !== undefined || xfrm.chCy !== undefined) return { ...xfrm }

	const space = prior ?? xfrm

	return {
		...xfrm,
		chX: space.chX ?? space.x,
		chY: space.chY ?? space.y,
		chCx: space.chCx ?? space.cx,
		chCy: space.chCy ?? space.cy
	}
}

// ST_Coordinate's range (§20.1.10.16); a size is ST_PositiveCoordinate (§20.1.10.42).
const MAX_COORDINATE = 27_273_042_316_900

// Whether a box an op sets is whole: every field present, finite and in range (a partial one would reach the writer and
// fail every later save).
function wellFormedXfrm(xfrm: Xfrm): boolean {
	const coordinate = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE
	const size = (value: unknown): boolean => coordinate(value) && (value as number) >= 0
	const child = xfrm as Partial<Record<"chX" | "chY" | "chCx" | "chCy", unknown>>

	return (
		coordinate(xfrm.x) &&
		coordinate(xfrm.y) &&
		size(xfrm.cx) &&
		size(xfrm.cy) &&
		typeof xfrm.rot === "number" &&
		Number.isFinite(xfrm.rot) &&
		typeof xfrm.flipH === "boolean" &&
		typeof xfrm.flipV === "boolean" &&
		(child.chX === undefined || coordinate(child.chX)) &&
		(child.chY === undefined || coordinate(child.chY)) &&
		(child.chCx === undefined || size(child.chCx)) &&
		(child.chCy === undefined || size(child.chCy))
	)
}

function setXfrm(node: SlideNode, op: OpOf<"shape"> & { kind: "setXfrm" }, context: ApplyContext): ApplyResult<typeof op> {
	if (op.xfrm !== undefined && !wellFormedXfrm(op.xfrm)) return refused("malformed", "a box without all its fields in range")

	const at = findShape(node.shapes, op.target.id)

	if (at === undefined) return refused("notFound", `shape ${String(op.target.id)}`)

	const locked = moveLock(at.shape, context)

	if (locked !== undefined) return locked

	const flip = frameFlip(at.shape, op.xfrm)

	if (flip !== undefined) return flip

	const prior = at.shape.xfrm

	if (op.xfrm === undefined) delete at.shape.xfrm
	else at.shape.xfrm = at.shape.kind === "grpSp" ? withChildSpace(op.xfrm, prior) : { ...op.xfrm }

	bump(node)

	return {
		kind: "applied",
		inverse: {
			ops: [{ family: "shape", kind: "setXfrm", target: op.target, xfrm: prior === undefined ? undefined : { ...prior } }],
			bytes: 0
		},
		op
	}
}

// The shapes of a tree by id, groups' children included; the first of an id in document order.
function shapeIndex(shapes: readonly ShapeNode[]): Map<number, ShapeNode> {
	const out = new Map<number, ShapeNode>()
	const stack = [...shapes].reverse()

	for (let shape = stack.pop(); shape !== undefined; shape = stack.pop()) {
		if (!out.has(shape.id)) out.set(shape.id, shape)
		if (shape.children !== undefined) for (let k = shape.children.length - 1; k >= 0; k--) stack.push(shape.children[k] as ShapeNode)
	}

	return out
}

// setXfrm for several shapes as one step; refused whole when one is missing, named twice or cannot move.
function setXfrms(node: SlideNode, op: OpOf<"shape"> & { kind: "setXfrms" }, context: ApplyContext): ApplyResult<typeof op> {
	if (op.xfrms.length === 0) return refused("malformed", "no shapes")
	if (op.xfrms.some(({ xfrm }) => xfrm !== undefined && !wellFormedXfrm(xfrm)))
		return refused("malformed", "a box without all its fields in range")

	const shapes: ShapeNode[] = []
	const seen = new Set<number>()
	// Each shape of the slide by id, found in one walk (the first in document order, as findShape finds it).
	const byId = shapeIndex(node.shapes)

	for (const { id, xfrm } of op.xfrms) {
		if (seen.has(id)) return refused("malformed", `shape ${String(id)} twice`)

		seen.add(id)

		const shape = byId.get(id)

		if (shape === undefined) return refused("notFound", `shape ${String(id)}`)

		const locked = moveLock(shape, context)

		if (locked !== undefined) return locked

		const flip = frameFlip(shape, xfrm)

		if (flip !== undefined) return flip

		shapes.push(shape)
	}

	const back: { id: number; xfrm: Xfrm | undefined }[] = []

	op.xfrms.forEach(({ xfrm }, index) => {
		const shape = shapes[index] as ShapeNode
		const prior = shape.xfrm

		back.push({ id: shape.id, xfrm: prior === undefined ? undefined : { ...prior } })

		if (xfrm === undefined) delete shape.xfrm
		else shape.xfrm = shape.kind === "grpSp" ? withChildSpace(xfrm, prior) : { ...xfrm }
	})
	bump(node)

	return { kind: "applied", inverse: { ops: [{ family: "shape", kind: "setXfrms", slide: node.ref, xfrms: back }], bytes: 0 }, op }
}

function carries(text: string | undefined): boolean {
	return text === undefined || xmlSafeText(text) === text
}

// The slide-space centres (EMU) of the shapes in `ids`: each one's box (a placeholder without its own takes the one
// it inherits, a box no level gives is the zero box at the origin, MS-OI29500 §2.1.1284) through its groups' boxes.
function slideCentres(deck: Deck, node: SlideNode, ids: ReadonlySet<number>): Map<number, { x: number; y: number }> {
	const out = new Map<number, { x: number; y: number }>()
	const walk = (shapes: readonly ShapeNode[], groups: readonly Xfrm[]): void => {
		for (const shape of shapes) {
			if (out.size === ids.size) return

			if (ids.has(shape.id)) {
				const box = shape.xfrm ?? inheritLevels(deck, node, shape).levels.find(level => level.shape.xfrm !== undefined)?.shape.xfrm
				let centre = box === undefined ? { x: 0, y: 0 } : { x: box.x + box.cx / 2, y: box.y + box.cy / 2 }

				for (let k = groups.length - 1; k >= 0; k--) centre = toParent(groups[k] as Xfrm, centre.x, centre.y)

				out.set(shape.id, centre)
			}

			if (shape.children !== undefined && shape.xfrm !== undefined) walk(shape.children, [...groups, shape.xfrm])
			else if (shape.children !== undefined) walk(shape.children, groups)
		}
	}

	walk(node.shapes, [])

	return out
}

// A move of shapes with locked motion paths shifts those paths back by how far their shapes' centres moved on the
// slide (a shape inside a moved or resized group included), in the same step. The inverse puts the boxes back first
// (which shifts the paths back by the same rule), then the paths as they were.
function withLockedPaths(deck: Deck, node: SlideNode, move: () => ApplyResult<ShapeOp>, context: ApplyContext): ApplyResult<ShapeOp> {
	const locked = new Set(
		motionBehaviors(node.timing)
			.filter(motion => motion.pathEditMode === "fixed")
			.map(motion => motion.shape)
	)

	if (locked.size === 0) return move()

	const before = slideCentres(deck, node, locked)
	const result = move()

	if (isRefused(result)) return result

	const after = slideCentres(deck, node, locked)
	const moves: { id: number; dx: number; dy: number }[] = []

	for (const [id, prior] of before) {
		const now = after.get(id)

		if (now !== undefined) moves.push({ id, dx: now.x - prior.x, dy: now.y - prior.y })
	}

	const inverses: DeckOp[] = []
	let bytes = result.inverse.bytes

	for (const op of lockedPathOps(node, moves, deck.size)) {
		const applied = applyMotionPath.apply(deck, op, context)

		// A path that cannot be shifted (refused) moves with its shape, as an unlocked one does.
		if (isRefused(applied)) continue

		inverses.unshift(...applied.inverse.ops)
		bytes += applied.inverse.bytes
	}

	return inverses.length === 0 ? result : { ...result, inverse: { ops: [...result.inverse.ops, ...inverses], bytes } }
}

// An ODP deck's groups that hold moved shapes take their members' bounds again (an ODP group's box is where its members
// are, as the reader reads it); an undo moves the members back and refits them the same way.
function refitted<R>(deck: Deck, node: SlideNode, ids: readonly number[], result: R): R {
	if (deck.format === "odp" && !isRefused(result as unknown)) refitGroups(node.shapes, new Set(ids))

	return result
}

function applied<O extends ShapeOp>(back: Inverse | Refused, op: O): ApplyResult<O> {
	return isRefused(back) ? back : { kind: "applied", inverse: back, op }
}

function applyOne(deck: Deck, op: ShapeOp, context: ApplyContext): ApplyResult<ShapeOp> {
	if (deck.gate.length > 0) return refused("viewOnly", deck.gate.join(","))

	const node = nodeOf(deck, "slide" in op ? op.slide : op.target.slide)

	if (isRefused(node)) return node

	switch (op.kind) {
		case "insert":
			return insert(node, op, context)
		case "delete":
			return remove(node, op, context)
		case "setXfrm":
			return refitted(
				deck,
				node,
				[op.target.id],
				withLockedPaths(deck, node, () => setXfrm(node, op, context), context)
			)
		case "setXfrms":
			return refitted(
				deck,
				node,
				op.xfrms.map(each => each.id),
				withLockedPaths(deck, node, () => setXfrms(node, op, context), context)
			)
		case "restore":
			return restore(node, op, context)
		case "setProps":
			return setProps(node, op, context)
		case "setStyle":
			return applied(
				setField(
					node,
					op.target,
					context,
					shape => ({
						family: "shape",
						kind: "setStyle",
						target: op.target,
						style: shape.style === undefined ? undefined : clone(shape.style)
					}),
					shape => {
						if (op.style === undefined) delete shape.style
						else shape.style = clone(op.style)
					}
				),
				op
			)
		case "setAlt":
			// Text the writer could not carry would read back as another value and refuse the save.
			if (op.alt !== undefined && (!carries(op.alt.descr) || !carries(op.alt.title)))
				return refused("malformed", "alt text holds characters XML cannot carry")

			return applied(
				setField(
					node,
					op.target,
					context,
					shape => ({
						family: "shape",
						kind: "setAlt",
						target: op.target,
						alt: shape.alt === undefined ? undefined : { ...shape.alt }
					}),
					shape => {
						if (op.alt === undefined) delete shape.alt
						else shape.alt = { ...op.alt }
					},
					true
				),
				op
			)
		case "setAction":
			// A url the reader would not read back as one (a space, a control character) would refuse every save.
			if (op.action?.kind === "url" && classifyHref(op.action.href).kind !== "url")
				return refused("malformed", "not a link the deck can carry")

			return applied(
				setField(
					node,
					op.target,
					context,
					shape => {
						const prior = shape.actions?.[op.trigger]

						return {
							family: "shape",
							kind: "setAction",
							target: op.target,
							trigger: op.trigger,
							action: prior === undefined ? undefined : clone(prior)
						}
					},
					shape => {
						const actions = { ...shape.actions }

						if (op.action === undefined) delete actions[op.trigger]
						else actions[op.trigger] = clone(op.action)

						if (actions.click === undefined && actions.hover === undefined) delete shape.actions
						else shape.actions = actions
					},
					true
				),
				op
			)
		case "zOrder":
			return zOrder(node, op, context)
		case "group":
			return group(deck, node, op, context)
		case "ungroup":
			return ungroup(node, op, context)
		case "align":
			return align(deck, node, op, context)
		case "distribute":
			return distribute(deck, node, op, context)
	}
}

// What a shape op names. Ops that move shapes between groups (group, ungroup) also touch what their inverse names,
// which the history adds (engine: touches of the op as applied and of its inverse).
function shapeTouches(op: ShapeOp): readonly Touch[] {
	switch (op.kind) {
		case "insert":
			return [nodeTouch(op.slide, op.shape.id)]
		// A delete that takes effects out of the slide's timing names it through its inverse (timing.setTiming).
		case "delete":
		case "zOrder":
			return op.shapes.map(id => nodeTouch(op.slide, id))
		case "setXfrm":
			return [{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "xfrm" } }]
		case "restore":
		case "setAlt":
		case "setAction":
			return [nodeTouch(op.target.slide, op.target.id)]
		case "setProps":
			return (Object.keys(op.props) as (keyof ShapePropsEdit)[]).map(group => ({
				kind: "shape",
				slide: op.target.slide,
				shape: op.target.id,
				dirt: { kind: "props", group }
			}))
		case "setStyle":
			return [{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "props", group: "style" } }]
		case "group":
			return [...(op.id === undefined ? [] : [nodeTouch(op.slide, op.id)]), ...op.shapes.map(id => nodeTouch(op.slide, id))]
		case "ungroup":
			return [nodeTouch(op.slide, op.group)]
		case "align":
		case "distribute":
			return op.shapes.map(id => ({ kind: "shape", slide: op.slide, shape: id, dirt: { kind: "xfrm" } }) as const)
		case "setXfrms":
			return op.xfrms.map(({ id }) => ({ kind: "shape", slide: op.slide, shape: id, dirt: { kind: "xfrm" } }) as const)
	}
}

export const applyShape: ApplyFamily<ShapeOp> = {
	apply: applyOne,
	touches: shapeTouches
}

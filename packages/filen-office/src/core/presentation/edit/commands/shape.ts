import { EMU_PER_PX } from "../../../drawingml/reader"
import { HANDLE_PLACES, type DrawingHandle } from "../../../docx/objects/hits"
import type { Action, ShapeLocks, ShapeRef, SlideRef, Xfrm } from "../../model"
import { ownDelta, ownThrough } from "../../groupSpace"
import type { DeckOp } from "../ops"
import { presentationHref, xmlSafeText } from "../xmlText"

// Moving, resizing and turning shapes as the editor's pointer and keys do it: boxes in, ops out. Slide EMU and
// a:xfrm's own terms throughout (rot in 60,000ths of a degree, clockwise; flips applied before the turn), so a box
// the page shows while dragging is exactly the box the op writes. Several shapes changed at once are one op, one
// history step.

export type { DrawingHandle }

// A shape of the slide in view with the box the editor shows for it, the file's own locks on it, and whether it draws
// as a line between two ends (a connector or a line preset), which are dragged instead of its box.
export interface PlacedShape {
	readonly id: number
	readonly xfrm: Xfrm
	readonly locks?: ShapeLocks
	readonly line?: true
	// A group member's: its enclosing groups' own boxes, outermost first (groupSpace.ts). Its `xfrm` is the box as it
	// shows on the slide; the op writes it back in the group's child space.
	readonly space?: readonly Xfrm[]
}

// Whether the file lets the editor move, resize or turn a shape (ECMA-376 Part 1 §20.1.2.2 noMove, noResize, noRot).
export function canMove(shape: PlacedShape): boolean {
	return shape.locks?.noMove !== true
}

export function canResize(shape: PlacedShape): boolean {
	return shape.locks?.noResize !== true
}

export function canTurn(shape: PlacedShape): boolean {
	return shape.locks?.noRot !== true && shape.line !== true
}

export const FULL_TURN = 21_600_000
const DEGREE = 60_000
// The step a turn snaps to while Shift is held (PowerPoint's).
export const ROTATE_SNAP = 15 * DEGREE
// Arrow keys move a selection this far (slide px); with Shift, NUDGE_LARGE_PX.
export const NUDGE_PX = 1
export const NUDGE_LARGE_PX = 10

function sameXfrm(a: Xfrm, b: Xfrm): boolean {
	return (
		a.x === b.x &&
		a.y === b.y &&
		a.cx === b.cx &&
		a.cy === b.cy &&
		a.rot === b.rot &&
		a.flipH === b.flipH &&
		a.flipV === b.flipV &&
		a.chX === b.chX &&
		a.chY === b.chY &&
		a.chCx === b.chCx &&
		a.chCy === b.chCy
	)
}

// The op that gives the shapes of `slide` the boxes in `after` (`before` holds what they have now): undefined
// when nothing changes, setXfrm for one shape, setXfrms for several (one history step). A group member's box (its
// `space` in `before`) is written in its group's child space.
export function xfrmsOp(slide: SlideRef, before: readonly PlacedShape[], after: readonly PlacedShape[]): DeckOp | undefined {
	const prior = new Map<number, PlacedShape>()

	for (const shape of before) prior.set(shape.id, shape)

	const changed = after.filter(shape => {
		const was = prior.get(shape.id)

		return was === undefined || !sameXfrm(was.xfrm, shape.xfrm)
	})
	const own = (shape: PlacedShape): Xfrm => {
		const space = prior.get(shape.id)?.space ?? shape.space

		return space === undefined || space.length === 0 ? { ...shape.xfrm } : ownThrough(space, shape.xfrm)
	}
	const only = changed[0]

	if (only === undefined) return undefined
	if (changed.length === 1) return { family: "shape", kind: "setXfrm", target: { slide, id: only.id }, xfrm: own(only) }

	return { family: "shape", kind: "setXfrms", slide, xfrms: changed.map(shape => ({ id: shape.id, xfrm: own(shape) })) }
}

export function movedXfrm(xfrm: Xfrm, dx: number, dy: number): Xfrm {
	return { ...xfrm, x: Math.round(xfrm.x + dx), y: Math.round(xfrm.y + dy) }
}

// A drag's offset with Shift held: along the axis it moved most.
export function constrainMove(dx: number, dy: number): { readonly dx: number; readonly dy: number } {
	return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy }
}

// The shapes moved by (dx, dy); one the file locks against moving keeps its place.
export function moveOp(slide: SlideRef, shapes: readonly PlacedShape[], dx: number, dy: number): DeckOp | undefined {
	return xfrmsOp(
		slide,
		shapes,
		shapes.map(shape => ({ id: shape.id, xfrm: canMove(shape) ? movedXfrm(shape.xfrm, dx, dy) : shape.xfrm }))
	)
}

export type NudgeDirection = "left" | "right" | "up" | "down"

// An arrow key's move: NUDGE_PX slide px, NUDGE_LARGE_PX with Shift.
export function nudgeOp(slide: SlideRef, shapes: readonly PlacedShape[], direction: NudgeDirection, large: boolean): DeckOp | undefined {
	const step = (large ? NUDGE_LARGE_PX : NUDGE_PX) * EMU_PER_PX
	const dx = direction === "left" ? -step : direction === "right" ? step : 0
	const dy = direction === "up" ? -step : direction === "down" ? step : 0

	return moveOp(slide, shapes, dx, dy)
}

function radians(rot: number): number {
	return ((rot / DEGREE) * Math.PI) / 180
}

export interface ResizeOptions {
	// The box keeps its proportions: a corner dragged with Shift, or any handle of a shape whose file locks its aspect
	// (a side handle then scales the other side about its middle).
	readonly keepRatio?: boolean
	// The centre stays and both sides move (Ctrl held).
	readonly fromCentre?: boolean
}

// The box after dragging `handle` by (dx, dy) slide EMU. The handle is a point of the box as it shows, turned by
// rot (a flip mirrors what the box holds, not the box), so the pointer's move is read along the box's own axes;
// the opposite edge or corner keeps its place on the slide. Sizes never go below zero.
export function resizedXfrm(xfrm: Xfrm, handle: DrawingHandle, dx: number, dy: number, options: ResizeOptions = {}): Xfrm {
	const [fx, fy] = HANDLE_PLACES[handle]
	const angle = radians(xfrm.rot)
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	// The move along the box's axes.
	const lx = dx * cos + dy * sin
	const ly = -dx * sin + dy * cos
	const horizontal = fx !== 0.5
	const vertical = fy !== 0.5
	const sides = options.fromCentre === true ? 2 : 1
	let width = horizontal ? xfrm.cx + (fx === 1 ? lx : -lx) * sides : xfrm.cx
	let height = vertical ? xfrm.cy + (fy === 1 ? ly : -ly) * sides : xfrm.cy

	width = Math.max(0, width)
	height = Math.max(0, height)

	if (options.keepRatio === true && xfrm.cx > 0 && xfrm.cy > 0) {
		const scale = horizontal && vertical ? Math.max(width / xfrm.cx, height / xfrm.cy) : horizontal ? width / xfrm.cx : height / xfrm.cy

		width = xfrm.cx * scale
		height = xfrm.cy * scale
	}

	// The point that stays, in the box's own frame from its centre: the opposite handle (the centre from the centre).
	const ax = options.fromCentre === true ? 0 : (0.5 - fx) * xfrm.cx
	const ay = options.fromCentre === true ? 0 : (0.5 - fy) * xfrm.cy
	const nx = options.fromCentre === true ? 0 : (0.5 - fx) * width
	const ny = options.fromCentre === true ? 0 : (0.5 - fy) * height
	const centreX = xfrm.x + xfrm.cx / 2 + (ax - nx) * cos - (ay - ny) * sin
	const centreY = xfrm.y + xfrm.cy / 2 + (ax - nx) * sin + (ay - ny) * cos
	const cx = Math.round(width)
	const cy = Math.round(height)

	return { ...xfrm, x: Math.round(centreX - cx / 2), y: Math.round(centreY - cy / 2), cx, cy }
}

// The box scaled by (sx, sy) along its own axes with the point opposite `handle` kept in place (the centre with
// `fromCentre`): how the other shapes of a selection follow the one whose handle is dragged.
export function scaledXfrm(xfrm: Xfrm, handle: DrawingHandle, sx: number, sy: number, fromCentre = false): Xfrm {
	const [fx, fy] = HANDLE_PLACES[handle]
	const width = fx === 0.5 ? xfrm.cx : Math.max(0, xfrm.cx * sx)
	const height = fy === 0.5 ? xfrm.cy : Math.max(0, xfrm.cy * sy)
	const angle = radians(xfrm.rot)
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	const ax = fromCentre ? 0 : (0.5 - fx) * (xfrm.cx - width)
	const ay = fromCentre ? 0 : (0.5 - fy) * (xfrm.cy - height)
	const centreX = xfrm.x + xfrm.cx / 2 + ax * cos - ay * sin
	const centreY = xfrm.y + xfrm.cy / 2 + ax * sin + ay * cos
	const cx = Math.round(width)
	const cy = Math.round(height)

	return { ...xfrm, x: Math.round(centreX - cx / 2), y: Math.round(centreY - cy / 2), cx, cy }
}

export function normalizedRot(rot: number): number {
	return ((Math.round(rot) % FULL_TURN) + FULL_TURN) % FULL_TURN
}

// The box turned by `delta` (60,000ths, clockwise) about its centre; with `snap`, the result lands on a
// ROTATE_SNAP multiple.
export function turnedXfrm(xfrm: Xfrm, delta: number, snap: boolean): Xfrm {
	const turned = xfrm.rot + delta
	const rot = snap ? Math.round(turned / ROTATE_SNAP) * ROTATE_SNAP : turned

	return { ...xfrm, rot: normalizedRot(rot) }
}

// The turn (60,000ths, clockwise) of the rotate handle dragged about the box's centre from one slide point to
// another.
export function dragTurn(
	xfrm: Xfrm,
	from: { readonly x: number; readonly y: number },
	to: { readonly x: number; readonly y: number }
): number {
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2
	const start = Math.atan2(from.y - cy, from.x - cx)
	const end = Math.atan2(to.y - cy, to.x - cx)

	return Math.round((((end - start) * 180) / Math.PI) * DEGREE)
}

// The shapes turned by `delta` (60,000ths, clockwise), each about its own centre; one the file locks against turning
// stays.
export function turnedShapes(shapes: readonly PlacedShape[], delta: number): PlacedShape[] {
	return shapes.map(shape => (shape.locks?.noRot === true ? shape : { ...shape, xfrm: turnedXfrm(shape.xfrm, delta, false) }))
}

// Rotate ▸ Right 90° / Left 90°.
export function rotateOp(slide: SlideRef, shapes: readonly PlacedShape[], quarter: 1 | -1): DeckOp | undefined {
	return xfrmsOp(slide, shapes, turnedShapes(shapes, quarter * 90 * DEGREE))
}

// Shift+arrow on a Mac: the right (bottom) edge moves NUDGE_PX the arrow's way along the box's own axes, the left (top)
// edge staying; a shape whose file locks its aspect scales both sides, one locked against resizing keeps its box, and
// no side shrinks below one step.
export function steppedShapes(shapes: readonly PlacedShape[], direction: NudgeDirection): PlacedShape[] {
	const step = NUDGE_PX * EMU_PER_PX
	const sign = direction === "right" || direction === "down" ? 1 : -1
	const horizontal = direction === "left" || direction === "right"

	return shapes.map(shape => {
		const xfrm = shape.xfrm

		if (!canResize(shape) || (sign < 0 && (horizontal ? xfrm.cx : xfrm.cy) < 2 * step)) return shape

		const angle = radians(xfrm.rot)
		const along = sign * step
		const dx = horizontal ? along * Math.cos(angle) : -along * Math.sin(angle)
		const dy = horizontal ? along * Math.sin(angle) : along * Math.cos(angle)

		return {
			...shape,
			xfrm: resizedXfrm(xfrm, horizontal ? "e" : "s", dx, dy, { keepRatio: shape.locks?.noChangeAspect === true })
		}
	})
}

// Duplicate (Ctrl+D): copies DUPLICATE_OFFSET_PX right and down of the originals; a Ctrl+drag gives its own offset
// (slide EMU). Members of a group (`space`, their enclosing groups' boxes) are copied into it, the offset taken into
// its child space so the copies land that far away on the slide.
export const DUPLICATE_OFFSET_PX = 10

export function duplicateOp(
	slide: SlideRef,
	ids: readonly number[],
	dx = DUPLICATE_OFFSET_PX * EMU_PER_PX,
	dy = DUPLICATE_OFFSET_PX * EMU_PER_PX,
	space?: readonly Xfrm[]
): DeckOp | undefined {
	if (ids.length === 0) return undefined

	const offset = space === undefined || space.length === 0 ? { dx, dy } : ownDelta(space, dx, dy)

	return { family: "shape", kind: "duplicate", slide, shapes: [...ids], ...offset }
}

// A line's two ends as they show (slide EMU): it draws from its box's top-left to its bottom-right corner, a flip
// swapping that axis's ends, turned with the box about its centre.
export function lineEnds(xfrm: Xfrm): { readonly start: { x: number; y: number }; readonly end: { x: number; y: number } } {
	const angle = radians(xfrm.rot)
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	const hx = ((xfrm.flipH ? 1 : -1) * xfrm.cx) / 2
	const hy = ((xfrm.flipV ? 1 : -1) * xfrm.cy) / 2
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2

	return {
		start: { x: cx + hx * cos - hy * sin, y: cy + hx * sin + hy * cos },
		end: { x: cx - hx * cos + hy * sin, y: cy - hx * sin - hy * cos }
	}
}

export type LineEnd = "start" | "end"

// The line's box with one end at `to` (slide EMU) and the other where it is, as PowerPoint drags a line's end: the
// turn stays, the box spans the two ends along its own axes, and an end dragged past the other flips that axis.
// With `snap`, the line from the fixed end lands on a ROTATE_SNAP step (Shift).
export function lineEndXfrm(xfrm: Xfrm, which: LineEnd, to: { readonly x: number; readonly y: number }, snap = false): Xfrm {
	const ends = lineEnds(xfrm)
	const fixed = which === "start" ? ends.end : ends.start
	let moved = to

	if (snap) {
		const length = Math.hypot(to.x - fixed.x, to.y - fixed.y)
		const step = (ROTATE_SNAP / DEGREE / 180) * Math.PI
		const direction = Math.round(Math.atan2(to.y - fixed.y, to.x - fixed.x) / step) * step

		moved = { x: fixed.x + length * Math.cos(direction), y: fixed.y + length * Math.sin(direction) }
	}

	const start = which === "start" ? moved : fixed
	const end = which === "start" ? fixed : moved
	const angle = radians(xfrm.rot)
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	// start → end along the box's own axes.
	const dx = end.x - start.x
	const dy = end.y - start.y
	const lx = dx * cos + dy * sin
	const ly = -dx * sin + dy * cos
	const cx = Math.round(Math.abs(lx))
	const cy = Math.round(Math.abs(ly))
	const midX = (start.x + end.x) / 2
	const midY = (start.y + end.y) / 2

	return { ...xfrm, x: Math.round(midX - cx / 2), y: Math.round(midY - cy / 2), cx, cy, flipH: lx < 0, flipV: ly < 0 }
}

// What a selected shape is, as far as flipping goes: its layer's role, the roles of every layer that paints it (a
// group's children's included) and whether it plays a medium.
export interface FlipCandidate extends PlacedShape {
	readonly role?: string
	readonly roles?: readonly string[]
	readonly media?: unknown
}

const UNFLIPPABLE: ReadonlySet<string> = new Set(["table", "chart", "ole", "smartart", "media"])

// Whether a shape can be flipped: a graphic frame (a table, chart, embedded object or diagram) has no flip PowerPoint
// draws (ECMA-376 §19.3.1.21) and ODF's draw:frame holds none; a medium plays unflipped in both; a group holding one
// would mirror it.
export function canFlip(shape: FlipCandidate): boolean {
	return !UNFLIPPABLE.has(shape.role ?? "") && !(shape.roles ?? []).some(role => UNFLIPPABLE.has(role)) && shape.media === undefined
}

// Rotate ▸ Flip: each shape mirrored in place. A turned shape mirrored across the slide's vertical axis keeps its
// box and turns the other way (flips apply before the turn).
export function flipOp(slide: SlideRef, shapes: readonly FlipCandidate[], axis: "horizontal" | "vertical"): DeckOp | undefined {
	if (!shapes.every(canFlip)) return undefined

	return xfrmsOp(
		slide,
		shapes,
		shapes.map(shape => ({
			id: shape.id,
			xfrm: {
				...shape.xfrm,
				flipH: axis === "horizontal" ? !shape.xfrm.flipH : shape.xfrm.flipH,
				flipV: axis === "vertical" ? !shape.xfrm.flipV : shape.xfrm.flipV,
				rot: normalizedRot(-shape.xfrm.rot)
			}
		}))
	)
}

export function deleteOp(slide: SlideRef, ids: readonly number[]): DeckOp | undefined {
	return ids.length === 0 ? undefined : { family: "shape", kind: "delete", slide, shapes: [...ids] }
}

export interface AltText {
	readonly descr?: string
	readonly title?: string
	readonly decorative?: boolean
}

// Alt text as the dialog leaves it: what XML cannot carry taken out (a pasted soft break becomes a space), trimmed,
// empty fields dropped; nothing at all removes it. A decorative shape keeps no description (PowerPoint clears it when
// the box is ticked).
export function altOp(target: ShapeRef, alt: AltText): DeckOp {
	const descr = alt.decorative === true ? "" : xmlSafeText(alt.descr ?? "").trim()
	const title = xmlSafeText(alt.title ?? "").trim()
	const next: { descr?: string; title?: string; decorative?: boolean } = {}

	if (descr !== "") next.descr = descr
	if (title !== "") next.title = title
	if (alt.decorative === true) next.decorative = true

	return { family: "shape", kind: "setAlt", target, alt: Object.keys(next).length === 0 ? undefined : next }
}

// An action the editor can set. Refused kinds (programs, macros, files, scripts) are never written by an edit; a
// shape that has one keeps it until it is removed.
export function settableAction(action: Action): boolean {
	return action.kind !== "refused"
}

// A url action stores the link as presentationHref leaves it (what the save reads back as the same url); one it
// refuses is no op.
export function actionOp(target: ShapeRef, trigger: "click" | "hover", action: Action | undefined): DeckOp | undefined {
	if (action !== undefined && !settableAction(action)) return undefined

	if (action?.kind === "url") {
		const href = presentationHref(action.href)

		if (href === undefined) return undefined

		return { family: "shape", kind: "setAction", target, trigger, action: href === action.href ? action : { kind: "url", href } }
	}

	return { family: "shape", kind: "setAction", target, trigger, action }
}

import { EMU_PER_PX } from "../../../core/drawingml/reader"
import { DRAWING_HANDLES, HANDLE_PLACES } from "../../../core/docx/objects/hits"
import {
	canMove,
	canResize,
	canTurn,
	constrainMove,
	dragTurn,
	duplicateOp,
	lineEndXfrm,
	lineEnds,
	movedXfrm,
	resizedXfrm,
	scaledXfrm,
	turnedXfrm,
	xfrmsOp,
	type DrawingHandle,
	type LineEnd,
	type PlacedShape
} from "../../../core/presentation/edit/commands/shape"
import type { DeckOp } from "../../../core/presentation/edit/ops"
import type { SlideRef, Xfrm } from "../../../core/presentation/model"
import { SnapTargets, type Guide, type SnapGrid, type Spacing } from "./guides"
import { boundsOf, unionBounds, type Bounds } from "./selection"

// One pointer drag on the selection, headless: moving it (copying it with Ctrl), resizing it by a handle of one of
// its shapes (the rest follow by the same proportions), turning it by that shape's rotate handle, or dragging one end of a line. The
// file's own locks hold: a shape locked against moving, resizing or turning shows no handle for it and keeps its box
// while the rest of the selection changes, and a locked aspect keeps the proportions (Shift frees them, as in
// PowerPoint). move() gives the boxes to show (the
// page previews them as CSS transforms of the painted layers, so nothing is laid out until the drop) and the
// guides; end() the one op the drag ends with. Slide EMU throughout; screen px only in the grab distances.

export { DRAWING_HANDLES, type DrawingHandle }

// How far from a handle's centre a press still takes it (screen px), and how far above the top edge the rotate
// handle sits.
export const HANDLE_GRAB_PX = 8
export const ROTATE_OFFSET_PX = 24
// A press must move this far (screen px) before it becomes a move or a marquee.
export const DRAG_START_PX = 3

export interface Point {
	readonly x: number
	readonly y: number
}

export type HandleHit =
	| { readonly kind: "resize"; readonly id: number; readonly handle: DrawingHandle }
	| { readonly kind: "rotate"; readonly id: number }
	| { readonly kind: "end"; readonly id: number; readonly end: LineEnd }

// A point of the box given as fractions of its width and height (from its top-left as it shows unturned), turned
// with it about its centre. EMU.
export function boxPoint(xfrm: Xfrm, fx: number, fy: number, outY = 0): Point {
	const angle = (xfrm.rot / 60000 / 180) * Math.PI
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	const lx = (fx - 0.5) * xfrm.cx
	const ly = (fy - 0.5) * xfrm.cy - outY

	return { x: xfrm.x + xfrm.cx / 2 + lx * cos - ly * sin, y: xfrm.y + xfrm.cy / 2 + lx * sin + ly * cos }
}

export function handlePoint(xfrm: Xfrm, handle: DrawingHandle): Point {
	const [fx, fy] = HANDLE_PLACES[handle]

	return boxPoint(xfrm, fx, fy)
}

// `offset`: ROTATE_OFFSET_PX in EMU at the current zoom.
export function rotatePoint(xfrm: Xfrm, offset: number): Point {
	return boxPoint(xfrm, 0.5, 0, offset)
}

// The handles a box shows: none on a box too small to hold them apart (only its corners then), the side handles
// only where the side is long enough.
export function shownHandles(xfrm: Xfrm, emuPerScreenPx: number): readonly DrawingHandle[] {
	const minimum = HANDLE_GRAB_PX * 2 * emuPerScreenPx

	if (xfrm.cx < minimum && xfrm.cy < minimum) return ["nw", "ne", "se", "sw"]

	return DRAWING_HANDLES.filter(handle => {
		const [fx, fy] = HANDLE_PLACES[handle]

		if (fx === 0.5) return xfrm.cx >= minimum
		if (fy === 0.5) return xfrm.cy >= minimum

		return true
	})
}

// The box handles a selected shape offers: none on a line (its ends instead) or a shape the file locks against
// resizing.
export function boxHandles(shape: PlacedShape, emuPerScreenPx: number): readonly DrawingHandle[] {
	return shape.line === true || !canResize(shape) ? [] : shownHandles(shape.xfrm, emuPerScreenPx)
}

// Whether a selected shape shows its rotate handle (not a line, not locked against turning).
export function hasRotateHandle(shape: PlacedShape): boolean {
	return canTurn(shape)
}

// Whether a selected shape shows its two end handles (a line the file lets resize).
export function hasEndHandles(shape: PlacedShape): boolean {
	return shape.line === true && canResize(shape)
}

// The handle of a selected shape under a slide point (front shapes first); `grab` and `offset` in EMU.
export function handleAt(
	shapes: readonly PlacedShape[],
	point: Point,
	grab: number,
	offset: number,
	emuPerScreenPx: number
): HandleHit | undefined {
	const near = (target: Point): boolean => Math.hypot(target.x - point.x, target.y - point.y) <= grab

	for (let k = shapes.length - 1; k >= 0; k--) {
		const shape = shapes[k] as PlacedShape

		if (hasEndHandles(shape)) {
			const ends = lineEnds(shape.xfrm)

			if (near(ends.end)) return { kind: "end", id: shape.id, end: "end" }
			if (near(ends.start)) return { kind: "end", id: shape.id, end: "start" }
		}

		if (hasRotateHandle(shape) && near(rotatePoint(shape.xfrm, offset))) return { kind: "rotate", id: shape.id }

		for (const handle of boxHandles(shape, emuPerScreenPx)) {
			if (near(handlePoint(shape.xfrm, handle))) return { kind: "resize", id: shape.id, handle }
		}
	}

	return undefined
}

const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const
const HANDLE_ANGLE: Readonly<Record<DrawingHandle, number>> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 }

// The resize cursor a handle shows on a turned box: the nearest of the four.
export function handleCursor(xfrm: Xfrm, handle: DrawingHandle): string {
	const angle = HANDLE_ANGLE[handle] + xfrm.rot / 60000
	const step = Math.round((((angle % 180) + 180) % 180) / 45) % 4

	return CURSORS[step] as string
}

// The CSS matrix (slide px) that shows what was painted in box `from` in box `to`: the unturned unit box of
// `from` mapped back, then onto `to`. Applied before a layer's own matrix.
export function previewMatrix(from: Xfrm, to: Xfrm): number[] {
	const unit = (xfrm: Xfrm): number[] => {
		const angle = (xfrm.rot / 60000 / 180) * Math.PI
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		const w = Math.max(1, xfrm.cx) / EMU_PER_PX
		const h = Math.max(1, xfrm.cy) / EMU_PER_PX
		const cx = (xfrm.x + xfrm.cx / 2) / EMU_PER_PX
		const cy = (xfrm.y + xfrm.cy / 2) / EMU_PER_PX

		// translate(centre) · rotate · scale(w, h) · translate(-0.5, -0.5)
		return [cos * w, sin * w, -sin * h, cos * h, cx - 0.5 * (cos * w - sin * h), cy - 0.5 * (sin * w + cos * h)]
	}
	const a = unit(to)
	const b = unit(from)
	// b⁻¹
	const det = (b[0] as number) * (b[3] as number) - (b[1] as number) * (b[2] as number)
	const [b0, b1, b2, b3, b4, b5] = b as [number, number, number, number, number, number]
	const inverse = [b3 / det, -b1 / det, -b2 / det, b0 / det, (b2 * b5 - b3 * b4) / det, (b1 * b4 - b0 * b5) / det]

	return multiply(a, inverse)
}

export function multiply(m: readonly number[], n: readonly number[]): number[] {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m
	const [p = 1, q = 0, r = 0, s = 1, t = 0, u = 0] = n

	return [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f]
}

export type DragKind = "move" | "resize" | "rotate" | "end"

export interface DragModifiers {
	// Shift: along one axis (move), proportions kept (corner resize), 15° steps (rotate).
	readonly shift: boolean
	// Ctrl: resize from the centre; a move drag copies (Ctrl+drag), read again on every frame so a press or release
	// during the drag decides at the drop.
	readonly ctrl: boolean
	// Alt: no snapping.
	readonly alt: boolean
}

export interface DragFrame {
	// A move drag's copies: `shapes` are the boxes the copies land in (the movable shapes only), the originals stay.
	readonly copy?: true
	readonly shapes: readonly PlacedShape[]
	readonly guides: readonly Guide[]
	readonly spacing: readonly Spacing[]
}

export interface ShapeDragOptions {
	readonly kind: DragKind
	readonly slide: SlideRef
	// The selected shapes, as they are now.
	readonly shapes: readonly PlacedShape[]
	// The shape whose handle was pressed (resize, rotate).
	readonly id?: number
	readonly handle?: DrawingHandle
	// The end of the line pressed (kind "end").
	readonly end?: LineEnd
	readonly start: Point
	// The other shapes' bounds, the slide's size and the grid objects snap to (absent: none), for snapping (absent: no
	// snapping).
	readonly snap?: {
		readonly others: readonly Bounds[]
		readonly slide: { readonly cx: number; readonly cy: number }
		readonly grid?: SnapGrid
	}
	// The snap distance in EMU at the current zoom.
	readonly threshold: number
}

export class ShapeDrag {
	readonly kind: DragKind
	private readonly options: ShapeDragOptions
	private readonly targets: SnapTargets | undefined
	private readonly primary: PlacedShape | undefined
	private frame: DragFrame
	// A move drag's offset at its last frame (EMU).
	private offset = { dx: 0, dy: 0 }

	constructor(options: ShapeDragOptions) {
		this.kind = options.kind
		this.options = options
		this.targets = options.snap === undefined ? undefined : new SnapTargets(options.snap.others, options.snap.slide, options.snap.grid)
		this.primary = options.shapes.find(shape => shape.id === options.id) ?? options.shapes[options.shapes.length - 1]
		this.frame = { shapes: options.shapes, guides: [], spacing: [] }
	}

	get current(): DragFrame {
		return this.frame
	}

	move(point: Point, modifiers: DragModifiers): DragFrame {
		const { start, shapes } = this.options
		let dx = point.x - start.x
		let dy = point.y - start.y

		switch (this.kind) {
			case "move": {
				const constrained = modifiers.shift ? constrainMove(dx, dy) : { dx, dy }
				const moving = shapes.filter(canMove)
				const bounds = unionBounds(moving.map(shape => boundsOf(movedXfrm(shape.xfrm, constrained.dx, constrained.dy))))
				let guides: readonly Guide[] = []
				let spacing: readonly Spacing[] = []

				dx = constrained.dx
				dy = constrained.dy

				if (this.targets !== undefined && bounds !== undefined && !modifiers.alt) {
					const snap = this.targets.snapMove(bounds, this.options.threshold, {
						x: !modifiers.shift || constrained.dx !== 0,
						y: !modifiers.shift || constrained.dy !== 0
					})

					dx += snap.dx
					dy += snap.dy
					guides = snap.guides
					spacing = snap.spacing
				}

				this.offset = { dx, dy }
				this.frame = modifiers.ctrl
					? { copy: true, shapes: moving.map(shape => ({ ...shape, xfrm: movedXfrm(shape.xfrm, dx, dy) })), guides, spacing }
					: {
							shapes: shapes.map(shape => (canMove(shape) ? { ...shape, xfrm: movedXfrm(shape.xfrm, dx, dy) } : shape)),
							guides,
							spacing
						}
				break
			}
			case "resize":
				this.frame = this.resize(dx, dy, modifiers)
				break
			case "end":
				this.frame = this.lineEnd(point, modifiers)
				break
			case "rotate": {
				const primary = this.primary

				if (primary === undefined) break

				const turn = dragTurn(primary.xfrm, start, point)

				this.frame = {
					shapes: shapes.map(shape =>
						canTurn(shape) ? { ...shape, xfrm: turnedXfrm(shape.xfrm, turn, modifiers.shift) } : shape
					),
					guides: [],
					spacing: []
				}
				break
			}
		}

		return this.frame
	}

	private resize(dx: number, dy: number, modifiers: DragModifiers): DragFrame {
		const primary = this.primary
		const handle = this.options.handle

		if (primary === undefined || handle === undefined) return this.frame

		const [fx, fy] = HANDLE_PLACES[handle]
		const corner = fx !== 0.5 && fy !== 0.5
		// A locked aspect keeps the proportions on every handle; Shift frees it on a corner, and keeps them on one
		// otherwise.
		const locked = primary.locks?.noChangeAspect === true
		const sizing = { keepRatio: corner ? modifiers.shift !== locked : locked, fromCentre: modifiers.ctrl }
		let next = resizedXfrm(primary.xfrm, handle, dx, dy, sizing)
		let guides: Guide[] = []

		// An unturned box snaps the edges its handle moves, to a line or else the grid (not while proportions are kept:
		// both edges would pull).
		if (this.targets !== undefined && primary.xfrm.rot === 0 && !sizing.keepRatio && !modifiers.alt) {
			const threshold = this.options.threshold
			const xEdge = fx === 1 ? next.x + next.cx : fx === 0 ? next.x : undefined
			const yEdge = fy === 1 ? next.y + next.cy : fy === 0 ? next.y : undefined
			const snapX = xEdge === undefined ? undefined : this.targets.snapEdges("x", [xEdge], threshold)
			const snapY = yEdge === undefined ? undefined : this.targets.snapEdges("y", [yEdge], threshold)

			if (snapX !== undefined || snapY !== undefined) {
				next = resizedXfrm(primary.xfrm, handle, dx + (snapX?.delta ?? 0), dy + (snapY?.delta ?? 0), sizing)

				const landed = boundsOf(next)

				guides = [
					...(snapX?.line === true ? this.targets.guidesAt("x", [fx === 1 ? landed.r : landed.x], landed) : []),
					...(snapY?.line === true ? this.targets.guidesAt("y", [fy === 1 ? landed.b : landed.y], landed) : [])
				]
			}
		}

		const sx = primary.xfrm.cx > 0 ? next.cx / primary.xfrm.cx : 1
		const sy = primary.xfrm.cy > 0 ? next.cy / primary.xfrm.cy : 1

		return {
			shapes: this.options.shapes.map(shape =>
				shape.id === primary.id
					? { ...shape, xfrm: next }
					: canResize(shape) && shape.line !== true
						? { ...shape, xfrm: scaledXfrm(shape.xfrm, handle, sx, sy, sizing.fromCentre) }
						: shape
			),
			guides,
			spacing: []
		}
	}

	// One end of the line pressed follows the pointer (snapping to the other shapes' edges and centres, or with Shift
	// to 15° steps from the other end); the rest of the selection stays.
	private lineEnd(point: Point, modifiers: DragModifiers): DragFrame {
		const primary = this.primary
		const end = this.options.end

		if (primary === undefined || end === undefined) return this.frame

		let to = point
		let guides: Guide[] = []

		if (this.targets !== undefined && !modifiers.shift && !modifiers.alt) {
			const threshold = this.options.threshold
			const snapX = this.targets.snapEdges("x", [point.x], threshold)
			const snapY = this.targets.snapEdges("y", [point.y], threshold)

			to = { x: point.x + (snapX?.delta ?? 0), y: point.y + (snapY?.delta ?? 0) }

			const at = { x: to.x, y: to.y, r: to.x, b: to.y }

			guides = [
				...(snapX?.line === true ? this.targets.guidesAt("x", [to.x], at) : []),
				...(snapY?.line === true ? this.targets.guidesAt("y", [to.y], at) : [])
			]
		}

		const next = lineEndXfrm(primary.xfrm, end, to, modifiers.shift)

		return {
			shapes: this.options.shapes.map(shape => (shape.id === primary.id ? { ...shape, xfrm: next } : shape)),
			guides,
			spacing: []
		}
	}

	// The op the drag ends with; undefined when no box changed. A copying move ends in one duplicate (one undo step)
	// of the movable shapes, back to front as given, at the drop's offset.
	end(): DeckOp | undefined {
		if (this.frame.copy === true) {
			const { dx, dy } = this.offset

			if (dx === 0 && dy === 0) return undefined

			return duplicateOp(
				this.options.slide,
				this.frame.shapes.map(shape => shape.id),
				dx,
				dy
			)
		}

		return xfrmsOp(this.options.slide, this.options.shapes, this.frame.shapes)
	}
}

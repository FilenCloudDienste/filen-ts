import { curvePath, linePath, polylinePath, simplifyStroke, type EditablePath, type Point } from "../../../../core/anim/motionEdit"
import type { Refused } from "../../../../core/presentation/model"

// The Draw Custom Path tools as a pointer state machine over slide fractions (x of the width, y of the height, from
// the slide's top left), as PowerPoint draws them:
// - Line: press and drag to the end (or click, then click the end).
// - Curve: click each point; a double click or Enter ends it, a click on the start closes it.
// - Freeform: click for straight segments, press and drag to draw freehand; ends and closes as Curve does.
// - Scribble: press and drag; the release ends it.
// From the keyboard, Line, Curve and Freeform place a point at the keyboard cursor (`place`): Line its start, then its
// end; Curve and Freeform each point as a click does (on the start it closes), and Enter ends them.
// Freehand samples are kept in one growing Float64Array and simplified once, when the path ends (within half a
// screen pixel), so a long stroke costs nothing per move beyond the sample it adds.

export type MotionTool = "line" | "curve" | "freeform" | "scribble"

export const MOTION_TOOLS: readonly MotionTool[] = ["line", "curve", "freeform", "scribble"]

// A second press this close (screen px) and soon (ms) after the last one is a double click: the path ends.
const DOUBLE_PX = 6
const DOUBLE_MS = 500
// A press this close (screen px) to the start of a path of three or more points closes it.
const CLOSE_PX = 8
// A press that moves this far (screen px) draws freehand (Freeform) or is a drag (Line).
const DRAG_PX = 3

export interface DrawGeometry {
	// The slide on screen, px.
	readonly width: number
	readonly height: number
}

export type DrawStep = "continue" | "done"

class Stroke {
	private data = new Float64Array(256)
	length = 0

	push(x: number, y: number): void {
		if (this.length + 2 > this.data.length) {
			const grown = new Float64Array(this.data.length * 2)

			grown.set(this.data)
			this.data = grown
		}

		this.data[this.length++] = x
		this.data[this.length++] = y
	}

	values(): Float64Array {
		return this.data.subarray(0, this.length)
	}
}

export class PathDrawing {
	readonly tool: MotionTool
	private readonly geometry: DrawGeometry
	// Fixed points so far (clicks, and freehand runs once simplified).
	private readonly points: Point[] = []
	private freehand: Stroke | undefined
	private pressed: { x: number; y: number } | undefined
	private dragging = false
	private lastPress: { x: number; y: number; time: number } | undefined
	private pointer: Point | undefined
	private closed = false
	private ended = false

	constructor(tool: MotionTool, geometry: DrawGeometry) {
		this.tool = tool
		this.geometry = geometry
	}

	get done(): boolean {
		return this.ended
	}

	private screenDistance(a: Point, b: Point): number {
		return Math.hypot((a.x - b.x) * this.geometry.width, (a.y - b.y) * this.geometry.height)
	}

	private tolerance(): number {
		// Half a screen pixel, in fractions of the height (simplifyStroke measures x by the aspect).
		return 0.5 / Math.max(1, this.geometry.height)
	}

	private flushFreehand(): void {
		const stroke = this.freehand

		this.freehand = undefined

		if (stroke === undefined || stroke.length < 4) return

		const kept = simplifyStroke(stroke.values(), this.tolerance(), this.geometry.width / Math.max(1, this.geometry.height))

		// The run starts at the last fixed point.
		for (const point of this.points.length > 0 ? kept.slice(1) : kept) this.points.push(point)
	}

	down(x: number, y: number, time: number): DrawStep {
		if (this.ended) return "done"

		const point = { x, y }
		const last = this.lastPress

		this.lastPress = { x, y, time }
		this.pressed = point
		this.dragging = false

		if (this.tool === "line" || this.tool === "scribble") {
			if (this.points.length === 0) {
				this.points.push(point)

				if (this.tool === "scribble") {
					this.freehand = new Stroke()
					this.freehand.push(x, y)
				}
			}

			return "continue"
		}

		// Curve and Freeform: a double click ends, a press on the start closes.
		if (
			last !== undefined &&
			time - last.time <= DOUBLE_MS &&
			this.screenDistance(point, last) <= DOUBLE_PX &&
			this.points.length >= 2
		) {
			this.ended = true

			return "done"
		}

		const first = this.points[0]

		if (first !== undefined && this.points.length >= 3 && this.screenDistance(point, first) <= CLOSE_PX) {
			this.closed = true
			this.ended = true

			return "done"
		}

		// A press on the last point adds no zero-length segment (a freehand run may start there).
		const previous = this.points[this.points.length - 1]

		if (previous === undefined || this.screenDistance(point, previous) > DOUBLE_PX) this.points.push(point)

		return "continue"
	}

	move(x: number, y: number): void {
		if (this.ended) return

		this.pointer = { x, y }

		const pressed = this.pressed

		if (pressed === undefined) return

		if (!this.dragging && this.screenDistance(pressed, { x, y }) >= DRAG_PX) {
			this.dragging = true

			if (this.tool === "freeform") {
				this.freehand = new Stroke()
				this.freehand.push(pressed.x, pressed.y)
			}
		}

		if (this.dragging && this.freehand !== undefined) this.freehand.push(x, y)
	}

	up(x: number, y: number): DrawStep {
		if (this.ended) return "done"

		const wasDrag = this.dragging

		this.move(x, y)
		this.pressed = undefined
		this.dragging = false

		switch (this.tool) {
			case "scribble":
				this.flushFreehand()
				this.ended = this.points.length >= 2

				return this.ended ? "done" : "continue"
			case "line": {
				const start = this.points[0]

				// A click (no drag) on the start waits for the end's click.
				if (start === undefined || (!wasDrag && this.screenDistance(start, { x, y }) < DRAG_PX)) return "continue"

				this.points.length = 1
				this.points.push({ x, y })
				this.ended = true

				return "done"
			}
			case "freeform":
				if (wasDrag) this.flushFreehand()

				return "continue"
			default:
				return "continue"
		}
	}

	// A point placed from the keyboard at (x, y); the cursor shows the rubber band to it.
	place(x: number, y: number): DrawStep {
		if (this.ended) return "done"
		if (this.tool === "scribble") return "continue"

		const point = { x, y }

		this.pointer = point

		if (this.tool === "line") {
			const start = this.points[0]

			if (start === undefined) {
				this.points.push(point)

				return "continue"
			}

			if (this.screenDistance(start, point) < DRAG_PX) return "continue"

			this.points.push(point)
			this.ended = true

			return "done"
		}

		this.flushFreehand()

		const first = this.points[0]

		if (first !== undefined && this.points.length >= 3 && this.screenDistance(point, first) <= CLOSE_PX) {
			this.closed = true
			this.ended = true

			return "done"
		}

		const previous = this.points[this.points.length - 1]

		if (previous === undefined || this.screenDistance(point, previous) > DOUBLE_PX) this.points.push(point)

		return "continue"
	}

	// The keyboard cursor moved to (x, y): the rubber band follows it.
	hover(x: number, y: number): void {
		if (!this.ended && this.pressed === undefined) this.pointer = { x, y }
	}

	// Enter: ends a Curve or Freeform of two or more points.
	finishNow(): DrawStep {
		this.flushFreehand()

		if (this.points.length >= 2) this.ended = true

		return this.ended ? "done" : "continue"
	}

	// The path drawn, relative to `origin` (the shape's centre, slide fractions); undefined before two points.
	result(origin: Point): EditablePath | Refused | undefined {
		const points = this.points.map(point => ({ x: point.x - origin.x, y: point.y - origin.y }))

		if (points.length < 2) return undefined

		switch (this.tool) {
			case "line":
				return linePath(points[0] as Point, points[1] as Point)
			case "curve":
				return curvePath(points, this.closed)
			default:
				return polylinePath(points, this.closed)
		}
	}

	// What to show while drawing (slide fractions, x y pairs): the fixed points, the freehand run, and the rubber band
	// to the pointer.
	preview(): Float64Array {
		const stroke = this.freehand
		const extra = this.ended || this.pointer === undefined ? 0 : 2
		const out = new Float64Array(this.points.length * 2 + (stroke?.length ?? 0) + extra)
		let k = 0

		for (const point of this.points) {
			out[k++] = point.x
			out[k++] = point.y
		}

		if (stroke !== undefined) {
			out.set(stroke.values(), k)
			k += stroke.length
		}

		if (extra > 0 && this.pointer !== undefined) {
			out[k++] = this.pointer.x
			out[k++] = this.pointer.y
		}

		return out
	}
}

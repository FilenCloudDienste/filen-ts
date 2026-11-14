import type { PdfPoint } from "../../../core/pdfedit/annotations"
import { clampPoint, type ToolPointer, type ToolStep } from "./types"

// The ink tool: one stroke per press, smoothed on the main thread when it ends and committed as one stroke (the host
// adds it to the drawing it is continuing, or starts one: one journal operation per stroke). Pen pressure is ignored.
// The stroke's points grow in a Float64Array the state shares from step to step (no object per point while drawing);
// each step returns a new state object so a renderer sees the change.

export interface InkStroke {
	readonly page: number
	// x, y pairs in page space; the first `length` values are points.
	readonly points: Float64Array
	readonly length: number
}

export interface InkState {
	readonly stroke: InkStroke | null
}

export interface InkCommit {
	readonly page: number
	readonly points: readonly PdfPoint[]
}

export const INK_IDLE: InkState = { stroke: null }

// A point closer than this (points) to the last one is dropped while drawing.
export const INK_MIN_STEP = 0.5
// Douglas-Peucker tolerance of the committed stroke (points).
export const INK_TOLERANCE = 0.3
// The engine's cap on one stroke.
export const INK_MAX_POINTS = 10_000

function append(stroke: InkStroke, point: PdfPoint): InkStroke {
	let points = stroke.points

	if (stroke.length + 2 > points.length) {
		const grown = new Float64Array(points.length * 2)

		grown.set(points)
		points = grown
	}

	points[stroke.length] = point[0]
	points[stroke.length + 1] = point[1]

	return { page: stroke.page, points, length: stroke.length + 2 }
}

export function inkPointer(state: InkState, event: ToolPointer): ToolStep<InkState, InkCommit> {
	const point = clampPoint(event.point, event.box)
	const stroke = state.stroke

	switch (event.type) {
		case "down":
			return { state: { stroke: append({ page: event.page, points: new Float64Array(256), length: 0 }, point) } }
		case "move": {
			if (stroke === null || stroke.page !== event.page || stroke.length / 2 >= INK_MAX_POINTS) return { state }

			const lastX = stroke.points[stroke.length - 2] ?? 0
			const lastY = stroke.points[stroke.length - 1] ?? 0

			return Math.hypot(point[0] - lastX, point[1] - lastY) < INK_MIN_STEP ? { state } : { state: { stroke: append(stroke, point) } }
		}
		case "up":
			return stroke === null
				? { state }
				: { state: INK_IDLE, commit: { page: stroke.page, points: smoothStroke(stroke.points, stroke.length) } }
		case "cancel":
			return { state: INK_IDLE }
	}
}

// Perpendicular distance of p from the segment a-b.
function segmentDistance(p: PdfPoint, a: PdfPoint, b: PdfPoint): number {
	const dx = b[0] - a[0]
	const dy = b[1] - a[1]
	const length = dx * dx + dy * dy

	if (length === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])

	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))

	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

// Douglas-Peucker with an explicit stack (no recursion depth on long strokes).
function simplify(points: readonly PdfPoint[], tolerance: number): PdfPoint[] {
	if (points.length <= 2) return points.slice()

	const keep = new Uint8Array(points.length)
	const stack: [number, number][] = [[0, points.length - 1]]

	keep[0] = 1
	keep[points.length - 1] = 1

	for (let range = stack.pop(); range !== undefined; range = stack.pop()) {
		const [first, last] = range
		const a = points[first]
		const b = points[last]

		if (a === undefined || b === undefined) continue

		let worst = -1
		let at = -1

		for (let index = first + 1; index < last; index++) {
			const point = points[index]
			const gap = point === undefined ? 0 : segmentDistance(point, a, b)

			if (gap > worst) {
				worst = gap
				at = index
			}
		}

		if (worst > tolerance && at > 0) {
			keep[at] = 1
			stack.push([first, at], [at, last])
		}
	}

	return points.filter((_, index) => keep[index] === 1)
}

// The committed stroke: a 1-2-1 moving average (ends kept) takes the pointer's jitter out, then Douglas-Peucker drops
// the points a straight run doesn't need. A press without movement becomes a dot (two points).
export function smoothStroke(points: Float64Array, length: number): PdfPoint[] {
	const count = length / 2
	const x = (index: number): number => points[index * 2] ?? 0
	const y = (index: number): number => points[index * 2 + 1] ?? 0

	if (count <= 1)
		return [
			[x(0), y(0)],
			[x(0) + 0.01, y(0)]
		]

	const smoothed: PdfPoint[] = []

	for (let index = 0; index < count; index++) {
		if (index === 0 || index === count - 1) smoothed.push([x(index), y(index)])
		else smoothed.push([(x(index - 1) + 2 * x(index) + x(index + 1)) / 4, (y(index - 1) + 2 * y(index) + y(index + 1)) / 4])
	}

	return simplify(smoothed, INK_TOLERANCE)
}

// The stroke being drawn as points (for an overlay that draws it as a polyline).
export function inkDraftPoints(stroke: InkStroke): string {
	let out = ""

	for (let index = 0; index < stroke.length; index += 2)
		out += `${index === 0 ? "" : " "}${String(stroke.points[index])},${String(stroke.points[index + 1])}`

	return out
}

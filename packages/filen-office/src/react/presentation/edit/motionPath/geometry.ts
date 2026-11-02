import { EMU_PER_PX } from "../../../../core/drawingml/reader"
import { parseMotionPath } from "../../../../core/anim/motion"
import { curvePath, segmentCount, type EditablePath } from "../../../../core/anim/motionEdit"

// Where a motion path shows on the editor's canvas: its points are fractions of the slide relative to the shape's
// centre, the canvas is screen px (EMU × scale / EMU_PER_PX). Everything here builds SVG path data strings once per
// draw, from typed arrays, with no per-point objects.

export interface SlideSize {
	readonly cx: number
	readonly cy: number
}

export interface Placement {
	// The shape's centre, EMU.
	readonly x: number
	readonly y: number
	readonly size: SlideSize
	// Screen px per EMU.
	readonly k: number
}

export function placementOf(center: { readonly x: number; readonly y: number }, size: SlideSize, scale: number): Placement {
	return { x: center.x, y: center.y, size, k: scale / EMU_PER_PX }
}

export function screenX(placement: Placement, fx: number): number {
	return (placement.x + fx * placement.size.cx) * placement.k
}

export function screenY(placement: Placement, fy: number): number {
	return (placement.y + fy * placement.size.cy) * placement.k
}

// A screen point back to path fractions (relative to the shape).
export function pathPoint(placement: Placement, sx: number, sy: number): { readonly x: number; readonly y: number } {
	const k = placement.k > 0 ? placement.k : 1

	return { x: (sx / k - placement.x) / placement.size.cx, y: (sy / k - placement.y) / placement.size.cy }
}

function f(value: number): string {
	return value.toFixed(1)
}

// SVG path data of x y pairs (fractions of the slide relative to the placement).
export function polylineData(placement: Placement, points: Float64Array): string {
	const count = points.length >> 1
	const parts = new Array<string>(count)

	for (let i = 0; i < count; i++)
		parts[i] = `${i === 0 ? "M" : "L"}${f(screenX(placement, points[i * 2] ?? 0))} ${f(screenY(placement, points[i * 2 + 1] ?? 0))}`

	return parts.join("")
}

// The path as the player flattens it (any §19.5.4 path, editable or not), for display.
export function playedPoints(path: string, size: SlideSize, maxSegments: number): Float64Array {
	try {
		return parseMotionPath(path, size.cy > 0 ? size.cx / size.cy : 1, maxSegments).points
	} catch {
		return new Float64Array(0)
	}
}

// SVG path data of an editable path with its curves as SVG cubics (exact, no flattening).
export function editableData(placement: Placement, path: EditablePath): string {
	const n = path.xs.length
	const segments = segmentCount(path)
	const parts = new Array<string>(segments + 2)
	const x = (value: number): string => f(screenX(placement, value))
	const y = (value: number): string => f(screenY(placement, value))

	parts[0] = `M${x(path.xs[0] ?? 0)} ${y(path.ys[0] ?? 0)}`

	for (let s = 0; s < segments; s++) {
		const to = (s + 1) % n

		if (path.curves[s] === 1) {
			const o = s * 4

			parts[s + 1] =
				`C${x(path.controls[o] ?? 0)} ${y(path.controls[o + 1] ?? 0)} ${x(path.controls[o + 2] ?? 0)} ${y(path.controls[o + 3] ?? 0)} ${x(path.xs[to] ?? 0)} ${y(path.ys[to] ?? 0)}`
		} else parts[s + 1] = `L${x(path.xs[to] ?? 0)} ${y(path.ys[to] ?? 0)}`
	}

	parts[segments + 1] = path.closed ? "Z" : ""

	return parts.join("")
}

// One small square per anchor (Edit Points), as one path: a 2,000-point path is one element, not 2,000.
export function anchorsData(placement: Placement, path: EditablePath, half: number = 3.5): string {
	const n = path.xs.length
	const parts = new Array<string>(n)
	const side = f(half * 2)

	for (let i = 0; i < n; i++)
		parts[i] =
			`M${f(screenX(placement, path.xs[i] ?? 0) - half)} ${f(screenY(placement, path.ys[i] ?? 0) - half)}h${side}v${side}h-${side}Z`

	return parts.join("")
}

// The handles of anchor `index` (the curves on either side of it): lines from the anchor and a dot at each end.
export function handlesData(placement: Placement, path: EditablePath, index: number): { readonly lines: string; readonly dots: string } {
	const n = path.xs.length
	const segments = segmentCount(path)

	if (index < 0 || index >= n) return { lines: "", dots: "" }

	const ax = screenX(placement, path.xs[index] ?? 0)
	const ay = screenY(placement, path.ys[index] ?? 0)
	let lines = ""
	let dots = ""

	for (const handle of handlesOf(path, index, segments)) {
		const hx = screenX(placement, path.controls[handle.offset] ?? 0)
		const hy = screenY(placement, path.controls[handle.offset + 1] ?? 0)

		lines += `M${f(ax)} ${f(ay)}L${f(hx)} ${f(hy)}`
		dots += `M${f(hx - 3.5)} ${f(hy)}a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0`
	}

	return { lines, dots }
}

export interface HandleRef {
	readonly segment: number
	readonly end: 0 | 1
	// Index into path.controls of its x.
	readonly offset: number
}

// The curve handles at anchor `index`: the end of the curve into it and the start of the curve out of it.
export function handlesOf(path: EditablePath, index: number, segments: number = segmentCount(path)): HandleRef[] {
	const out: HandleRef[] = []
	const incoming = index > 0 ? index - 1 : path.closed ? segments - 1 : -1
	const outgoing = index < segments ? index : -1

	if (incoming >= 0 && path.curves[incoming] === 1) out.push({ segment: incoming, end: 1, offset: incoming * 4 + 2 })
	if (outgoing >= 0 && outgoing !== incoming && path.curves[outgoing] === 1) out.push({ segment: outgoing, end: 0, offset: outgoing * 4 })

	return out
}

// The start and end markers (PowerPoint: a green triangle at the start, a red one at the end), each pointing along
// the path, size `r` screen px.
export function markersData(points: Float64Array, placement: Placement, r: number = 6): { readonly start: string; readonly end: string } {
	const count = points.length >> 1

	if (count === 0) return { start: "", end: "" }

	const at = (i: number): [number, number] => [screenX(placement, points[i * 2] ?? 0), screenY(placement, points[i * 2 + 1] ?? 0)]
	const triangle = (tip: [number, number], from: [number, number]): string => {
		let dx = tip[0] - from[0]
		let dy = tip[1] - from[1]
		const length = Math.hypot(dx, dy)

		if (length === 0) {
			dx = 1
			dy = 0
		} else {
			dx /= length
			dy /= length
		}

		// Long and narrow, so it reads as pointing along the path.
		const bx = tip[0] - dx * r * 2
		const by = tip[1] - dy * r * 2
		const w = r * 0.65

		return `M${f(tip[0])} ${f(tip[1])}L${f(bx - dy * w)} ${f(by + dx * w)}L${f(bx + dy * w)} ${f(by - dx * w)}Z`
	}
	// A direction from the first point that differs from it (a path may start with coincident points).
	const away = (from: number, step: number): [number, number] => {
		const origin = at(from)

		for (let i = from + step; i >= 0 && i < count; i += step) {
			const point = at(i)

			if (point[0] !== origin[0] || point[1] !== origin[1]) return point
		}

		return [origin[0] - step, origin[1]]
	}
	const start = at(0)
	const end = at(count - 1)
	const next = away(0, 1)
	const length = Math.hypot(next[0] - start[0], next[1] - start[1]) || 1
	const tip: [number, number] = [start[0] + ((next[0] - start[0]) / length) * r * 2, start[1] + ((next[1] - start[1]) / length) * r * 2]

	// The start triangle stands on the start and points along the path; the end one arrives at the end.
	return { start: triangle(tip, start), end: triangle(end, away(count - 1, -1)) }
}

// The preview of a path being drawn (slide fractions from the slide's top left, x y pairs), as screen path data: a
// Curve's clicks as the curve they make.
export function drawingData(points: Float64Array, curve: boolean, k: number, size: SlideSize): string {
	const origin: Placement = { x: 0, y: 0, size, k }

	if (curve && points.length >= 4) {
		const clicks = Array.from({ length: points.length >> 1 }, (_, i) => ({ x: points[i * 2] ?? 0, y: points[i * 2 + 1] ?? 0 }))
		const path = curvePath(clicks)

		if (!("reason" in path)) return editableData(origin, path)
	}

	return polylineData(origin, points)
}

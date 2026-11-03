import { DEFAULT_PRESENTATION_BUDGETS } from "../presentation/budget"
import { refused, type Refused } from "../presentation/model"
import type { Behavior, TimeNode, TimingTree } from "./model"
import { motion } from "./presets/effects/build"
import type { EffectPreset } from "./presets/effects/types"

// Custom motion paths as an editable model (ECMA-376 Part 1 §19.5.4 p:animMotion): the anchors of the path's one
// subpath, whether each segment between them is a straight line or a cubic Bézier, the curves' control points, and
// whether the path closes. Coordinates are fractions of the slide's width and height relative to the shape's place
// (its centre at 0 0: the player translates the shape by the path's point), the way the attribute is written.
//
// Point types are §19.5.4 ptsTypes, whose letters ECMA-376 only names ("A = Auto, F = Corner, T = Straight, S =
// Smooth"; MS-OI29500 §2.1.1141 d: used only when Office edits the path). What each does is PowerPoint's documented
// Edit Points behaviour ("Draw or edit a freeform shape", support.microsoft.com: "A smooth point joins two line
// segments of equal length. A straight point joins two line segments of different lengths."): A auto (its curves'
// control points follow its neighbours, as a Catmull-Rom spline through the anchors), F corner (its two handles move
// alone), T straight (handles in line, each its own length), S smooth (handles in line and of one length); the letter
// is upper case when a line follows the point and lower case when a curve does. One letter is written per point of
// the path attribute, a closed path's return to its start included.
//
// Everything here is pure and allocation-bounded: an edit copies the typed arrays once; nothing is parsed per frame.

export type PointKind = "auto" | "corner" | "straight" | "smooth"

export interface EditablePath {
	// Anchors, n of them.
	readonly xs: Float64Array
	readonly ys: Float64Array
	// PointKind per anchor (KIND_ORDER index).
	readonly kinds: Uint8Array
	// Per segment (closed ? n : n − 1 of them; segment i runs from anchor i to anchor i + 1, the last of a closed path
	// back to anchor 0): 1 when it is a curve.
	readonly curves: Uint8Array
	// Per segment its control points c1x c1y c2x c2y (a line's are kept at a third and two thirds of it).
	readonly controls: Float64Array
	readonly closed: boolean
}

// The presetID of a custom (drawn) motion path.
export const CUSTOM_PATH_ID = 0

export const KIND_ORDER: readonly PointKind[] = ["auto", "corner", "straight", "smooth"]
const LETTERS = "AFTS"

export interface Point {
	readonly x: number
	readonly y: number
}

export function segmentCount(path: EditablePath): number {
	const n = path.xs.length

	return path.closed ? n : Math.max(0, n - 1)
}

function kindIndex(kind: PointKind): number {
	return KIND_ORDER.indexOf(kind)
}

export function kindOf(path: EditablePath, index: number): PointKind {
	return KIND_ORDER[path.kinds[index] ?? 0] ?? "auto"
}

function make(xs: number[], ys: number[], kinds: number[], curves: number[], controls: number[], closed: boolean): EditablePath {
	return {
		xs: Float64Array.from(xs),
		ys: Float64Array.from(ys),
		kinds: Uint8Array.from(kinds),
		curves: Uint8Array.from(curves),
		controls: Float64Array.from(controls),
		closed
	}
}

function copy(
	path: EditablePath,
	closed: boolean = path.closed
): {
	xs: Float64Array
	ys: Float64Array
	kinds: Uint8Array
	curves: Uint8Array
	controls: Float64Array
	closed: boolean
} {
	return {
		xs: path.xs.slice(),
		ys: path.ys.slice(),
		kinds: path.kinds.slice(),
		curves: path.curves.slice(),
		controls: path.controls.slice(),
		closed
	}
}

function lineControls(controls: Float64Array, segment: number, ax: number, ay: number, bx: number, by: number): void {
	const o = segment * 4

	controls[o] = ax + (bx - ax) / 3
	controls[o + 1] = ay + (by - ay) / 3
	controls[o + 2] = ax + ((bx - ax) * 2) / 3
	controls[o + 3] = ay + ((by - ay) * 2) / 3
}

// --- Reading and writing the attribute ---

const TOKENS = /[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gu
// The chords the player flattens a curve into (motion.ts).
const CURVE_CHORDS = 16

// The path attribute (and its ptsTypes) as an editable path; a path of more than one subpath, or with nothing to
// edit, is refused (it stays as the file wrote it), and so is one of more flattened segments (a line one, a curve
// CURVE_CHORDS, the close one) than `maxSegments`, the most an edit may write, read only that far.
export function readEditablePath(
	path: string,
	ptsTypes?: string,
	maxSegments: number = DEFAULT_PRESENTATION_BUDGETS.timing.motionSegments
): EditablePath | Refused {
	// Tokens are read one at a time, so a path past the bound is refused before the rest of it is split.
	const scan = new RegExp(TOKENS.source, "uy")
	let token: string | undefined
	let at = 0
	// The next token; characters that start none are passed over.
	const advance = (): void => {
		for (; at < path.length; at++) {
			scan.lastIndex = at

			const found = scan.exec(path)?.[0]

			if (found !== undefined) {
				token = found
				at += found.length

				return
			}
		}

		token = undefined
	}
	let flattened = 0
	const grow = (count: number): boolean => {
		flattened += count

		return flattened > maxSegments
	}
	const xs: number[] = []
	const ys: number[] = []
	const curves: number[] = []
	const controls: number[] = []
	let x = 0
	let y = 0
	let command = ""
	let closed = false
	const tooMany = (): Refused => refused("tooLarge", `motion path: more than ${String(maxSegments)} segments`)
	const number = (): number | undefined => {
		const value = token === undefined || /^[A-Za-z]$/u.test(token) ? undefined : Number(token)

		if (value === undefined) return undefined

		advance()

		return Number.isFinite(value) ? value : undefined
	}

	advance()

	while (token !== undefined) {
		if (/^[A-Za-z]$/u.test(token)) {
			const letter = token

			advance()

			const upper = letter.toUpperCase()

			if (upper === "E") break

			if (closed) return refused("unsupported", "motion path: more than one subpath")

			if (upper === "Z") {
				if (xs.length === 0) return refused("malformed", "motion path: close before a point")
				if (grow(1)) return tooMany()

				closed = true

				continue
			}

			if (upper !== "M" && upper !== "L" && upper !== "C") return refused("unsupported", `motion path command ${letter}`)
			if (upper === "M" && xs.length > 0) return refused("unsupported", "motion path: more than one subpath")
			if (upper !== "M" && xs.length === 0) return refused("malformed", "motion path: no start point")

			command = letter

			continue
		}

		if (command === "") return refused("malformed", "motion path: a number before a command")

		const relative = command !== command.toUpperCase()
		const ox = relative ? x : 0
		const oy = relative ? y : 0

		switch (command.toUpperCase()) {
			case "M":
			case "L": {
				const nx = number()
				const ny = number()

				if (nx === undefined || ny === undefined) return refused("malformed", "motion path: a point without two numbers")

				const px = ox + nx
				const py = oy + ny

				if (xs.length > 0) {
					if (grow(1)) return tooMany()

					curves.push(0)
					controls.push(x + (px - x) / 3, y + (py - y) / 3, x + ((px - x) * 2) / 3, y + ((py - y) * 2) / 3)
				}

				xs.push(px)
				ys.push(py)
				x = px
				y = py

				// Coordinates after a move are lines (SVG and §19.5.4 alike).
				if (command.toUpperCase() === "M") command = relative ? "l" : "L"

				break
			}
			case "C": {
				const values: number[] = []

				for (let k = 0; k < 6; k++) {
					const value = number()

					if (value === undefined) return refused("malformed", "motion path: a curve without six numbers")

					values.push(value)
				}

				const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = values

				if (grow(CURVE_CHORDS)) return tooMany()

				curves.push(1)
				controls.push(ox + x1, oy + y1, ox + x2, oy + y2)
				xs.push(ox + x3)
				ys.push(oy + y3)
				x = ox + x3
				y = oy + y3

				break
			}
			default:
				return refused("unsupported", `motion path command ${command}`)
		}
	}

	if (xs.length === 0) return refused("malformed", "motion path: no points")

	if (closed) {
		const n = xs.length

		// An explicit return to the start is the closing segment itself; else the path closes with a line.
		if (n > 2 && same(xs[n - 1] ?? 0, xs[0] ?? 0) && same(ys[n - 1] ?? 0, ys[0] ?? 0)) {
			xs.pop()
			ys.pop()
		} else {
			const lx = xs[n - 1] ?? 0
			const ly = ys[n - 1] ?? 0
			const fx = xs[0] ?? 0
			const fy = ys[0] ?? 0

			curves.push(0)
			controls.push(lx + (fx - lx) / 3, ly + (fy - ly) / 3, lx + ((fx - lx) * 2) / 3, ly + ((fy - ly) * 2) / 3)
		}
	}

	// A ptsTypes letter per point in order; past its end a point is a corner, extra letters are ignored (MS-OI29500
	// §2.1.1141 d: "If there are fewer entries than points, the extra points are to be treated as ... an 'F' (corner
	// line) ... Otherwise ... an 'f' (corner curve)"). Without one (ODF has none), a point on a curve is a corner, so its
	// handles stay where the file put them, and any other point is auto.
	const segments = curves.length
	const kinds = xs.map((_, index) => {
		if (ptsTypes !== undefined) {
			const letter = ptsTypes[index]

			if (letter === undefined) return KIND_ORDER.indexOf("corner")

			const found = LETTERS.indexOf(letter.toUpperCase())

			return found < 0 ? 0 : found
		}

		const before = index > 0 ? index - 1 : closed ? segments - 1 : -1
		const after = index < segments ? index : -1

		return (before >= 0 && curves[before] === 1) || (after >= 0 && curves[after] === 1) ? 1 : 0
	})

	return make(xs, ys, kinds, curves, controls, closed)
}

function same(a: number, b: number): boolean {
	return Math.abs(a - b) < 1e-9
}

// Five decimals, as PowerPoint writes path coordinates.
export function formatCoordinate(value: number): string {
	const rounded = Math.round(value * 100000) / 100000

	return Object.is(rounded, -0) || rounded === 0 ? "0" : String(rounded)
}

// The path attribute (absolute commands, the closing segment written out before Z, then E) and its ptsTypes.
export function writeEditablePath(path: EditablePath): { readonly path: string; readonly ptsTypes: string } {
	const n = path.xs.length
	const parts: string[] = [`M ${formatCoordinate(path.xs[0] ?? 0)} ${formatCoordinate(path.ys[0] ?? 0)}`]
	let types = ""
	const segments = segmentCount(path)

	for (let s = 0; s < segments; s++) {
		const to = (s + 1) % n
		const tx = formatCoordinate(path.xs[to] ?? 0)
		const ty = formatCoordinate(path.ys[to] ?? 0)

		if (path.curves[s] === 1) {
			const o = s * 4

			parts.push(
				`C ${formatCoordinate(path.controls[o] ?? 0)} ${formatCoordinate(path.controls[o + 1] ?? 0)} ${formatCoordinate(path.controls[o + 2] ?? 0)} ${formatCoordinate(path.controls[o + 3] ?? 0)} ${tx} ${ty}`
			)
		} else parts.push(`L ${tx} ${ty}`)
	}

	for (let i = 0; i < n; i++) {
		const letter = LETTERS[path.kinds[i] ?? 0] ?? "A"
		const curveFollows = i < segments && path.curves[i] === 1

		types += curveFollows ? letter.toLowerCase() : letter
	}

	if (path.closed) {
		parts.push("Z")
		types += LETTERS[path.kinds[0] ?? 0] ?? "A"
	}

	parts.push("E")

	return { path: parts.join(" "), ptsTypes: types }
}

// The SVG path data of a §19.5.4 path for ODF's anim:animateMotion svg:path (ODF 1.3 §19.538 is SVG path data, which
// has no E): the commands as written up to E, which is dropped.
export function svgMotionPath(path: string): string {
	const tokens = path.match(TOKENS) ?? []
	const end = tokens.findIndex(token => token === "E" || token === "e")

	return (end < 0 ? tokens : tokens.slice(0, end)).join(" ")
}

// --- Geometry ---

// The flattened polyline of the path (curves in `steps` chords each) as x, y pairs: what the canvas draws.
export function polyline(path: EditablePath, steps: number = 16): Float64Array {
	const n = path.xs.length
	const segments = segmentCount(path)
	let count = 1

	for (let s = 0; s < segments; s++) count += path.curves[s] === 1 ? steps : 1

	const out = new Float64Array(count * 2)
	let k = 0

	out[k++] = path.xs[0] ?? 0
	out[k++] = path.ys[0] ?? 0

	for (let s = 0; s < segments; s++) {
		const from = s
		const to = (s + 1) % n
		const ax = path.xs[from] ?? 0
		const ay = path.ys[from] ?? 0
		const bx = path.xs[to] ?? 0
		const by = path.ys[to] ?? 0

		if (path.curves[s] !== 1) {
			out[k++] = bx
			out[k++] = by

			continue
		}

		const o = s * 4
		const c1x = path.controls[o] ?? 0
		const c1y = path.controls[o + 1] ?? 0
		const c2x = path.controls[o + 2] ?? 0
		const c2y = path.controls[o + 3] ?? 0

		for (let step = 1; step <= steps; step++) {
			const t = step / steps
			const u = 1 - t

			out[k++] = u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx
			out[k++] = u * u * u * ay + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * by
		}
	}

	return out
}

// --- Auto points ---

// Control points of the curves next to auto anchors, as a Catmull-Rom spline through the anchors (each handle a
// sixth of the chord between the anchor's neighbours). Only the segments touching `around` (all when absent).
function smoothAuto(path: ReturnType<typeof copy>, around?: readonly number[]): void {
	const n = path.xs.length
	const segments = path.closed ? n : n - 1

	if (n < 2) return

	const neighbour = (i: number, step: number): number => {
		const j = i + step

		if (path.closed) return ((j % n) + n) % n

		return Math.min(n - 1, Math.max(0, j))
	}
	const tangent = (i: number): [number, number] => {
		const a = neighbour(i, -1)
		const b = neighbour(i, 1)

		return [((path.xs[b] ?? 0) - (path.xs[a] ?? 0)) / 6, ((path.ys[b] ?? 0) - (path.ys[a] ?? 0)) / 6]
	}
	const visit = new Set<number>()

	if (around === undefined) for (let s = 0; s < segments; s++) visit.add(s)
	else
		for (const i of around) {
			for (const s of [i - 2, i - 1, i, i + 1]) {
				if (path.closed) visit.add(((s % n) + n) % n)
				else if (s >= 0 && s < segments) visit.add(s)
			}
		}

	for (const s of visit) {
		if (path.curves[s] !== 1) continue

		const from = s
		const to = (s + 1) % n
		const o = s * 4

		if (path.kinds[from] === 0) {
			const [tx, ty] = tangent(from)

			path.controls[o] = (path.xs[from] ?? 0) + tx
			path.controls[o + 1] = (path.ys[from] ?? 0) + ty
		}

		if (path.kinds[to] === 0) {
			const [tx, ty] = tangent(to)

			path.controls[o + 2] = (path.xs[to] ?? 0) - tx
			path.controls[o + 3] = (path.ys[to] ?? 0) - ty
		}
	}
}

// --- Drawing ---

// A straight line from `a` to `b` (the Line tool).
export function linePath(a: Point, b: Point): EditablePath {
	return make(
		[a.x, b.x],
		[a.y, b.y],
		[0, 0],
		[0],
		[a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3, a.x + ((b.x - a.x) * 2) / 3, a.y + ((b.y - a.y) * 2) / 3],
		false
	)
}

// A curve through `points` (the Curve tool): every point auto, every segment a curve, closed when asked.
export function curvePath(points: readonly Point[], closed: boolean = false): EditablePath | Refused {
	if (points.length < 2) return refused("malformed", "a curve needs two points")

	const segments = closed ? points.length : points.length - 1
	const path = copy(
		make(
			points.map(point => point.x),
			points.map(point => point.y),
			points.map(() => 0),
			new Array<number>(segments).fill(1),
			new Array<number>(segments * 4).fill(0),
			closed
		)
	)

	smoothAuto(path)

	return path
}

// Straight segments through `points` (the Freeform tool's clicks, and the Scribble tool's stroke once simplified).
export function polylinePath(points: readonly Point[], closed: boolean = false): EditablePath | Refused {
	if (points.length < 2) return refused("malformed", "a path needs two points")

	const n = points.length
	const segments = closed ? n : n - 1
	const controls = new Float64Array(segments * 4)

	for (let s = 0; s < segments; s++) {
		const a = points[s] as Point
		const b = points[(s + 1) % n] as Point

		lineControls(controls, s, a.x, a.y, b.x, b.y)
	}

	return {
		xs: Float64Array.from(points, point => point.x),
		ys: Float64Array.from(points, point => point.y),
		kinds: new Uint8Array(n),
		curves: new Uint8Array(segments),
		controls,
		closed
	}
}

// Ramer–Douglas–Peucker over a freehand stroke (x, y pairs): the points within `tolerance` of the line between the
// points kept are dropped. `aspect` (width over height) measures distances as the slide shows them. Iterative, so a
// long stroke never deepens the stack.
export function simplifyStroke(stroke: Float64Array, tolerance: number, aspect: number): Point[] {
	const count = stroke.length >> 1

	if (count <= 2) return Array.from({ length: count }, (_, i) => ({ x: stroke[i * 2] ?? 0, y: stroke[i * 2 + 1] ?? 0 }))

	const keep = new Uint8Array(count)
	const stack: number[] = [0, count - 1]

	keep[0] = 1
	keep[count - 1] = 1

	while (stack.length > 0) {
		const last = stack.pop() ?? 0
		const first = stack.pop() ?? 0
		const ax = (stroke[first * 2] ?? 0) * aspect
		const ay = stroke[first * 2 + 1] ?? 0
		const bx = (stroke[last * 2] ?? 0) * aspect
		const by = stroke[last * 2 + 1] ?? 0
		const dx = bx - ax
		const dy = by - ay
		const length = Math.hypot(dx, dy)
		let worst = -1
		let at = -1

		for (let i = first + 1; i < last; i++) {
			const px = (stroke[i * 2] ?? 0) * aspect - ax
			const py = (stroke[i * 2 + 1] ?? 0) - ay
			const distance = length > 0 ? Math.abs(px * dy - py * dx) / length : Math.hypot(px, py)

			if (distance > worst) {
				worst = distance
				at = i
			}
		}

		if (at > 0 && worst > tolerance) {
			keep[at] = 1
			stack.push(first, at, at, last)
		}
	}

	const out: Point[] = []

	for (let i = 0; i < count; i++) if (keep[i] === 1) out.push({ x: stroke[i * 2] ?? 0, y: stroke[i * 2 + 1] ?? 0 })

	return out
}

// --- Edit Points ---

// Anchor `index` moved to (x, y): its handles move with it, and the curves of auto anchors around it follow.
export function movePoint(path: EditablePath, index: number, x: number, y: number): EditablePath {
	const n = path.xs.length

	if (index < 0 || index >= n) return path

	const next = copy(path)
	const dx = x - (next.xs[index] ?? 0)
	const dy = y - (next.ys[index] ?? 0)
	const segments = segmentCount(next)
	const outgoing = index < segments ? index : -1
	const incoming = index > 0 ? index - 1 : next.closed ? n - 1 : -1

	next.xs[index] = x
	next.ys[index] = y

	for (const s of [outgoing, incoming]) {
		if (s < 0) continue

		const o = s * 4
		const from = s
		const to = (s + 1) % n

		if (next.curves[s] !== 1) {
			lineControls(next.controls, s, next.xs[from] ?? 0, next.ys[from] ?? 0, next.xs[to] ?? 0, next.ys[to] ?? 0)

			continue
		}

		if (from === index) {
			next.controls[o] = (next.controls[o] ?? 0) + dx
			next.controls[o + 1] = (next.controls[o + 1] ?? 0) + dy
		}

		if (to === index) {
			next.controls[o + 2] = (next.controls[o + 2] ?? 0) + dx
			next.controls[o + 3] = (next.controls[o + 3] ?? 0) + dy
		}
	}

	smoothAuto(next, [index])

	return next
}

// The handle at the `end` (0: start, 1: end) of curve `segment` moved to (x, y). Its anchor's other handle follows
// as the anchor's type says (straight: in line; smooth: in line and as long); an auto anchor becomes smooth.
export function moveHandle(path: EditablePath, segment: number, end: 0 | 1, x: number, y: number): EditablePath {
	const n = path.xs.length
	const segments = segmentCount(path)

	if (segment < 0 || segment >= segments || path.curves[segment] !== 1) return path

	const next = copy(path)
	const anchor = end === 0 ? segment : (segment + 1) % n
	const o = segment * 4 + end * 2

	next.controls[o] = x
	next.controls[o + 1] = y

	if (next.kinds[anchor] === kindIndex("auto")) next.kinds[anchor] = kindIndex("smooth")

	const kind = kindOf(next, anchor)

	if (kind === "smooth" || kind === "straight") {
		// The anchor's other handle: the end of the segment before it, or the start of the one after it.
		const other =
			end === 0
				? segment > 0
					? segment - 1
					: next.closed
						? segments - 1
						: -1
				: segment + 1 < segments || next.closed
					? (segment + 1) % segments
					: -1

		if (other >= 0 && other !== segment && next.curves[other] === 1) {
			const ax = next.xs[anchor] ?? 0
			const ay = next.ys[anchor] ?? 0
			const q = other * 4 + (end === 0 ? 2 : 0)
			const hx = x - ax
			const hy = y - ay
			const length = Math.hypot(hx, hy)
			const otherLength = kind === "smooth" ? length : Math.hypot((next.controls[q] ?? 0) - ax, (next.controls[q + 1] ?? 0) - ay)

			if (length > 0) {
				next.controls[q] = ax - (hx / length) * otherLength
				next.controls[q + 1] = ay - (hy / length) * otherLength
			}
		}
	}

	return next
}

// A point added on `segment` at `t` (0..1 along it): a curve is split where it is (de Casteljau), so the path keeps
// its shape; the new anchor is straight on a curve (the split leaves its handles in line, of their own lengths) and
// auto on a line.
export function insertPoint(path: EditablePath, segment: number, t: number = 0.5): EditablePath {
	const n = path.xs.length
	const segments = segmentCount(path)

	if (segment < 0 || segment >= segments) return path

	const from = segment
	const to = (segment + 1) % n
	const ax = path.xs[from] ?? 0
	const ay = path.ys[from] ?? 0
	const bx = path.xs[to] ?? 0
	const by = path.ys[to] ?? 0
	const curve = path.curves[segment] === 1
	const u = Math.min(1, Math.max(0, t))
	const o = segment * 4
	const c1x = path.controls[o] ?? 0
	const c1y = path.controls[o + 1] ?? 0
	const c2x = path.controls[o + 2] ?? 0
	const c2y = path.controls[o + 3] ?? 0
	const lerp = (p: number, q: number): number => p + (q - p) * u
	// de Casteljau.
	const p01x = lerp(ax, c1x)
	const p01y = lerp(ay, c1y)
	const p12x = lerp(c1x, c2x)
	const p12y = lerp(c1y, c2y)
	const p23x = lerp(c2x, bx)
	const p23y = lerp(c2y, by)
	const p012x = lerp(p01x, p12x)
	const p012y = lerp(p01y, p12y)
	const p123x = lerp(p12x, p23x)
	const p123y = lerp(p12y, p23y)
	const mx = curve ? lerp(p012x, p123x) : lerp(ax, bx)
	const my = curve ? lerp(p012y, p123y) : lerp(ay, by)
	const at = segment + 1
	const xs = new Float64Array(n + 1)
	const ys = new Float64Array(n + 1)
	const kinds = new Uint8Array(n + 1)
	const curves = new Uint8Array(segments + 1)
	const controls = new Float64Array((segments + 1) * 4)

	xs.set(path.xs.subarray(0, at))
	xs[at] = mx
	xs.set(path.xs.subarray(at), at + 1)
	ys.set(path.ys.subarray(0, at))
	ys[at] = my
	ys.set(path.ys.subarray(at), at + 1)
	kinds.set(path.kinds.subarray(0, at))
	kinds[at] = curve ? kindIndex("straight") : kindIndex("auto")
	kinds.set(path.kinds.subarray(at), at + 1)
	curves.set(path.curves.subarray(0, segment))
	curves[segment] = curve ? 1 : 0
	curves[segment + 1] = curve ? 1 : 0
	curves.set(path.curves.subarray(segment + 1), segment + 2)
	controls.set(path.controls.subarray(0, segment * 4))
	controls.set(path.controls.subarray((segment + 1) * 4), (segment + 2) * 4)

	if (curve) {
		controls.set([p01x, p01y, p012x, p012y], segment * 4)
		controls.set([p123x, p123y, p23x, p23y], (segment + 1) * 4)
	} else {
		lineControls(controls, segment, ax, ay, mx, my)
		lineControls(controls, segment + 1, mx, my, bx, by)
	}

	return { xs, ys, kinds, curves, controls, closed: path.closed }
}

// Anchor `index` deleted: its two segments become one (a curve when either was, keeping their outer handles). A
// path keeps at least two points (three when closed); deleting past that changes nothing.
export function deletePoint(path: EditablePath, index: number): EditablePath {
	const n = path.xs.length

	if (index < 0 || index >= n || n <= (path.closed ? 3 : 2)) return path

	const segments = segmentCount(path)
	const xs: number[] = []
	const ys: number[] = []
	const kinds: number[] = []
	const curves: number[] = []
	const controls: number[] = []

	for (let i = 0; i < n; i++) {
		if (i === index) continue

		xs.push(path.xs[i] ?? 0)
		ys.push(path.ys[i] ?? 0)
		kinds.push(path.kinds[i] ?? 0)
	}

	const incoming = index > 0 ? index - 1 : path.closed ? segments - 1 : -1
	const outgoing = index < segments ? index : -1
	const segmentAt = (s: number): [number, number, number, number, number] => [
		path.curves[s] ?? 0,
		path.controls[s * 4] ?? 0,
		path.controls[s * 4 + 1] ?? 0,
		path.controls[s * 4 + 2] ?? 0,
		path.controls[s * 4 + 3] ?? 0
	]

	for (let s = 0; s < segments; s++) {
		if (s === outgoing && incoming >= 0) continue

		if (s === incoming && outgoing >= 0) {
			const a = segmentAt(incoming)
			const b = segmentAt(outgoing)

			curves.push(a[0] === 1 || b[0] === 1 ? 1 : 0)
			controls.push(a[1], a[2], b[3], b[4])

			continue
		}

		// An end anchor of an open path: its one segment goes.
		if (s === incoming || s === outgoing) continue

		const own = segmentAt(s)

		curves.push(own[0])
		controls.push(own[1], own[2], own[3], own[4])
	}

	const next = copy(make(xs, ys, kinds, curves, controls, path.closed))

	for (let s = 0; s < next.curves.length; s++) {
		if (next.curves[s] !== 1) {
			const to = (s + 1) % next.xs.length

			lineControls(next.controls, s, next.xs[s] ?? 0, next.ys[s] ?? 0, next.xs[to] ?? 0, next.ys[to] ?? 0)
		}
	}

	smoothAuto(next, [Math.max(0, index - 1), Math.min(next.xs.length - 1, index)])

	return next
}

// Segment `segment` made a straight line or a curve (a new curve starts straight, its handles on the chord, and
// bends as its auto anchors say).
export function setSegmentType(path: EditablePath, segment: number, type: "line" | "curve"): EditablePath {
	if (segment < 0 || segment >= segmentCount(path) || (path.curves[segment] === 1) === (type === "curve")) return path

	const next = copy(path)
	const to = (segment + 1) % next.xs.length

	next.curves[segment] = type === "curve" ? 1 : 0
	lineControls(next.controls, segment, next.xs[segment] ?? 0, next.ys[segment] ?? 0, next.xs[to] ?? 0, next.ys[to] ?? 0)

	if (type === "curve") smoothAuto(next, [segment, to])

	return next
}

// Anchor `index` given `kind`: auto recomputes its handles; straight puts them in line (each keeping its length);
// smooth in line and of their mean length; corner leaves them.
export function setPointKind(path: EditablePath, index: number, kind: PointKind): EditablePath {
	const n = path.xs.length

	if (index < 0 || index >= n || kindOf(path, index) === kind) return path

	const next = copy(path)
	const segments = segmentCount(next)

	next.kinds[index] = kindIndex(kind)

	if (kind === "auto") {
		smoothAuto(next, [index])

		return next
	}

	if (kind === "corner") return next

	const incoming = index > 0 ? index - 1 : next.closed ? segments - 1 : -1
	const outgoing = index < segments ? index : -1

	if (incoming < 0 || outgoing < 0 || next.curves[incoming] !== 1 || next.curves[outgoing] !== 1) return next

	const ax = next.xs[index] ?? 0
	const ay = next.ys[index] ?? 0
	const i = incoming * 4 + 2
	const o = outgoing * 4
	const inX = (next.controls[i] ?? 0) - ax
	const inY = (next.controls[i + 1] ?? 0) - ay
	const outX = (next.controls[o] ?? 0) - ax
	const outY = (next.controls[o + 1] ?? 0) - ay
	const inLength = Math.hypot(inX, inY)
	const outLength = Math.hypot(outX, outY)
	// The direction through the anchor: from the incoming handle to the outgoing one.
	let dx = outX - inX
	let dy = outY - inY
	const length = Math.hypot(dx, dy)

	if (length === 0) return next

	dx /= length
	dy /= length

	const mean = (inLength + outLength) / 2
	const inTo = kind === "smooth" ? mean : inLength
	const outTo = kind === "smooth" ? mean : outLength

	next.controls[i] = ax - dx * inTo
	next.controls[i + 1] = ay - dy * inTo
	next.controls[o] = ax + dx * outTo
	next.controls[o + 1] = ay + dy * outTo

	return next
}

// Close Path / Open Path: a closed path gains a straight segment back to its start; an open one loses it.
export function setClosed(path: EditablePath, closed: boolean): EditablePath {
	if (path.closed === closed || path.xs.length < 2) return path

	const n = path.xs.length

	if (!closed) {
		const segments = n - 1

		return {
			xs: path.xs.slice(),
			ys: path.ys.slice(),
			kinds: path.kinds.slice(),
			curves: path.curves.slice(0, segments),
			controls: path.controls.slice(0, segments * 4),
			closed: false
		}
	}

	const curves = new Uint8Array(n)
	const controls = new Float64Array(n * 4)

	curves.set(path.curves)
	controls.set(path.controls)
	lineControls(controls, n - 1, path.xs[n - 1] ?? 0, path.ys[n - 1] ?? 0, path.xs[0] ?? 0, path.ys[0] ?? 0)

	return { xs: path.xs.slice(), ys: path.ys.slice(), kinds: path.kinds.slice(), curves, controls, closed: true }
}

// Reverse Path Direction: the same path travelled from its end (a closed path from its start the other way round).
export function reversePath(path: EditablePath): EditablePath {
	const n = path.xs.length
	const segments = segmentCount(path)
	const xs = new Float64Array(n)
	const ys = new Float64Array(n)
	const kinds = new Uint8Array(n)
	const curves = new Uint8Array(segments)
	const controls = new Float64Array(segments * 4)
	// Open: anchor i → n − 1 − i; closed: the start stays, the rest reverse (i → n − i).
	const map = (i: number): number => (path.closed ? (n - i) % n : n - 1 - i)

	for (let i = 0; i < n; i++) {
		const j = map(i)

		xs[j] = path.xs[i] ?? 0
		ys[j] = path.ys[i] ?? 0
		kinds[j] = path.kinds[i] ?? 0
	}

	for (let s = 0; s < segments; s++) {
		// Segment s runs from i = s to i + 1; reversed it runs from map(i + 1) to map(i), which is segment map(s + 1).
		const t = path.closed ? map((s + 1) % n) : segments - 1 - s
		const o = s * 4
		const q = t * 4

		curves[t] = path.curves[s] ?? 0
		controls[q] = path.controls[o + 2] ?? 0
		controls[q + 1] = path.controls[o + 3] ?? 0
		controls[q + 2] = path.controls[o] ?? 0
		controls[q + 3] = path.controls[o + 1] ?? 0
	}

	return { xs, ys, kinds, curves, controls, closed: path.closed }
}

// The whole path moved by (dx, dy): what a locked path (pathEditMode "fixed") is rewritten by when its shape moves,
// so it stays where it is on the slide.
export function translatePath(path: EditablePath, dx: number, dy: number): EditablePath {
	const next = copy(path)

	for (let i = 0; i < next.xs.length; i++) {
		next.xs[i] = (next.xs[i] ?? 0) + dx
		next.ys[i] = (next.ys[i] ?? 0) + dy
	}

	for (let k = 0; k < next.controls.length; k += 2) {
		next.controls[k] = (next.controls[k] ?? 0) + dx
		next.controls[k + 1] = (next.controls[k + 1] ?? 0) + dy
	}

	return next
}

// The path attribute moved by (dx, dy) as text: every absolute coordinate pair shifted, relative ones (after the
// first point) left as they are, everything else as written, so a locked path keeps its own commands and point count.
export function translatePathText(path: string, dx: number, dy: number): string {
	const tokens = path.match(TOKENS) ?? []
	const out: string[] = []
	let command = ""
	let pair = 0
	let first = true

	for (const token of tokens) {
		if (/^[A-Za-z]$/u.test(token)) {
			command = token
			pair = 0
			out.push(token)

			continue
		}

		const absolute = command === command.toUpperCase() || (first && command === "m")
		const shift = absolute && command !== "Z" && command !== "E" ? (pair % 2 === 0 ? dx : dy) : 0

		out.push(shift === 0 ? token : formatCoordinate(Number(token) + shift))

		if (pair % 2 === 1) first = false

		pair++
	}

	return out.join(" ")
}

// The anchor nearest (x, y) within `radius` (distances as the slide shows them, `aspect` its width over height).
export function nearestPoint(path: EditablePath, x: number, y: number, radius: number, aspect: number): number {
	let best = -1
	let bestDistance = radius

	for (let i = 0; i < path.xs.length; i++) {
		const distance = Math.hypot(((path.xs[i] ?? 0) - x) * aspect, (path.ys[i] ?? 0) - y)

		if (distance <= bestDistance) {
			bestDistance = distance
			best = i
		}
	}

	return best
}

// The segment nearest (x, y) within `radius`, and where on it (t), for adding a point there.
export function nearestSegment(
	path: EditablePath,
	x: number,
	y: number,
	radius: number,
	aspect: number
): { readonly segment: number; readonly t: number } | undefined {
	const n = path.xs.length
	const steps = 16
	let best: { segment: number; t: number } | undefined
	let bestDistance = radius

	for (let s = 0; s < segmentCount(path); s++) {
		const to = (s + 1) % n
		const ax = path.xs[s] ?? 0
		const ay = path.ys[s] ?? 0
		const bx = path.xs[to] ?? 0
		const by = path.ys[to] ?? 0
		const o = s * 4
		const curve = path.curves[s] === 1
		const pointOf = (t: number): [number, number] => {
			if (!curve) return [ax + (bx - ax) * t, ay + (by - ay) * t]

			const u = 1 - t
			const c1x = path.controls[o] ?? 0
			const c1y = path.controls[o + 1] ?? 0
			const c2x = path.controls[o + 2] ?? 0
			const c2y = path.controls[o + 3] ?? 0

			return [
				u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx,
				u * u * u * ay + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * by
			]
		}
		let [px, py] = pointOf(0)

		for (let step = 1; step <= steps; step++) {
			const [qx, qy] = pointOf(step / steps)
			const dx = (qx - px) * aspect
			const dy = qy - py
			const lengthSquared = dx * dx + dy * dy
			const f = lengthSquared > 0 ? Math.min(1, Math.max(0, ((x - px) * aspect * dx + (y - py) * dy) / lengthSquared)) : 0
			const distance = Math.hypot((x - px) * aspect - dx * f, y - py - dy * f)

			if (distance <= bestDistance) {
				bestDistance = distance
				best = { segment: s, t: (step - 1 + f) / steps }
			}

			px = qx
			py = qy
		}
	}

	return best
}

// --- Motion behaviours of a slide's timing ---

export interface MotionBehavior {
	// The animMotion behaviour's ctn id (what setPath names).
	readonly node: number
	// Its effect par's ctn id (what the pane names).
	readonly effect: number
	readonly shape: number
	readonly path: string
	readonly ptsTypes?: string
	readonly pathEditMode?: "relative" | "fixed"
	readonly origin?: "parent" | "layout"
	readonly rAng?: number
	// A preset path's (the effect's presetID), or 0 for a custom path.
	readonly presetID?: number
}

type MotionBehaviorNode = Extract<Behavior, { type: "animMotion" }>

// Every animMotion with a path in `timing`, in document order, with the effect it belongs to (the nearest par above
// it that names a preset class, else its parent).
export function motionBehaviors(timing: TimingTree | undefined): MotionBehavior[] {
	const out: MotionBehavior[] = []

	if (timing === undefined) return out

	const stack: { node: TimeNode; effect: TimeNode | undefined }[] = [{ node: timing.root, effect: undefined }]

	for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
		const { node } = entry
		const effect = node.ctn.presetClass !== undefined ? node : entry.effect

		if (node.kind === "behavior" && node.behavior.type === "animMotion") {
			const behavior: MotionBehaviorNode = node.behavior
			const target = behavior.common.target

			if (behavior.path !== undefined && "shape" in target) {
				out.push({
					node: node.ctn.id,
					effect: (effect ?? node).ctn.id,
					shape: target.shape,
					path: behavior.path,
					...(behavior.ptsTypes === undefined ? {} : { ptsTypes: behavior.ptsTypes }),
					...(behavior.pathEditMode === undefined ? {} : { pathEditMode: behavior.pathEditMode }),
					...(behavior.origin === undefined ? {} : { origin: behavior.origin }),
					...(behavior.rAng === undefined ? {} : { rAng: behavior.rAng }),
					...(effect?.ctn.presetID === undefined ? {} : { presetID: effect.ctn.presetID })
				})
			}
		}

		const children = node.ctn.children

		for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i] as TimeNode, effect })
	}

	return out
}

// `behavior` with its path set as `change` says (a new object), or undefined when it is not an animMotion.
export function withPath(
	behavior: Behavior,
	change: {
		readonly path: string
		readonly ptsTypes?: string
		readonly origin?: "parent" | "layout"
		readonly pathEditMode?: "relative" | "fixed"
		readonly rAng?: number
	}
): Behavior | undefined {
	if (behavior.type !== "animMotion") return undefined

	const { ptsTypes: _ptsTypes, ...rest } = behavior
	// The file's ptsTypes describes its own path: kept only while the path is the same.
	const kept = change.ptsTypes ?? (change.path === behavior.path ? behavior.ptsTypes : undefined)

	return {
		...rest,
		path: change.path,
		...(kept === undefined ? {} : { ptsTypes: kept }),
		...(change.origin === undefined ? {} : { origin: change.origin }),
		...(change.pathEditMode === undefined ? {} : { pathEditMode: change.pathEditMode }),
		...(change.rAng === undefined ? {} : { rAng: change.rAng })
	}
}

// --- A drawn path as an effect ---

// The effect a custom path is added as (presetClass "path", presetID 0: PowerPoint's custom path), its one animMotion
// carrying the drawn path and its point types, unlocked (pathEditMode "relative") like every new path.
export function customPathPreset(written: { readonly path: string; readonly ptsTypes?: string }): EffectPreset {
	return {
		presetClass: "path",
		id: CUSTOM_PATH_ID,
		name: "CustomPath",
		group: "lines",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => {
			const node = motion(target, written.path, durationMs)

			return [
				node.kind === "behavior" && node.behavior.type === "animMotion" && written.ptsTypes !== undefined
					? { ...node, behavior: { ...node.behavior, ptsTypes: written.ptsTypes } }
					: node
			]
		}
	}
}

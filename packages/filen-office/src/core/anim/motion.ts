import { tooLarge } from "../presentation/refusal"

// Motion paths (ECMA-376 Part 1 §19.5 p:animMotion path, ST string "M 0 0 L 0.25 0.33 C … Z E"): points are fractions
// of the slide's width and height, relative to the shape's own position (pathEditMode "relative") or to the slide
// ("fixed" paths are written relative too, so both read the same way here). Upper-case commands are absolute, lower-case
// relative to the current point; E ends the path. The shape moves at constant speed along the path's length (SMIL
// calcMode "paced", the animateMotion default), so the path is flattened once into segments with cumulative lengths in
// slide pixels and sampled by a binary search.

export interface MotionPath {
	// Flattened vertices as x, y pairs (fractions of the slide).
	readonly points: Float64Array
	// Cumulative length at each vertex, in the units the path was measured in.
	readonly lengths: Float64Array
	readonly total: number
}

// Cubic Béziers are flattened into this many chords each.
const CURVE_STEPS = 16

// Reads `path` (refusing tooLarge past `maxSegments` flattened segments); `aspect` is the slide's width over its
// height, so lengths are measured as a viewer sees them.
export function parseMotionPath(path: string, aspect: number, maxSegments: number): MotionPath {
	const tokens = path.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gu) ?? []
	const xs: number[] = []
	const ys: number[] = []
	let x = 0
	let y = 0
	let startX = 0
	let startY = 0
	let command = "M"
	let at = 0
	const push = (px: number, py: number): void => {
		if (xs.length > maxSegments) tooLarge("motion path segments", maxSegments)

		xs.push(px)
		ys.push(py)
	}
	const number = (): number | undefined => {
		const token = tokens[at]

		if (token === undefined || /[A-Za-z]/u.test(token)) return undefined

		at++

		return Number(token)
	}

	while (at < tokens.length) {
		const token = tokens[at] ?? ""

		if (/[A-Za-z]/u.test(token)) {
			command = token
			at++

			if (command === "Z" || command === "z") {
				push(startX, startY)
				x = startX
				y = startY

				continue
			}

			if (command === "E" || command === "e") break

			continue
		}

		const relative = command === command.toLowerCase()
		const ox = relative ? x : 0
		const oy = relative ? y : 0

		switch (command.toUpperCase()) {
			case "M": {
				const nx = number()
				const ny = number()

				if (nx === undefined || ny === undefined) return finish(xs, ys, aspect)

				x = ox + nx
				y = oy + ny
				startX = x
				startY = y

				push(x, y)

				command = relative ? "l" : "L"

				break
			}
			case "L": {
				const nx = number()
				const ny = number()

				if (nx === undefined || ny === undefined) return finish(xs, ys, aspect)

				x = ox + nx
				y = oy + ny
				push(x, y)

				break
			}
			case "C": {
				const values: number[] = []

				for (let k = 0; k < 6; k++) {
					const value = number()

					if (value === undefined) return finish(xs, ys, aspect)

					values.push(value)
				}

				const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = values
				const p1x = ox + x1
				const p1y = oy + y1
				const p2x = ox + x2
				const p2y = oy + y2
				const p3x = ox + x3
				const p3y = oy + y3

				if (xs.length === 0) push(x, y)

				for (let step = 1; step <= CURVE_STEPS; step++) {
					const t = step / CURVE_STEPS
					const u = 1 - t

					push(
						u * u * u * x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x,
						u * u * u * y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y
					)
				}

				x = p3x
				y = p3y

				break
			}
			default:
				// An unknown command's numbers are skipped.
				at++
		}
	}

	return finish(xs, ys, aspect)
}

function finish(xs: readonly number[], ys: readonly number[], aspect: number): MotionPath {
	if (xs.length === 0) return { points: new Float64Array([0, 0]), lengths: new Float64Array([0]), total: 0 }

	const points = new Float64Array(xs.length * 2)
	const lengths = new Float64Array(xs.length)
	let total = 0

	for (let k = 0; k < xs.length; k++) {
		points[k * 2] = xs[k] ?? 0
		points[k * 2 + 1] = ys[k] ?? 0

		if (k > 0) total += Math.hypot(((xs[k] ?? 0) - (xs[k - 1] ?? 0)) * aspect, (ys[k] ?? 0) - (ys[k - 1] ?? 0))

		lengths[k] = total
	}

	return { points, lengths, total }
}

// The point at `progress` (0..1) of the path's length, written into `out` as [x, y] fractions of the slide.
export function pointAt(path: MotionPath, progress: number, out: Float64Array): Float64Array {
	const { points, lengths, total } = path
	const last = lengths.length - 1

	if (total <= 0 || progress <= 0 || last <= 0) {
		const k = progress >= 1 && last > 0 ? last : 0

		out[0] = points[k * 2] ?? 0
		out[1] = points[k * 2 + 1] ?? 0

		return out
	}

	const target = Math.min(1, progress) * total
	let low = 0
	let high = last

	while (high - low > 1) {
		const middle = (low + high) >> 1

		if ((lengths[middle] ?? 0) < target) low = middle
		else high = middle
	}

	const from = lengths[low] ?? 0
	const span = (lengths[high] ?? 0) - from
	const f = span > 0 ? (target - from) / span : 0

	out[0] = (points[low * 2] ?? 0) + ((points[high * 2] ?? 0) - (points[low * 2] ?? 0)) * f
	out[1] = (points[low * 2 + 1] ?? 0) + ((points[high * 2 + 1] ?? 0) - (points[low * 2 + 1] ?? 0)) * f

	return out
}

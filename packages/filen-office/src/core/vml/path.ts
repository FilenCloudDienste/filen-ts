import type { DrawingList } from "../drawingml/displayList"

// VML shape paths and formulas (v:shape@path, v:formulas): evaluated into the display list's commands.

// Values the formula language names (v:f), besides @n (formula results) and #n (adjust values).
export interface FormulaEnvironment {
	// coordsize and coordorigin of the shape.
	readonly width: number
	readonly height: number
	readonly originX: number
	readonly originY: number
	readonly pixelWidth: number
	readonly pixelHeight: number
	readonly pixelLineWidth: number
	readonly lineDrawn: boolean
	readonly hasFill: boolean
	readonly adjust: readonly number[]
}

// Fixed-point degrees (1/65536 degree) per radian.
const FD_PER_RADIAN = (180 * 65536) / Math.PI

function namedValue(name: string, env: FormulaEnvironment): number {
	switch (name) {
		case "width":
			return env.width
		case "height":
			return env.height
		case "xcenter":
			return env.originX + env.width / 2
		case "ycenter":
			return env.originY + env.height / 2
		case "xlimo":
		case "ylimo":
			return 0
		case "pixelwidth":
			return env.pixelWidth
		case "pixelheight":
			return env.pixelHeight
		case "pixellinewidth":
			return env.pixelLineWidth
		case "emuwidth":
			return env.pixelWidth * 9525
		case "emuheight":
			return env.pixelHeight * 9525
		case "emuwidth2":
			return (env.pixelWidth * 9525) / 2
		case "emuheight2":
			return (env.pixelHeight * 9525) / 2
		case "linedrawn":
		case "hasstroke":
			return env.lineDrawn ? 1 : 0
		case "hasfill":
			return env.hasFill ? 1 : 0
		default:
			return 0
	}
}

function value(token: string | undefined, results: Float64Array, count: number, env: FormulaEnvironment): number {
	if (token === undefined || token === "") return 0

	const first = token[0]

	if (first === "@") {
		const index = Number.parseInt(token.slice(1), 10)

		return index >= 0 && index < count ? (results[index] ?? 0) : 0
	}

	if (first === "#") return env.adjust[Number.parseInt(token.slice(1), 10)] ?? 0

	const number = Number(token)

	return Number.isFinite(number) ? number : namedValue(token.toLowerCase(), env)
}

function finite(value: number): number {
	return Number.isFinite(value) ? value : 0
}

// Evaluates v:f equations in order; a result may use earlier results only.
export function evaluateFormulas(equations: readonly string[], env: FormulaEnvironment): Float64Array {
	const results = new Float64Array(equations.length)

	for (let k = 0; k < equations.length; k++) {
		const [op, a, b, c] = (equations[k] ?? "").trim().split(/\s+/)
		const v = value(a, results, k, env)
		const p1 = value(b, results, k, env)
		const p2 = value(c, results, k, env)
		let out: number

		switch (op) {
			case "val":
				out = v
				break
			case "sum":
				out = v + p1 - p2
				break
			case "prod":
			case "product":
				out = p2 === 0 ? 0 : (v * p1) / p2
				break
			case "mid":
				out = (v + p1) / 2
				break
			case "abs":
				out = Math.abs(v)
				break
			case "min":
				out = Math.min(v, p1)
				break
			case "max":
				out = Math.max(v, p1)
				break
			case "if":
				out = v > 0 ? p1 : p2
				break
			case "mod":
				out = Math.sqrt(v * v + p1 * p1 + p2 * p2)
				break
			case "atan2":
				out = Math.atan2(p1, v) * FD_PER_RADIAN
				break
			case "sin":
				out = v * Math.sin(p1 / FD_PER_RADIAN)
				break
			case "cos":
				out = v * Math.cos(p1 / FD_PER_RADIAN)
				break
			case "tan":
				out = v * Math.tan(p1 / FD_PER_RADIAN)
				break
			case "cosatan2":
				out = v * Math.cos(Math.atan2(p2, p1))
				break
			case "sinatan2":
				out = v * Math.sin(Math.atan2(p2, p1))
				break
			case "sqrt":
				out = v < 0 ? 0 : Math.sqrt(v)
				break
			case "sumangle":
				out = v + p1 * 65536 - p2 * 65536
				break
			case "ellipse":
				out = p1 === 0 ? 0 : p2 * Math.sqrt(Math.max(0, 1 - (v / p1) * (v / p1)))
				break
			default:
				out = 0
		}

		results[k] = finite(out)
	}

	return results
}

// One painted part of a path (between "e" commands), with its own nf/ns flags.
export interface VmlSegment {
	readonly firstCommand: number
	readonly firstCoord: number
	readonly commandCount: number
	readonly fill: boolean
	readonly stroke: boolean
	readonly open: boolean
}

// Maps coordinate space to local px: x' = (x - originX) * scaleX.
export interface CoordinateMap {
	readonly originX: number
	readonly originY: number
	readonly scaleX: number
	readonly scaleY: number
}

const TWO_LETTER: ReadonlySet<string> = new Set([
	"nf",
	"ns",
	"ae",
	"al",
	"at",
	"ar",
	"wa",
	"wr",
	"qx",
	"qy",
	"qb",
	"ha",
	"hb",
	"hc",
	"hd",
	"he",
	"hf",
	"hg",
	"hh",
	"hi"
])

function isValueStart(code: number): boolean {
	return (code >= 48 && code <= 57) || code === 45 || code === 43 || code === 46 || code === 64 || code === 35
}

function isLetter(code: number): boolean {
	return (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
}

// Commands one VML path may emit, and values one command may carry: a crafted multi-megabyte path stays
// bounded in time and memory.
export const MAX_PATH_COMMANDS = 1 << 20
export const MAX_COMMAND_VALUES = 1 << 16

// Reads a VML path one command at a time, in a single pass over the string. Each value (the raw text of a
// member, "" for an empty one, read as 0) goes to `onValue` as it is read; nothing is collected.
export class PathScanner {
	private readonly path: string
	private at = 0

	constructor(path: string) {
		this.path = path
	}

	// The next command (lower-case), or undefined at the end.
	next(onValue: (text: string) => void): string | undefined {
		const path = this.path
		const length = path.length
		let i = this.at

		while (i < length && !isLetter(path.charCodeAt(i))) i++

		if (i >= length) {
			this.at = i

			return undefined
		}

		const pair = path.slice(i, i + 2).toLowerCase()
		const command = TWO_LETTER.has(pair) ? pair : (pair[0] ?? "")
		let expecting = true
		let values = 0

		i += command.length

		for (;;) {
			while (
				i < length &&
				(path.charCodeAt(i) === 32 || path.charCodeAt(i) === 9 || path.charCodeAt(i) === 10 || path.charCodeAt(i) === 13)
			)
				i++

			const next = path.charCodeAt(i)

			if (i < length && isValueStart(next)) {
				const start = i

				i++

				// A sign, "@" or "#" starts a new value; digits and the decimal point continue one.
				while (i < length && ((path.charCodeAt(i) >= 48 && path.charCodeAt(i) <= 57) || path.charCodeAt(i) === 46)) i++

				if (values++ < MAX_COMMAND_VALUES) onValue(path.slice(start, i))

				expecting = false
			} else if (next === 44) {
				if (expecting && values++ < MAX_COMMAND_VALUES) onValue("")

				expecting = true
				i++
			} else {
				if (expecting && values > 0 && values++ < MAX_COMMAND_VALUES) onValue("")

				break
			}
		}

		this.at = i

		return command
	}
}

// Tokenises a VML path into commands with their argument strings ("" for empty members, read as 0).
export function tokenizePath(path: string): { command: string; args: string[] }[] {
	const out: { command: string; args: string[] }[] = []
	const scanner = new PathScanner(path)
	let args: string[] = []
	const collect = (text: string): void => {
		args.push(text)
	}

	for (let command = scanner.next(collect); command !== undefined; command = scanner.next(collect)) {
		out.push({ command, args })
		args = []
	}

	return out
}

const KAPPA = 0.5522847498307936

// Cubic segments of an ellipse arc from parametric angle t0 over delta (radians; positive runs clockwise
// on screen), starting at the current point.
export function ellipseArc(list: DrawingList, cx: number, cy: number, rx: number, ry: number, t0: number, delta: number): [number, number] {
	if (delta === 0 || !Number.isFinite(delta)) return [cx + rx * Math.cos(t0), cy + ry * Math.sin(t0)]

	// A quarter turn per segment, at most four: past a full turn the arc retraces the same ellipse.
	const sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, delta))
	const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
	const step = sweep / segments
	const k = (4 / 3) * Math.tan(step / 4)
	let a = t0
	let x = cx + rx * Math.cos(t0)
	let y = cy + ry * Math.sin(t0)

	for (let s = 0; s < segments; s++) {
		const b = a + step
		const cosA = Math.cos(a)
		const sinA = Math.sin(a)
		const cosB = Math.cos(b)
		const sinB = Math.sin(b)

		x = cx + rx * cosB
		y = cy + ry * sinB
		list.cubicTo(
			cx + rx * (cosA - k * sinA),
			cy + ry * (sinA + k * cosA),
			cx + rx * (cosB + k * sinB),
			cy + ry * (sinB - k * cosB),
			x,
			y
		)
		a = b
	}

	return [x, y]
}

// Appends a VML path in local px. `formulas` are the evaluated v:f results; `adjust` the adjust values.
// `onSegment` runs as each segment completes, before the next one starts, so the caller can add its item
// (and decorations) while the segment's commands are the list's last.
export function emitVmlPath(
	list: DrawingList,
	path: string,
	map: CoordinateMap,
	formulas: Float64Array,
	adjust: readonly number[],
	onSegment: (segment: VmlSegment) => void
): void {
	const resolve = (token: string | undefined): number => {
		if (token === undefined || token === "") return 0
		if (token[0] === "@") return formulas[Number.parseInt(token.slice(1), 10)] ?? 0
		if (token[0] === "#") return adjust[Number.parseInt(token.slice(1), 10)] ?? 0

		const number = Number(token)

		return Number.isFinite(number) ? number : 0
	}
	const px = (x: number): number => (x - map.originX) * map.scaleX
	const py = (y: number): number => (y - map.originY) * map.scaleY
	// Current point and subpath start, in coordinate space.
	let x = 0
	let y = 0
	let startX = 0
	let startY = 0
	let hasPoint = false
	let firstCommand = list.commandCount
	let firstCoord = list.coordCount
	let fill = true
	let stroke = true
	let open = true
	const finish = (): void => {
		const commandCount = list.commandCount - firstCommand

		if (commandCount > 0) onSegment({ firstCommand, firstCoord, commandCount, fill, stroke, open })

		firstCommand = list.commandCount
		firstCoord = list.coordCount
		fill = true
		stroke = true
		open = true
		hasPoint = false
	}
	const moveTo = (nx: number, ny: number): void => {
		x = startX = nx
		y = startY = ny
		list.moveTo(px(x), py(y))
		hasPoint = true
	}
	const ensurePoint = (): void => {
		if (!hasPoint) moveTo(x, y)
	}
	const lineTo = (nx: number, ny: number): void => {
		ensurePoint()
		x = nx
		y = ny
		list.lineTo(px(x), py(y))
	}
	const curveTo = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number): void => {
		ensurePoint()
		x = nx
		y = ny
		list.cubicTo(px(x1), py(y1), px(x2), py(y2), px(x), py(y))
	}
	// An ellipse arc in coordinate space; `connect` draws a line to its start, else moves there.
	const arc = (cx: number, cy: number, rx: number, ry: number, t0: number, delta: number, connect: boolean): void => {
		const sx = cx + rx * Math.cos(t0)
		const sy = cy + ry * Math.sin(t0)

		if (connect && hasPoint) lineTo(sx, sy)
		else moveTo(sx, sy)

		const scaledX = rx * map.scaleX
		const scaledY = ry * map.scaleY
		const [ex, ey] = ellipseArc(list, px(cx), py(cy), scaledX, scaledY, t0, delta)

		x = scaledX === 0 ? cx + rx * Math.cos(t0 + delta) : ex / map.scaleX + map.originX
		y = scaledY === 0 ? cy + ry * Math.sin(t0 + delta) : ey / map.scaleY + map.originY
	}

	const scanner = new PathScanner(path)
	const limit = list.commandCount + MAX_PATH_COMMANDS
	// Values of the current command, resolved as they are read; reused for every command.
	const n: number[] = []
	const collect = (text: string): void => {
		n.push(resolve(text))
	}

	for (
		let command = scanner.next(collect);
		command !== undefined && list.commandCount < limit;
		n.length = 0, command = scanner.next(collect)
	) {
		switch (command) {
			case "m":
				if (n.length >= 2) moveTo(n[0] ?? 0, n[1] ?? 0)

				for (let k = 2; k + 1 < n.length; k += 2) lineTo(n[k] ?? 0, n[k + 1] ?? 0)

				break
			case "t":
				if (n.length >= 2) moveTo(x + (n[0] ?? 0), y + (n[1] ?? 0))

				for (let k = 2; k + 1 < n.length; k += 2) lineTo(x + (n[k] ?? 0), y + (n[k + 1] ?? 0))

				break
			case "l":
				for (let k = 0; k + 1 < n.length; k += 2) lineTo(n[k] ?? 0, n[k + 1] ?? 0)
				break
			case "r":
				for (let k = 0; k + 1 < n.length; k += 2) lineTo(x + (n[k] ?? 0), y + (n[k + 1] ?? 0))
				break
			case "c":
				for (let k = 0; k + 5 < n.length; k += 6) {
					curveTo(n[k] ?? 0, n[k + 1] ?? 0, n[k + 2] ?? 0, n[k + 3] ?? 0, n[k + 4] ?? 0, n[k + 5] ?? 0)
				}

				break
			case "v":
				for (let k = 0; k + 5 < n.length; k += 6) {
					const ox = x
					const oy = y

					curveTo(
						ox + (n[k] ?? 0),
						oy + (n[k + 1] ?? 0),
						ox + (n[k + 2] ?? 0),
						oy + (n[k + 3] ?? 0),
						ox + (n[k + 4] ?? 0),
						oy + (n[k + 5] ?? 0)
					)
				}

				break
			case "x":
				if (hasPoint) list.close()

				open = false
				x = startX
				y = startY
				break
			case "e":
				finish()
				break
			case "nf":
				fill = false
				break
			case "ns":
				stroke = false
				break
			case "ae":
			case "al":
				// Centre, radii, start angle and sweep in 1/65536 degree, counter-clockwise on screen.
				for (let k = 0; k + 5 < n.length; k += 6) {
					const start = -(n[k + 4] ?? 0) / FD_PER_RADIAN
					// Past a full turn the arc retraces the same ellipse: clamp to one turn, keeping the direction.
					const raw = -(n[k + 5] ?? 0) / FD_PER_RADIAN
					const sweep = Number.isNaN(raw) ? 0 : Math.max(-2 * Math.PI, Math.min(2 * Math.PI, raw))

					arc(n[k] ?? 0, n[k + 1] ?? 0, n[k + 2] ?? 0, n[k + 3] ?? 0, start, sweep, command === "ae")
				}

				break
			case "at":
			case "ar":
			case "wa":
			case "wr":
				// Bounding box, then radial vectors to the start and end points; at/ar run counter-clockwise,
				// wa/wr clockwise; at/wa connect from the current point.
				for (let k = 0; k + 7 < n.length; k += 8) {
					const left = n[k] ?? 0
					const top = n[k + 1] ?? 0
					const right = n[k + 2] ?? 0
					const bottom = n[k + 3] ?? 0
					const cx = (left + right) / 2
					const cy = (top + bottom) / 2
					const rx = Math.abs(right - left) / 2
					const ry = Math.abs(bottom - top) / 2

					if (rx === 0 || ry === 0) {
						lineTo(n[k + 6] ?? 0, n[k + 7] ?? 0)

						continue
					}

					const t0 = Math.atan2(((n[k + 5] ?? 0) - cy) / ry, ((n[k + 4] ?? 0) - cx) / rx)
					const t1 = Math.atan2(((n[k + 7] ?? 0) - cy) / ry, ((n[k + 6] ?? 0) - cx) / rx)
					const clockwise = command === "wa" || command === "wr"
					let delta = t1 - t0

					if (clockwise) {
						if (delta <= 0) delta += 2 * Math.PI
					} else if (delta >= 0) {
						delta -= 2 * Math.PI
					}

					arc(cx, cy, rx, ry, t0, delta, command === "at" || command === "wa")
				}

				break
			case "qx":
			case "qy": {
				// Elliptical quadrants, alternating the tangent direction pair by pair.
				let horizontal = command === "qx"

				for (let k = 0; k + 1 < n.length; k += 2) {
					const nx = n[k] ?? 0
					const ny = n[k + 1] ?? 0

					if (horizontal) curveTo(x + (nx - x) * KAPPA, y, nx, ny + (y - ny) * KAPPA, nx, ny)
					else curveTo(x, y + (ny - y) * KAPPA, nx + (x - nx) * KAPPA, ny, nx, ny)

					horizontal = !horizontal
				}

				break
			}
			case "qb": {
				// Quadratic B-spline: control points with implied on-curve midpoints, ending at the last point.
				const count = n.length >> 1

				if (count === 1) lineTo(n[0] ?? 0, n[1] ?? 0)

				for (let k = 0; k + 1 < count; k++) {
					ensurePoint()

					const cx = n[k * 2] ?? 0
					const cy = n[k * 2 + 1] ?? 0
					const final = k + 2 === count
					const nx = final ? (n[k * 2 + 2] ?? 0) : (cx + (n[k * 2 + 2] ?? 0)) / 2
					const ny = final ? (n[k * 2 + 3] ?? 0) : (cy + (n[k * 2 + 3] ?? 0)) / 2

					list.quadTo(px(cx), py(cy), px(nx), py(ny))
					x = nx
					y = ny
				}

				break
			}
			default:
				break
		}
	}

	finish()
}

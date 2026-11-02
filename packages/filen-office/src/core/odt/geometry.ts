// Custom shape geometry (ODF 1.3 Part 3 §19.145 draw:enhanced-path, §19.171 draw:formula, §10.6.2
// draw:enhanced-geometry) and SVG path data (svg:d, draw:points) evaluated to absolute moves, lines, cubic
// curves and closes, then written as DrawingML custGeom (ECMA-376 Part 1 §20.1.9.8). Every arc becomes cubic
// Béziers of at most a quarter turn each, so no angle convention leaks into the output.

export type Segment =
	| { readonly kind: "M" | "L"; readonly x: number; readonly y: number }
	| {
			readonly kind: "C"
			readonly x1: number
			readonly y1: number
			readonly x2: number
			readonly y2: number
			readonly x: number
			readonly y: number
	  }
	| { readonly kind: "Z" }

export interface SubPath {
	readonly segments: Segment[]
	fill: boolean
	stroke: boolean
}

export interface Geometry {
	// The coordinate space the paths are in (svg:viewBox).
	readonly left: number
	readonly top: number
	readonly width: number
	readonly height: number
	readonly paths: readonly SubPath[]
}

export class GeometryError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "GeometryError"
	}
}

// Formulas referring to each other: how deep an evaluation may go before it is a cycle.
const MAX_DEPTH = 64
// Segments one shape may produce (hostile repeats are cut there).
const MAX_SEGMENTS = 100_000

// --- Formula language ---

type Token =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "op"; readonly value: string }

function tokenize(source: string): Token[] {
	const tokens: Token[] = []
	let at = 0

	while (at < source.length) {
		const char = source[at] ?? ""

		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			at++
		} else if (/[0-9.]/.test(char)) {
			const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(source.slice(at))

			if (match === null) throw new GeometryError(`Bad number in ${source}`)

			tokens.push({ kind: "number", value: Number(match[0]) })
			at += match[0].length
		} else if (char === "?" || char === "$" || /[A-Za-z_]/.test(char)) {
			const match = /^[?$]?[A-Za-z0-9_]+/.exec(source.slice(at))

			if (match === null) throw new GeometryError(`Bad name in ${source}`)

			tokens.push({ kind: "name", value: match[0] })
			at += match[0].length
		} else if ("+-*/(),".includes(char)) {
			tokens.push({ kind: "op", value: char })
			at++
		} else {
			throw new GeometryError(`Unexpected ${char} in ${source}`)
		}
	}

	return tokens
}

type Expression =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "unary"; readonly operand: Expression }
	| { readonly kind: "binary"; readonly op: string; readonly left: Expression; readonly right: Expression }
	| { readonly kind: "call"; readonly name: string; readonly args: readonly Expression[] }

class Parser {
	private at = 0
	private readonly tokens: readonly Token[]

	constructor(tokens: readonly Token[]) {
		this.tokens = tokens
	}

	parse(): Expression {
		const expression = this.sum()

		if (this.at !== this.tokens.length) throw new GeometryError("Trailing input in a formula")

		return expression
	}

	private peek(): Token | undefined {
		return this.tokens[this.at]
	}

	private isOp(value: string): boolean {
		const token = this.peek()

		return token?.kind === "op" && token.value === value
	}

	private sum(): Expression {
		let left = this.product()

		while (this.isOp("+") || this.isOp("-")) {
			const op = (this.tokens[this.at++] as Token).value as string

			left = { kind: "binary", op, left, right: this.product() }
		}

		return left
	}

	private product(): Expression {
		let left = this.unary()

		while (this.isOp("*") || this.isOp("/")) {
			const op = (this.tokens[this.at++] as Token).value as string

			left = { kind: "binary", op, left, right: this.unary() }
		}

		return left
	}

	private unary(): Expression {
		if (this.isOp("-")) {
			this.at++

			return { kind: "unary", operand: this.unary() }
		}

		if (this.isOp("+")) {
			this.at++

			return this.unary()
		}

		return this.primary()
	}

	private primary(): Expression {
		const token = this.tokens[this.at++]

		if (token === undefined) throw new GeometryError("A formula ends early")

		if (token.kind === "number") return { kind: "number", value: token.value }

		if (token.kind === "op") {
			if (token.value !== "(") throw new GeometryError(`Unexpected ${token.value}`)

			const inner = this.sum()

			if (!this.isOp(")")) throw new GeometryError("Unbalanced parenthesis")

			this.at++

			return inner
		}

		if (this.isOp("(")) {
			this.at++

			const args: Expression[] = []

			if (!this.isOp(")")) {
				args.push(this.sum())

				while (this.isOp(",")) {
					this.at++
					args.push(this.sum())
				}
			}

			if (!this.isOp(")")) throw new GeometryError("Unbalanced parenthesis")

			this.at++

			return { kind: "call", name: token.value, args }
		}

		return { kind: "name", value: token.value }
	}
}

export function parseFormula(source: string): Expression {
	return new Parser(tokenize(source)).parse()
}

export interface FormulaContext {
	readonly left: number
	readonly top: number
	readonly width: number
	readonly height: number
	// The shape's size in 1/100 mm (logwidth, logheight).
	readonly logWidth: number
	readonly logHeight: number
	readonly modifiers: readonly number[]
	readonly equations: ReadonlyMap<string, string>
}

export class Evaluator {
	private readonly context: FormulaContext
	private readonly parsed = new Map<string, Expression>()
	private readonly values = new Map<string, number>()
	private readonly active = new Set<string>()

	constructor(context: FormulaContext) {
		this.context = context
	}

	// A parameter of an enhanced path or a formula's name: a number, ?equation, $modifier or constant.
	value(parameter: string, depth = 0): number {
		const number = Number(parameter)

		if (parameter.trim() !== "" && Number.isFinite(number)) return number

		return this.name(parameter, depth)
	}

	private name(name: string, depth: number): number {
		if (depth > MAX_DEPTH) throw new GeometryError("Formulas nest too deeply")

		const context = this.context

		if (name.startsWith("$")) return context.modifiers[Number(name.slice(1))] ?? 0

		if (name.startsWith("?")) {
			const equation = name.slice(1)
			const known = this.values.get(equation)

			if (known !== undefined) return known
			if (this.active.has(equation)) throw new GeometryError(`Formula ${equation} refers to itself`)

			const source = context.equations.get(equation)

			if (source === undefined) return 0

			let expression = this.parsed.get(equation)

			if (expression === undefined) {
				expression = parseFormula(source)
				this.parsed.set(equation, expression)
			}

			this.active.add(equation)

			const value = this.evaluate(expression, depth + 1)

			this.active.delete(equation)
			this.values.set(equation, value)

			return value
		}

		switch (name) {
			case "left":
				return context.left
			case "top":
				return context.top
			case "right":
				return context.left + context.width
			case "bottom":
				return context.top + context.height
			case "width":
				return context.width
			case "height":
				return context.height
			case "logwidth":
				return context.logWidth
			case "logheight":
				return context.logHeight
			case "pi":
				return Math.PI
			case "hasstroke":
			case "hasfill":
				return 1
			case "xstretch":
			case "ystretch":
				return 0
			default:
				throw new GeometryError(`Unknown name ${name}`)
		}
	}

	evaluate(expression: Expression, depth = 0): number {
		if (depth > MAX_DEPTH) throw new GeometryError("Formulas nest too deeply")

		switch (expression.kind) {
			case "number":
				return expression.value
			case "name":
				return this.name(expression.value, depth)
			case "unary":
				return -this.evaluate(expression.operand, depth + 1)
			case "binary": {
				const left = this.evaluate(expression.left, depth + 1)
				const right = this.evaluate(expression.right, depth + 1)

				switch (expression.op) {
					case "+":
						return left + right
					case "-":
						return left - right
					case "*":
						return left * right
					default:
						return right === 0 ? 0 : left / right
				}
			}
			case "call": {
				const args = expression.args.map(arg => this.evaluate(arg, depth + 1))
				const [a = 0, b = 0, c = 0] = args

				switch (expression.name) {
					case "abs":
						return Math.abs(a)
					case "sqrt":
						return Math.sqrt(Math.max(0, a))
					case "sin":
						return Math.sin(a)
					case "cos":
						return Math.cos(a)
					case "tan":
						return Math.tan(a)
					case "atan":
						return Math.atan(a)
					case "atan2":
						return Math.atan2(a, b)
					case "min":
						return Math.min(a, b)
					case "max":
						return Math.max(a, b)
					case "if":
						return a > 0 ? b : c
					default:
						throw new GeometryError(`Unknown function ${expression.name}`)
				}
			}
		}
	}
}

// --- Paths ---

const KAPPA = 0.5522847498307936

class PathBuilder {
	readonly paths: SubPath[] = []
	private current: SubPath | undefined
	private count = 0
	x = 0
	y = 0
	startX = 0
	startY = 0

	private push(segment: Segment): void {
		if (++this.count > MAX_SEGMENTS) throw new GeometryError("Too many path segments")

		if (this.current === undefined) {
			this.current = { segments: [], fill: true, stroke: true }
			this.paths.push(this.current)
		}

		this.current.segments.push(segment)
	}

	move(x: number, y: number): void {
		this.push({ kind: "M", x, y })
		this.x = this.startX = x
		this.y = this.startY = y
	}

	line(x: number, y: number): void {
		if (this.current === undefined) {
			this.move(x, y)

			return
		}

		this.push({ kind: "L", x, y })
		this.x = x
		this.y = y
	}

	cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		if (this.current === undefined) this.move(this.x, this.y)

		this.push({ kind: "C", x1, y1, x2, y2, x, y })
		this.x = x
		this.y = y
	}

	quadratic(qx: number, qy: number, x: number, y: number): void {
		this.cubic(this.x + ((qx - this.x) * 2) / 3, this.y + ((qy - this.y) * 2) / 3, x + ((qx - x) * 2) / 3, y + ((qy - y) * 2) / 3, x, y)
	}

	close(): void {
		if (this.current === undefined) return

		this.push({ kind: "Z" })
		this.x = this.startX
		this.y = this.startY
	}

	// Ends the subpath (N): later segments start a new path element.
	end(): void {
		this.current = undefined
	}

	noFill(): void {
		this.ensure().fill = false
	}

	noStroke(): void {
		this.ensure().stroke = false
	}

	private ensure(): SubPath {
		if (this.current === undefined) {
			this.current = { segments: [], fill: true, stroke: true }
			this.paths.push(this.current)
		}

		return this.current
	}

	// An elliptical arc around (cx, cy) with radii (rx, ry) from angle `start` sweeping `sweep` (radians, in
	// screen coordinates: positive turns from +x towards +y), joined to the current point by a line (`line`)
	// or starting a new subpath.
	arc(cx: number, cy: number, rx: number, ry: number, start: number, sweep: number, join: "line" | "move"): void {
		const x0 = cx + rx * Math.cos(start)
		const y0 = cy + ry * Math.sin(start)

		if (join === "move" || this.current === undefined) this.move(x0, y0)
		else this.line(x0, y0)

		const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
		const delta = sweep / steps
		const k = (4 / 3) * Math.tan(delta / 4)
		let angle = start

		for (let step = 0; step < steps; step++) {
			const next = angle + delta
			const cos0 = Math.cos(angle)
			const sin0 = Math.sin(angle)
			const cos1 = Math.cos(next)
			const sin1 = Math.sin(next)

			this.cubic(
				cx + rx * (cos0 - k * sin0),
				cy + ry * (sin0 + k * cos0),
				cx + rx * (cos1 + k * sin1),
				cy + ry * (sin1 - k * cos1),
				cx + rx * cos1,
				cy + ry * sin1
			)
			angle = next
		}
	}

	// A quarter ellipse to (x, y), its first tangent horizontal (x) or vertical (y).
	quadrant(x: number, y: number, horizontal: boolean): void {
		const x0 = this.x
		const y0 = this.y

		if (horizontal) this.cubic(x0 + KAPPA * (x - x0), y0, x, y + KAPPA * (y0 - y), x, y)
		else this.cubic(x0, y0 + KAPPA * (y - y0), x + KAPPA * (x0 - x), y, x, y)
	}
}

// The screen angle (radians) of a point on the ellipse bounded by (x1, y1)–(x2, y2), seen from its centre.
function angleOf(cx: number, cy: number, rx: number, ry: number, x: number, y: number): number {
	return Math.atan2((y - cy) / (ry || 1), (x - cx) / (rx || 1))
}

// draw:enhanced-path parameters are split on whitespace (and commas some writers use).
function splitParameters(path: string): string[] {
	const out: string[] = []
	const pattern =
		/([A-Za-z](?![A-Za-z0-9_]))|(\?[A-Za-z0-9_]+)|(\$\d+)|(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)/g

	for (let match = pattern.exec(path); match !== null; match = pattern.exec(path)) out.push(match[0])

	return out
}

const COMMAND_ARGUMENTS: Readonly<Record<string, number>> = {
	M: 2,
	L: 2,
	C: 6,
	Z: 0,
	N: 0,
	F: 0,
	S: 0,
	// LibreOffice's darken, darkenLess, lighten and lightenLess (a DrawingML path's fill mode): filled, as drawn here.
	H: 0,
	I: 0,
	J: 0,
	K: 0,
	T: 6,
	U: 6,
	A: 8,
	B: 8,
	W: 8,
	V: 8,
	X: 2,
	Y: 2,
	Q: 4
}

export function enhancedPath(path: string, evaluator: Evaluator): SubPath[] {
	const builder = new PathBuilder()
	const parameters = splitParameters(path)
	let at = 0
	let command = ""

	const next = (): number => {
		const parameter = parameters[at++]

		if (parameter === undefined) throw new GeometryError("A path ends inside a command")

		return evaluator.value(parameter)
	}

	while (at < parameters.length) {
		const token = parameters[at] ?? ""

		if (/^[A-Za-z]$/.test(token) && COMMAND_ARGUMENTS[token] !== undefined) {
			command = token
			at++

			if (COMMAND_ARGUMENTS[command] === 0) {
				if (command === "Z") builder.close()
				else if (command === "N") builder.end()
				else if (command === "F") builder.noFill()
				else if (command === "S") builder.noStroke()
			}

			continue
		}

		const count = COMMAND_ARGUMENTS[command]

		if (count === undefined || count === 0) throw new GeometryError(`Parameter ${token} outside a command`)

		switch (command) {
			case "M":
				builder.move(next(), next())
				command = "L"
				break
			case "L":
				builder.line(next(), next())
				break
			case "C":
				builder.cubic(next(), next(), next(), next(), next(), next())
				break
			case "Q": {
				const qx = next()
				const qy = next()

				builder.quadratic(qx, qy, next(), next())
				break
			}
			case "T":
			case "U": {
				// Centre, radii, start and end angle in degrees, counter-clockwise on screen (y down).
				const cx = next()
				const cy = next()
				const rx = next()
				const ry = next()
				const start = next()
				let end = next()

				if (end <= start) end += 360 * Math.ceil((start - end) / 360 + 1e-9) || 360

				const sweep = Math.min(360, end - start)

				builder.arc(cx, cy, rx, ry, (-start * Math.PI) / 180, (-sweep * Math.PI) / 180, command === "T" ? "line" : "move")
				break
			}
			case "A":
			case "B":
			case "W":
			case "V": {
				const x1 = next()
				const y1 = next()
				const x2 = next()
				const y2 = next()
				const x3 = next()
				const y3 = next()
				const x4 = next()
				const y4 = next()
				const cx = (x1 + x2) / 2
				const cy = (y1 + y2) / 2
				const rx = Math.abs(x2 - x1) / 2
				const ry = Math.abs(y2 - y1) / 2
				const start = angleOf(cx, cy, rx, ry, x3, y3)
				const end = angleOf(cx, cy, rx, ry, x4, y4)
				const clockwise = command === "W" || command === "V"
				let sweep = end - start

				// Counter-clockwise on screen is decreasing screen angle.
				if (clockwise) {
					while (sweep <= 0) sweep += 2 * Math.PI
				} else {
					while (sweep >= 0) sweep -= 2 * Math.PI
				}

				if (Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-9 && (x3 !== x4 || y3 !== y4)) sweep = 0

				builder.arc(cx, cy, rx, ry, start, sweep, command === "A" || command === "W" ? "line" : "move")
				break
			}
			case "X":
				builder.quadrant(next(), next(), true)
				command = "Y"
				break
			case "Y":
				builder.quadrant(next(), next(), false)
				command = "X"
				break
		}
	}

	return builder.paths
}

// svg:d path data (SVG 1.1 §8.3), absolute or relative, arcs included.
export function svgPath(data: string): SubPath[] {
	const builder = new PathBuilder()
	const tokens = data.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []
	let at = 0
	let command = ""
	let lastControlX = 0
	let lastControlY = 0
	let lastKind = ""

	const number = (): number => {
		const token = tokens[at++]

		if (token === undefined || /[A-Za-z]/.test(token)) throw new GeometryError("Path data ends inside a command")

		return Number(token)
	}

	while (at < tokens.length) {
		const token = tokens[at] ?? ""

		if (/^[A-Za-z]$/.test(token)) {
			command = token
			at++

			if (command === "Z" || command === "z") {
				builder.close()
				lastKind = "Z"
			}

			continue
		}

		const relative = command === command.toLowerCase()
		const ox = relative ? builder.x : 0
		const oy = relative ? builder.y : 0

		switch (command.toUpperCase()) {
			case "M":
				builder.move(ox + number(), oy + number())
				command = relative ? "l" : "L"
				lastKind = "M"
				break
			case "L":
				builder.line(ox + number(), oy + number())
				lastKind = "L"
				break
			case "H":
				builder.line(ox + number(), builder.y)
				lastKind = "L"
				break
			case "V":
				builder.line(builder.x, oy + number())
				lastKind = "L"
				break
			case "C": {
				const x1 = ox + number()
				const y1 = oy + number()
				const x2 = ox + number()
				const y2 = oy + number()

				builder.cubic(x1, y1, x2, y2, ox + number(), oy + number())
				lastControlX = x2
				lastControlY = y2
				lastKind = "C"
				break
			}
			case "S": {
				const x1 = lastKind === "C" ? 2 * builder.x - lastControlX : builder.x
				const y1 = lastKind === "C" ? 2 * builder.y - lastControlY : builder.y
				const x2 = ox + number()
				const y2 = oy + number()

				builder.cubic(x1, y1, x2, y2, ox + number(), oy + number())
				lastControlX = x2
				lastControlY = y2
				lastKind = "C"
				break
			}
			case "Q": {
				const qx = ox + number()
				const qy = oy + number()

				builder.quadratic(qx, qy, ox + number(), oy + number())
				lastControlX = qx
				lastControlY = qy
				lastKind = "Q"
				break
			}
			case "T": {
				const qx = lastKind === "Q" ? 2 * builder.x - lastControlX : builder.x
				const qy = lastKind === "Q" ? 2 * builder.y - lastControlY : builder.y

				builder.quadratic(qx, qy, ox + number(), oy + number())
				lastControlX = qx
				lastControlY = qy
				lastKind = "Q"
				break
			}
			case "A": {
				const rx = Math.abs(number())
				const ry = Math.abs(number())
				const rotation = number()
				const large = number() !== 0
				const sweep = number() !== 0
				const x = ox + number()
				const y = oy + number()

				svgArc(builder, rx, ry, rotation, large, sweep, x, y)
				lastKind = "A"
				break
			}
			default:
				throw new GeometryError(`Unknown path command ${command}`)
		}
	}

	return builder.paths
}

// SVG 1.1 Appendix F.6.5: endpoint to centre parameterization. A rotated ellipse is drawn unrotated (rare in ODF).
function svgArc(
	builder: PathBuilder,
	rx: number,
	ry: number,
	rotation: number,
	large: boolean,
	sweep: boolean,
	x: number,
	y: number
): void {
	const x0 = builder.x
	const y0 = builder.y

	if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
		builder.line(x, y)

		return
	}

	const phi = (rotation * Math.PI) / 180
	const cos = Math.cos(phi)
	const sin = Math.sin(phi)
	const dx = (x0 - x) / 2
	const dy = (y0 - y) / 2
	const x1 = cos * dx + sin * dy
	const y1 = -sin * dx + cos * dy
	const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)

	if (lambda > 1) {
		rx *= Math.sqrt(lambda)
		ry *= Math.sqrt(lambda)
	}

	const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
	const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
	const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / (denominator || 1)))
	const cx1 = (factor * rx * y1) / ry
	const cy1 = (-factor * ry * x1) / rx
	const cx = cos * cx1 - sin * cy1 + (x0 + x) / 2
	const cy = sin * cx1 + cos * cy1 + (y0 + y) / 2
	const start = Math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
	let delta = Math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - start

	if (sweep && delta < 0) delta += 2 * Math.PI
	else if (!sweep && delta > 0) delta -= 2 * Math.PI

	builder.arc(cx, cy, rx, ry, start, delta, "line")
}

// draw:points "x,y x,y ..." as a polyline (closed for a polygon).
export function pointsPath(points: string, closed: boolean): SubPath[] {
	const builder = new PathBuilder()
	const numbers = (points.match(/-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number)

	for (let k = 0; k + 1 < numbers.length; k += 2) {
		if (k === 0) builder.move(numbers[k] ?? 0, numbers[k + 1] ?? 0)
		else builder.line(numbers[k] ?? 0, numbers[k + 1] ?? 0)
	}

	if (closed) builder.close()

	if (!closed) for (const path of builder.paths) path.fill = false

	return builder.paths
}

// The paths as a:custGeom, mapped from the view box onto a path space of integer coordinates.
export function customGeometry(geometry: Geometry, mirrorX: boolean, mirrorY: boolean): string {
	const scale = 100_000 / Math.max(geometry.width, geometry.height, 1e-9)
	const w = Math.max(1, Math.round(geometry.width * scale))
	const h = Math.max(1, Math.round(geometry.height * scale))
	const point = (x: number, y: number): string => {
		let px = (x - geometry.left) * scale
		let py = (y - geometry.top) * scale

		if (mirrorX) px = w - px
		if (mirrorY) py = h - py

		return `<a:pt x="${Math.round(px)}" y="${Math.round(py)}"/>`
	}
	let paths = ""

	for (const path of geometry.paths) {
		if (path.segments.length === 0) continue

		let xml = ""

		for (const segment of path.segments) {
			switch (segment.kind) {
				case "M":
					xml += `<a:moveTo>${point(segment.x, segment.y)}</a:moveTo>`
					break
				case "L":
					xml += `<a:lnTo>${point(segment.x, segment.y)}</a:lnTo>`
					break
				case "C":
					xml += `<a:cubicBezTo>${point(segment.x1, segment.y1)}${point(segment.x2, segment.y2)}${point(segment.x, segment.y)}</a:cubicBezTo>`
					break
				case "Z":
					xml += "<a:close/>"
			}
		}

		paths += `<a:path w="${w}" h="${h}"${path.fill ? "" : ' fill="none"'}${path.stroke ? "" : ' stroke="0"'}>${xml}</a:path>`
	}

	return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom>`
}

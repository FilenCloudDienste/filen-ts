import type { GridCanvas } from "../paint/canvas"

// Whitespace SVG would collapse: at either end, or two characters of it in a row.
const SPACES = /^\s|\s$|\s\s/

// A GridCanvas that writes SVG instead of pixels, so the grid's own painters (cells, borders, text, conditional
// formatting's bars and icons) draw a printed page as vectors: text stays text and lines stay sharp at any printer's
// resolution. What it writes is in the canvas's coordinates under its current transform; the caller places the whole
// in the page (a group's transform). Patterns are not drawn: a PatternCache handed no swatches fills a patterned cell
// with its blend of colours.

type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5]
	]
}

interface Rect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

interface State {
	matrix: Matrix
	fillStyle: string | object
	strokeStyle: string | object
	lineWidth: number
	font: string
	textAlign: GridCanvas["textAlign"]
	textBaseline: GridCanvas["textBaseline"]
	dash: readonly number[]
	clip: Rect | null
}

// A linear gradient: its line in the canvas's coordinates when it was made, and its stops.
class SvgGradient {
	readonly stops: { offset: number; color: string }[] = []
	id: string | null = null
	readonly x1: number
	readonly y1: number
	readonly x2: number
	readonly y2: number

	constructor(x1: number, y1: number, x2: number, y2: number) {
		this.x1 = x1
		this.y1 = y1
		this.x2 = x2
		this.y2 = y2
	}

	addColorStop(offset: number, color: string): void {
		this.stops.push({ offset, color })
	}
}

function number(value: number): string {
	return String(Math.round(value * 100) / 100)
}

// Text and attribute values for markup parsed as XML: escaped, and every character XML 1.0 forbids (C0 controls but
// tab, line feed and carriage return; U+FFFE, U+FFFF; a lone surrogate) drawn as a space, as a canvas draws it, so
// a page holding one still parses.
export function escapeSvgText(text: string): string {
	return xmlChars(text).replace(/[&<>"]/g, char => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;"))
}

// `text` with the characters XML 1.0's Char production leaves out replaced by spaces (the same string when none).
export function xmlChars(text: string): string {
	let out: string | null = null
	let from = 0

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		let allowed: boolean

		if (code < 0x20) {
			allowed = code === 0x09 || code === 0x0a || code === 0x0d
		} else if (code >= 0xd800 && code <= 0xdfff) {
			const next = text.charCodeAt(i + 1)

			// A high surrogate with its low one is a character; either alone is not.
			if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
				i++

				continue
			}

			allowed = false
		} else {
			allowed = code !== 0xfffe && code !== 0xffff
		}

		if (allowed) continue

		out = `${out ?? ""}${text.slice(from, i)} `
		from = i + 1
	}

	return out === null ? text : out + text.slice(from)
}

const ANCHORS: Readonly<Record<GridCanvas["textAlign"], string>> = {
	left: "start",
	start: "start",
	center: "middle",
	right: "end",
	end: "end"
}

const BASELINES: Readonly<Record<GridCanvas["textBaseline"], string | null>> = {
	alphabetic: null,
	ideographic: "ideographic",
	top: "text-before-edge",
	hanging: "hanging",
	middle: "central",
	bottom: "text-after-edge"
}

export class SvgCanvas implements GridCanvas {
	private state: State = {
		matrix: IDENTITY,
		fillStyle: "#000000",
		strokeStyle: "#000000",
		lineWidth: 1,
		font: "10px sans-serif",
		textAlign: "start",
		textBaseline: "alphabetic",
		dash: [],
		clip: null
	}
	private readonly stack: State[] = []
	private readonly body: string[] = []
	private readonly defs: string[] = []
	// The clip the open group draws under (undefined: no group open).
	private group: Rect | null | undefined = undefined
	private path = ""
	// The current path's points, for clip() (a rectangle's, in practice).
	private pathMinX = Infinity
	private pathMinY = Infinity
	private pathMaxX = -Infinity
	private pathMaxY = -Infinity
	private ids = 0

	private readonly prefix: string
	private readonly measure: (font: string, text: string) => number

	// `prefix` keeps the ids of clips and gradients unique among SVGs in one document; `measure` is the text measure
	// layout used (a browser canvas's), so text is placed where the grid would place it.
	constructor(prefix: string, measure: (font: string, text: string) => number) {
		this.prefix = prefix
		this.measure = measure
	}

	get fillStyle(): string | object {
		return this.state.fillStyle
	}

	set fillStyle(value: string | object) {
		this.state.fillStyle = value
	}

	get strokeStyle(): string | object {
		return this.state.strokeStyle
	}

	set strokeStyle(value: string | object) {
		this.state.strokeStyle = value
	}

	get lineWidth(): number {
		return this.state.lineWidth
	}

	set lineWidth(value: number) {
		if (Number.isFinite(value) && value > 0) this.state.lineWidth = value
	}

	get font(): string {
		return this.state.font
	}

	set font(value: string) {
		this.state.font = value
	}

	get textAlign(): GridCanvas["textAlign"] {
		return this.state.textAlign
	}

	set textAlign(value: GridCanvas["textAlign"]) {
		this.state.textAlign = value
	}

	get textBaseline(): GridCanvas["textBaseline"] {
		return this.state.textBaseline
	}

	set textBaseline(value: GridCanvas["textBaseline"]) {
		this.state.textBaseline = value
	}

	// --- State ---

	save(): void {
		this.stack.push({ ...this.state })
	}

	restore(): void {
		const previous = this.stack.pop()

		if (previous !== undefined) this.state = previous
	}

	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.state.matrix = [a, b, c, d, e, f]
	}

	translate(x: number, y: number): void {
		this.state.matrix = multiply(this.state.matrix, [1, 0, 0, 1, x, y])
	}

	rotate(angle: number): void {
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)

		this.state.matrix = multiply(this.state.matrix, [cos, sin, -sin, cos, 0, 0])
	}

	setLineDash(segments: number[]): void {
		this.state.dash = segments.slice()
	}

	// --- Geometry ---

	private point(x: number, y: number): [number, number] {
		const m = this.state.matrix

		return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
	}

	// Whether the transform keeps rectangles axis-aligned.
	private aligned(): boolean {
		const m = this.state.matrix

		return Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9
	}

	private box(x: number, y: number, width: number, height: number): Rect {
		const [x1, y1] = this.point(x, y)
		const [x2, y2] = this.point(x + width, y + height)

		return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
	}

	// The transform's scale, for line widths and radii.
	private scale(): number {
		const m = this.state.matrix

		return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
	}

	private touch(x: number, y: number): void {
		this.pathMinX = Math.min(this.pathMinX, x)
		this.pathMinY = Math.min(this.pathMinY, y)
		this.pathMaxX = Math.max(this.pathMaxX, x)
		this.pathMaxY = Math.max(this.pathMaxY, y)
	}

	beginPath(): void {
		this.path = ""
		this.pathMinX = Infinity
		this.pathMinY = Infinity
		this.pathMaxX = -Infinity
		this.pathMaxY = -Infinity
	}

	moveTo(x: number, y: number): void {
		const [px, py] = this.point(x, y)

		this.touch(px, py)
		this.path += `M${number(px)} ${number(py)}`
	}

	lineTo(x: number, y: number): void {
		const [px, py] = this.point(x, y)

		this.touch(px, py)
		this.path += `L${number(px)} ${number(py)}`
	}

	closePath(): void {
		this.path += "Z"
	}

	rect(x: number, y: number, width: number, height: number): void {
		this.moveTo(x, y)
		this.lineTo(x + width, y)
		this.lineTo(x + width, y + height)
		this.lineTo(x, y + height)
		this.closePath()
	}

	arc(x: number, y: number, radius: number, start: number, end: number): void {
		const r = radius * this.scale()
		const sweep = end - start
		const full = Math.abs(sweep) >= Math.PI * 2 - 1e-9
		const [sx, sy] = this.point(x + radius * Math.cos(start), y + radius * Math.sin(start))

		this.path += this.path === "" ? `M${number(sx)} ${number(sy)}` : `L${number(sx)} ${number(sy)}`

		const [cx, cy] = this.point(x, y)

		this.touch(cx - r, cy - r)
		this.touch(cx + r, cy + r)

		if (full) {
			const [mx, my] = this.point(x - radius * Math.cos(start), y - radius * Math.sin(start))

			this.path += `A${number(r)} ${number(r)} 0 1 1 ${number(mx)} ${number(my)}A${number(r)} ${number(r)} 0 1 1 ${number(sx)} ${number(sy)}`

			return
		}

		const [ex, ey] = this.point(x + radius * Math.cos(end), y + radius * Math.sin(end))

		this.path += `A${number(r)} ${number(r)} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0} 1 ${number(ex)} ${number(ey)}`
	}

	clip(): void {
		if (this.pathMinX > this.pathMaxX) return

		const box: Rect = {
			x: this.pathMinX,
			y: this.pathMinY,
			width: this.pathMaxX - this.pathMinX,
			height: this.pathMaxY - this.pathMinY
		}
		const clip = this.state.clip

		if (clip === null) {
			this.state.clip = box

			return
		}

		const x = Math.max(box.x, clip.x)
		const y = Math.max(box.y, clip.y)

		this.state.clip = {
			x,
			y,
			width: Math.max(0, Math.min(box.x + box.width, clip.x + clip.width) - x),
			height: Math.max(0, Math.min(box.y + box.height, clip.y + clip.height) - y)
		}
	}

	// --- Drawing ---

	private paint(style: string | object): string {
		if (typeof style === "string") return escapeSvgText(style)
		if (style instanceof SvgGradient) {
			if (style.id === null) {
				style.id = `${this.prefix}g${String(this.ids++)}`

				const [x1, y1] = this.point(style.x1, style.y1)
				const [x2, y2] = this.point(style.x2, style.y2)
				const stops = style.stops
					.map(stop => `<stop offset="${number(stop.offset)}" stop-color="${escapeSvgText(stop.color)}"/>`)
					.join("")

				this.defs.push(
					`<linearGradient id="${style.id}" gradientUnits="userSpaceOnUse" x1="${number(x1)}" y1="${number(y1)}" x2="${number(x2)}" y2="${number(y2)}">${stops}</linearGradient>`
				)
			}

			return `url(#${style.id})`
		}

		return "#000000"
	}

	// Opens the group for the current clip when it is not the one open.
	private emit(element: string): void {
		const clip = this.state.clip

		if (clip !== this.group) {
			const same =
				clip !== null &&
				this.group !== null &&
				this.group !== undefined &&
				clip.x === this.group.x &&
				clip.y === this.group.y &&
				clip.width === this.group.width &&
				clip.height === this.group.height

			if (!same) {
				if (this.group !== undefined) this.body.push("</g>")

				if (clip === null) {
					this.body.push("<g>")
				} else {
					const id = `${this.prefix}c${String(this.ids++)}`

					this.defs.push(
						`<clipPath id="${id}"><rect x="${number(clip.x)}" y="${number(clip.y)}" width="${number(clip.width)}" height="${number(clip.height)}"/></clipPath>`
					)
					this.body.push(`<g clip-path="url(#${id})">`)
				}
			}

			this.group = clip
		}

		this.body.push(element)
	}

	private matrixAttribute(): string {
		const m = this.state.matrix

		return ` transform="matrix(${m.map(number).join(" ")})"`
	}

	fillRect(x: number, y: number, width: number, height: number): void {
		if (width === 0 || height === 0) return

		const fill = this.paint(this.state.fillStyle)

		if (this.aligned()) {
			const box = this.box(x, y, width, height)

			this.emit(
				`<rect x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}" fill="${fill}"/>`
			)
		} else {
			this.emit(
				`<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" fill="${fill}"${this.matrixAttribute()}/>`
			)
		}
	}

	// Paper is white: what a canvas would clear shows as white.
	clearRect(x: number, y: number, width: number, height: number): void {
		const fill = this.state.fillStyle

		this.state.fillStyle = "#ffffff"
		this.fillRect(x, y, width, height)
		this.state.fillStyle = fill
	}

	fill(): void {
		if (this.path !== "") this.emit(`<path d="${this.path}" fill="${this.paint(this.state.fillStyle)}"/>`)
	}

	stroke(): void {
		if (this.path === "") return

		const scale = this.scale()
		const dash =
			this.state.dash.length === 0 ? "" : ` stroke-dasharray="${this.state.dash.map(length => number(length * scale)).join(" ")}"`

		this.emit(
			`<path d="${this.path}" fill="none" stroke="${this.paint(this.state.strokeStyle)}" stroke-width="${number(this.state.lineWidth * scale)}"${dash}/>`
		)
	}

	fillText(text: string, x: number, y: number): void {
		if (text === "") return

		const anchor = ANCHORS[this.state.textAlign]
		const baseline = BASELINES[this.state.textBaseline]
		// SVG collapses a text's spaces (leading, trailing, runs of them) unless asked to keep them; a canvas draws each.
		const attributes =
			(SPACES.test(text) ? 'xml:space="preserve" ' : "") +
			`fill="${this.paint(this.state.fillStyle)}" style="font:${escapeSvgText(this.state.font)}"` +
			(anchor === "start" ? "" : ` text-anchor="${anchor}"`) +
			(baseline === null ? "" : ` dominant-baseline="${baseline}"`)
		const m = this.state.matrix

		// Text is placed unscaled where the transform is a plain translation; anything else carries its transform.
		if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
			this.emit(`<text x="${number(x + m[4])}" y="${number(y + m[5])}" ${attributes}>${escapeSvgText(text)}</text>`)
		} else {
			this.emit(`<text x="${number(x)}" y="${number(y)}" ${attributes}${this.matrixAttribute()}>${escapeSvgText(text)}</text>`)
		}
	}

	// What fillText writes is measured: the characters XML forbids as the spaces they are written as.
	measureText(text: string): { readonly width: number } {
		return { width: this.measure(this.state.font, xmlChars(text)) }
	}

	createPattern(): object | null {
		return null
	}

	createLinearGradient(x0: number, y0: number, x1: number, y1: number): SvgGradient {
		return new SvgGradient(x0, y0, x1, y1)
	}

	// The definitions and drawing so far, as an SVG group's content.
	markup(): string {
		const body = this.group === undefined ? this.body.join("") : `${this.body.join("")}</g>`

		return `${this.defs.length === 0 ? "" : `<defs>${this.defs.join("")}</defs>`}${body}`
	}
}

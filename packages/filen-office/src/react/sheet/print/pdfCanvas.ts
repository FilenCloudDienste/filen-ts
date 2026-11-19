import type { Matrix } from "../../../core/pdfwrite/content"
import type { PdfFontFaceRequest, PdfFontSet, PdfShapedText } from "../../../core/pdfwrite/fonts/fontSet"
import type { PdfPage } from "../../../core/pdfwrite/page"
import { grayRgba } from "../../../core/drawingml/pdf"
import type { GridCanvas } from "../paint/canvas"

// A GridCanvas that draws onto a PDF page, so the grid's own painters (cells, borders, text, conditional formatting's
// bars and icons, headings) print as vectors and real text: what SvgCanvas does for the browser's print, for a PDF.
// It needs no DOM, so it runs in the sheet worker beside the session.
//
// As SvgCanvas: drawing is in the canvas's coordinates under its current transform, here mapped onto the page by
// `base`; a clip is the box of its path (the painters clip to rectangles); patterns are not drawn (a PatternCache
// handed no swatches fills a patterned cell with its blend of colours); a canvas gradient (a data bar's fade) is drawn
// as bands of its colours.
//
// Text is shaped by the export's fonts and measured by them too, so text is placed where it is drawn. Shaping is
// synchronous and needs its faces loaded: a canvas made without a page only measures, recording the loads text
// needs (`loads`); the page is drawn once they are done.
//
// Marked content: everything drawn is an artifact (fills, lines, headings), except text while a cell is current
// (`content`): that is kept, by cell, and drawn as the content of the cell's structure element once the structure is
// built in reading order (drawCell), over what the painters drew.

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

// A canvas gradient (createLinearGradient): its line in the canvas's coordinates when it was made, and its stops.
export class PdfCanvasGradient {
	readonly stops: { readonly offset: number; readonly color: number }[] = []
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
		this.stops.push({ offset: Math.min(1, Math.max(0, offset)), color: cssColor(color) })
		this.stops.sort((a, b) => a.offset - b.offset)
	}

	// The colour at `t` (0..1) along the line.
	at(t: number): number {
		const stops = this.stops
		const first = stops[0]

		if (first === undefined) return 0
		if (t <= first.offset) return first.color

		for (let k = 1; k < stops.length; k++) {
			const to = stops[k]
			const from = stops[k - 1]

			if (to === undefined || from === undefined || t > to.offset) continue

			const span = to.offset - from.offset
			const u = span > 0 ? (t - from.offset) / span : 1
			const mix = (shift: number): number =>
				Math.round(((from.color >>> shift) & 255) * (1 - u) + ((to.color >>> shift) & 255) * u) << shift

			return (mix(24) | mix(16) | mix(8) | mix(0)) >>> 0
		}

		return stops[stops.length - 1]?.color ?? first.color
	}
}

// A CSS colour as 0xRRGGBBAA: #rgb, #rrggbb, #rrggbbaa, rgb() and rgba(); anything else is black.
export function cssColor(value: string): number {
	const text = value.trim().toLowerCase()

	if (text.startsWith("#")) {
		const hex = text.slice(1)

		if (/^[0-9a-f]{3}$/.test(hex)) {
			const [r = "0", g = "0", b = "0"] = hex

			return (Number.parseInt(r + r + g + g + b + b, 16) * 256 + 255) >>> 0
		}

		if (/^[0-9a-f]{6}$/.test(hex)) return (Number.parseInt(hex, 16) * 256 + 255) >>> 0
		if (/^[0-9a-f]{8}$/.test(hex)) return Number.parseInt(hex, 16) >>> 0
	}

	const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text)

	if (match !== null) {
		const channel = (part: string | undefined, scale: number): number =>
			Math.min(255, Math.max(0, Math.round(Number(part ?? "0") * scale)))

		return (
			((channel(match[1], 1) << 24) | (channel(match[2], 1) << 16) | (channel(match[3], 1) << 8) | channel(match[4] ?? "1", 255)) >>>
			0
		)
	}

	if (text === "transparent") return 0

	return 0x000000ff
}

// A canvas draws ASCII whitespace (tab, line feed, form feed, carriage return) as spaces (HTML's text preparation
// algorithm), never as a missing glyph.
export function canvasText(text: string): string {
	return /[\t\n\f\r]/.test(text) ? text.replace(/[\t\n\f\r]/g, " ") : text
}

export interface CanvasFont {
	readonly px: number
	readonly request: PdfFontFaceRequest
}

const FONT = /^\s*(?:(italic|oblique)\s+)?(?:(bold|bolder|[5-9]00)\s+)?(?:(italic|oblique)\s+)?([\d.]+)(px|pt)\s+(.+)$/i

// A canvas font shorthand ("italic bold 14.67px "Calibri", Carlito, sans-serif") as a face request: the first family
// named, quoted or not. A size in points is 4/3 as many px, as a browser canvas reads it.
export function canvasFont(font: string): CanvasFont {
	const match = FONT.exec(font)

	if (match === null) return { px: 10, request: { family: "Arial", bold: false, italic: false, slot: "hAnsi" } }

	const families = match[6] ?? ""
	const quoted = /^\s*"([^"]+)"/.exec(families)
	const first = quoted?.[1] ?? families.split(",")[0]?.trim() ?? "Arial"

	return {
		px: Math.max(0.1, Number(match[4]) * (match[5]?.toLowerCase() === "pt" ? 4 / 3 : 1)),
		request: {
			family:
				first === "" || first === "sans-serif"
					? "Arial"
					: first === "serif"
						? "Times New Roman"
						: first === "monospace"
							? "Courier New"
							: first,
			bold: match[2] !== undefined,
			italic: match[1] !== undefined || match[3] !== undefined,
			slot: "hAnsi"
		}
	}
}

// Where the baseline is for a canvas textBaseline, as a fraction of the font size below the y given (the em box of
// an OpenType face: ascent 0.8, descent 0.2, as browsers place it for faces without their own metrics).
const BASELINE_SHIFT: Readonly<Record<GridCanvas["textBaseline"], number>> = {
	alphabetic: 0,
	ideographic: -0.2,
	bottom: -0.2,
	top: 0.8,
	hanging: 0.8,
	middle: 0.3
}

// Bands a gradient fill is drawn as.
const GRADIENT_BANDS = 32
// Synthetic italic: the slant of a face drawn in place of an italic one.
const FAUX_ITALIC = 0.21

// A cell's text kept for its structure element: shaped, placed (page px) and clipped as it was drawn.
interface KeptText {
	readonly runs: Parameters<PdfPage["text"]>[0]
	readonly options: Parameters<PdfPage["text"]>[1]
	readonly clip: Rect | null
}

// Text shaped once per page: a page measures its text, then draws it. Entries are let go together at clear() (after
// each page) or past `limit` (shaping recorded the glyphs' use when they were made, so nothing is lost).
export class PdfShapeCache {
	private readonly entries = new Map<string, PdfShapedText>()

	readonly fonts: PdfFontSet
	private readonly limit: number

	constructor(fonts: PdfFontSet, limit: number = 16_384) {
		this.fonts = fonts
		this.limit = limit
	}

	clear(): void {
		this.entries.clear()
	}

	// The text shaped (bidi resolved within it), or null while a face it needs loads (the load joins `loads`).
	get(text: string, request: PdfFontFaceRequest, loads: Promise<void>[]): PdfShapedText | null {
		const key = `${request.family}\u0000${request.bold ? "b" : ""}${request.italic ? "i" : ""}\u0000${text}`
		const known = this.entries.get(key)

		if (known !== undefined) return known

		const pending = this.fonts.prepare(text, 0, text.length, request)

		if (pending !== undefined) {
			loads.push(pending)

			return null
		}

		const shaped = this.fonts.shape(text, 0, text.length, request, { level: 0, flags: 0, bidi: true })

		if (this.entries.size >= this.limit) this.entries.clear()

		this.entries.set(key, shaped)

		return shaped
	}
}

export interface PdfCanvasOptions {
	// The page drawn on; null measures only (loads are recorded).
	readonly page: PdfPage | null
	readonly shapes: PdfShapeCache
	// The canvas's space onto the page's px.
	readonly base: Matrix
	readonly gray: boolean
	readonly tagged: boolean
}

export class PdfCanvas implements GridCanvas {
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
	// The path in page px: subpaths of points.
	private subpaths: number[][] = []
	private minX = Infinity
	private minY = Infinity
	private maxX = -Infinity
	private maxY = -Infinity
	// What is open on the page: the clip group (undefined: none) and the marked content.
	private group: Rect | null | undefined = undefined
	private artifact = false
	private fontKey = ""
	private parsed: CanvasFont = canvasFont("10px sans-serif")
	// The cell text drawn now belongs to (its key; null: an artifact).
	content: number | null = null
	private readonly kept = new Map<number, KeptText[]>()
	// Face loads text drawn or measured needed (a measuring canvas only).
	readonly loads: Promise<void>[] = []

	private readonly options: PdfCanvasOptions

	constructor(options: PdfCanvasOptions) {
		this.options = options
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

	// --- Geometry (page px) ---

	private matrix(): Matrix {
		return multiply(this.options.base, this.state.matrix)
	}

	private point(x: number, y: number): [number, number] {
		const m = this.matrix()

		return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
	}

	private scale(): number {
		const m = this.matrix()

		return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
	}

	private touch(x: number, y: number): void {
		if (x < this.minX) this.minX = x
		if (y < this.minY) this.minY = y
		if (x > this.maxX) this.maxX = x
		if (y > this.maxY) this.maxY = y
	}

	beginPath(): void {
		this.subpaths = []
		this.minX = Infinity
		this.minY = Infinity
		this.maxX = -Infinity
		this.maxY = -Infinity
	}

	moveTo(x: number, y: number): void {
		const [px, py] = this.point(x, y)

		this.touch(px, py)
		this.subpaths.push([px, py])
	}

	lineTo(x: number, y: number): void {
		const [px, py] = this.point(x, y)
		const current = this.subpaths[this.subpaths.length - 1]

		this.touch(px, py)

		if (current === undefined) this.subpaths.push([px, py])
		else current.push(px, py)
	}

	closePath(): void {
		const current = this.subpaths[this.subpaths.length - 1]

		if (current !== undefined && current.length >= 2) current.push(current[0] ?? 0, current[1] ?? 0)
	}

	rect(x: number, y: number, width: number, height: number): void {
		this.moveTo(x, y)
		this.lineTo(x + width, y)
		this.lineTo(x + width, y + height)
		this.lineTo(x, y + height)
		this.closePath()
	}

	// An arc as line segments a fraction of a pixel from the curve (icons a few px across).
	arc(x: number, y: number, radius: number, start: number, end: number): void {
		const sweep = end - start
		const r = Math.abs(radius) * this.scale()
		const steps = Math.max(8, Math.min(256, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(r, 1)) * 2)))
		const first = this.subpaths.length === 0

		for (let k = 0; k <= steps; k++) {
			const angle = start + (sweep * k) / steps
			const px = x + radius * Math.cos(angle)
			const py = y + radius * Math.sin(angle)

			if (k === 0 && first) this.moveTo(px, py)
			else this.lineTo(px, py)
		}
	}

	clip(): void {
		if (this.minX > this.maxX) return

		const box: Rect = { x: this.minX, y: this.minY, width: this.maxX - this.minX, height: this.maxY - this.minY }
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

	// --- Output ---

	private color(style: string | object): number {
		const value =
			typeof style === "string" ? cssColor(style) : style instanceof PdfCanvasGradient ? (style.at(0.5) ?? 0x000000ff) : 0x000000ff

		return this.options.gray ? grayRgba(value) : value
	}

	// Makes the page's clip group and marked content what the next operator needs.
	private prepareFor(): PdfPage | null {
		const page = this.options.page

		if (page === null) return null

		const clip = this.state.clip
		const group = this.group
		const sameClip =
			group !== undefined &&
			(clip === group ||
				(clip !== null &&
					group !== null &&
					clip.x === group.x &&
					clip.y === group.y &&
					clip.width === group.width &&
					clip.height === group.height))

		if (!sameClip) {
			this.closeMark(page)

			if (group !== undefined) page.restoreState()

			page.saveState()

			if (clip !== null) page.rect(clip.x, clip.y, clip.width, clip.height).clip()

			this.group = clip
		}

		if (!this.artifact) {
			page.beginArtifact({ type: "Layout" })
			this.artifact = true
		}

		return page
	}

	private closeMark(page: PdfPage): void {
		if (!this.artifact) return

		page.endArtifact()
		this.artifact = false
	}

	// Closes what is open on the page: before drawing on it otherwise (objects, header and footer) and at its end.
	flush(): void {
		const page = this.options.page

		if (page === null) return

		this.closeMark(page)

		if (this.group !== undefined) page.restoreState()

		this.group = undefined
	}

	private emitPath(page: PdfPage): void {
		for (const points of this.subpaths) {
			if (points.length < 2) continue

			page.moveTo(points[0] ?? 0, points[1] ?? 0)

			for (let k = 2; k + 1 < points.length; k += 2) page.lineTo(points[k] ?? 0, points[k + 1] ?? 0)
		}
	}

	fillRect(x: number, y: number, width: number, height: number): void {
		if (width === 0 || height === 0) return

		const style = this.state.fillStyle

		if (style instanceof PdfCanvasGradient) {
			this.gradientRect(style, x, y, width, height)

			return
		}

		const color = this.color(style)

		if ((color & 255) === 0) return

		const page = this.prepareFor()

		if (page === null) return

		const m = this.matrix()

		page.fillColor(color)

		if (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) {
			const [x1, y1] = this.point(x, y)
			const [x2, y2] = this.point(x + width, y + height)

			page.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)).fill()

			return
		}

		const corners = [this.point(x, y), this.point(x + width, y), this.point(x + width, y + height), this.point(x, y + height)]

		page.moveTo(corners[0]?.[0] ?? 0, corners[0]?.[1] ?? 0)

		for (const [px, py] of corners.slice(1)) page.lineTo(px, py)

		page.closePath().fill()
	}

	// A gradient fill as bands across its line (a data bar's fade runs along the bar).
	private gradientRect(gradient: PdfCanvasGradient, x: number, y: number, width: number, height: number): void {
		const page = this.prepareFor()

		if (page === null) return

		const horizontal = Math.abs(gradient.x2 - gradient.x1) >= Math.abs(gradient.y2 - gradient.y1)
		const from = horizontal ? gradient.x1 : gradient.y1
		const span = (horizontal ? gradient.x2 : gradient.y2) - from
		const length = horizontal ? width : height
		const start = horizontal ? x : y

		for (let band = 0; band < GRADIENT_BANDS; band++) {
			const a = start + (length * band) / GRADIENT_BANDS
			const b = start + (length * (band + 1)) / GRADIENT_BANDS
			const t = span === 0 ? 0 : ((a + b) / 2 - from) / span
			let color = gradient.at(Math.min(1, Math.max(0, t)))

			if (this.options.gray) color = grayRgba(color)

			const [x1, y1] = horizontal ? this.point(a, y) : this.point(x, a)
			const [x2, y2] = horizontal ? this.point(b, y + height) : this.point(x + width, b)

			page.fillColor(color)
				.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
				.fill()
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
		if (this.subpaths.length === 0) return

		const color = this.color(this.state.fillStyle)

		if ((color & 255) === 0) return

		const page = this.prepareFor()

		if (page === null) return

		page.fillColor(color)
		this.emitPath(page)
		page.fill()
	}

	stroke(): void {
		if (this.subpaths.length === 0) return

		const color = this.color(this.state.strokeStyle)

		if ((color & 255) === 0) return

		const page = this.prepareFor()

		if (page === null) return

		const scale = this.scale()

		page.strokeColor(color).lineWidth(this.state.lineWidth * scale)
		page.dash(this.state.dash.map(length => length * scale))
		this.emitPath(page)
		page.stroke()
	}

	// --- Text ---

	private currentFont(): CanvasFont {
		if (this.fontKey !== this.state.font) {
			this.parsed = canvasFont(this.state.font)
			this.fontKey = this.state.font
		}

		return this.parsed
	}

	measureText(raw: string): { readonly width: number } {
		const text = canvasText(raw)
		const font = this.currentFont()

		if (text === "") return { width: 0 }

		const shaped = this.options.shapes.get(text, font.request, this.loads)

		return { width: shaped === null ? text.length * font.px * 0.5 : (shaped.width * font.px) / 1000 }
	}

	fillText(raw: string, x: number, y: number): void {
		const text = canvasText(raw)

		if (text === "") return

		const font = this.currentFont()
		const shaped = this.options.shapes.get(text, font.request, this.loads)

		if (shaped === null) {
			// A page is drawn once what it shows is loaded: text it would leave out is an error, never a gap.
			if (this.options.page !== null) throw new Error("A face the page draws with is not loaded")

			return
		}

		if (shaped.runs.length === 0 || this.options.page === null) return

		const color = this.color(this.state.fillStyle)

		if ((color & 255) === 0) return

		const width = (shaped.width * font.px) / 1000
		const align = this.state.textAlign
		const dx = align === "center" ? -width / 2 : align === "right" || align === "end" ? -width : 0
		const dy = BASELINE_SHIFT[this.state.textBaseline] * font.px
		const m = this.matrix()
		const [px, py] = this.point(x + dx, y + dy)
		const faux = shaped.runs[0]
		const slant = faux?.fauxItalic === true ? FAUX_ITALIC : 0
		const options: KeptText["options"] = {
			x: px,
			y: py,
			size: font.px,
			color,
			text,
			transform: [m[0], m[1], m[2] - slant * m[0], m[3] - slant * m[1]],
			...(faux?.fauxBold === true && { render: "fillStroke", strokeWidth: font.px / 30 })
		}

		if (this.options.tagged && this.content !== null) {
			let list = this.kept.get(this.content)

			if (list === undefined) {
				list = []
				this.kept.set(this.content, list)
			}

			list.push({ runs: shaped.runs, options, clip: this.state.clip })

			return
		}

		this.prepareFor()?.text(shaped.runs, options)
	}

	// The cells whose text is kept, by key.
	keptCells(): ReadonlySet<number> {
		return new Set(this.kept.keys())
	}

	// Draws a cell's kept text as the content of structure element `node` (call after flush, in reading order).
	drawCell(key: number, node: number): void {
		const page = this.options.page
		const list = this.kept.get(key)

		if (page === null || list === undefined) return

		page.beginContent(node)
		this.drawKept(page, list)
		page.endContent()
		this.kept.delete(key)
	}

	// Draws a cell's kept text as an artifact (text with no place in the page's structure; call after flush).
	drawArtifact(key: number): void {
		const page = this.options.page
		const list = this.kept.get(key)

		if (page === null || list === undefined) return

		page.beginArtifact({ type: "Layout" })
		this.drawKept(page, list)
		page.endArtifact()
		this.kept.delete(key)
	}

	private drawKept(page: PdfPage, list: readonly KeptText[]): void {
		for (const text of list) {
			if (text.clip !== null) page.saveState().rect(text.clip.x, text.clip.y, text.clip.width, text.clip.height).clip()

			page.text(text.runs, text.options)

			if (text.clip !== null) page.restoreState()
		}
	}

	createPattern(): object | null {
		return null
	}

	createLinearGradient(x0: number, y0: number, x1: number, y1: number): PdfCanvasGradient {
		return new PdfCanvasGradient(x0, y0, x1, y1)
	}
}

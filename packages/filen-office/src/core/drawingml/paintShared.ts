import {
	ItemFlag,
	type DrawingImage,
	type GradientStops,
	type Inset,
	type Rgba,
	type TextBodyProps,
	type TextParagraph,
	type TextRun
} from "./displayList"
import { lumTransfer } from "./lum"

// What the canvas, PDF and SVG painters read from a display list the same way: number guards, colour maths, dash
// presets, matrices, picture recolouring and the frame and line-height maths of a text body. Each painter measures
// and draws its text itself; only where lines go is shared.

export const PX_PER_PT = 96 / 72
export const MAX_COORD = 2 ** 31
const MAX_STOPS = 64

export type Matrix = readonly [number, number, number, number, number, number]

export function finite(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? value : fallback
}

export function clamp(value: number | undefined, min: number, max: number, fallback: number = min): number {
	return value !== undefined && Number.isFinite(value) ? (value < min ? min : value > max ? max : value) : fallback
}

export function index(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : -1
}

export const mod = (value: number, by: number): number => ((value % by) + by) % by

export function channel(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)))
}

export function rgbaFrom(r: number, g: number, b: number, a: number): number {
	return ((channel(r) << 24) | (channel(g) << 16) | (channel(b) << 8) | channel(a)) >>> 0
}

export function rgbaOf(value: Rgba | undefined): number {
	return value !== undefined && Number.isFinite(value) ? value >>> 0 : 0
}

export function mixRgba(c1: number, c2: number, t: number): number {
	const u = 1 - t

	return rgbaFrom(
		((c1 >>> 24) & 255) * u + ((c2 >>> 24) & 255) * t,
		((c1 >>> 16) & 255) * u + ((c2 >>> 16) & 255) * t,
		((c1 >>> 8) & 255) * u + ((c2 >>> 8) & 255) * t,
		(c1 & 255) * u + (c2 & 255) * t
	)
}

// ST_PathFillMode as a blend toward white or black.
export function modify(color: number, modifier: number): number {
	switch (modifier) {
		case ItemFlag.LIGHTEN:
			return mixRgba(color, 0xffffff00 | (color & 255), 0.4)
		case ItemFlag.LIGHTEN_LESS:
			return mixRgba(color, 0xffffff00 | (color & 255), 0.2)
		case ItemFlag.DARKEN:
			return mixRgba(color, color & 255, 0.4)
		case ItemFlag.DARKEN_LESS:
			return mixRgba(color, color & 255, 0.2)
		default:
			return color
	}
}

export function stopCount(stops: GradientStops): number {
	return Math.min(stops.offsets.length, stops.colors.length, MAX_STOPS)
}

export function averageColor(stops: GradientStops): number {
	const count = stopCount(stops)
	let r = 0
	let g = 0
	let b = 0
	let a = 0

	for (let k = 0; k < count; k++) {
		const color = rgbaOf(stops.colors[k])

		r += (color >>> 24) & 255
		g += (color >>> 16) & 255
		b += (color >>> 8) & 255
		a += color & 255
	}

	return count === 0 ? 0 : rgbaFrom(r / count, g / count, b / count, a / count)
}

// The share of the foreground a preset pattern covers (its pctN; half for the line and shape presets): what a
// pattern is drawn as where it is drawn as one blended colour.
export function patternCoverage(pattern: string): number {
	const percent = /^pct(\d+)$/u.exec(pattern)

	return percent === null ? 0.5 : clamp(Number(percent[1]) / 100, 0, 1, 0.5)
}

// A linear paint's gradient line in pixels (x0, y0, x1, y1): through the box's centre, as long as the box's
// projection onto it. Unscaled (lin@scaled false), the angle holds in pixels; scaled, it is the unit-square angle
// stretched with the box, whose pixel normal is (h cos, w sin), as the SVG painter's objectBoundingBox gradient.
export function linearGradientLine(
	angle: number | undefined,
	scaled: boolean | undefined,
	x: number,
	y: number,
	width: number,
	height: number
): [number, number, number, number] {
	const degrees = mod(finite(angle, 0), 360)
	const radians = (degrees * Math.PI) / 180
	// Exact on the axes, so a vertical or horizontal line carries no trig residue.
	let dx = degrees === 90 || degrees === 270 ? 0 : Math.cos(radians)
	let dy = degrees === 0 || degrees === 180 ? 0 : Math.sin(radians)

	if (scaled === true) {
		const sx = height * dx
		const sy = width * dy
		const length = Math.hypot(sx, sy)

		dx = length > 0 ? sx / length : 1
		dy = length > 0 ? sy / length : 0
	}

	const half = (width * Math.abs(dx) + height * Math.abs(dy)) / 2
	const cx = x + width / 2
	const cy = y + height / 2

	return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half]
}

// Dash, gap lengths in multiples of the line width (ST_PresetLineDashVal).
export function presetDashes(dash: string): readonly number[] | undefined {
	switch (dash) {
		case "dot":
			return [1, 3]
		case "dash":
			return [4, 3]
		case "lgDash":
			return [8, 3]
		case "dashDot":
			return [4, 3, 1, 3]
		case "lgDashDot":
			return [8, 3, 1, 3]
		case "lgDashDotDot":
			return [8, 3, 1, 3, 1, 3]
		case "sysDash":
			return [3, 1]
		case "sysDot":
			return [1, 1]
		case "sysDashDot":
			return [3, 1, 1, 1]
		case "sysDashDotDot":
			return [3, 1, 1, 1, 1, 1]
		default:
			return undefined
	}
}

export function insetOf(inset: Inset | undefined, min: number, max: number): [number, number, number, number] {
	if (inset === undefined || inset === null) return [0, 0, 0, 0]

	return [
		clamp(inset.left, min, max, 0),
		clamp(inset.top, min, max, 0),
		clamp(inset.right, min, max, 0),
		clamp(inset.bottom, min, max, 0)
	]
}

// --- Matrices ---

export function matrixOf(values: ArrayLike<number>, at: number = 0): Matrix {
	return [
		finite(values[at], 1),
		finite(values[at + 1], 0),
		finite(values[at + 2], 0),
		finite(values[at + 3], 1),
		clamp(values[at + 4], -MAX_COORD, MAX_COORD, 0),
		clamp(values[at + 5], -MAX_COORD, MAX_COORD, 0)
	]
}

export function invert(m: Matrix): Matrix | null {
	const det = m[0] * m[3] - m[1] * m[2]

	if (!(Math.abs(det) > 1e-12)) return null

	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

// The box (x, y, width, height) seen through `m`'s inverse: min x, min y, max x, max y.
export function boundsThrough(m: Matrix, x: number, y: number, width: number, height: number): [number, number, number, number] {
	const inverse = invert(m)

	if (inverse === null) return [0, 0, 1, 1]

	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity

	for (const [px, py] of [
		[x, y],
		[x + width, y],
		[x, y + height],
		[x + width, y + height]
	] as const) {
		const tx = inverse[0] * px + inverse[2] * py + inverse[4]
		const ty = inverse[1] * px + inverse[3] * py + inverse[5]

		minX = Math.min(minX, tx)
		minY = Math.min(minY, ty)
		maxX = Math.max(maxX, tx)
		maxY = Math.max(maxY, ty)
	}

	return [minX, minY, maxX, maxY]
}

// --- Text ---

export function genericFamily(font: string): string {
	const name = typeof font === "string" ? font.toLowerCase() : ""

	if (name.includes("mono") || name.includes("courier") || name.includes("consol")) return "monospace"
	if (name.includes("sans")) return "sans-serif"
	if (
		name.includes("times") ||
		name.includes("cambria") ||
		name.includes("georgia") ||
		name.includes("garamond") ||
		name.includes("serif")
	)
		return "serif"

	return "sans-serif"
}

export function verticalRotation(vertical: string): number {
	switch (vertical) {
		case "vert":
		case "eaVert":
		case "wordArtVert":
		case "mongolianVert":
			return 90
		case "vert270":
		case "wordArtVertRtl":
			return 270
		default:
			return 0
	}
}

export function runPx(run: TextRun, scale: number): number {
	const px = clamp(run.size, 1, 1000, 11) * PX_PER_PT * scale

	return finite(run.baseline, 0) !== 0 ? (px * 2) / 3 : px
}

// Symbol-font bullets (Wingdings 1-3, Webdings, Symbol and its variants such as Symbol MT) map their glyphs onto
// letters and private-use code points, and the bullet is drawn in its paragraph's first run's face: a plain bullet
// reads better.
export function symbolBullet(font: string): boolean {
	const name = typeof font === "string" ? font.toLowerCase() : ""

	return name.includes("wingdings") || name.includes("symbol") || name.includes("webdings")
}

// A text block's first line (its top, before the ascent) within a box `height` tall, by its lineAlign; with no
// height, around the anchor point.
export function blockTop(lineAlign: "start" | "middle" | "end", height: number, total: number): number {
	if (height <= 0) return lineAlign === "middle" ? -total / 2 : lineAlign === "end" ? -total : 0

	return lineAlign === "middle" ? (height - total) / 2 : lineAlign === "end" ? height - total : 0
}

// One line of a text body: a paragraph's runs from..to (exclusive), split at line breaks.
export interface BodyLine {
	readonly paragraph: TextParagraph
	readonly from: number
	readonly to: number
	readonly first: boolean
	readonly size: number
	readonly height: number
	before: number
	after: number
}

// The runs a painter still draws (a hostile list cannot make it draw without bound); the text body takes its runs
// from it.
export interface RunBudget {
	left: number
}

// A body's lines: one per paragraph or line break, no wrapping, each as high as its largest run.
export function bodyLines(paragraphs: readonly TextParagraph[], scale: number, reduction: number, budget: RunBudget): BodyLine[] {
	const lines: BodyLine[] = []

	for (let p = 0; p < paragraphs.length && budget.left > 0; p++) {
		const paragraph = paragraphs[p]

		if (paragraph === undefined || paragraph === null || !Array.isArray(paragraph.runs)) continue

		const runs = paragraph.runs
		const count = Math.min(runs.length, budget.left)
		const spacing = finite(paragraph.lineSpacing, 0)
		const before = p === 0 ? 0 : clamp(paragraph.spaceBefore, 0, 1000, 0) * PX_PER_PT
		const after = clamp(paragraph.spaceAfter, 0, 1000, 0) * PX_PER_PT
		const firstLine = lines.length
		let from = 0

		budget.left -= count

		for (let k = 0; k <= count; k++) {
			if (k < count && runs[k]?.lineBreak !== true) continue

			let size = 0

			for (let r = from; r < k; r++) {
				const sized = runs[r]

				if (sized !== undefined) size = Math.max(size, runPx(sized, scale))
			}

			if (size === 0) size = clamp(paragraph.endSize, 1, 1000, 11) * PX_PER_PT * scale

			const single = size * 1.2
			const height =
				(spacing > 0 ? single * Math.min(spacing, 10) : spacing < 0 ? Math.min(-spacing, 1000) * PX_PER_PT : single) *
				(1 - reduction)

			lines.push({ paragraph, from, to: k, first: lines.length === firstLine, size, height, before: 0, after: 0 })
			from = k + 1
		}

		const first = lines[firstLine]
		const last = lines[lines.length - 1]

		if (first !== undefined) first.before = before
		if (last !== undefined) last.after = after
	}

	return lines
}

// Where a text body's lines go in its box (x, y, width, height): turned with its vertical direction, inset,
// anchored, and shrunk by normal autofit.
export interface BodyFrame {
	readonly lines: readonly BodyLine[]
	readonly left: number
	readonly right: number
	// The first line's top; each line adds its before, height and after.
	readonly top: number
	// Degrees about (cx, cy).
	readonly rotation: number
	readonly cx: number
	readonly cy: number
	// The autofit font scale.
	readonly scale: number
}

// Null when the body has no line to draw.
export function bodyFrame(
	body: TextBodyProps,
	paragraphs: readonly TextParagraph[],
	box: readonly [number, number, number, number],
	budget: RunBudget
): BodyFrame | null {
	const [x, y, width, height] = box
	const turn = verticalRotation(body.vertical)
	const rotation = mod(finite(body.rotation, 0) + turn, 360)
	const swap = turn !== 0
	const cx = x + width / 2
	const cy = y + height / 2
	const boxWidth = swap ? height : width
	const boxHeight = swap ? width : height
	const [insetLeft, insetTop, insetRight, insetBottom] = insetOf(body.insets, 0, 10_000)
	const left = cx - boxWidth / 2 + insetLeft
	const right = cx + boxWidth / 2 - insetRight
	const top = cy - boxHeight / 2 + insetTop
	const bottom = cy + boxHeight / 2 - insetBottom
	const normal = body.autofit === "normal"
	const scale = normal ? clamp(body.fontScale, 0.01, 1, 1) : 1
	const reduction = normal ? clamp(body.lineSpacingReduction, 0, 0.9, 0) : 0
	const lines = bodyLines(paragraphs, scale, reduction, budget)

	if (lines.length === 0) return null

	let total = 0

	for (const line of lines) total += line.before + line.height + line.after

	return {
		lines,
		left,
		right,
		top: body.anchor === "ctr" ? top + (bottom - top - total) / 2 : body.anchor === "b" ? bottom - total : top,
		rotation,
		cx,
		cy,
		scale
	}
}

// A body line's baseline from its top: centred in its height as a 1.2 em line, 0.95 em below that line's top.
export function lineBaseline(line: BodyLine, top: number): number {
	return top + (line.height - line.size * 1.2) / 2 + line.size * 0.95
}

// --- Pictures recoloured (grayscale, brightness/contrast, bi-level, duotone, colour change) ---

export function recolors(image: DrawingImage): boolean {
	return (
		image.grayscale === true ||
		clamp(image.biLevel, -1, 1, -1) >= 0 ||
		(Array.isArray(image.duotone) && image.duotone.length === 2) ||
		clamp(image.brightness, -1, 1, 0) !== 0 ||
		clamp(image.contrast, -0.99, 0.99, 0) !== 0 ||
		(Array.isArray(image.colorChange) && image.colorChange.length === 2)
	)
}

// The SVG painter's filter chain on RGBA pixels (sRGB): colour change first (a:clrChange, exact match), then grey
// (saturate 0), brightness and contrast as one linear transfer, the bi-level threshold, and the duotone ramp.
export function recolorPixels(pixels: Uint8ClampedArray, image: DrawingImage): void {
	const biLevel = clamp(image.biLevel, -1, 1, -1)
	const brightness = clamp(image.brightness, -1, 1, 0)
	const contrast = clamp(image.contrast, -0.99, 0.99, 0)
	const duotone = Array.isArray(image.duotone) && image.duotone.length === 2 ? image.duotone : undefined
	const change = Array.isArray(image.colorChange) && image.colorChange.length === 2 ? image.colorChange : undefined
	const gray = image.grayscale === true || biLevel >= 0 || duotone !== undefined
	const [slope, intercept] = lumTransfer(brightness, contrast)
	const linear = brightness !== 0 || contrast !== 0
	const from = change === undefined ? 0 : rgbaOf(change[0]) >>> 8
	const to = change === undefined ? 0 : rgbaOf(change[1])
	const dark = duotone === undefined ? 0 : rgbaOf(duotone[0])
	const light = duotone === undefined ? 0 : rgbaOf(duotone[1])

	for (let at = 0; at + 3 < pixels.length; at += 4) {
		let r = pixels[at] ?? 0
		let g = pixels[at + 1] ?? 0
		let b = pixels[at + 2] ?? 0

		if (change !== undefined && ((r << 16) | (g << 8) | b) === from) {
			r = to >>> 24
			g = (to >>> 16) & 255
			b = (to >>> 8) & 255
			pixels[at + 3] = Math.round(((pixels[at + 3] ?? 0) * (to & 255)) / 255)
		}

		if (gray) {
			const y = 0.213 * r + 0.715 * g + 0.072 * b

			r = y
			g = y
			b = y
		}

		if (linear) {
			r = (slope * (r / 255) + intercept) * 255
			g = (slope * (g / 255) + intercept) * 255
			b = (slope * (b / 255) + intercept) * 255
		}

		if (biLevel >= 0) {
			// feFuncX type="discrete" with 16 steps (the SVG painter's table).
			r = Math.floor(clamp(r / 255, 0, 0.9999) * 16) / 16 < biLevel ? 0 : 255
			g = Math.floor(clamp(g / 255, 0, 0.9999) * 16) / 16 < biLevel ? 0 : 255
			b = Math.floor(clamp(b / 255, 0, 0.9999) * 16) / 16 < biLevel ? 0 : 255
		}

		if (duotone !== undefined) {
			const t = clamp(r / 255, 0, 1)
			const color = mixRgba(dark, light, t)

			r = color >>> 24
			g = (color >>> 16) & 255
			b = (color >>> 8) & 255
		}

		pixels[at] = channel(r)
		pixels[at + 1] = channel(g)
		pixels[at + 2] = channel(b)
	}
}

import type { DecorationValue } from "../docx/layout/styles"
import type { DocxPageData, DocxTextStyle } from "../docx/layout/pageData"
import {
	DECORATION_FLOATS,
	DECORATION_INTS,
	DecorationKind,
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FRAGMENT_LEVEL_SHIFT,
	FragmentFlag,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS
} from "../text/displayList"
import { TabLeader } from "../text/paragraph"
import type { DrawingData } from "./data"
import {
	ITEM_FILL_MODIFIER_MASK,
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	pathGradientCircle,
	PATH_COMMAND_COORDS,
	PathCommand,
	type DrawingClip,
	type DrawingImage,
	type DrawingText,
	type GradientStops,
	type ImageTile,
	type Inset,
	type Paint,
	type Rgba,
	type Shadow,
	type Stroke,
	type TextParagraph,
	type TextRun
} from "./displayList"
import { averageShade, shadeRaster } from "./shade"
import { layoutBlock } from "./textBlock"

// A drawing's display list (DrawingData) and a laid-out text page (DocxPageData with its paint tables) painted onto
// a 2D canvas: an OffscreenCanvas in a worker, an HTMLCanvasElement on a page. What it draws follows the SVG painter
// (react/docx/paint/drawing.ts and page.ts) item for item, so a thumbnail, an exported PNG and a show layer look like
// the slide on screen: paths with every paint kind (solid, linear and path gradients, preset patterns, pictures
// stretched or tiled, Gouraud-shaded meshes rasterised at the drawn resolution, metafile gradients with their spread),
// strokes with caps, joins and dashes, clips and boolean clip regions, pictures cropped and recoloured, shadows, and
// text drawn with fillText in the faces the worker registered.
//
// The canvas is typed structurally (Canvas2DLike), so the module needs no DOM and runs against a recorder in tests.
// The data crossed a thread boundary: every number is checked before it reaches the context. Nothing is fetched or
// decoded here: the caller hands in decoded pictures (`images`) and, for patterns, recolouring and shaded meshes,
// scratch canvases (`surface`); without a scratch canvas those draw their mean colour.

// --- The canvas, structurally ---

export interface CanvasGradientLike {
	addColorStop(offset: number, color: string): void
}

export interface CanvasPatternLike {
	setTransform?(transform: { a: number; b: number; c: number; d: number; e: number; f: number }): void
}

export interface ImageDataLike {
	readonly width: number
	readonly height: number
	readonly data: Uint8ClampedArray
}

// The decoded pictures and scratch canvases a context draws (`I`: ImageBitmap, OffscreenCanvas…).
export interface CanvasSized {
	readonly width: number
	readonly height: number
}

export interface Canvas2DLike<I = unknown> {
	globalAlpha: number
	globalCompositeOperation: string
	fillStyle: unknown
	strokeStyle: unknown
	lineWidth: number
	lineCap: string
	lineJoin: string
	miterLimit: number
	font: string
	textAlign: string
	textBaseline: string
	direction?: string | undefined
	// Absent where the browser lacks the property (letter and word spacing are then placed by hand).
	letterSpacing?: string | undefined
	wordSpacing?: string | undefined
	fontVariantCaps?: string | undefined
	shadowColor: string
	shadowBlur: number
	shadowOffsetX: number
	shadowOffsetY: number
	imageSmoothingEnabled?: boolean | undefined
	save(): void
	restore(): void
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
	beginPath(): void
	moveTo(x: number, y: number): void
	lineTo(x: number, y: number): void
	bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
	closePath(): void
	rect(x: number, y: number, width: number, height: number): void
	fill(rule?: "nonzero" | "evenodd"): void
	stroke(): void
	clip(rule?: "nonzero" | "evenodd"): void
	fillRect(x: number, y: number, width: number, height: number): void
	clearRect(x: number, y: number, width: number, height: number): void
	setLineDash(segments: number[]): void
	createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradientLike
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradientLike
	createPattern(image: I, repetition: "repeat" | "no-repeat"): CanvasPatternLike | null
	drawImage(image: I, dx: number, dy: number, dw: number, dh: number): void
	drawImage(image: I, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
	fillText(text: string, x: number, y: number): void
	strokeText(text: string, x: number, y: number): void
	measureText(text: string): { readonly width: number }
	createImageData(width: number, height: number): ImageDataLike
	getImageData(x: number, y: number, width: number, height: number): ImageDataLike
	putImageData(data: ImageDataLike, x: number, y: number): void
}

// A scratch canvas and its context.
export interface CanvasSurface<I> {
	readonly canvas: I
	readonly context: Canvas2DLike<I>
}

export interface CanvasPaintContext<I extends CanvasSized> {
	// The decoded picture of a drawing image, or undefined when it cannot be shown (a placeholder is drawn).
	image(image: DrawingImage): I | undefined
	// A scratch canvas of `width` x `height` pixels, or undefined (patterns, recolouring and meshes then draw their
	// mean colour).
	surface?(width: number, height: number): CanvasSurface<I> | undefined
}

// The faces text is drawn in: the CSS font set on the context for a style's font (an internal alias the worker
// registered), undefined to keep it.
export interface CanvasTextFaces {
	font?(css: string): string | undefined
}

// --- Numbers ---

const MAX_ITEMS = 200_000
const MAX_COORD = 2 ** 31
const MAX_STOPS = 64
const MAX_DASHES = 32
const MAX_RUNS = 50_000
const MAX_CLIP_CHAIN = 1024
const MAX_CLIP_SHAPES = 4096
const MAX_GLYPHS = 20_000
// Gradient periods drawn for a reflected or repeated metafile gradient.
const MAX_PERIODS = 64
// A scratch canvas's side and pixel count (recoloured pictures, tiles, meshes).
const MAX_SURFACE_SIDE = 4096
const MAX_SURFACE_PIXELS = 4096 * 2048
// Rows recoloured at a time.
const RECOLOR_BAND = 128
const PX_PER_PT = 96 / 72
// A drawing's family list (an internal alias and a generic family), and a text style's CSS font (page.ts's rule).
const FONT_FAMILY = /^(?:"[A-Za-z0-9_-]{1,128}", )?(?:serif|sans-serif|monospace)$/
const CSS_FONT =
	/^(?:italic )?\d{1,4} \d{1,5}(?:\.\d{1,3})? ?px (?:"[A-Za-z0-9_-]{1,128}", )?(?:serif|sans-serif|monospace|cursive|fantasy|system-ui)$/
const FALLBACK_FONT = "400 16px serif"
const HEX = /^[0-9A-Fa-f]{6}$/
const AUTO_TEXT = "#000000"
const PLACEHOLDER_FILL = "#f1f1f1"
const PLACEHOLDER_STROKE = "#c8c8c8"

type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0]

function finite(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? value : fallback
}

function clamp(value: number | undefined, min: number, max: number, fallback: number = min): number {
	return value !== undefined && Number.isFinite(value) ? (value < min ? min : value > max ? max : value) : fallback
}

function index(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : -1
}

const mod = (value: number, by: number): number => ((value % by) + by) % by

function channel(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)))
}

function rgbaFrom(r: number, g: number, b: number, a: number): number {
	return ((channel(r) << 24) | (channel(g) << 16) | (channel(b) << 8) | channel(a)) >>> 0
}

function mix(c1: number, c2: number, t: number): number {
	const u = 1 - t

	return rgbaFrom(
		((c1 >>> 24) & 255) * u + ((c2 >>> 24) & 255) * t,
		((c1 >>> 16) & 255) * u + ((c2 >>> 16) & 255) * t,
		((c1 >>> 8) & 255) * u + ((c2 >>> 8) & 255) * t,
		(c1 & 255) * u + (c2 & 255) * t
	)
}

// ST_PathFillMode as a blend toward white or black (as the SVG painter draws it).
function modify(color: number, modifier: number): number {
	switch (modifier) {
		case ItemFlag.LIGHTEN:
			return mix(color, 0xffffff00 | (color & 255), 0.4)
		case ItemFlag.LIGHTEN_LESS:
			return mix(color, 0xffffff00 | (color & 255), 0.2)
		case ItemFlag.DARKEN:
			return mix(color, color & 255, 0.4)
		case ItemFlag.DARKEN_LESS:
			return mix(color, color & 255, 0.2)
		default:
			return color
	}
}

function rgbaOf(value: Rgba | undefined): number {
	return value !== undefined && Number.isFinite(value) ? value >>> 0 : 0
}

const cssColors = new Map<number, string>()

// 0xRRGGBBAA as CSS (#rrggbbaa), memoised: colours repeat across items and slides.
export function canvasColor(color: Rgba): string {
	const value = rgbaOf(color)
	let css = cssColors.get(value)

	if (css === undefined) {
		css = `#${value.toString(16).padStart(8, "0")}`

		if (cssColors.size < 4096) cssColors.set(value, css)
	}

	return css
}

function stopCount(stops: GradientStops): number {
	return Math.min(stops.offsets.length, stops.colors.length, MAX_STOPS)
}

function averageColor(stops: GradientStops): number {
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

// Dash, gap lengths in multiples of the line width (ST_PresetLineDashVal).
function presetDashes(dash: string): readonly number[] | undefined {
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

function insetOf(inset: Inset | undefined, min: number, max: number): [number, number, number, number] {
	if (inset === undefined || inset === null) return [0, 0, 0, 0]

	return [
		clamp(inset.left, min, max, 0),
		clamp(inset.top, min, max, 0),
		clamp(inset.right, min, max, 0),
		clamp(inset.bottom, min, max, 0)
	]
}

function matrixAt(values: ArrayLike<number>, at: number = 0): Matrix {
	return [
		finite(values[at], 1),
		finite(values[at + 1], 0),
		finite(values[at + 2], 0),
		finite(values[at + 3], 1),
		clamp(values[at + 4], -MAX_COORD, MAX_COORD, 0),
		clamp(values[at + 5], -MAX_COORD, MAX_COORD, 0)
	]
}

// m1 then m2: the matrix that applies m2 inside m1's space (canvas transform() order).
function times(m1: Matrix, m2: Matrix): Matrix {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
	]
}

function invert(m: Matrix): Matrix | null {
	const det = m[0] * m[3] - m[1] * m[2]

	if (!(Math.abs(det) > 1e-12)) return null

	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

// Device pixels per unit of `m` (the square root of its area scale).
function scaleOf(m: Matrix): number {
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
}

// The box (x, y, width, height) seen through `m`'s inverse: min x, min y, max x, max y.
function boundsThrough(m: Matrix, x: number, y: number, width: number, height: number): [number, number, number, number] {
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

function genericFamily(font: string): string {
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

function verticalRotation(vertical: string): number {
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

function runPx(run: TextRun, scale: number): number {
	const px = clamp(run.size, 1, 1000, 11) * PX_PER_PT * scale

	return finite(run.baseline, 0) !== 0 ? (px * 2) / 3 : px
}

// Symbol-font bullets (Wingdings, Symbol) map their glyphs onto letters; a plain bullet reads better.
function symbolBullet(font: string): boolean {
	const name = typeof font === "string" ? font.toLowerCase() : ""

	return name.includes("wingdings") || name.includes("symbol") || name.includes("webdings")
}

function px3(value: number): string {
	return String(Math.round(clamp(value, -10_000, 10_000, 0) * 1000) / 1000)
}

// --- Preset patterns (ST_PresetPatternVal, §20.1.10.51) as 8x8 foreground masks ---

const BAYER = [
	0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11,
	43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21
]

function percent(value: number): (x: number, y: number) => boolean {
	const threshold = Math.round((value / 100) * 64)

	return (x, y) => (BAYER[y * 8 + x] ?? 64) < threshold
}

const SMALL_CONFETTI = [0x80, 0x10, 0x02, 0x40, 0x04, 0x20, 0x01, 0x08]
const LARGE_CONFETTI = [0xc1, 0x0c, 0x30, 0xc3, 0x18, 0x60, 0x86, 0x03]

function confetti(rows: readonly number[], x: number, y: number): boolean {
	return (((rows[y] ?? 0) >> (7 - x)) & 1) === 1
}

const PATTERN_RULES = new Map<string, (x: number, y: number) => boolean>([
	["pct5", percent(5)],
	["pct10", percent(10)],
	["pct20", percent(20)],
	["pct25", percent(25)],
	["pct30", percent(30)],
	["pct40", percent(40)],
	["pct50", percent(50)],
	["pct60", percent(60)],
	["pct70", percent(70)],
	["pct75", percent(75)],
	["pct80", percent(80)],
	["pct90", percent(90)],
	["ltHorz", (_x, y) => y === 0],
	["horz", (_x, y) => y % 4 === 0],
	["narHorz", (_x, y) => y % 2 === 0],
	["dkHorz", (_x, y) => y % 4 < 2],
	["ltVert", x => x === 0],
	["vert", x => x % 4 === 0],
	["narVert", x => x % 2 === 0],
	["dkVert", x => x % 4 < 2],
	["dashHorz", (x, y) => (y === 0 && x < 4) || (y === 4 && x >= 4)],
	["dashVert", (x, y) => (x === 0 && y < 4) || (x === 4 && y >= 4)],
	["ltDnDiag", (x, y) => mod(x - y, 8) === 0],
	["dnDiag", (x, y) => mod(x - y, 4) === 0],
	["dkDnDiag", (x, y) => mod(x - y, 4) < 2],
	["wdDnDiag", (x, y) => mod(x - y, 8) < 3],
	["dashDnDiag", (x, y) => mod(x - y, 4) === 0 && y % 4 < 2],
	["ltUpDiag", (x, y) => mod(x + y, 8) === 7],
	["upDiag", (x, y) => mod(x + y, 4) === 3],
	["dkUpDiag", (x, y) => mod(x + y, 4) >= 2],
	["wdUpDiag", (x, y) => mod(x + y, 8) >= 5],
	["dashUpDiag", (x, y) => mod(x + y, 4) === 3 && y % 4 < 2],
	["cross", (x, y) => x === 0 || y === 0],
	["lgGrid", (x, y) => x === 0 || y === 0],
	["smGrid", (x, y) => x % 4 === 0 || y % 4 === 0],
	["dotGrid", (x, y) => (y === 0 && x % 2 === 0) || (x === 0 && y % 2 === 0)],
	["diagCross", (x, y) => mod(x - y, 4) === 0 || mod(x + y, 4) === 3],
	["smCheck", (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0],
	["lgCheck", (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0],
	["horzBrick", (x, y) => y % 4 === 0 || (y < 4 ? x === 0 : x === 4)],
	["diagBrick", (x, y) => mod(x + y, 8) === 7 || (y > 3 && mod(x - y, 8) === 4)],
	["solidDmnd", (x, y) => Math.abs(x - 3.5) + Math.abs(y - 3.5) <= 3],
	["openDmnd", (x, y) => Math.abs(x - 3.5) + Math.abs(y - 3.5) === 3],
	["dotDmnd", (x, y) => (x + y) % 2 === 0 && Math.abs(x - 3.5) + Math.abs(y - 3.5) === 3],
	["zigZag", (x, y) => y % 4 === Math.abs((x % 4) - 2) || y % 4 === Math.abs((x % 4) - 2) + 1],
	["trellis", (x, y) => (y % 2 === 0 ? x % 4 !== 3 : x % 4 === 1)],
	["smConfetti", (x, y) => confetti(SMALL_CONFETTI, x, y)],
	["lgConfetti", (x, y) => confetti(LARGE_CONFETTI, x, y)]
])

// The share of the foreground a preset pattern covers (its pctN; about half for line and shape presets): what a
// pattern is drawn as where it is drawn in one colour.
function patternShare(pattern: string): number {
	const percent = /^pct(\d+)$/u.exec(pattern)

	return percent === null ? 0.5 : clamp(Number(percent[1]) / 100, 0, 1, 0.5)
}

const patternMasks = new Map<string, Uint8Array>()

// The 8x8 foreground mask of a preset pattern (1 = foreground, row-major), undefined for presets drawn as the blend of
// their colours (sphere, weave, plaid…).
export function patternMask(preset: string): Uint8Array | undefined {
	const cached = patternMasks.get(preset)

	if (cached !== undefined) return cached

	const rule = PATTERN_RULES.get(preset)

	if (rule === undefined) return undefined

	const mask = new Uint8Array(64)

	for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) mask[y * 8 + x] = rule(x, y) ? 1 : 0

	patternMasks.set(preset, mask)

	return mask
}

// --- Pictures recoloured (grayscale, brightness/contrast, bi-level, duotone, colour change) ---

function recolors(image: DrawingImage): boolean {
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
	const slope = (1 + contrast) / (1 - contrast)
	const intercept = 0.5 - 0.5 * slope + brightness
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
			const color = mix(dark, light, t)

			r = color >>> 24
			g = (color >>> 16) & 255
			b = (color >>> 8) & 255
		}

		pixels[at] = channel(r)
		pixels[at + 1] = channel(g)
		pixels[at + 2] = channel(b)
	}
}

// --- The drawing painter ---

interface BodyLine {
	readonly paragraph: TextParagraph
	readonly from: number
	readonly to: number
	readonly first: boolean
	readonly size: number
	readonly height: number
	before: number
	after: number
}

type Box = readonly [number, number, number, number]

class CanvasDrawingPainter<I extends CanvasSized> {
	private runsLeft = MAX_RUNS
	private readonly chains = new Map<number, readonly number[] | undefined>()
	private readonly patterns = new Map<number, CanvasPatternLike | null>()
	private readonly recolored = new Map<DrawingImage, I | null>()
	private readonly ctx: Canvas2DLike<I>
	private readonly data: DrawingData
	private readonly context: CanvasPaintContext<I>
	// Drawing space → device.
	private readonly base: Matrix
	// The item being drawn: its local space → device.
	private local: Matrix = IDENTITY_MATRIX

	constructor(ctx: Canvas2DLike<I>, data: DrawingData, base: Matrix, context: CanvasPaintContext<I>) {
		this.ctx = ctx
		this.data = data
		this.base = base
		this.context = context
	}

	private place(m: Matrix): void {
		this.ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
	}

	paint(): void {
		const { ctx, data } = this
		const width = clamp(data.width, 0, MAX_COORD, 0)
		const height = clamp(data.height, 0, MAX_COORD, 0)

		ctx.save()

		try {
			this.place(this.base)

			if (typeof data.background === "number" && width > 0 && height > 0) {
				ctx.fillStyle = canvasColor(data.background)
				ctx.fillRect(0, 0, width, height)
			}

			const count = Math.min(
				index(data.itemCount) < 0 ? 0 : data.itemCount,
				MAX_ITEMS,
				Math.floor(data.itemFloats.length / ITEM_FLOATS),
				Math.floor(data.itemInts.length / ITEM_INTS)
			)
			const itemClips = data.itemClips instanceof Int32Array ? data.itemClips : null

			for (let item = 0; item < count; item++) {
				const flags = data.itemInts[item * ITEM_INTS + ItemInt.FLAGS] ?? 0

				if ((flags & ItemFlag.HIDDEN) !== 0) continue

				const chain = this.clipChain(itemClips === null ? -1 : index(itemClips[item]))

				// A malformed clip hides the item rather than showing what it would have clipped away.
				if (chain === undefined) continue

				this.item(item, flags, chain)
			}
		} finally {
			ctx.restore()
		}
	}

	// --- Clips ---

	private clips(): readonly DrawingClip[] {
		return Array.isArray(this.data.clips) ? this.data.clips : []
	}

	// A clip and its parents, outermost first; [] for none, undefined when malformed.
	private clipChain(clipIndex: number): readonly number[] | undefined {
		if (clipIndex < 0) return []

		if (this.chains.has(clipIndex)) return this.chains.get(clipIndex)

		const clips = this.clips()
		const chain: number[] = []
		let result: readonly number[] | undefined

		for (let at = clipIndex; at >= 0 && chain.length <= MAX_CLIP_CHAIN;) {
			const clip = clips[at]

			if (clip === undefined || clip === null) break

			chain.push(at)

			const parent = index(clip.parent)

			if (parent < 0) {
				result = chain.reverse()
				break
			}

			// Parents precede their children; anything else is malformed.
			if (parent >= at) break

			at = parent
		}

		this.chains.set(clipIndex, result)

		return result
	}

	// Appends path commands, each shape placed by its own matrix in drawing space; false when nothing was added.
	private appendRange(m: Matrix, first: number, count: number, firstCoord: number): boolean {
		const { ctx } = this
		const commands = this.data.commands
		const coords = this.data.coords
		let at = firstCoord

		if (first < 0 || count <= 0 || at < 0) return false

		this.place(m)

		const end = Math.min(commands.length, first + count)
		let any = false

		for (let k = first; k < end; k++) {
			const command = commands[k] ?? -1
			const needed = PATH_COMMAND_COORDS[command] ?? -1

			if (needed < 0 || at + needed > coords.length) break

			const c0 = clamp(coords[at], -MAX_COORD, MAX_COORD, 0)
			const c1 = clamp(coords[at + 1], -MAX_COORD, MAX_COORD, 0)

			switch (command) {
				case PathCommand.MOVE:
					ctx.moveTo(c0, c1)
					break
				case PathCommand.LINE:
					ctx.lineTo(c0, c1)
					break
				case PathCommand.CUBIC:
					ctx.bezierCurveTo(
						c0,
						c1,
						clamp(coords[at + 2], -MAX_COORD, MAX_COORD, 0),
						clamp(coords[at + 3], -MAX_COORD, MAX_COORD, 0),
						clamp(coords[at + 4], -MAX_COORD, MAX_COORD, 0),
						clamp(coords[at + 5], -MAX_COORD, MAX_COORD, 0)
					)
					break
				case PathCommand.QUAD:
					ctx.quadraticCurveTo(
						c0,
						c1,
						clamp(coords[at + 2], -MAX_COORD, MAX_COORD, 0),
						clamp(coords[at + 3], -MAX_COORD, MAX_COORD, 0)
					)
					break
				default:
					ctx.closePath()
					break
			}

			any = true
			at += needed
		}

		return any
	}

	private clipShapes(clip: DrawingClip): boolean {
		let any = false
		const shapes = [clip, ...(Array.isArray(clip.shapes) ? clip.shapes.slice(0, MAX_CLIP_SHAPES) : [])]

		for (const shape of shapes) {
			if (shape === undefined || shape === null) continue

			const m = times(this.base, matrixAt(Array.isArray(shape.matrix) ? shape.matrix : []))

			if (this.appendRange(m, index(shape.firstCommand), index(shape.commandCount), index(shape.firstCoord))) any = true
		}

		return any
	}

	// A rectangle far beyond the drawing (the plane a subtracted region is cut from), in drawing space.
	private plane(): Box {
		const size = Math.max(clamp(this.data.width, 0, MAX_COORD, 0), clamp(this.data.height, 0, MAX_COORD, 0), 1) * 64

		return [-size, -size, size * 2, size * 2]
	}

	// Intersects the canvas clip with one clip level; its group opacity (applied to each item, as the PDF painter does).
	private applyClip(clipIndex: number): number {
		const { ctx } = this
		const clips = this.clips()
		const clip = clips[clipIndex]

		if (clip === undefined || clip === null) return 1

		ctx.beginPath()

		if (Array.isArray(clip.add)) {
			// A boolean region: the union of the added clips' areas, then each subtracted area cut out of the plane.
			let any = false

			for (const member of clip.add.slice(0, MAX_CLIP_SHAPES)) {
				const other = typeof member === "number" && member < clipIndex ? clips[member] : undefined

				if (other !== undefined && other !== null && !Array.isArray(other.add) && this.clipShapes(other)) any = true
			}

			this.place(this.base)

			if (!any) ctx.rect(0, 0, 0, 0)

			ctx.clip("nonzero")

			for (const member of Array.isArray(clip.subtract) ? clip.subtract.slice(0, MAX_CLIP_SHAPES) : []) {
				const other = typeof member === "number" && member < clipIndex ? clips[member] : undefined

				if (other === undefined || other === null || Array.isArray(other.add)) continue

				const [x, y, width, height] = this.plane()

				ctx.beginPath()
				this.place(this.base)
				ctx.rect(x, y, width, height)
				this.clipShapes(other)
				this.place(this.base)
				ctx.clip("evenodd")
			}
		} else {
			const any = this.clipShapes(clip)

			this.place(this.base)

			// A clip without commands hides everything it clips.
			if (!any) ctx.rect(0, 0, 0, 0)

			ctx.clip(clip.evenOdd === true && (clip.shapes?.length ?? 0) === 0 ? "evenodd" : "nonzero")
		}

		return clamp(clip.opacity ?? 1, 0, 1, 1)
	}

	// --- Items ---

	private item(item: number, flags: number, chain: readonly number[]): void {
		const { ctx, data } = this
		const i = item * ITEM_INTS
		const f = item * ITEM_FLOATS

		ctx.save()

		try {
			let opacity = 1

			for (const clip of chain) opacity *= this.applyClip(clip)

			if (opacity <= 0) return

			ctx.globalAlpha = opacity

			switch (flags & ItemFlag.BLEND_MASK) {
				case ItemFlag.BLEND_MULTIPLY:
					ctx.globalCompositeOperation = "multiply"
					break
				case ItemFlag.BLEND_LIGHTEN:
					ctx.globalCompositeOperation = "lighten"
					break
				case ItemFlag.BLEND_DIFFERENCE:
					ctx.globalCompositeOperation = "difference"
					break
				default:
					break
			}

			this.shadow(index(data.itemInts[i + ItemInt.SHADOW]))
			this.local = times(this.base, matrixAt(data.itemFloats, f))

			switch (data.itemInts[i + ItemInt.KIND]) {
				case ItemKind.PATH:
					this.pathItem(i, f, flags)
					break
				case ItemKind.IMAGE:
					this.imageItem(i, f)
					break
				case ItemKind.TEXT:
					this.textItem(i, f)
					break
				default:
					break
			}
		} finally {
			ctx.restore()
		}
	}

	// a:outerShdw as the context's shadow, offset and blurred in drawing space (the canvas takes device pixels).
	private shadow(shadowIndex: number): void {
		const shadow: Shadow | undefined = shadowIndex < 0 ? undefined : this.data.shadows[shadowIndex]

		if (shadow === undefined || shadow === null) return

		const color = rgbaOf(shadow.color)
		const { dx, dy, blur } = shadow

		if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(blur)) return
		if (Math.abs(dx) > 4096 || Math.abs(dy) > 4096 || blur < 0 || blur > 1024 || (color & 255) === 0) return

		const m = this.base

		this.ctx.shadowColor = canvasColor(color)
		this.ctx.shadowOffsetX = m[0] * dx + m[2] * dy
		this.ctx.shadowOffsetY = m[1] * dx + m[3] * dy
		// SVG's stdDeviation is blur / 2; a canvas shadow's σ is shadowBlur / 2.
		this.ctx.shadowBlur = blur * scaleOf(m)
	}

	private box(f: number): Box {
		const m = this.data.itemFloats

		return [
			clamp(m[f + ItemFloat.X], -MAX_COORD, MAX_COORD, 0),
			clamp(m[f + ItemFloat.Y], -MAX_COORD, MAX_COORD, 0),
			clamp(m[f + ItemFloat.WIDTH], 0, MAX_COORD, 0),
			clamp(m[f + ItemFloat.HEIGHT], 0, MAX_COORD, 0)
		]
	}

	// Starts a path of the item's own commands (in its local space); false when it has none.
	private path(i: number): boolean {
		const ints = this.data.itemInts

		this.ctx.beginPath()

		return this.appendRange(
			this.local,
			index(ints[i + ItemInt.FIRST_COMMAND]),
			index(ints[i + ItemInt.COMMAND_COUNT]),
			index(ints[i + ItemInt.FIRST_COORD])
		)
	}

	private pathItem(i: number, f: number, flags: number): void {
		const { ctx, data } = this
		const ints = data.itemInts
		const rule = (flags & ItemFlag.EVEN_ODD) !== 0 ? "evenodd" : "nonzero"
		const box = this.box(f)
		const fill = index(ints[i + ItemInt.FILL])
		const paint = fill < 0 ? undefined : data.paints[fill]

		if (!this.path(i)) return

		if (paint !== undefined && paint !== null) {
			const style = this.styleOf(fill, paint, box, flags & ITEM_FILL_MODIFIER_MASK)

			if (style !== undefined) {
				if (style !== null) {
					ctx.fillStyle = style
					ctx.fill(rule)
				}
			} else {
				// An area paint (stretched radial, picture, shaded mesh, metafile gradient): drawn inside the path.
				ctx.save()
				ctx.clip(rule)
				this.paintArea(paint, box)
				ctx.restore()
				this.path(i)
			}
		}

		const stroke = index(ints[i + ItemInt.STROKE])
		const line: Stroke | undefined = stroke < 0 ? undefined : data.strokes[stroke]

		if (line !== undefined && line !== null) this.strokePath(line, box)
	}

	// A paint as a fill or stroke style in the item's local space: a colour, a gradient or a pattern; null for one
	// that draws nothing; undefined for an area paint drawn by paintArea.
	private styleOf(paintIndex: number, paint: Paint, box: Box, modifier: number): unknown {
		const { ctx } = this
		const [x, y, width, height] = box
		const flat = !(width > 0 && height > 0)

		switch (paint.kind) {
			case "solid": {
				const color = modify(rgbaOf(paint.color), modifier)

				return (color & 255) === 0 ? null : canvasColor(color)
			}
			case "linear": {
				if (flat || stopCount(paint.stops) === 0) return canvasColor(averageColor(paint.stops))

				const angle = mod(finite(paint.angle, 0), 360)
				const radians = (angle * Math.PI) / 180
				let dx = Math.cos(radians)
				let dy = Math.sin(radians)

				// An unscaled angle stays true in the box (the SVG painter's objectBoundingBox gradient).
				if (paint.scaled !== true && angle % 90 !== 0) {
					dx *= width
					dy *= height

					const length = Math.hypot(dx, dy)

					dx = length > 0 ? dx / length : 1
					dy = length > 0 ? dy / length : 0
				}

				const half = (Math.abs(dx) + Math.abs(dy)) / 2
				const gradient = ctx.createLinearGradient(
					x + (0.5 - dx * half) * width,
					y + (0.5 - dy * half) * height,
					x + (0.5 + dx * half) * width,
					y + (0.5 + dy * half) * height
				)

				this.stops(gradient, paint.stops, 0, 1, 0)

				return gradient
			}
			case "path":
				return flat || stopCount(paint.stops) === 0 ? canvasColor(averageColor(paint.stops)) : undefined
			case "pattern": {
				const foreground = rgbaOf(paint.foreground)
				const background = rgbaOf(paint.background)

				if (flat) return canvasColor(mix(foreground, background, 0.5))

				const pattern = this.pattern(paintIndex, paint.pattern, foreground, background)

				return pattern ?? canvasColor(mix(foreground, background, 0.5))
			}
			case "gradient":
				return stopCount(paint.stops) === 0 ? null : undefined
			case "image":
				return flat ? null : undefined
			case "shaded":
				return this.context.surface === undefined ? canvasColor(averageShade(paint.colors)) : undefined
		}
	}

	private stops(gradient: CanvasGradientLike, stops: GradientStops, inner: number, periods: number, reflect: number): void {
		const count = stopCount(stops)
		const offsets: number[] = []
		let previous = 0

		for (let k = 0; k < count; k++) {
			previous = Math.max(previous, clamp(stops.offsets[k], 0, 1, 0))
			offsets.push(previous)
		}

		for (let period = 0; period < periods; period++) {
			const mirrored = reflect !== 0 && period % 2 === 1

			for (let k = 0; k < count; k++) {
				const at = mirrored ? count - 1 - k : k
				const offset = mirrored ? 1 - (offsets[at] ?? 0) : (offsets[at] ?? 0)

				gradient.addColorStop(
					clamp((period + inner + offset * (1 - inner)) / periods, 0, 1, 0),
					canvasColor(rgbaOf(stops.colors[at]))
				)
			}
		}
	}

	// Paints the clipped area with a paint whose space is not the item's local space (or that is not a style).
	private paintArea(paint: Paint, box: Box): void {
		const { ctx } = this
		const [x, y, width, height] = box

		switch (paint.kind) {
			case "path": {
				const { cx, cy, radius, inner } = pathGradientCircle(paint)

				// The SVG painter's objectBoundingBox radial: a circle in the unit box, stretched with the box.
				this.place(times(this.local, [width, 0, 0, height, x, y]))

				const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)

				this.stops(gradient, paint.stops, inner, 1, 0)
				ctx.fillStyle = gradient
				ctx.fillRect(-16, -16, 33, 33)
				break
			}
			case "gradient": {
				const m = matrixAt(Array.isArray(paint.matrix) ? paint.matrix : [])
				const [minX, minY, maxX, maxY] = boundsThrough(m, x, y, Math.max(width, 1), Math.max(height, 1))
				const spread = paint.spread === "reflect" ? 1 : paint.spread === "repeat" ? 2 : 0

				this.place(times(this.local, m))

				if (paint.type === "linear") {
					const from = spread === 0 ? 0 : Math.max(Math.floor(minX), -MAX_PERIODS / 2)
					const to = spread === 0 ? 1 : Math.min(Math.max(Math.ceil(maxX), from + 1), from + MAX_PERIODS)
					const gradient = ctx.createLinearGradient(from, 0, to, 0)

					// A reflected gradient starts mirrored on odd periods counted from the origin.
					this.stops(gradient, paint.stops, 0, to - from, spread === 1 ? (mod(from, 2) === 0 ? 1 : -1) : 0)
					ctx.fillStyle = gradient
				} else {
					const focus = Array.isArray(paint.focus) ? paint.focus : [0, 0]
					const reach = Math.max(Math.hypot(minX, minY), Math.hypot(maxX, minY), Math.hypot(minX, maxY), Math.hypot(maxX, maxY))
					const periods = spread === 0 ? 1 : Math.min(MAX_PERIODS, Math.max(1, Math.ceil(reach)))
					const gradient = ctx.createRadialGradient(
						clamp(focus[0], -1, 1, 0) * periods,
						clamp(focus[1], -1, 1, 0) * periods,
						0,
						0,
						0,
						periods
					)

					this.stops(gradient, paint.stops, 0, periods, spread === 1 ? 1 : 0)
					ctx.fillStyle = gradient
				}

				ctx.fillRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2)
				break
			}
			case "image": {
				const image = this.data.images[index(paint.image)]

				if (image === undefined || image === null) break

				const tile: ImageTile | undefined = paint.tile ?? undefined

				if (tile !== undefined && tile.width !== undefined) {
					this.tile(image, tile)
					break
				}

				// Stretched over the box minus a:fillRect (an implicit tile is approximated the same way).
				const [left, top, right, bottom] = insetOf(paint.stretch, -10, 1)

				this.place(this.local)
				this.picture(image, x + left * width, y + top * height, width * (1 - left - right), height * (1 - top - bottom))
				break
			}
			case "shaded": {
				const raster =
					paint.points instanceof Float32Array && paint.colors instanceof Uint32Array
						? shadeRaster(paint.points, paint.colors, paint.ramp, scaleOf(this.local), MAX_SURFACE_PIXELS / 4)
						: undefined
				const surface = raster === undefined ? undefined : this.context.surface?.(raster.width, raster.height)

				if (raster === undefined || surface === undefined) {
					this.place(this.local)
					ctx.fillStyle = canvasColor(paint.colors instanceof Uint32Array ? averageShade(paint.colors) : 0)
					ctx.fillRect(x, y, width, height)
					break
				}

				const pixels = surface.context.createImageData(raster.width, raster.height)

				pixels.data.set(raster.rgba)
				surface.context.putImageData(pixels, 0, 0)
				this.place(this.local)
				ctx.drawImage(surface.canvas, raster.bounds[0], raster.bounds[1], raster.bounds[2], raster.bounds[3])
				break
			}
			default:
				break
		}
	}

	// An explicit image tile: placed by its matrix, mirrored per flip, repeated over the area unless clamped.
	private tile(image: DrawingImage, tile: ImageTile): void {
		const { ctx } = this
		const width = clamp(tile.width, 0, MAX_COORD, 0)
		const height = clamp(tile.height, 0, MAX_COORD, 0)
		const m = times(this.local, matrixAt(Array.isArray(tile.matrix) ? tile.matrix : []))

		if (!(width > 0 && height > 0)) return

		if (tile.clamp === true) {
			this.place(m)
			this.picture(image, 0, 0, width, height)

			return
		}

		const flipX = tile.flip === "x" || tile.flip === "xy"
		const flipY = tile.flip === "y" || tile.flip === "xy"
		const cellWidth = width * (flipX ? 2 : 1)
		const cellHeight = height * (flipY ? 2 : 1)
		// The cell rendered at the resolution it is drawn at, within the scratch budget.
		const scale = Math.min(
			scaleOf(m),
			MAX_SURFACE_SIDE / cellWidth,
			MAX_SURFACE_SIDE / cellHeight,
			Math.sqrt(MAX_SURFACE_PIXELS / (cellWidth * cellHeight))
		)
		const pixelsWide = Math.max(1, Math.round(cellWidth * scale))
		const pixelsHigh = Math.max(1, Math.round(cellHeight * scale))
		const surface = this.context.surface?.(pixelsWide, pixelsHigh)
		const decoded = this.source(image)

		if (surface === undefined || decoded === undefined) return

		const sx = pixelsWide / cellWidth
		const sy = pixelsHigh / cellHeight
		const copies: readonly (readonly [number, number])[] = [
			[1, 1],
			...(flipX ? ([[-1, 1]] as const) : []),
			...(flipY ? ([[1, -1]] as const) : []),
			...(flipX && flipY ? ([[-1, -1]] as const) : [])
		]

		for (const [fx, fy] of copies) {
			surface.context.setTransform(fx * sx, 0, 0, fy * sy, fx < 0 ? width * 2 * sx : 0, fy < 0 ? height * 2 * sy : 0)
			this.pictureOn(surface.context, decoded, image, 0, 0, width, height)
		}

		const pattern = ctx.createPattern(surface.canvas, "repeat")

		if (pattern === null) return

		// The pattern's pixels back to tile units, then the tile's placement (the area is filled in device space).
		pattern.setTransform?.({ a: m[0] / sx, b: m[1] / sx, c: m[2] / sy, d: m[3] / sy, e: m[4], f: m[5] })
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.fillStyle = pattern
		ctx.fillRect(-MAX_SURFACE_SIDE * 64, -MAX_SURFACE_SIDE * 64, MAX_SURFACE_SIDE * 128, MAX_SURFACE_SIDE * 128)
	}

	// An 8x8 preset pattern tile (its pixels in the item's local units, as the SVG painter's userSpaceOnUse pattern).
	private pattern(paintIndex: number, preset: string, foreground: number, background: number): CanvasPatternLike | undefined {
		if (this.patterns.has(paintIndex)) return this.patterns.get(paintIndex) ?? undefined

		const mask = typeof preset === "string" ? patternMask(preset) : undefined
		const surface = mask === undefined ? undefined : this.context.surface?.(8, 8)
		let pattern: CanvasPatternLike | null = null

		if (mask !== undefined && surface !== undefined) {
			const pixels = surface.context.createImageData(8, 8)

			for (let k = 0; k < 64; k++) {
				const color = mask[k] === 1 ? foreground : background

				pixels.data[k * 4] = color >>> 24
				pixels.data[k * 4 + 1] = (color >>> 16) & 255
				pixels.data[k * 4 + 2] = (color >>> 8) & 255
				pixels.data[k * 4 + 3] = color & 255
			}

			surface.context.putImageData(pixels, 0, 0)
			pattern = this.ctx.createPattern(surface.canvas, "repeat")
		}

		this.patterns.set(paintIndex, pattern)

		return pattern ?? undefined
	}

	private strokePath(stroke: Stroke, box: Box): void {
		const { ctx } = this
		const paint = this.data.paints[index(stroke.paint)]

		if (paint === undefined || paint === null) return

		let style = this.styleOf(index(stroke.paint), paint, box, 0)

		// Area paints outline in their mean colour.
		if (style === undefined) {
			style =
				paint.kind === "path" || paint.kind === "gradient"
					? canvasColor(averageColor(paint.stops))
					: paint.kind === "shaded"
						? canvasColor(averageShade(paint.colors))
						: canvasColor(0x000000ff)
		}

		if (style === null) return

		const width = clamp(stroke.width, 0, 10_000, 1) || 1

		this.place(this.local)
		ctx.strokeStyle = style
		ctx.lineWidth = width
		ctx.lineCap = stroke.cap === "round" ? "round" : stroke.cap === "square" ? "square" : "butt"
		ctx.lineJoin = stroke.join === "round" ? "round" : stroke.join === "bevel" ? "bevel" : "miter"
		ctx.miterLimit = clamp(stroke.miterLimit, 1, 100, 8)

		const custom = stroke.customDash
		const dashes = custom !== null && custom !== undefined && custom.length > 0 ? Array.from(custom) : presetDashes(stroke.dash)

		if (dashes !== undefined && dashes.some(length => length > 0)) {
			ctx.setLineDash(dashes.slice(0, MAX_DASHES).map(length => clamp(length, 0, 1000, 0) * width))
		}

		ctx.stroke()
	}

	// --- Pictures ---

	// The decoded picture to draw for an image, recoloured once per painting when its effects ask for it.
	private source(image: DrawingImage): I | undefined {
		const decoded = this.context.image(image)

		if (decoded === undefined || !recolors(image)) return decoded

		const known = this.recolored.get(image)

		if (known !== undefined) return known ?? decoded

		const scale = Math.min(
			1,
			MAX_SURFACE_SIDE / Math.max(decoded.width, 1),
			Math.sqrt(MAX_SURFACE_PIXELS / Math.max(decoded.width * decoded.height, 1))
		)
		const width = Math.max(1, Math.floor(decoded.width * scale))
		const height = Math.max(1, Math.floor(decoded.height * scale))
		const surface = this.context.surface?.(width, height)

		if (surface === undefined) {
			this.recolored.set(image, null)

			return decoded
		}

		surface.context.drawImage(decoded, 0, 0, width, height)

		// In bands, so the pixels held at once stay bounded.
		for (let top = 0; top < height; top += RECOLOR_BAND) {
			const rows = Math.min(RECOLOR_BAND, height - top)
			const band = surface.context.getImageData(0, top, width, rows)

			recolorPixels(band.data, image)
			surface.context.putImageData(band, 0, top)
		}

		this.recolored.set(image, surface.canvas)

		return surface.canvas
	}

	// Draws `image` into (x, y, width, height) of the current space with its crop and opacity.
	private picture(image: DrawingImage, x: number, y: number, width: number, height: number): void {
		const decoded = this.source(image)

		if (decoded === undefined) {
			this.placeholder(x, y, width, height)

			return
		}

		this.pictureOn(this.ctx, decoded, image, x, y, width, height)
	}

	private pictureOn(ctx: Canvas2DLike<I>, decoded: I, image: DrawingImage, x: number, y: number, width: number, height: number): void {
		if (!(width > 0 && height > 0)) return

		const [left, top, right, bottom] = insetOf(image.crop, -10, 1)
		const cropWidth = 1 - left - right
		const cropHeight = 1 - top - bottom

		if (!(cropWidth > 0.0001 && cropHeight > 0.0001)) return

		const alpha = clamp(image.alpha, 0, 1, 1)
		const natural = [Math.max(decoded.width, 1), Math.max(decoded.height, 1)] as const

		ctx.save()
		ctx.globalAlpha *= alpha

		if (left === 0 && top === 0 && right === 0 && bottom === 0) {
			ctx.drawImage(decoded, x, y, width, height)
		} else if (left >= 0 && top >= 0 && right >= 0 && bottom >= 0) {
			// A plain crop: only the source rectangle is drawn.
			ctx.drawImage(
				decoded,
				left * natural[0],
				top * natural[1],
				cropWidth * natural[0],
				cropHeight * natural[1],
				x,
				y,
				width,
				height
			)
		} else {
			// A negative inset pads: the whole picture placed so its crop fills the box, clipped to it.
			const fullWidth = width / cropWidth
			const fullHeight = height / cropHeight

			ctx.beginPath()
			ctx.rect(x, y, width, height)
			ctx.clip()
			ctx.drawImage(decoded, x - left * fullWidth, y - top * fullHeight, fullWidth, fullHeight)
		}

		ctx.restore()
	}

	private placeholder(x: number, y: number, width: number, height: number): void {
		const { ctx } = this

		if (!(width > 0 && height > 0)) return

		ctx.fillStyle = PLACEHOLDER_FILL
		ctx.fillRect(x, y, width, height)
		ctx.strokeStyle = PLACEHOLDER_STROKE
		// One device pixel, as the SVG painter's non-scaling stroke.
		ctx.lineWidth = 1 / Math.max(scaleOf(this.local), 1e-6)
		ctx.beginPath()
		ctx.rect(x, y, width, height)
		ctx.stroke()
	}

	private imageItem(i: number, f: number): void {
		const [x, y, width, height] = this.box(f)

		if (!(width > 0 && height > 0)) return

		const image = this.data.images[index(this.data.itemInts[i + ItemInt.REF])]
		const ints = this.data.itemInts

		if (index(ints[i + ItemInt.COMMAND_COUNT]) > 0 && this.path(i)) this.ctx.clip()

		this.place(this.local)

		if (image === undefined || image === null) this.placeholder(x, y, width, height)
		else this.picture(image, x, y, width, height)
	}

	// --- Text ---

	private family(textIndex: number, font: string): string {
		const resolved = Array.isArray(this.data.textFonts) ? this.data.textFonts[textIndex] : undefined

		return typeof resolved === "string" && FONT_FAMILY.test(resolved) ? resolved : genericFamily(font)
	}

	private runFont(run: TextRun, size: number, family: string): string {
		return `${run.italic === true ? "italic " : ""}${run.bold === true ? 700 : 400} ${px3(size)}px ${family}`
	}

	// A text's paint instead of its colour (in the item's local box), or the run's colour.
	private textStyle(run: TextRun, fill: number | undefined, f: number): unknown {
		const paintIndex = index(fill)
		const paint = paintIndex < 0 ? undefined : this.data.paints[paintIndex]

		if (paint !== undefined && paint !== null) {
			const style = this.styleOf(paintIndex, paint, this.box(f), 0)

			if (style !== undefined) return style

			return canvasColor(
				paint.kind === "path" || paint.kind === "gradient"
					? averageColor(paint.stops)
					: paint.kind === "shaded"
						? averageShade(paint.colors)
						: 0
			)
		}

		const color = rgbaOf(run.color)

		return (color & 255) === 0 ? null : canvasColor(color)
	}

	// Draws `text` with the pen at (x, y) on the baseline in the current font; underline and strike as bars.
	private show(text: string, run: TextRun, x: number, y: number, size: number, style: unknown): number {
		const { ctx } = this
		const letter = clamp(run.spacing, -100, 100, 0) * PX_PER_PT
		const width = ctx.measureText(text).width + (ctx.letterSpacing === undefined ? 0 : letter * text.length)

		if (style === null) return width

		ctx.fillStyle = style
		ctx.fillText(text, x, y)

		const thickness = Math.max(0.5, size / 14)

		if (typeof run.underline === "string" && run.underline !== "none") {
			ctx.fillRect(x, y + size * 0.12, width, thickness)

			if (run.underline === "dbl") ctx.fillRect(x, y + size * 0.12 + thickness * 2, width, thickness)
		}

		if (run.strike === "sngStrike" || run.strike === "dblStrike") {
			ctx.fillRect(x, y - size * 0.3, width, thickness)

			if (run.strike === "dblStrike") ctx.fillRect(x, y - size * 0.3 - thickness * 2, width, thickness)
		}

		return width
	}

	private runState(run: TextRun, size: number, family: string): void {
		const { ctx } = this

		ctx.font = this.runFont(run, size, family)
		ctx.textBaseline = "alphabetic"

		if (ctx.letterSpacing !== undefined) ctx.letterSpacing = `${px3(clamp(run.spacing, -100, 100, 0) * PX_PER_PT)}px`
		if (ctx.fontVariantCaps !== undefined) ctx.fontVariantCaps = run.caps === "small" ? "small-caps" : "normal"
	}

	private textItem(i: number, f: number): void {
		const textIndex = index(this.data.itemInts[i + ItemInt.REF])
		const text: DrawingText | undefined = this.data.texts[textIndex]

		if (text === undefined || text === null) return

		this.place(this.local)

		switch (text.kind) {
			case "glyphs":
				this.glyphItem(text, textIndex, f)
				return
			case "block":
				this.blockItem(text, textIndex, f)
				return
			case "body":
				this.bodyItem(text, f)
				return
			default:
				// A story is a text box the host lays out and paints itself.
				return
		}
	}

	private glyphItem(text: Extract<DrawingText, { kind: "glyphs" }>, textIndex: number, f: number): void {
		const { ctx } = this
		const run = text.run

		if (typeof run !== "object" || run === null || typeof run.text !== "string" || run.text === "" || this.runsLeft <= 0) return

		this.runsLeft--

		const size = runPx(run, 1)
		const style = this.textStyle(run, text.fill, f)
		const positions = text.positions instanceof Float32Array ? text.positions : null
		const align = text.anchor === "middle" ? "center" : text.anchor === "end" ? "right" : "left"

		this.runState(run, size, this.family(textIndex, run.font))
		ctx.textAlign = align

		if (positions !== null && positions.length > 0) {
			// Each character at its own position, the anchor applied to each.
			const characters = Array.from(run.text.slice(0, MAX_GLYPHS * 2)).slice(0, Math.min(positions.length, MAX_GLYPHS))

			for (let k = 0; k < characters.length; k++)
				this.show(characters[k] ?? "", run, clamp(positions[k], -MAX_COORD, MAX_COORD, 0), 0, size, style)

			return
		}

		const characters = run.text.slice(0, MAX_GLYPHS)

		ctx.textAlign = "left"

		const width = ctx.measureText(characters).width

		this.show(characters, run, text.anchor === "middle" ? -width / 2 : text.anchor === "end" ? -width : 0, 0, size, style)
	}

	private blockItem(text: Extract<DrawingText, { kind: "block" }>, textIndex: number, f: number): void {
		const { ctx } = this
		const run = text.run

		if (typeof run !== "object" || run === null || typeof run.text !== "string" || run.text === "" || this.runsLeft <= 0) return

		this.runsLeft--

		const size = runPx(run, 1)

		this.runState(run, size, this.family(textIndex, run.font))
		ctx.textAlign = "left"
		ctx.direction = text.rtl === true ? "rtl" : "ltr"

		const width = clamp(text.width, 0, MAX_COORD, 0)
		const height = clamp(text.height, 0, MAX_COORD, 0)
		const lineHeight = clamp(text.lineHeight, 0.01, MAX_COORD, size * 1.2)
		const trimming = typeof text.trimming === "string" ? text.trimming : "none"
		const lines = layoutBlock(
			run.text.slice(0, MAX_GLYPHS),
			width,
			height,
			lineHeight,
			text.wrap === true,
			text.lineLimit === true,
			trimming,
			value => ctx.measureText(value).width
		)

		if (lines.length === 0) return

		const total = lines.length * lineHeight
		const top =
			height <= 0
				? text.lineAlign === "middle"
					? -total / 2
					: text.lineAlign === "end"
						? -total
						: 0
				: text.lineAlign === "middle"
					? (height - total) / 2
					: text.lineAlign === "end"
						? height - total
						: 0
		const ascent = clamp(text.ascent, 0, 3, 0.9) * size
		const style = this.textStyle(run, text.fill, f)

		if (text.clip === true && width > 0 && height > 0) {
			ctx.beginPath()
			ctx.rect(0, 0, width, height)
			ctx.clip()
		}

		for (let k = 0; k < lines.length; k++) {
			const line = lines[k] ?? ""

			if (line === "") continue

			const lineWidth = ctx.measureText(line).width
			const x = text.align === "middle" ? width / 2 - lineWidth / 2 : text.align === "end" ? width - lineWidth : 0

			this.show(line, run, x, top + k * lineHeight + ascent, size, style)
		}
	}

	private bodyLines(paragraphs: readonly TextParagraph[], scale: number, reduction: number): BodyLine[] {
		const lines: BodyLine[] = []

		for (let p = 0; p < paragraphs.length && this.runsLeft > 0; p++) {
			const paragraph = paragraphs[p]

			if (paragraph === undefined || paragraph === null || !Array.isArray(paragraph.runs)) continue

			const runs = paragraph.runs
			const count = Math.min(runs.length, this.runsLeft)
			const spacing = finite(paragraph.lineSpacing, 0)
			const before = p === 0 ? 0 : clamp(paragraph.spaceBefore, 0, 1000, 0) * PX_PER_PT
			const after = clamp(paragraph.spaceAfter, 0, 1000, 0) * PX_PER_PT
			const firstLine = lines.length
			let from = 0

			this.runsLeft -= count

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

	// Rich text laid out as the SVG painter lays it out: a line per paragraph or line break, no wrapping, anchored in
	// the box (rotated with the body and its vertical direction).
	private bodyItem(text: Extract<DrawingText, { kind: "body" }>, f: number): void {
		const body = text.body

		if (typeof body !== "object" || body === null || !Array.isArray(text.paragraphs)) return

		const [x, y, width, height] = this.box(f)
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
		const lines = this.bodyLines(text.paragraphs, scale, reduction)

		if (lines.length === 0) return

		let total = 0

		for (const line of lines) total += line.before + line.height + line.after

		let cursor = body.anchor === "ctr" ? top + (bottom - top - total) / 2 : body.anchor === "b" ? bottom - total : top

		if (rotation !== 0) {
			const radians = (rotation * Math.PI) / 180
			const cos = Math.cos(radians)
			const sin = Math.sin(radians)

			this.place(times(this.local, [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]))
		}

		this.ctx.textAlign = "left"

		for (const line of lines) {
			cursor += line.before
			this.bodyLine(line, left, right, cursor + (line.height - line.size * 1.2) / 2 + line.size * 0.95, scale)
			cursor += line.height + line.after
		}
	}

	private bodyLine(line: BodyLine, left: number, right: number, baseline: number, scale: number): void {
		const { ctx } = this
		const paragraph = line.paragraph
		const runs = paragraph.runs
		const marginLeft = clamp(paragraph.marginLeft, -10_000, 10_000, 0) + (line.first ? clamp(paragraph.indent, -10_000, 10_000, 0) : 0)
		const pieces: { readonly text: string; readonly run: TextRun; readonly size: number; readonly width: number }[] = []
		const firstRun = runs[line.from]
		const add = (value: string, run: TextRun): void => {
			if (value === "") return

			const size = runPx(run, scale)

			this.runState(run, size, genericFamily(run.font))
			pieces.push({ text: value, run, size, width: ctx.measureText(value).width })
		}

		if (line.first && typeof paragraph.bullet === "string" && paragraph.bullet !== "" && firstRun !== undefined)
			add(`${symbolBullet(paragraph.bulletFont) ? "•" : paragraph.bullet} `, { ...firstRun, baseline: 0 })

		for (let r = line.from; r < line.to; r++) {
			const run = runs[r]

			if (run !== undefined && typeof run.text === "string") add(run.caps === "all" ? run.text.toUpperCase() : run.text, run)
		}

		if (pieces.length === 0) return

		const widths = pieces.reduce((sum, piece) => sum + piece.width, 0)
		let x = paragraph.align === "ctr" ? (left + right) / 2 - widths / 2 : paragraph.align === "r" ? right - widths : left + marginLeft

		for (const piece of pieces) {
			const shift = clamp(piece.run.baseline, -1, 1, 0) * clamp(piece.run.size, 1, 1000, 11) * PX_PER_PT * scale
			const color = rgbaOf(piece.run.color)

			this.runState(piece.run, piece.size, genericFamily(piece.run.font))
			this.show(piece.text, piece.run, x, baseline - shift, piece.size, (color & 255) === 0 ? null : canvasColor(color))
			x += piece.width
		}
	}
}

// Paints `data` onto `ctx` through `matrix` (drawing px → the context's pixels, a b c d e f). The context's own
// transform is replaced while painting and restored after.
export function paintDrawingCanvas<I extends CanvasSized>(
	ctx: Canvas2DLike<I>,
	data: DrawingData,
	matrix: readonly number[],
	images: CanvasPaintContext<I>
): void {
	new CanvasDrawingPainter(ctx, data, matrixAt(matrix), images).paint()
}

// Every image a drawing shows (picture fills and image items, hidden items skipped), once each, so the caller can
// decode them before painting.
export function canvasDrawingImages(data: DrawingData): DrawingImage[] {
	const ints = data.itemInts
	const count = Math.min(index(data.itemCount) < 0 ? 0 : data.itemCount, MAX_ITEMS, Math.floor(ints.length / ITEM_INTS))
	const seen = new Set<DrawingImage>()
	const out: DrawingImage[] = []
	const add = (imageIndex: number): void => {
		const image = imageIndex < 0 ? undefined : data.images[imageIndex]

		if (image === undefined || image === null || seen.has(image)) return

		seen.add(image)
		out.push(image)
	}
	const addPaint = (paintIndex: number): void => {
		const paint = paintIndex < 0 ? undefined : data.paints[paintIndex]

		if (paint !== undefined && paint !== null && paint.kind === "image") add(index(paint.image))
	}

	for (let item = 0; item < count; item++) {
		const i = item * ITEM_INTS

		if (((ints[i + ItemInt.FLAGS] ?? 0) & ItemFlag.HIDDEN) !== 0) continue

		switch (ints[i + ItemInt.KIND]) {
			case ItemKind.PATH: {
				addPaint(index(ints[i + ItemInt.FILL]))

				const stroke = data.strokes[index(ints[i + ItemInt.STROKE])]

				if (stroke !== undefined && stroke !== null) addPaint(index(stroke.paint))

				break
			}
			case ItemKind.IMAGE:
				add(index(ints[i + ItemInt.REF]))
				break
			case ItemKind.TEXT: {
				const text = data.texts[index(ints[i + ItemInt.REF])]

				if (text !== undefined && text !== null && "fill" in text && text.fill !== undefined) addPaint(index(text.fill))

				break
			}
			default:
				break
		}
	}

	return out
}

// --- The text page painter ---

// A laid-out text page as the canvas draws it: the page data with the tables its styles index (TextPage of the
// presentation engine; the docx engine's pages carry none of the optional paint tables).
export interface CanvasTextPage {
	readonly page: DocxPageData
	readonly styles: readonly DocxTextStyle[]
	readonly decorations: readonly DecorationValue[]
	readonly paints?: readonly Paint[]
	readonly strokes?: readonly Stroke[]
	readonly textEffects?: readonly CanvasTextEffects[]
}

// Text effects as drawn (presentation output's RenderEffects, structurally).
export type CanvasTextEffects = readonly (
	| {
			readonly kind: "outerShadow" | "innerShadow"
			readonly color: Rgba
			readonly blur: number
			readonly dx: number
			readonly dy: number
	  }
	| { readonly kind: "glow"; readonly color: Rgba; readonly radius: number }
	| { readonly kind: "softEdge" | "blur"; readonly radius: number }
	| { readonly kind: "reflection"; readonly distance?: number; readonly startAlpha?: number; readonly endPos?: number }
)[]

// Bands a text reflection's fade is drawn in (each a clipped copy at its own opacity).
const REFLECTION_BANDS = 8

const LEADER_DASH: Readonly<Record<number, readonly number[]>> = {
	[TabLeader.DOT]: [1, 2],
	[TabLeader.MIDDLE_DOT]: [1, 2],
	[TabLeader.HYPHEN]: [3, 2],
	[TabLeader.UNDERSCORE]: [],
	[TabLeader.HEAVY]: []
}

function cssFont(font: string): string {
	return typeof font === "string" && CSS_FONT.test(font) ? font : FALLBACK_FONT
}

function hexColor(color: string | undefined): string {
	return color !== undefined && HEX.test(color) ? `#${color}` : AUTO_TEXT
}

function decorationColor(value: DecorationValue | undefined): string | undefined {
	if (value === undefined) return undefined

	switch (value.kind) {
		case "color":
			return HEX.test(value.color) ? `#${value.color}` : undefined
		case "underline":
		case "border":
			return value.color !== undefined && HEX.test(value.color) ? `#${value.color}` : undefined
		default:
			return AUTO_TEXT
	}
}

function lowerCase(char: string): boolean {
	return char !== char.toUpperCase()
}

class CanvasTextPainter<I> {
	private readonly ctx: Canvas2DLike<I>
	private readonly text: CanvasTextPage
	private readonly faces: CanvasTextFaces | undefined
	private readonly base: Matrix

	constructor(ctx: Canvas2DLike<I>, text: CanvasTextPage, base: Matrix, faces: CanvasTextFaces | undefined) {
		this.ctx = ctx
		this.text = text
		this.base = base
		this.faces = faces
	}

	private font(css: string): string {
		const font = cssFont(css)

		return this.faces?.font?.(font) ?? font
	}

	paint(): void {
		const { ctx } = this
		const page = this.text.page

		ctx.save()

		try {
			ctx.setTransform(this.base[0], this.base[1], this.base[2], this.base[3], this.base[4], this.base[5])
			ctx.textBaseline = "alphabetic"
			ctx.textAlign = "left"

			const lines = Math.min(index(page.lineCount) < 0 ? 0 : page.lineCount, Math.floor(page.lineInts.length / LINE_INTS))

			// Fills under the text, then the text, then the lines over it, as the DOM painter stacks them.
			for (let line = 0; line < lines; line++) this.decorations(line, true)
			for (let line = 0; line < lines; line++) this.line(line)
			for (let line = 0; line < lines; line++) this.decorations(line, false)
		} finally {
			ctx.restore()
		}
	}

	private styleColor(style: DocxTextStyle | undefined): string {
		return style === undefined || style.color.length === 0 ? AUTO_TEXT : hexColor(style.color)
	}

	// A style's fill as the DOM painter draws it on the fragment's span (page.ts drawingTextCss): a linear gradient
	// along the paint's angle across the span's box (CSS linear-gradient), a path gradient as a radial one from its
	// focus, a pattern in the blend of its colours, else the colour.
	private fillOf(style: DocxTextStyle | undefined, box: Box): unknown {
		const paintIndex = index(style?.paint)
		const paint = paintIndex < 0 ? undefined : this.text.paints?.[paintIndex]

		if (paint === undefined || paint === null) return this.styleColor(style)

		const [x, y, width, height] = box

		switch (paint.kind) {
			case "solid":
				return canvasColor(paint.color)
			case "linear":
			case "gradient": {
				if (stopCount(paint.stops) === 0) return null

				const radians = ((paint.kind === "linear" ? mod(finite(paint.angle, 0), 360) : 0) * Math.PI) / 180
				const dx = Math.cos(radians)
				const dy = Math.sin(radians)
				// CSS: the gradient line through the centre, as long as the box's projection onto it.
				const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2
				const cx = x + width / 2
				const cy = y + height / 2

				return this.gradientStops(
					this.ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half),
					paint.stops
				)
			}
			case "path": {
				if (stopCount(paint.stops) === 0) return null

				const fx = x + ((clamp(paint.focus.left, 0, 1, 0) + 1 - clamp(paint.focus.right, 0, 1, 0)) / 2) * width
				const fy = y + ((clamp(paint.focus.top, 0, 1, 0) + 1 - clamp(paint.focus.bottom, 0, 1, 0)) / 2) * height

				if (paint.shape === "circle") {
					// circle farthest-corner
					const radius = Math.max(
						Math.hypot(fx - x, fy - y),
						Math.hypot(x + width - fx, fy - y),
						Math.hypot(fx - x, y + height - fy),
						Math.hypot(x + width - fx, y + height - fy)
					)

					return this.gradientStops(this.ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.max(radius, 0.001)), paint.stops)
				}

				// ellipse farthest-side: drawn as the circle of its larger radius (a canvas gradient has no ellipse).
				const radius = Math.max(fx - x, x + width - fx, fy - y, y + height - fy, 0.001)

				return this.gradientStops(this.ctx.createRadialGradient(fx, fy, 0, fx, fy, radius), paint.stops)
			}
			case "pattern":
				return canvasColor(mix(rgbaOf(paint.background), rgbaOf(paint.foreground), patternShare(paint.pattern)))
			case "shaded":
				return canvasColor(averageShade(paint.colors))
			default:
				return this.styleColor(style)
		}
	}

	private gradientStops(gradient: CanvasGradientLike, stops: GradientStops): CanvasGradientLike {
		const count = stopCount(stops)

		for (let k = 0; k < count; k++) gradient.addColorStop(clamp(stops.offsets[k], 0, 1, 0), canvasColor(rgbaOf(stops.colors[k])))

		return gradient
	}

	private line(line: number): void {
		const { ctx } = this
		const page = this.text.page
		const lf = line * LINE_FLOATS
		const li = line * LINE_INTS
		const baseline = page.lineFloats[lf + 2] ?? 0
		const first = index(page.lineInts[li])
		const count = index(page.lineInts[li + 1])
		const source = page.lineInts[li + 5] ?? -1
		const text = page.sourceTexts[source] ?? ""

		if (first < 0 || count <= 0) return

		const last = Math.min(first + count, Math.floor(page.fragmentInts.length / FRAGMENT_INTS))

		for (let k = first; k < last; k++) {
			const ff = k * FRAGMENT_FLOATS
			const fi = k * FRAGMENT_INTS
			const start = page.fragmentInts[fi] ?? 0
			const end = page.fragmentInts[fi + 1] ?? 0
			const info = page.fragmentInts[fi + 3] ?? 0
			const kind = info & FRAGMENT_KIND_MASK
			const style = this.text.styles[page.fragmentInts[fi + 2] ?? -1]
			const x = page.fragmentFloats[ff] ?? 0
			const y = baseline - finite(style?.shift, 0)

			if (kind === FragmentKind.TAB) {
				this.leader(page.fragmentInts[fi + 4] ?? 0, style, x, y, page.fragmentFloats[ff + 1] ?? 0)
				continue
			}

			const hyphen = (info & FragmentFlag.HYPHEN) !== 0

			if (kind !== FragmentKind.TEXT || (end <= start && !hyphen)) continue

			let content = text.slice(start, end) + (hyphen ? "-" : "")

			if ((info & FragmentFlag.CAPS) !== 0) content = content.toUpperCase()

			const width = page.fragmentFloats[ff + 1] ?? 0
			// An upright cluster of sideways text: drawn by a painter turned 90° counter-clockwise about the centre of
			// its box, (x + width / 2, y − (ascent − descent) / 2).
			const painter =
				(info & FragmentFlag.UPRIGHT) !== 0
					? this.turned(x + width / 2, y - (finite(style?.ascent, 0) - finite(style?.descent, 0)) / 2)
					: this

			ctx.save()

			if (painter !== this)
				ctx.setTransform(painter.base[0], painter.base[1], painter.base[2], painter.base[3], painter.base[4], painter.base[5])

			painter.fragment(content, style, info, x, y, width, page.fragmentFloats[ff + 2] ?? 0, page.fragmentFloats[ff + 3] ?? 0)
			ctx.restore()
		}
	}

	// This painter turned 90° counter-clockwise about (cx, cy).
	private turned(cx: number, cy: number): CanvasTextPainter<I> {
		return new CanvasTextPainter(this.ctx, this.text, times(this.base, [0, -1, 1, 0, cx - cy, cy + cx]), this.faces)
	}

	private fragment(
		content: string,
		style: DocxTextStyle | undefined,
		info: number,
		x: number,
		y: number,
		width: number,
		wordSpacing: number,
		justifyLetters: number
	): void {
		const { ctx } = this
		const font = this.font(style?.font ?? FALLBACK_FONT)
		const smallFont = this.font(style?.smallCapsFont ?? FALLBACK_FONT)
		const scaleX = style !== undefined && style.scaleX > 0 && Number.isFinite(style.scaleX) ? Math.min(style.scaleX, 10) : 1
		const letterSpacing = finite(style?.letterSpacing, 0) + finite(justifyLetters, 0)
		const rtl = (info >> FRAGMENT_LEVEL_SHIFT) % 2 === 1
		const ascent = Math.max(0, finite(style?.ascent, 0))
		const box: Box = [x, y - ascent, Math.max(0, width), ascent + Math.max(0, finite(style?.descent, 0))]
		// Opacity of a fill-less style's colour (a paint's stops carry their own).
		// Opacity of a fill-less style's colour, the glyph fill only (a paint's stops carry their own; outlines and
		// shadows keep theirs).
		const alpha = style?.paint === undefined ? clamp(style?.alpha, 0, 1, 1) : 1
		const painted = this.fillOf(style, box)
		const fill =
			alpha >= 1 || typeof painted !== "string"
				? painted
				: alpha <= 0
					? null
					: `${painted}${Math.round(alpha * 255)
							.toString(16)
							.padStart(2, "0")}`
		const outline = style?.outline === undefined ? undefined : this.text.strokes?.[index(style.outline)]
		const effects = style?.effects === undefined ? undefined : this.text.textEffects?.[index(style.effects)]

		ctx.font = font
		ctx.direction = rtl ? "rtl" : "ltr"

		if (scaleX !== 1) {
			// Scaled about the fragment's start, as CSS scaleX on a left-anchored span.
			const m = times(this.base, [scaleX, 0, 0, 1, x - scaleX * x, 0])

			ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
		}

		// Pieces drawn in one font each: small capitals split out of the lower-case letters.
		const pieces: [string, string][] = []

		if ((info & FragmentFlag.SMALL_CAPS) !== 0 && !rtl) {
			for (let at = 0; at < content.length;) {
				const lower = lowerCase(content.charAt(at))
				let next = at + 1

				while (next < content.length && lowerCase(content.charAt(next)) === lower) next++

				const piece = content.slice(at, next)

				pieces.push(lower ? [piece.toUpperCase(), smallFont] : [piece, font])
				at = next
			}
		} else {
			pieces.push([content, font])
		}

		const spaced = letterSpacing !== 0 || wordSpacing !== 0
		const native = ctx.letterSpacing !== undefined && ctx.wordSpacing !== undefined

		if (native) {
			ctx.letterSpacing = `${px3(letterSpacing)}px`
			ctx.wordSpacing = `${px3(wordSpacing)}px`
		}

		const draw = (piece: string, at: number): void => {
			if (effects !== undefined) this.effects(effects, piece, at, y, fill)

			if (fill !== null) {
				ctx.fillStyle = fill
				ctx.fillText(piece, at, y)
			}

			if (outline !== undefined && outline !== null) this.outline(outline, piece, at, y)
			if (effects !== undefined) this.reflection(effects, style, piece, at, y, fill)
		}

		let pen = x

		for (const [piece, pieceFont] of pieces) {
			ctx.font = pieceFont

			if (!spaced || native || rtl) {
				draw(piece, pen)
				pen += ctx.measureText(piece).width
				continue
			}

			// No spacing on the context: each character placed with the spacing CSS would add.
			for (const character of piece) {
				draw(character, pen)
				pen += ctx.measureText(character).width + letterSpacing + (character === " " ? wordSpacing : 0)
			}
		}
	}

	// The glyph outline centred on the glyphs' edges, in one colour (a gradient's first stop, a pattern's blend), as
	// the DOM painter's -webkit-text-stroke draws it.
	private outline(stroke: Stroke, text: string, x: number, y: number): void {
		const { ctx } = this
		const width = clamp(stroke.width, 0, 1000, 0)
		const paint = this.text.paints?.[index(stroke.paint)]

		if (!(width > 0) || paint === undefined || paint === null) return

		const color =
			paint.kind === "solid"
				? rgbaOf(paint.color)
				: paint.kind === "pattern"
					? mix(rgbaOf(paint.background), rgbaOf(paint.foreground), patternShare(paint.pattern))
					: paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient"
						? rgbaOf(paint.stops.colors[0] ?? 0x000000ff)
						: paint.kind === "shaded"
							? averageShade(paint.colors)
							: 0x000000ff

		if ((color & 255) === 0) return

		ctx.save()
		ctx.strokeStyle = canvasColor(color)
		ctx.lineWidth = width
		ctx.lineJoin = "round"
		ctx.strokeText(text, x, y)
		ctx.restore()
	}

	// Shadows and glows behind the glyphs, as the DOM painter's text-shadow draws them (a glow: two unoffset shadows at
	// its radius and half of it): each the canvas shadow of a copy drawn far off the canvas, so only the shadow lands.
	private effects(effects: CanvasTextEffects, text: string, x: number, y: number, fill: unknown): void {
		const { ctx } = this
		const m = this.base
		const scale = scaleOf(m)
		// Far beyond the page in page px, carried back by the shadow offset in device px.
		const away = Math.max(clamp(this.text.page.width, 0, MAX_COORD, 0), clamp(this.text.page.height, 0, MAX_COORD, 0), 1) * 4
		const cast = (color: number, blur: number, dx: number, dy: number): void => {
			if ((color & 255) === 0) return

			ctx.save()
			ctx.shadowColor = canvasColor(color)
			ctx.shadowBlur = Math.max(0, blur) * scale
			ctx.shadowOffsetX = m[0] * (dx + away) + m[2] * dy
			ctx.shadowOffsetY = m[1] * (dx + away) + m[3] * dy
			ctx.fillStyle = fill === null ? "#000000" : fill
			ctx.fillText(text, x - away, y)
			ctx.restore()
		}

		for (const effect of effects) {
			if (effect === undefined || effect === null) continue

			if (effect.kind === "outerShadow") {
				cast(
					rgbaOf(effect.color),
					clamp(effect.blur, 0, 1024, 0),
					clamp(effect.dx, -4096, 4096, 0),
					clamp(effect.dy, -4096, 4096, 0)
				)
			} else if (effect.kind === "glow") {
				const radius = clamp(effect.radius, 0, 1024, 0)

				cast(rgbaOf(effect.color), radius, 0, 0)
				cast(rgbaOf(effect.color), radius / 2, 0, 0)
			}
		}
	}

	// A reflection as the DOM painter's -webkit-box-reflect draws it: the span's box (its line-height, the glyphs centred
	// in it by the half-leading) mirrored `distance` below its bottom, opaque by startAlpha at the edge and fading out over
	// endPos of the box's height.
	private reflection(
		effects: CanvasTextEffects,
		style: DocxTextStyle | undefined,
		text: string,
		x: number,
		y: number,
		fill: unknown
	): void {
		const effect = effects.find(candidate => candidate?.kind === "reflection")

		if (effect === undefined || effect.kind !== "reflection" || fill === null) return

		const startAlpha = clamp(effect.startAlpha, 0, 1, 0)
		const endPos = clamp(effect.endPos, 0, 1, 0)

		if (startAlpha === 0 || endPos === 0) return

		const ascent = Math.max(0, finite(style?.ascent, 0))
		const descent = Math.max(0, finite(style?.descent, 0))
		const lineHeight = Number(/\/\s*([\d.]+)px/.exec(style?.font ?? "")?.[1] ?? Number.NaN)
		const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : ascent + descent
		const bottom = y + descent + (height - ascent - descent) / 2
		const axis = bottom + clamp(effect.distance, 0, MAX_COORD, 0) / 2
		const fade = endPos * height
		const { ctx } = this
		const m = times(this.base, [1, 0, 0, -1, 0, 2 * axis])
		const reach = Math.max(
			clamp(this.text.page.width, 0, MAX_COORD, 0),
			Math.abs(x) + Math.abs(finite(this.ctx.measureText(text).width, 0)),
			1
		)

		for (let band = 0; band < REFLECTION_BANDS; band++) {
			// Bands from the box's bottom edge upwards in its own space, which the mirror puts nearest the glyphs.
			const from = bottom - (fade * band) / REFLECTION_BANDS
			const to = bottom - (fade * (band + 1)) / REFLECTION_BANDS

			ctx.save()
			ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
			ctx.beginPath()
			ctx.rect(-reach, to, 3 * reach, from - to)
			ctx.clip()
			ctx.globalAlpha *= startAlpha * (1 - (band + 0.5) / REFLECTION_BANDS)
			ctx.fillStyle = fill
			ctx.fillText(text, x, y)
			ctx.restore()
		}
	}

	private leader(leader: number, style: DocxTextStyle | undefined, x: number, y: number, width: number): void {
		const dash = LEADER_DASH[leader]

		if (dash === undefined || !(width > 0)) return

		const { ctx } = this

		ctx.save()
		ctx.strokeStyle = this.styleColor(style)
		ctx.lineWidth = leader === TabLeader.HEAVY ? 2 : 1
		ctx.setLineDash([...dash])
		ctx.beginPath()
		ctx.moveTo(x, y)
		ctx.lineTo(x + width, y)
		ctx.stroke()
		ctx.restore()
	}

	// The style colour of the fragment under x on a line (for decorations drawn in the text's colour).
	private colorAt(line: number, x: number): string {
		const page = this.text.page
		const first = page.lineInts[line * LINE_INTS] ?? 0
		const count = page.lineInts[line * LINE_INTS + 1] ?? 0
		let style = -1

		for (let k = first; k < first + count; k++) {
			if ((page.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0) > x + 0.5) break

			style = page.fragmentInts[k * FRAGMENT_INTS + 2] ?? -1
		}

		return this.styleColor(this.text.styles[style])
	}

	private decorations(line: number, under: boolean): void {
		const { ctx } = this
		const page = this.text.page
		const first = index(page.lineInts[line * LINE_INTS + 6])
		const last = line + 1 < page.lineCount ? (page.lineInts[(line + 1) * LINE_INTS + 6] ?? 0) : page.decorationCount
		const end = Math.min(last, Math.floor(page.decorationInts.length / DECORATION_INTS))

		for (let d = Math.max(0, first); d < end; d++) {
			const df = d * DECORATION_FLOATS
			const di = d * DECORATION_INTS
			const kind = page.decorationInts[di] ?? 0
			const fill = kind === DecorationKind.SHADING || kind === DecorationKind.HIGHLIGHT

			if (fill !== under) continue

			const x = page.decorationFloats[df] ?? 0
			const y = page.decorationFloats[df + 1] ?? 0
			const width = page.decorationFloats[df + 2] ?? 0
			const height = page.decorationFloats[df + 3] ?? 0
			const value = this.text.decorations[(page.decorationInts[di + 1] ?? 0) - 1]

			if (!(width > 0) && kind !== DecorationKind.BAR) continue

			switch (kind) {
				case DecorationKind.SHADING:
				case DecorationKind.HIGHLIGHT: {
					const color = decorationColor(value)

					if (color === undefined) continue

					ctx.fillStyle = color
					ctx.fillRect(x, y, width, height)
					break
				}
				case DecorationKind.UNDERLINE: {
					const color = decorationColor(value) ?? this.colorAt(line, x)
					const thickness = Math.max(1, height)

					ctx.fillStyle = color

					if (value?.kind === "underline" && (value.style === "double" || value.style === "wavyDouble")) {
						ctx.fillRect(x, y, width, thickness)
						ctx.fillRect(x, y + height + thickness, width, thickness)
					} else {
						ctx.fillRect(x, y, width, thickness)
					}

					break
				}
				case DecorationKind.STRIKE:
					ctx.fillStyle = this.colorAt(line, x)
					ctx.fillRect(x, y, width, height)
					break
				case DecorationKind.DOUBLE_STRIKE:
					ctx.fillStyle = this.colorAt(line, x)
					ctx.fillRect(x, y, width, height)
					ctx.fillRect(x, y + height * 2, width, height)
					break
				case DecorationKind.BORDER: {
					if (value?.kind !== "border" || value.style === "none" || value.style === "nil") continue

					const lineWidth = Math.max(1, clamp(value.width, 0, 1000, 1))

					ctx.strokeStyle = decorationColor(value) ?? this.colorAt(line, x)
					ctx.lineWidth = lineWidth
					ctx.beginPath()
					ctx.rect(x + lineWidth / 2, y + lineWidth / 2, width - lineWidth, height - lineWidth)
					ctx.stroke()
					break
				}
				case DecorationKind.BAR:
					ctx.fillStyle = AUTO_TEXT
					ctx.fillRect(x, y, Math.max(width, 1), height)
					break
				default:
					break
			}
		}
	}
}

// Paints a laid-out text page onto `ctx` through `matrix` (page px → the context's pixels): fills and highlights,
// the text with its paint, opacity, outline and effects, then underlines, strikes and borders. `faces` maps a style's
// CSS font onto the face registered in this realm (the worker's FontFaceSet registers the engine's aliases as they
// are, so none is needed there).
export function paintTextPageCanvas<I>(
	ctx: Canvas2DLike<I>,
	page: CanvasTextPage,
	matrix: readonly number[],
	faces?: CanvasTextFaces
): void {
	new CanvasTextPainter(ctx, page, matrixAt(matrix), faces).paint()
}

// The CSS fonts a text page draws in (each style a fragment uses, small capitals included), so the caller can load
// them before painting: fillText draws a fallback face for a font still loading.
export function canvasTextFonts(page: CanvasTextPage): string[] {
	const used = new Set<number>()
	const data = page.page
	const count = Math.min(index(data.fragmentCount) < 0 ? 0 : data.fragmentCount, Math.floor(data.fragmentInts.length / FRAGMENT_INTS))

	for (let k = 0; k < count; k++) used.add(data.fragmentInts[k * FRAGMENT_INTS + 2] ?? -1)

	const fonts = new Set<string>()

	for (const style of used) {
		const resolved = page.styles[style]

		if (resolved === undefined) continue

		fonts.add(cssFont(resolved.font))
		fonts.add(cssFont(resolved.smallCapsFont))
	}

	return [...fonts]
}

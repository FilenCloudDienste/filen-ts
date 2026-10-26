import type { Matrix } from "../pdfwrite/content"
import type { PdfFontFaceRequest, PdfFontSet, PdfShapedText } from "../pdfwrite/fonts/fontSet"
import type { PdfGradient } from "../pdfwrite/shading"
import type { PdfImage, PdfPage } from "../pdfwrite/page"
import {
	ITEM_FILL_MODIFIER_MASK,
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	pathGradientCircle,
	type DrawingClip,
	type DrawingImage,
	type DrawingList,
	type DrawingText,
	type GradientStops,
	type Inset,
	type Paint,
	type Stroke,
	type TextParagraph,
	type TextRun
} from "./displayList"
import { averageShade } from "./shade"
import { layoutBlock } from "./textBlock"

// A drawing's display list painted onto a PDF page as vectors: paths with their fills (solid, linear and path
// gradients as shadings, patterns as the blend of their colours, pictures clipped by the path), strokes with
// widths, caps, joins and dashes, clips (and their parents), pictures with their crop and opacity, and text shaped
// by the export's fonts. What it draws matches the SVG painter (react/docx/paint/drawing.ts) item for item; shadows,
// picture recolouring and a clip group's opacity as one group are not drawn (each item takes the group's opacity).
//
// Coordinates are the drawing's px; `placement` maps them onto the page's px (see core/pdfwrite/page.ts). The
// caller opens the marked content (a Figure, or an artifact) around it.

export interface PdfDrawingData {
	readonly width: number
	readonly height: number
	readonly commands: Uint8Array
	readonly coords: Float32Array
	readonly itemCount: number
	readonly itemFloats: Float32Array
	readonly itemInts: Int32Array
	readonly paints: DrawingList["paints"]
	readonly strokes: DrawingList["strokes"]
	readonly images: DrawingList["images"]
	readonly texts: DrawingList["texts"]
	readonly clips?: DrawingList["clips"]
	readonly itemClips?: Int32Array
	readonly background?: number
}

export interface PdfDrawingContext {
	readonly page: PdfPage
	readonly fonts: PdfFontSet
	// The picture of a drawing image, written once per export (undefined: it does not draw).
	image(image: DrawingImage): Promise<PdfImage | undefined>
	// The family text without a typeface of its own is drawn in.
	readonly defaultFamily: string
	// Every colour drawn as its grey (a sheet printed in black and white).
	readonly gray?: boolean
}

const MAX_ITEMS = 200_000
const MAX_COORD = 2 ** 31
const MAX_RUNS = 50_000
const MAX_CLIP_CHAIN = 1024
const PX_PER_PT = 96 / 72
// Synthetic italic: the slant of a face drawn in place of an italic one.
const FAUX_ITALIC = 0.21

function finite(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? value : fallback
}

function clamp(value: number | undefined, min: number, max: number, fallback: number = min): number {
	return Math.min(max, Math.max(min, finite(value, fallback)))
}

function index(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : -1
}

function channel(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)))
}

function rgbaFrom(r: number, g: number, b: number, a: number): number {
	return ((channel(r) << 24) | (channel(g) << 16) | (channel(b) << 8) | channel(a)) >>> 0
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

// ST_PathFillMode, as a blend toward white or black (as the SVG painter draws it).
function modify(color: number, modifier: number): number {
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

// The grey of a colour as SVG's saturate(0) gives it (Filter Effects 1 §feColorMatrix).
export function grayRgba(color: number): number {
	const r = (color >>> 24) & 255
	const g = (color >>> 16) & 255
	const b = (color >>> 8) & 255
	const y = 0.213 * r + 0.715 * g + 0.072 * b

	return rgbaFrom(y, y, y, color & 255)
}

function stopCount(stops: GradientStops): number {
	return Math.min(stops.offsets.length, stops.colors.length, 64)
}

function averageColor(stops: GradientStops): number {
	const count = stopCount(stops)
	let r = 0
	let g = 0
	let b = 0
	let a = 0

	for (let k = 0; k < count; k++) {
		const color = (stops.colors[k] ?? 0) >>> 0

		r += (color >>> 24) & 255
		g += (color >>> 16) & 255
		b += (color >>> 8) & 255
		a += color & 255
	}

	return count === 0 ? 0 : rgbaFrom(r / count, g / count, b / count, a / count)
}

// The share of the foreground a preset pattern covers (its "pctNN" percentage; half for the line and shape
// patterns): a pattern is drawn as the blend of its colours.
function patternCoverage(pattern: string): number {
	const match = /^pct(\d+)$/.exec(pattern)

	return match === null ? 0.5 : clamp(Number(match[1]) / 100, 0, 1, 0.5)
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
	if (inset === undefined) return [0, 0, 0, 0]

	return [
		clamp(inset.left, min, max, 0),
		clamp(inset.top, min, max, 0),
		clamp(inset.right, min, max, 0),
		clamp(inset.bottom, min, max, 0)
	]
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

function symbolBullet(font: string): boolean {
	const name = font.toLowerCase()

	return name === "symbol" || name === "wingdings" || name.startsWith("wingdings ")
}

const mod = (value: number, by: number): number => ((value % by) + by) % by

function matrixOf(values: ArrayLike<number>, at: number = 0): Matrix {
	return [
		finite(values[at], 1),
		finite(values[at + 1], 0),
		finite(values[at + 2], 0),
		finite(values[at + 3], 1),
		clamp(values[at + 4], -MAX_COORD, MAX_COORD, 0),
		clamp(values[at + 5], -MAX_COORD, MAX_COORD, 0)
	]
}

function identity(m: Matrix): boolean {
	return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
}

function invert(m: Matrix): Matrix | null {
	const det = m[0] * m[3] - m[1] * m[2]

	if (!(Math.abs(det) > 1e-12)) return null

	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
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

class DrawingPainter {
	private runsLeft = MAX_RUNS
	private readonly chains = new Map<number, readonly number[] | undefined>()

	private readonly data: PdfDrawingData
	private readonly context: PdfDrawingContext

	constructor(data: PdfDrawingData, context: PdfDrawingContext) {
		this.data = data
		this.context = context
	}

	private get page(): PdfPage {
		return this.context.page
	}

	private color(color: number): number {
		const value = color >>> 0

		return this.context.gray === true ? grayRgba(value) : value
	}

	async paint(placement: Matrix): Promise<void> {
		const data = this.data
		const page = this.page
		const width = clamp(data.width, 0, MAX_COORD, 0)
		const height = clamp(data.height, 0, MAX_COORD, 0)

		page.saveState()

		if (!identity(placement)) page.concat(placement)

		try {
			if (typeof data.background === "number" && width > 0 && height > 0) {
				page.fillColor(this.color(data.background)).rect(0, 0, width, height).fill()
			}

			const count = Math.min(
				index(data.itemCount) < 0 ? 0 : data.itemCount,
				MAX_ITEMS,
				Math.floor(data.itemFloats.length / ITEM_FLOATS),
				Math.floor(data.itemInts.length / ITEM_INTS)
			)
			const itemClips = data.itemClips instanceof Int32Array ? data.itemClips : null

			for (let item = 0; item < count; item++) {
				const i = item * ITEM_INTS
				const flags = data.itemInts[i + ItemInt.FLAGS] ?? 0

				if ((flags & ItemFlag.HIDDEN) !== 0) continue

				const chain = this.clipChain(itemClips === null ? -1 : index(itemClips[item]))

				// A malformed clip hides the item rather than showing what it would have clipped away.
				if (chain === undefined) continue

				await this.item(item, flags, chain)
			}
		} finally {
			page.restoreState()
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
		let at = clipIndex
		let result: readonly number[] | undefined = undefined

		while (at >= 0 && chain.length <= MAX_CLIP_CHAIN) {
			const clip = clips[at]

			if (clip === undefined) break

			chain.push(at)

			const parent = index(clip.parent)

			if (parent < 0) {
				result = chain.reverse()
				break
			}

			if (parent >= at) break

			at = parent
		}

		this.chains.set(clipIndex, result)

		return result
	}

	// Intersects the clip with clip `clipIndex` (in drawing space): its shapes unioned; a boolean region as its
	// added clips' areas, the subtracted ones cut out even-odd (exact where they lie inside what is added and apart).
	private applyClip(clipIndex: number): number {
		const clip = this.clips()[clipIndex]
		const page = this.page

		if (clip === undefined) return 1

		let any = false
		const shape = (m: ArrayLike<number>, first: number, count: number, coord: number): void => {
			if (count <= 0) return

			page.pathCommands(this.data.commands, this.data.coords, index(first), count, index(coord), matrixOf(m))
			any = true
		}

		if (clip.add !== undefined) {
			for (const member of [...clip.add, ...(clip.subtract ?? [])]) {
				const other = this.clips()[member]

				if (other === undefined || other.add !== undefined) continue

				shape(other.matrix, other.firstCommand, other.commandCount, other.firstCoord)

				for (const extra of other.shapes ?? []) shape(extra.matrix, extra.firstCommand, extra.commandCount, extra.firstCoord)
			}

			if (!any) page.rect(0, 0, 0, 0)

			page.clip((clip.subtract?.length ?? 0) > 0)
		} else {
			shape(clip.matrix, clip.firstCommand, clip.commandCount, clip.firstCoord)

			for (const extra of clip.shapes ?? []) shape(extra.matrix, extra.firstCommand, extra.commandCount, extra.firstCoord)

			// A clip without commands hides everything it clips.
			if (!any) page.rect(0, 0, 0, 0)

			page.clip(clip.evenOdd && (clip.shapes?.length ?? 0) === 0)
		}

		return clip.opacity ?? 1
	}

	// --- Items ---

	private async item(item: number, flags: number, chain: readonly number[]): Promise<void> {
		const data = this.data
		const page = this.page
		const i = item * ITEM_INTS
		const f = item * ITEM_FLOATS
		const kind = data.itemInts[i + ItemInt.KIND]

		page.saveState()

		try {
			let opacity = 1

			for (const clip of chain) opacity *= this.applyClip(clip)

			const blend = flags & ItemFlag.BLEND_MASK

			if (blend !== 0)
				page.graphicsState({
					blend: blend === ItemFlag.BLEND_MULTIPLY ? "Multiply" : blend === ItemFlag.BLEND_LIGHTEN ? "Lighten" : "Difference"
				})

			const m = matrixOf(data.itemFloats, f)

			if (!identity(m)) page.concat(m)

			switch (kind) {
				case ItemKind.PATH:
					await this.pathItem(i, f, flags, opacity)
					break
				case ItemKind.IMAGE:
					await this.imageItem(i, f, opacity)
					break
				case ItemKind.TEXT:
					await this.textItem(i, f, opacity)
					break
				default:
					break
			}
		} finally {
			page.restoreState()
		}
	}

	private box(f: number): [number, number, number, number] {
		const m = this.data.itemFloats

		return [
			clamp(m[f + ItemFloat.X], -MAX_COORD, MAX_COORD, 0),
			clamp(m[f + ItemFloat.Y], -MAX_COORD, MAX_COORD, 0),
			clamp(m[f + ItemFloat.WIDTH], 0, MAX_COORD, 0),
			clamp(m[f + ItemFloat.HEIGHT], 0, MAX_COORD, 0)
		]
	}

	// Appends the item's own path; false when it has none.
	private path(i: number): boolean {
		const ints = this.data.itemInts
		const first = index(ints[i + ItemInt.FIRST_COMMAND])
		const count = index(ints[i + ItemInt.COMMAND_COUNT])
		const coord = index(ints[i + ItemInt.FIRST_COORD])

		if (first < 0 || count <= 0 || coord < 0) return false

		this.page.pathCommands(this.data.commands, this.data.coords, first, Math.min(count, this.data.commands.length - first), coord)

		return true
	}

	private alpha(color: number, opacity: number): number {
		if (opacity >= 1) return color

		return ((color & 0xffffff00) | Math.round((color & 255) * opacity)) >>> 0
	}

	private async pathItem(i: number, f: number, flags: number, opacity: number): Promise<void> {
		const ints = this.data.itemInts
		const page = this.page
		const evenOdd = (flags & ItemFlag.EVEN_ODD) !== 0
		const box = this.box(f)
		const fill = index(ints[i + ItemInt.FILL])
		const stroke = index(ints[i + ItemInt.STROKE])
		const paint = fill < 0 ? undefined : this.data.paints[fill]

		if (paint !== undefined) {
			const solid = this.solidOf(paint, box, flags & ITEM_FILL_MODIFIER_MASK)

			if (solid !== undefined) {
				if ((solid & 255) > 0 && this.path(i)) page.fillColor(this.alpha(this.color(solid), opacity)).fill(evenOdd)
			} else if (this.path(i)) {
				page.saveState()
				page.clip(evenOdd)
				await this.paintArea(paint, box, opacity)
				page.restoreState()
			}
		}

		const line: Stroke | undefined = stroke < 0 ? undefined : this.data.strokes[stroke]

		if (line !== undefined) this.strokePath(i, line, box, opacity)
	}

	// A paint as one colour when it is one (or is drawn as one: a pattern, a flat box's gradient, a shaded mesh);
	// undefined for what paints an area (gradients, pictures).
	private solidOf(paint: Paint, box: readonly [number, number, number, number], modifier: number): number | undefined {
		const flat = !(box[2] > 0 && box[3] > 0)

		switch (paint.kind) {
			case "solid":
				return modify(paint.color >>> 0, modifier)
			case "linear":
			case "path":
				return flat || stopCount(paint.stops) === 0 ? averageColor(paint.stops) : undefined
			case "gradient":
				return stopCount(paint.stops) === 0 ? 0 : undefined
			case "pattern":
				return mixRgba(paint.background >>> 0, paint.foreground >>> 0, patternCoverage(paint.pattern))
			case "shaded":
				return paint.colors instanceof Uint32Array ? averageShade(paint.colors) : 0
			case "image":
				return flat ? 0 : undefined
		}
	}

	// Paints the current clip with a gradient or picture paint over the item's box (local space).
	private async paintArea(paint: Paint, box: readonly [number, number, number, number], opacity: number): Promise<void> {
		const [x, y, width, height] = box
		const page = this.page

		switch (paint.kind) {
			case "linear": {
				const angle = mod(finite(paint.angle, 0), 360)
				const radians = (angle * Math.PI) / 180
				let dx = Math.cos(radians)
				let dy = Math.sin(radians)

				if (paint.scaled !== true && angle % 90 !== 0) {
					dx *= width
					dy *= height

					const length = Math.hypot(dx, dy)

					dx = length > 0 ? dx / length : 1
					dy = length > 0 ? dy / length : 0
				}

				const half = (Math.abs(dx) + Math.abs(dy)) / 2

				await page.gradient(
					this.gradient(
						"axial",
						[
							x + (0.5 - dx * half) * width,
							y + (0.5 - dy * half) * height,
							x + (0.5 + dx * half) * width,
							y + (0.5 + dy * half) * height
						],
						paint.stops,
						0,
						"pad",
						[x, y, x + width, y + height],
						opacity
					)
				)
				break
			}
			case "path": {
				const { cx, cy, radius, inner } = pathGradientCircle(paint)

				// The SVG painter's objectBoundingBox radial: a circle in the unit box, stretched with the box.
				page.saveState()
				page.concat([width, 0, 0, height, x, y])
				await page.gradient(this.gradient("radial", [cx, cy, 0, cx, cy, radius], paint.stops, inner, "pad", [0, 0, 1, 1], opacity))
				page.restoreState()
				break
			}
			case "gradient": {
				const m = matrixOf(paint.matrix)
				const bounds = boundsThrough(m, x, y, width, height)
				const focus = paint.focus ?? [0, 0]

				page.saveState()
				page.concat(m)
				await page.gradient(
					this.gradient(
						paint.type === "linear" ? "axial" : "radial",
						paint.type === "linear" ? [0, 0, 1, 0] : [finite(focus[0], 0), finite(focus[1], 0), 0, 0, 0, 1],
						paint.stops,
						0,
						paint.spread,
						bounds,
						opacity
					)
				)
				page.restoreState()
				break
			}
			case "image": {
				const image = this.data.images[index(paint.image)]

				if (image === undefined) break

				// A tiled picture is drawn once over the box (its tiling is not repeated).
				const [left, top, right, bottom] = insetOf(paint.stretch, -10, 10)

				await this.drawPicture(
					image,
					x + left * width,
					y + top * height,
					width * (1 - left - right),
					height * (1 - top - bottom),
					opacity
				)
				break
			}
			default:
				break
		}
	}

	private gradient(
		type: "axial" | "radial",
		coords: readonly number[],
		stops: GradientStops,
		inner: number,
		spread: "pad" | "reflect" | "repeat",
		bounds: readonly [number, number, number, number],
		opacity: number
	): PdfGradient {
		const count = stopCount(stops)
		const offsets: number[] = []
		const colors: number[] = []
		let previous = 0

		for (let k = 0; k < count; k++) {
			const offset = Math.max(previous, clamp(stops.offsets[k], 0, 1, 0))

			previous = offset
			offsets.push(inner + offset * (1 - inner))
			colors.push(this.alpha(this.color((stops.colors[k] ?? 0) >>> 0), opacity))
		}

		// A radial gradient's inner stop: solid inside it, as SVG pads below the first offset.
		return { type, coords, offsets, colors, spread, bounds }
	}

	private strokePath(i: number, stroke: Stroke, box: readonly [number, number, number, number], opacity: number): void {
		const page = this.page
		const paint = this.data.paints[index(stroke.paint)]

		if (paint === undefined) return

		// A gradient or picture outline is drawn in its mean colour.
		const color =
			this.solidOf(paint, box, 0) ??
			(paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient" ? averageColor(paint.stops) : 0x000000ff)

		if ((color & 255) === 0 || !this.path(i)) return

		const width = clamp(stroke.width, 0, 10_000, 1) || 1

		page.strokeColor(this.alpha(this.color(color), opacity)).lineWidth(width)
		page.lineCap(stroke.cap === "round" ? "round" : stroke.cap === "square" ? "square" : "butt")
		page.lineJoin(stroke.join === "round" ? "round" : stroke.join === "bevel" ? "bevel" : "miter")

		if (stroke.join === "miter") page.miterLimit(clamp(stroke.miterLimit, 1, 100, 8))

		const custom = stroke.customDash
		const dashes = custom !== null && custom.length > 0 ? Array.from(custom).slice(0, 32) : presetDashes(stroke.dash)

		if (dashes !== undefined && dashes.some(length => length > 0)) page.dash(dashes.map(length => clamp(length, 0, 1000, 0) * width))

		page.stroke()
	}

	// --- Pictures ---

	private async drawPicture(image: DrawingImage, x: number, y: number, width: number, height: number, opacity: number): Promise<void> {
		if (!(width > 0 && height > 0)) return

		const [left, top, right, bottom] = insetOf(image.crop, -10, 1)
		const cropWidth = 1 - left - right
		const cropHeight = 1 - top - bottom

		if (!(cropWidth > 0.0001 && cropHeight > 0.0001)) return

		const picture = await this.context.image(image)

		if (picture === undefined) return

		const page = this.page
		const alpha = clamp(image.alpha, 0, 1, 1) * opacity
		const cropped = left !== 0 || top !== 0 || right !== 0 || bottom !== 0

		page.saveState()

		if (alpha < 1) page.graphicsState({ fillAlpha: alpha })

		if (cropped) {
			page.rect(x, y, width, height).clip()

			const fullWidth = width / cropWidth
			const fullHeight = height / cropHeight

			page.drawImage(picture, x - left * fullWidth, y - top * fullHeight, fullWidth, fullHeight)
		} else {
			page.drawImage(picture, x, y, width, height)
		}

		page.restoreState()
	}

	private async imageItem(i: number, f: number, opacity: number): Promise<void> {
		const [x, y, width, height] = this.box(f)

		if (!(width > 0 && height > 0)) return

		const image = this.data.images[index(this.data.itemInts[i + ItemInt.REF])]

		if (this.path(i)) this.page.clip()

		if (image !== undefined) {
			await this.drawPicture(image, x, y, width, height, opacity)

			return
		}

		// A picture that cannot be shown: the placeholder the SVG painter draws.
		this.page.fillColor(this.color(0xf0f0f0ff)).rect(x, y, width, height).fill()
	}

	// --- Text ---

	private request(run: TextRun): PdfFontFaceRequest {
		return {
			family: run.font === "" ? this.context.defaultFamily : run.font,
			bold: run.bold,
			italic: run.italic,
			slot: "hAnsi"
		}
	}

	private async shape(raw: string, run: TextRun, rtl: boolean): Promise<PdfShapedText> {
		// Whitespace controls show as spaces, as SVG text with xml:space="preserve" shows them.
		const text = /[\t\n\f\r]/.test(raw) ? raw.replace(/[\t\n\f\r]/g, " ") : raw
		const fonts = this.context.fonts
		const request = this.request(run)
		const pending = fonts.prepare(text, 0, text.length, request)

		if (pending !== undefined) await pending

		return fonts.shape(text, 0, text.length, request, { level: rtl ? 1 : 0, flags: 0, bidi: true })
	}

	// Draws shaped text with its pen at (x, y) on the baseline; the width drawn, px.
	private show(
		shaped: PdfShapedText,
		text: string,
		run: TextRun,
		x: number,
		y: number,
		size: number,
		opacity: number,
		color?: number
	): number {
		const page = this.page
		const letter = clamp(run.spacing, -100, 100, 0) * PX_PER_PT
		const natural = (shaped.width * size) / 1000 + letter * text.length
		const faux = shaped.runs[0]
		const fill = this.alpha(this.color(color ?? run.color >>> 0), opacity)

		if ((fill & 255) === 0 || shaped.runs.length === 0) return natural

		page.text(shaped.runs, {
			x,
			y,
			size,
			color: fill,
			text,
			...(letter !== 0 && { letterSpacing: letter }),
			...(faux?.fauxItalic === true && { transform: [1, 0, -FAUX_ITALIC, 1] }),
			...(faux?.fauxBold === true && { render: "fillStroke", strokeWidth: size / 30 })
		})

		const thickness = Math.max(0.5, size / 14)

		if (run.underline !== "none") {
			page.fillColor(fill)
				.rect(x, y + size * 0.12, natural, thickness)
				.fill()

			if (run.underline === "dbl") page.rect(x, y + size * 0.12 + thickness * 2, natural, thickness).fill()
		}

		if (run.strike !== "noStrike") {
			page.fillColor(fill)
				.rect(x, y - size * 0.3, natural, thickness)
				.fill()

			if (run.strike === "dblStrike") page.rect(x, y - size * 0.3 - thickness * 2, natural, thickness).fill()
		}

		return natural
	}

	private async textItem(i: number, f: number, opacity: number): Promise<void> {
		const text: DrawingText | undefined = this.data.texts[index(this.data.itemInts[i + ItemInt.REF])]

		if (text === undefined) return

		switch (text.kind) {
			case "glyphs":
				await this.glyphItem(text, opacity)
				return
			case "block":
				await this.blockItem(text, opacity)
				return
			case "body":
				await this.bodyItem(text, f, opacity)
				return
			default:
				// A story is a text box the page layout draws itself.
				return
		}
	}

	private fillOf(fill: number | undefined): number | undefined {
		const paint = fill === undefined ? undefined : this.data.paints[index(fill)]

		if (paint === undefined) return undefined

		return (
			this.solidOf(paint, [0, 0, 1, 1], 0) ??
			(paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient" ? averageColor(paint.stops) : undefined)
		)
	}

	private async glyphItem(text: Extract<DrawingText, { kind: "glyphs" }>, opacity: number): Promise<void> {
		const run = text.run

		if (run.text === "" || this.runsLeft <= 0) return

		this.runsLeft--

		const size = runPx(run, 1)
		const color = this.fillOf(text.fill)
		const positions = text.positions

		if (positions !== null && positions.length > 0) {
			// Each character at its own position, the anchor applied to each.
			const characters = Array.from(run.text).slice(0, Math.min(positions.length, 20_000))

			for (let k = 0; k < characters.length; k++) {
				const character = characters[k] ?? ""
				const shaped = await this.shape(character, run, false)
				const width = (shaped.width * size) / 1000
				const at = (positions[k] ?? 0) - (text.anchor === "middle" ? width / 2 : text.anchor === "end" ? width : 0)

				this.show(shaped, character, run, at, 0, size, opacity, color)
			}

			return
		}

		const shaped = await this.shape(run.text, run, false)
		const width = (shaped.width * size) / 1000

		this.show(
			shaped,
			run.text,
			run,
			text.anchor === "middle" ? -width / 2 : text.anchor === "end" ? -width : 0,
			0,
			size,
			opacity,
			color
		)
	}

	private async blockItem(text: Extract<DrawingText, { kind: "block" }>, opacity: number): Promise<void> {
		const run = text.run

		if (run.text === "" || this.runsLeft <= 0) return

		this.runsLeft--

		const size = runPx(run, 1)
		const fonts = this.context.fonts
		const request = this.request(run)
		const source = run.text.slice(0, 20_000)
		const pending = fonts.prepare(source, 0, source.length, request)

		if (pending !== undefined) await pending

		const measure = (value: string): number =>
			(fonts.shape(value, 0, value.length, request, { level: text.rtl ? 1 : 0, flags: 0, bidi: true }).width * size) / 1000
		const width = clamp(text.width, 0, MAX_COORD, 0)
		const height = clamp(text.height, 0, MAX_COORD, 0)
		const lineHeight = clamp(text.lineHeight, 0.01, MAX_COORD, size * 1.2)
		const lines = layoutBlock(source, width, height, lineHeight, text.wrap, text.lineLimit, text.trimming, measure)

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
		const color = this.fillOf(text.fill)
		const page = this.page

		page.saveState()

		if (text.clip && width > 0 && height > 0) page.rect(0, 0, width, height).clip()

		for (let k = 0; k < lines.length; k++) {
			const line = lines[k] ?? ""

			if (line === "") continue

			const shaped = await this.shape(line, run, text.rtl)
			const lineWidth = (shaped.width * size) / 1000
			const x = text.align === "middle" ? width / 2 - lineWidth / 2 : text.align === "end" ? width - lineWidth : 0

			this.show(shaped, line, run, x, top + k * lineHeight + ascent, size, opacity, color)
		}

		page.restoreState()
	}

	private bodyLines(paragraphs: readonly TextParagraph[], scale: number, reduction: number): BodyLine[] {
		const lines: BodyLine[] = []

		for (let p = 0; p < paragraphs.length && this.runsLeft > 0; p++) {
			const paragraph = paragraphs[p]

			if (paragraph === undefined) continue

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

	// Rich text laid out as the SVG painter lays it out: a line per paragraph or line break, no wrapping, anchored
	// in the box (rotated with the body and its vertical direction).
	private async bodyItem(text: Extract<DrawingText, { kind: "body" }>, f: number, opacity: number): Promise<void> {
		const body = text.body
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
		const page = this.page

		page.saveState()

		if (rotation !== 0) {
			const radians = (rotation * Math.PI) / 180
			const cos = Math.cos(radians)
			const sin = Math.sin(radians)

			page.concat([cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy])
		}

		for (const line of lines) {
			cursor += line.before

			await this.bodyLine(line, left, right, cursor + (line.height - line.size * 1.2) / 2 + line.size * 0.95, scale, opacity)

			cursor += line.height + line.after
		}

		page.restoreState()
	}

	private async bodyLine(line: BodyLine, left: number, right: number, baseline: number, scale: number, opacity: number): Promise<void> {
		const paragraph = line.paragraph
		const runs = paragraph.runs
		const marginLeft = clamp(paragraph.marginLeft, -10_000, 10_000, 0) + (line.first ? clamp(paragraph.indent, -10_000, 10_000, 0) : 0)
		const pieces: {
			readonly text: string
			readonly run: TextRun
			readonly shaped: PdfShapedText
			readonly size: number
			readonly width: number
		}[] = []
		const firstRun = runs[line.from]
		const add = async (value: string, run: TextRun): Promise<void> => {
			if (value === "") return

			const size = runPx(run, scale)
			const shaped = await this.shape(value, run, paragraph.rtl)
			const letter = clamp(run.spacing, -100, 100, 0) * PX_PER_PT

			pieces.push({ text: value, run, shaped, size, width: (shaped.width * size) / 1000 + letter * value.length })
		}

		if (line.first && paragraph.bullet !== "" && firstRun !== undefined)
			await add(`${symbolBullet(paragraph.bulletFont) ? "•" : paragraph.bullet} `, { ...firstRun, baseline: 0 })

		for (let r = line.from; r < line.to; r++) {
			const run = runs[r]

			if (run !== undefined) await add(run.caps === "all" ? run.text.toUpperCase() : run.text, run)
		}

		if (pieces.length === 0) return

		const widths = pieces.reduce((sum, piece) => sum + piece.width, 0)
		let x = paragraph.align === "ctr" ? (left + right) / 2 - widths / 2 : paragraph.align === "r" ? right - widths : left + marginLeft

		for (const piece of pieces) {
			const shift = clamp(piece.run.baseline, -1, 1, 0) * clamp(piece.run.size, 1, 1000, 11) * PX_PER_PT * scale

			this.show(piece.shaped, piece.text, piece.run, x, baseline - shift, piece.size, opacity)
			x += piece.width
		}
	}
}

// Paints `data` onto the context's page through `placement` (drawing px to page px).
export async function paintDrawingPdf(context: PdfDrawingContext, data: PdfDrawingData, placement: Matrix): Promise<void> {
	await new DrawingPainter(data, context).paint(placement)
}

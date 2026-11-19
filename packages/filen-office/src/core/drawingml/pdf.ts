import { ByteWriter } from "../pdfwrite/bytes"
import { ContentBuilder, type Matrix } from "../pdfwrite/content"
import type { PdfFontFaceRequest, PdfFontSet, PdfShapedText } from "../pdfwrite/fonts/fontSet"
import type { PdfGradient } from "../pdfwrite/shading"
import type { PdfImageData } from "../pdfwrite/images"
import type { PdfImage, PdfPage } from "../pdfwrite/page"
import type { PdfImageSource } from "../pdfwrite/writer"
import { closedCommands, commandBounds, compoundMask, type CompoundMask } from "./compoundLine"
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
	type DrawingClip,
	type DrawingImage,
	type DrawingText,
	type GradientStops,
	type ImageTile,
	type Paint,
	type Stroke,
	type TextRun
} from "./displayList"
import {
	averageColor,
	blockTop,
	bodyFrame,
	boundsThrough,
	clamp,
	finite,
	index,
	insetOf,
	lineBaseline,
	linearGradientLine,
	MAX_COORD,
	matrixOf,
	mixRgba,
	modify,
	patternCoverage,
	presetDashes,
	PX_PER_PT,
	recolorPixels,
	recolors,
	rgbaFrom,
	runPx,
	stopCount,
	symbolBullet,
	type BodyLine,
	type RunBudget
} from "./paintShared"
import { averageShade } from "./shade"
import { layoutBlock } from "./textBlock"

// A drawing's display list painted onto a PDF page as vectors: paths with their fills (solid, linear and path
// gradients as shadings, patterns as the blend of their colours, pictures clipped by the path), strokes with
// widths, caps, joins, dashes and compound or inset lines (soft-masked), clips (and their parents), pictures with
// their crop and opacity, and text shaped by the export's fonts. What it draws matches the SVG painter
// (react/docx/paint/drawing.ts) item for item; shadows and a clip group's opacity as one group are not drawn (each
// item takes the group's opacity).
//
// Coordinates are the drawing's px; `placement` maps them onto the page's px (see core/pdfwrite/page.ts). The
// caller opens the marked content (a Figure, or an artifact) around it.

// Shadows are not drawn, and text takes the export's fonts.
export type PdfDrawingData = Omit<DrawingData, "shadows" | "textFonts">

export interface PdfDrawingContext {
	readonly page: PdfPage
	readonly fonts: PdfFontSet
	// The picture of a drawing image as drawn (recoloured: see pictureSource), written once per export (undefined:
	// it does not draw).
	image(image: DrawingImage): Promise<PdfImage | undefined>
	// The family text without a typeface of its own is drawn in.
	readonly defaultFamily: string
	// Every colour drawn as its grey (a sheet printed in black and white).
	readonly gray?: boolean
}

// A picture's dedupe key: its part (or other key) plus the recolouring it is drawn with.
export function pictureKey(image: DrawingImage, key: string): string {
	if (!recolors(image)) return key

	return `${key}|${image.grayscale ? 1 : 0}|${String(image.biLevel)}|${String(image.brightness)}|${String(image.contrast)}|${String(image.duotone)}|${String(image.colorChange)}`
}

// The image source for a drawing image's bytes: recoloured as the screen draws it (decoded, then written as pixels).
export function pictureSource(image: DrawingImage, data: PdfImageData, key: string | undefined): PdfImageSource {
	if (!recolors(image)) return key === undefined ? { data } : { data, key }

	return {
		data,
		...(key === undefined ? {} : { key: pictureKey(image, key) }),
		transform: rgba => recolorPixels(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), image)
	}
}

const MAX_ITEMS = 200_000
const MAX_RUNS = 50_000
const MAX_CLIP_CHAIN = 1024
// Synthetic italic: the slant of a face drawn in place of an italic one.
const FAUX_ITALIC = 0.21

// The grey of a colour as SVG's saturate(0) gives it (Filter Effects 1 §feColorMatrix).
export function grayRgba(color: number): number {
	const r = (color >>> 24) & 255
	const g = (color >>> 16) & 255
	const b = (color >>> 8) & 255
	const y = 0.213 * r + 0.715 * g + 0.072 * b

	return rgbaFrom(y, y, y, color & 255)
}

function identity(m: Matrix): boolean {
	return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
}

class DrawingPainter {
	private readonly runs: RunBudget = { left: MAX_RUNS }
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

			if (clip === undefined || clip === null) break

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

	// Whether the item has a path of its own. State operators go before one is built (none inside a path object, §8.2).
	private hasPath(i: number): boolean {
		const ints = this.data.itemInts

		return (
			index(ints[i + ItemInt.FIRST_COMMAND]) >= 0 &&
			index(ints[i + ItemInt.COMMAND_COUNT]) > 0 &&
			index(ints[i + ItemInt.FIRST_COORD]) >= 0
		)
	}

	// Appends the item's own path; false when it has none.
	private path(i: number): boolean {
		const ints = this.data.itemInts
		const first = index(ints[i + ItemInt.FIRST_COMMAND])
		const count = index(ints[i + ItemInt.COMMAND_COUNT])
		const coord = index(ints[i + ItemInt.FIRST_COORD])

		if (!this.hasPath(i)) return false

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

			if (solid === undefined && paint.kind === "shaded") {
				// A plain mesh's outline is its triangles (a 3D scene's, a gradient triangle's), which the shading paints
				// exactly: no clip path is written. One the writer refuses fills the outline in its mean colour.
				const colors = opacity >= 1 ? paint.colors : paint.colors.map(color => this.alpha(color >>> 0, opacity))

				if (!(await page.mesh({ points: paint.points, colors })) && this.hasPath(i)) {
					page.fillColor(this.alpha(this.color(averageShade(paint.colors)), opacity))
					this.path(i)
					page.fill(evenOdd)
				}
			} else if (solid !== undefined) {
				if ((solid & 255) > 0 && this.hasPath(i)) {
					page.fillColor(this.alpha(this.color(solid), opacity))
					this.path(i)
					page.fill(evenOdd)
				}
			} else if (this.hasPath(i)) {
				page.saveState()
				this.path(i)
				page.clip(evenOdd)
				await this.paintArea(paint, box, opacity)
				page.restoreState()
			}
		}

		const line: Stroke | undefined = stroke < 0 ? undefined : this.data.strokes[stroke]

		if (line !== undefined) await this.strokePath(i, line, box, opacity, evenOdd)
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
				// A plain Gouraud mesh paints its area (a type 4 shading); one with a centre ramp, its mean colour.
				return paint.ramp === null &&
					paint.points instanceof Float32Array &&
					paint.colors instanceof Uint32Array &&
					paint.colors.length >= 3
					? undefined
					: paint.colors instanceof Uint32Array
						? averageShade(paint.colors)
						: 0
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
				await page.gradient(
					this.gradient(
						"axial",
						linearGradientLine(paint.angle, paint.scaled, x, y, width, height),
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
				const { cx, cy, rx, ry, inner } = pathGradientCircle(paint, width, height)

				// The unit circle placed as the gradient's ellipse, as the canvas painter draws it; bounds are the box there.
				page.saveState()
				page.concat([rx * width, 0, 0, ry * height, x + cx * width, y + cy * height])
				await page.gradient(
					this.gradient(
						"radial",
						[0, 0, 0, 0, 0, 1],
						paint.stops,
						inner,
						"pad",
						[-cx / rx, -cy / ry, (1 - cx) / rx, (1 - cy) / ry],
						opacity
					)
				)
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
			case "shaded": {
				const colors = opacity >= 1 ? paint.colors : paint.colors.map(color => this.alpha(color >>> 0, opacity))

				// A mesh the writer refuses (bounds that are no page geometry) shows its mean colour.
				if (!(await page.mesh({ points: paint.points, colors })))
					page.fillColor(this.alpha(this.color(averageShade(paint.colors)), opacity))
						.rect(x, y, width, height)
						.fill()

				break
			}
			case "image": {
				const image = this.data.images[index(paint.image)]

				if (image === undefined) break

				const tile = paint.tile ?? undefined

				// An explicit tile repeats through a tiling pattern; an implicit one is stretched, as on screen.
				if (tile !== undefined && tile.width !== undefined) {
					await this.tile(image, tile, box, opacity)
					break
				}

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

	private async strokePath(
		i: number,
		stroke: Stroke,
		box: readonly [number, number, number, number],
		opacity: number,
		evenOdd: boolean
	): Promise<void> {
		const page = this.page
		const paint = this.data.paints[index(stroke.paint)]
		const ints = this.data.itemInts
		const first = index(ints[i + ItemInt.FIRST_COMMAND])
		const count = index(ints[i + ItemInt.COMMAND_COUNT])

		if (paint === undefined || !this.hasPath(i)) return

		// A gradient or picture outline is drawn in its mean colour.
		const color =
			this.solidOf(paint, box, 0) ??
			(paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient" ? averageColor(paint.stops) : 0x000000ff)

		if ((color & 255) === 0) return

		const width = clamp(stroke.width, 0, 10_000, 1) || 1
		const cap = stroke.cap === "round" ? "round" : stroke.cap === "square" ? "square" : "butt"
		const join = stroke.join === "round" ? "round" : stroke.join === "bevel" ? "bevel" : "miter"
		const miterLimit = clamp(stroke.miterLimit, 1, 100, 8)
		const mask = compoundMask(stroke.compound, width, stroke.inset && closedCommands(this.data.commands, first, count))

		if (mask !== undefined) {
			page.saveState()
			await this.strokeMask(i, mask, cap, join, miterLimit, evenOdd)
		}

		page.strokeColor(this.alpha(this.color(color), opacity)).lineWidth(mask?.pen ?? width)
		page.lineCap(cap)
		page.lineJoin(join)

		if (join === "miter") page.miterLimit(miterLimit)

		const custom = stroke.customDash
		const dashes = custom !== null && custom.length > 0 ? Array.from(custom).slice(0, 32) : presetDashes(stroke.dash)

		if (dashes !== undefined && dashes.some(length => length > 0)) page.dash(dashes.map(length => clamp(length, 0, 1000, 0) * width))

		this.path(i)
		page.stroke()

		if (mask !== undefined) page.restoreState()
	}

	// A compound or inset outline's mask (core/drawingml/compoundLine) as a soft mask on the stroke that follows: the
	// keeping strokes white, the clearing ones and the cleared interior black.
	private async strokeMask(
		i: number,
		mask: CompoundMask,
		cap: "butt" | "round" | "square",
		join: "miter" | "round" | "bevel",
		miterLimit: number,
		evenOdd: boolean
	): Promise<void> {
		const { commands, coords, itemInts: ints } = this.data
		const first = index(ints[i + ItemInt.FIRST_COMMAND])
		const count = Math.min(index(ints[i + ItemInt.COMMAND_COUNT]), commands.length - first)
		const coord = index(ints[i + ItemInt.FIRST_COORD])
		const bounds = commandBounds(commands, coords, first, count, coord)

		if (bounds === undefined) return

		const content = new ContentBuilder(new ByteWriter(1024))
		const outline = (): void => {
			content.pathCommands(commands, coords, first, count, coord)
		}
		const strokes = (list: CompoundMask["outer"]): void => {
			for (const step of list) {
				content.op(step.keep ? "1 G" : "0 G").lineWidth(step.width)
				outline()
				content.stroke()
			}
		}
		// Miter joins reach out miterLimit half pens, square caps √2.
		const reach = (mask.pen / 2) * Math.max(join === "miter" ? miterLimit : 1, Math.SQRT2) + 1

		content.lineCap(cap).lineJoin(join)

		if (join === "miter") content.miterLimit(miterLimit)

		strokes(mask.outer)

		if (mask.inner !== null) {
			content.saveState()
			outline()
			content.clip(evenOdd)
			content.op("0 g")
			outline()
			content.fill(evenOdd)
			strokes(mask.inner)
			content.restoreState()
		}

		await this.page.softMask(content.out.view().slice(), [bounds[0] - reach, bounds[1] - reach, bounds[2] + reach, bounds[3] + reach])
	}

	// --- Pictures ---

	private async tile(
		image: DrawingImage,
		tile: ImageTile,
		box: readonly [number, number, number, number],
		opacity: number
	): Promise<void> {
		const width = clamp(tile.width, 0, MAX_COORD, 0)
		const height = clamp(tile.height, 0, MAX_COORD, 0)
		const m = matrixOf(Array.isArray(tile.matrix) ? tile.matrix : [])
		const page = this.page

		if (!(width > 0 && height > 0)) return

		if (tile.clamp === true) {
			page.saveState()
			page.concat(m)
			await this.drawPicture(image, 0, 0, width, height, opacity)
			page.restoreState()

			return
		}

		const picture = await this.context.image(image)

		if (picture === undefined) return

		const alpha = clamp(image.alpha, 0, 1, 1) * opacity

		page.saveState()

		if (alpha < 1) page.graphicsState({ fillAlpha: alpha })

		await page.tile(
			picture,
			{
				width,
				height,
				matrix: m,
				flipX: tile.flip === "x" || tile.flip === "xy",
				flipY: tile.flip === "y" || tile.flip === "xy",
				crop: insetOf(image.crop, -10, 1)
			},
			box[0],
			box[1],
			box[2],
			box[3]
		)
		page.restoreState()
	}

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

		if (run.text === "" || this.runs.left <= 0) return

		this.runs.left--

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

		if (run.text === "" || this.runs.left <= 0) return

		this.runs.left--

		const size = runPx(run, 1)
		const fonts = this.context.fonts
		const request = this.request(run)
		const source = run.text.slice(0, 20_000)
		const pending = fonts.prepare(source, 0, source.length, request)

		if (pending !== undefined) await pending

		const measure = (value: string): number =>
			(fonts.shape(value, 0, value.length, request, { level: text.rtl ? 1 : 0, flags: 0, bidi: true }).width * size) / 1000
		let width = clamp(text.width, 0, MAX_COORD, 0)
		const height = clamp(text.height, 0, MAX_COORD, 0)
		const lineHeight = clamp(text.lineHeight, 0.01, MAX_COORD, size * 1.2)
		const lines = layoutBlock(source, width, height, lineHeight, text.wrap, text.lineLimit, text.trimming, measure)

		if (lines.length === 0) return

		let stretch = 1

		if (text.stretch === true && width > 0) {
			let widest = 0

			for (const line of lines) widest = Math.max(widest, measure(line))

			if (widest > 0) {
				// Laid out at the natural width, then scaled on x to the rectangle's.
				stretch = width / widest
				width = widest
			}
		}

		const total = lines.length * lineHeight
		const top = blockTop(text.lineAlign, height, total)
		const ascent = clamp(text.ascent, 0, 3, 0.9) * size
		const color = this.fillOf(text.fill)
		const page = this.page

		page.saveState()

		if (stretch !== 1) page.concat([stretch, 0, 0, 1, 0, 0])
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

	// Rich text laid out as the SVG painter lays it out: a line per paragraph or line break, no wrapping, anchored
	// in the box (rotated with the body and its vertical direction).
	private async bodyItem(text: Extract<DrawingText, { kind: "body" }>, f: number, opacity: number): Promise<void> {
		const body = text.body
		const frame = bodyFrame(body, text.paragraphs, this.box(f), this.runs)

		if (frame === null) return

		const { left, right, rotation, cx, cy, scale } = frame
		let cursor = frame.top
		const page = this.page

		page.saveState()

		if (rotation !== 0) {
			const radians = (rotation * Math.PI) / 180
			const cos = Math.cos(radians)
			const sin = Math.sin(radians)

			page.concat([cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy])
		}

		for (const line of frame.lines) {
			cursor += line.before

			await this.bodyLine(line, left, right, lineBaseline(line, cursor), scale, opacity)

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

import {
	canvasDrawingImages,
	canvasTextFonts,
	paintDrawingCanvas,
	paintTextPageCanvas,
	type Canvas2DLike,
	type CanvasPaintContext
} from "../../core/drawingml/canvas"
import { EMU_PER_PX, MISSING_IMAGE, imageFormat, imageHandling, type DrawingImage } from "../../core/drawingml/index"
import type { RenderEffects, SlideRender, TextPage } from "../../core/presentation/output"
import { PICTURE_BULLET_OBJECT } from "../../core/presentation/text/page"
import { realmSurface, type RasterImage, type RealmCanvas } from "./services"

// Slides drawn on a canvas: the raster path of thumbnails, PNG/JPEG export, show layers and handout previews. A
// slide is its background, then each layer's drawing placed by its matrix and its text page by its text matrix, as
// the SVG compositor stacks them (white paper under everything). Pictures are decoded at the size they can be drawn
// at, a few at a time; with a DecodedPictures cache they are shared by the slides that show them (a layout's or a
// master's picture is decoded once for the deck), without one they are closed after the slide.

// Thumbnail widths served (px).
export const MIN_THUMB_WIDTH = 16
export const MAX_THUMB_WIDTH = 2048
// The thumbnail cache of a session (bitmap bytes, width x height x 4).
export const THUMB_CACHE_BYTES = 64 * 1024 * 1024

type Matrix = readonly number[]

function times(m1: Matrix, m2: Matrix): number[] {
	const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1
	const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2

	return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1]
}

function color(rgba: number): string {
	return `#${(rgba >>> 0).toString(16).padStart(8, "0")}`
}

// Effects of a layer the canvas does not draw exactly (counted per kind for the effects report).
export type UndrawnEffect = "innerShadow" | "softEdge"

// Draws what a layer's outer effects add under it: a shadow or glow as the canvas shadow of a copy drawn far off the
// canvas (so only the shadow lands; the layer itself is drawn once, after), the reflection as a mirrored copy below at
// the mean of its opacities. Inner shadows and soft edges are not drawn (counted for the effects report).
function paintEffects(
	ctx: Canvas2DLike<RasterImage>,
	effects: RenderEffects,
	scale: number,
	paint: (extra: Matrix) => void,
	undrawn: Map<UndrawnEffect, number>,
	bottom: number,
	away: number
): void {
	const cast = (shadow: string, blur: number, dx: number, dy: number): void => {
		ctx.save()
		ctx.shadowColor = shadow
		ctx.shadowBlur = Math.max(0, blur) * scale
		ctx.shadowOffsetX = (dx + away) * scale
		ctx.shadowOffsetY = dy * scale
		paint([1, 0, 0, 1, -away, 0])
		ctx.restore()
	}

	for (const effect of effects) {
		switch (effect.kind) {
			case "outerShadow":
				cast(color(effect.color), effect.blur, effect.dx, effect.dy)
				break
			case "glow":
				// The SVG compositor's drop-shadow(0 0 radius): a Gaussian of deviation radius / 2.
				cast(color(effect.color), effect.radius, 0, 0)
				break
			case "reflection": {
				const alpha = Math.min(1, Math.max(0, (effect.startAlpha + effect.endAlpha) / 2))

				if (alpha <= 0) break

				ctx.save()
				ctx.globalAlpha *= alpha
				// Mirrored about the layer's bottom edge, `distance` below it.
				paint([1, 0, 0, -1, 0, 2 * bottom + effect.distance])
				ctx.restore()
				break
			}
			case "innerShadow":
			case "softEdge":
				undrawn.set(effect.kind, (undrawn.get(effect.kind) ?? 0) + 1)
				break
			default:
				break
		}
	}
}

// Paints a rendered slide onto `ctx` at `scale` device px per slide px, slide point `origin` (slide px) at the canvas
// origin; the effects it could not draw, by kind.
export function paintSlideCanvas(
	ctx: Canvas2DLike<RasterImage>,
	render: SlideRender,
	scale: number,
	images: CanvasPaintContext<RasterImage>,
	origin: { readonly x: number; readonly y: number } = { x: 0, y: 0 }
): Map<UndrawnEffect, number> {
	const undrawn = new Map<UndrawnEffect, number>()
	const base = [scale, 0, 0, scale, -origin.x * scale, -origin.y * scale]
	// Further than any layer reaches: copies drawn this far left cast only their shadows onto the canvas.
	const away = Math.max(render.background.width, render.background.height, 1) * 4

	paintDrawingCanvas(ctx, render.background, base, images)

	for (const layer of render.layers) {
		// The effects are the drawing's, or its text's when the shape draws no fill or line (effectsOnText).
		const paint = (extra: Matrix, text: boolean = true): void => {
			paintDrawingCanvas(ctx, layer.drawing, times(base, times(extra, layer.matrix)), images)

			if (text && layer.text !== undefined) {
				const matrix = times(base, times(extra, layer.textMatrix ?? layer.matrix))

				paintTextPageCanvas(ctx, layer.text, matrix)
				paintPictureBullets(ctx, layer.text, matrix, images)
			}
		}
		const effects = layer.effects ?? []

		if (effects.length > 0) {
			const [, , , d = 1, , f = 0] = layer.matrix

			paintEffects(
				ctx,
				effects,
				scale,
				extra => paint(extra, layer.effectsOnText === true),
				undrawn,
				f + d * layer.drawing.height,
				away
			)
		}

		paint([1, 0, 0, 1, 0, 0])
	}

	return undrawn
}

// The picture a picture bullet shows, as a drawing image of its part (looked up by its part name).
function bulletImage(part: string): DrawingImage {
	const format = imageFormat(part, undefined)

	return { ...MISSING_IMAGE, partName: part, format, handling: imageHandling(format) }
}

// A text page's picture bullets drawn over their places (the page's objects of PICTURE_BULLET_OBJECT).
function paintPictureBullets(
	ctx: Canvas2DLike<RasterImage>,
	text: TextPage,
	matrix: Matrix,
	images: CanvasPaintContext<RasterImage>
): void {
	const page = text.page

	for (let k = 0; k < page.objectCount; k++) {
		const part = page.objectKinds[k] === PICTURE_BULLET_OBJECT ? text.images?.[page.objectInts[k * 3] ?? -1] : undefined
		const bitmap = part === undefined ? undefined : images.image(bulletImage(part))

		if (bitmap === undefined) continue

		const [x = 0, y = 0, w = 0, h = 0] = page.objectFloats.subarray(k * 4, k * 4 + 4)

		ctx.save()
		ctx.setTransform(matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0, matrix[3] ?? 1, matrix[4] ?? 0, matrix[5] ?? 0)
		ctx.drawImage(bitmap, x, y, w, h)
		ctx.restore()
	}
}

// Every picture a slide shows, once each (a picture bullet's too).
export function slideImages(render: SlideRender): DrawingImage[] {
	const seen = new Set<string>()
	const out: DrawingImage[] = []

	for (const layer of render.layers) {
		for (const part of layer.text?.images ?? []) {
			if (seen.has(part)) continue

			seen.add(part)
			out.push(bulletImage(part))
		}
	}

	for (const drawing of [render.background, ...render.layers.map(layer => layer.drawing)]) {
		for (const image of canvasDrawingImages(drawing)) {
			const key = image.partName ?? ""

			if (key === "" && image.bytes === undefined) continue
			if (key !== "" && seen.has(key)) continue

			if (key !== "") seen.add(key)

			out.push(image)
		}
	}

	return out
}

// The CSS fonts a slide's text draws in.
export function slideFonts(render: SlideRender): string[] {
	const fonts = new Set<string>()

	for (const layer of render.layers) if (layer.text !== undefined) for (const font of canvasTextFonts(layer.text)) fonts.add(font)

	return [...fonts]
}

const NATIVE: ReadonlySet<string> = new Set(["png", "jpeg", "gif", "bmp", "webp"])
const MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp"
}

export interface RasterizeOptions {
	readonly canvas: RealmCanvas
	// Deck size (EMU).
	readonly size: { readonly cx: number; readonly cy: number }
	readonly widthPx: number
	// A picture part's bytes; null when the package has none.
	readonly read: (part: string) => Promise<Uint8Array | null>
	// Decoded pictures shared across slides (the session's); absent: each slide decodes its own and closes them.
	readonly pictures?: DecodedPictures
}

// Decodes running at once for one slide (each can hold up to maxSide² pixels while it runs).
const DECODE_CONCURRENCY = 4

// Runs `jobs` at most `limit` at a time; every job settles before this does, and the first failure is thrown then.
async function settleAll(jobs: readonly (() => Promise<void>)[], limit: number): Promise<void> {
	let next = 0
	let failure: { readonly error: unknown } | undefined
	const lane = async (): Promise<void> => {
		while (next < jobs.length) {
			const job = jobs[next++] as () => Promise<void>

			try {
				await job()
			} catch (error) {
				failure ??= { error }
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, lane))

	if (failure !== undefined) throw failure.error
}

export interface RasterizedSlide {
	readonly bitmap: RasterImage
	readonly width: number
	readonly height: number
	readonly undrawn: ReadonlyMap<UndrawnEffect, number>
}

// A slide's pictures decoded for the canvas painter (at most `maxSide` px a side) and its faces loaded; release()
// closes the decodes it owns and gives back the shared ones it holds. On a failure everything is released first.
export interface SlidePictures {
	readonly images: CanvasPaintContext<RasterImage>
	release(): void
}

export async function decodeSlidePictures(render: SlideRender, options: RasterizeOptions, maxSide: number): Promise<SlidePictures> {
	const decoded = new Map<DrawingImage, RasterImage>()
	const byPart = new Map<string, RasterImage | undefined>()
	const pictures = options.pictures
	// Decodes this slide owns (closed after), and the shared ones it holds (released after).
	const owned: RasterImage[] = []
	const held: string[] = []
	const jobs: (() => Promise<void>)[] = []
	const release = (): void => {
		for (const bitmap of owned) bitmap.close()

		for (const key of held) pictures?.release(key)

		owned.length = 0
		held.length = 0
	}

	for (const image of slideImages(render)) {
		// An SVG picture without a raster fallback (asvg:svgBlip alone) is rasterised where SVG can be decoded.
		const svg = image.format === "svg" && image.partName !== undefined

		if (!NATIVE.has(image.format) && !svg) continue

		const part = image.partName

		if (part !== undefined) {
			if (byPart.has(part)) continue

			byPart.set(part, undefined)

			const load = async (): Promise<RasterImage | undefined> => {
				const bytes = await options.read(part)

				if (bytes === null) return undefined

				return svg ? options.canvas.svg?.(bytes, maxSide) : options.canvas.decode(bytes, MIME[image.format] ?? "", maxSide)
			}

			if (pictures === undefined) {
				jobs.push(async () => {
					const bitmap = await load()

					if (bitmap !== undefined) owned.push(bitmap)

					byPart.set(part, bitmap)
				})
			} else {
				const key = DecodedPictures.key(part, svg, maxSide)

				held.push(key)
				jobs.push(async () => {
					byPart.set(part, await pictures.acquire(key, load))
				})
			}
		} else if (image.bytes !== undefined && !svg) {
			const bytes = image.bytes

			jobs.push(async () => {
				const bitmap = await options.canvas.decode(bytes, MIME[image.format] ?? "", maxSide)

				if (bitmap === undefined) return

				owned.push(bitmap)
				decoded.set(image, bitmap)
			})
		}
	}

	try {
		await settleAll(jobs, DECODE_CONCURRENCY)
		await options.canvas.fontsReady(slideFonts(render))
	} catch (error) {
		release()

		throw error
	}

	const lookup = (image: DrawingImage): RasterImage | undefined =>
		decoded.get(image) ?? (image.partName === undefined ? undefined : byPart.get(image.partName))

	return { images: { image: lookup, surface: realmSurface(options.canvas) }, release }
}

// A slide as a bitmap `widthPx` wide (its height from the deck's aspect): pictures decoded at most twice the width
// (a cropped picture shows more of its pixels than its box), faces loaded, painted, the canvas handed off as the
// bitmap. Undefined when the realm has no canvas of that size.
export async function rasterizeSlide(render: SlideRender, options: RasterizeOptions): Promise<RasterizedSlide | undefined> {
	const slideWidth = Math.max(1, options.size.cx / EMU_PER_PX)
	const slideHeight = Math.max(1, options.size.cy / EMU_PER_PX)
	const width = Math.max(1, Math.round(options.widthPx))
	const height = Math.max(1, Math.round((width * slideHeight) / slideWidth))
	const canvas = options.canvas.canvas(width, height)
	const ctx = canvas?.getContext("2d") ?? null

	if (canvas === undefined || ctx === null) return undefined

	const pictures = await decodeSlidePictures(render, options, Math.min(4096, width * 2))

	try {
		ctx.fillStyle = "#ffffff"
		ctx.fillRect(0, 0, width, height)

		const undrawn = paintSlideCanvas(ctx, render, width / slideWidth, pictures.images)

		return { bitmap: canvas.transferToImageBitmap(), width, height, undrawn }
	} finally {
		pictures.release()
	}
}

// Decoded pictures shared by the slides of a session (thumbnails, show layers), by part and decode size: in use they
// stay, idle ones are kept up to a byte budget (least recently used closed first) and all are closed by clear().
export const DECODED_PICTURE_BYTES = 32 * 1024 * 1024
// Entries kept at most (parts that did not decode are remembered too, at no bytes).
const MAX_DECODED_PICTURES = 1024

interface DecodedPicture {
	readonly loaded: Promise<RasterImage | undefined>
	bitmap: RasterImage | undefined
	bytes: number
	users: number
}

export class DecodedPictures {
	private readonly entries = new Map<string, DecodedPicture>()
	private idleBytes = 0
	private readonly limit: number
	private cleared = false
	decodes = 0
	closed = 0

	constructor(limit: number = DECODED_PICTURE_BYTES) {
		this.limit = limit
	}

	static key(part: string, svg: boolean, maxSide: number): string {
		return `${svg ? "svg" : "raster"}\u0000${String(maxSide)}\u0000${part}`
	}

	get size(): number {
		return this.entries.size
	}

	// The picture, decoded once by `load` and held until release(key).
	acquire(key: string, load: () => Promise<RasterImage | undefined>): Promise<RasterImage | undefined> {
		let entry = this.entries.get(key)

		if (entry === undefined) {
			this.decodes++

			const created: DecodedPicture = {
				bitmap: undefined,
				bytes: 0,
				users: 0,
				loaded: load().then(
					bitmap => {
						if (bitmap === undefined) return undefined

						// Cleared or evicted while it decoded: nobody can release it later, so the slide waiting gets none.
						if (this.cleared || this.entries.get(key) !== created) {
							bitmap.close()
							this.closed++

							return undefined
						}

						created.bitmap = bitmap
						created.bytes = bitmap.width * bitmap.height * 4

						if (created.users === 0) this.idle(created.bytes)

						return bitmap
					},
					(error: unknown) => {
						// Not remembered: the next slide that shows it tries again.
						if (this.entries.get(key) === created) this.entries.delete(key)

						throw error
					}
				)
			}

			entry = created
		} else {
			this.entries.delete(key)

			if (entry.users === 0) this.idleBytes -= entry.bytes
		}

		entry.users++
		this.entries.set(key, entry)

		return entry.loaded
	}

	release(key: string): void {
		const entry = this.entries.get(key)

		if (entry === undefined || entry.users === 0) return

		entry.users--

		if (entry.users === 0) this.idle(entry.bytes)
	}

	private idle(bytes: number): void {
		this.idleBytes += bytes

		for (const [key, entry] of this.entries) {
			if (this.idleBytes <= this.limit && this.entries.size <= MAX_DECODED_PICTURES) break
			if (entry.users > 0) continue

			this.drop(key, entry)
		}
	}

	private drop(key: string, entry: DecodedPicture): void {
		this.entries.delete(key)

		if (entry.users === 0) this.idleBytes -= entry.bytes

		if (entry.bitmap !== undefined) {
			entry.bitmap.close()
			this.closed++
		}
	}

	clear(): void {
		this.cleared = true

		for (const [key, entry] of [...this.entries]) this.drop(key, entry)
	}
}

// Thumbnails by slide, revision and width, least recently used evicted first (closed as they go) beyond the byte
// budget.
export class ThumbnailCache {
	private readonly entries = new Map<string, { readonly bitmap: RasterImage; readonly bytes: number }>()
	private used = 0
	private readonly limit: number
	closed = 0

	constructor(limit: number = THUMB_CACHE_BYTES) {
		this.limit = limit
	}

	get bytes(): number {
		return this.used
	}

	get size(): number {
		return this.entries.size
	}

	static key(slide: number, revision: number, width: number): string {
		return `${String(slide)}:${String(revision)}:${String(width)}`
	}

	get(key: string): RasterImage | undefined {
		const entry = this.entries.get(key)

		if (entry === undefined) return undefined

		// Most recent last.
		this.entries.delete(key)
		this.entries.set(key, entry)

		return entry.bitmap
	}

	put(key: string, bitmap: RasterImage): void {
		const bytes = bitmap.width * bitmap.height * 4
		const old = this.entries.get(key)

		if (old !== undefined) this.drop(key, old)

		// One larger than the whole budget is not kept.
		if (bytes > this.limit) {
			bitmap.close()
			this.closed++

			return
		}

		this.entries.set(key, { bitmap, bytes })
		this.used += bytes

		for (const [oldest, entry] of this.entries) {
			if (this.used <= this.limit) break

			this.drop(oldest, entry)
		}
	}

	// Drops every entry of a slide whose revision is no longer `current`.
	invalidate(slide: number, current: number): void {
		const prefix = `${String(slide)}:`

		for (const [key, entry] of [...this.entries])
			if (key.startsWith(prefix) && !key.startsWith(`${prefix}${String(current)}:`)) this.drop(key, entry)
	}

	clear(): void {
		for (const [key, entry] of [...this.entries]) this.drop(key, entry)
	}

	private drop(key: string, entry: { readonly bitmap: RasterImage; readonly bytes: number }): void {
		this.entries.delete(key)
		this.used -= entry.bytes
		entry.bitmap.close()
		this.closed++
	}
}

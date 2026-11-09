import { IDENTITY, multiply, type DrawingData, type DrawingImage, type Paint, type Rgba } from "../../../core/drawingml/index"
import { ShadeJob, type ShadedMesh } from "../../../core/drawingml/shade"
import { encodePng } from "../../../core/metafile/dib"
import { PngSteps } from "../../../core/drawingml/shadePng"
import { mergeShadedRuns } from "./shadeRuns"
import type { RenderEffects, SlideLayer, TextPage } from "../../../core/presentation/output"
import { PICTURE_BULLET_OBJECT } from "../../../core/presentation/text/page"
import type { PresentationSessionApi } from "../../../dom/presentation/protocol"
import { drawingImages, paintDrawing } from "../../docx/paint/drawing"
import { paintPage, type PaintedPage } from "../../docx/paint/page"
import type { SlidePainter } from "../SlideView"

// The slide compositor: a SlideRender as DOM. The background, then per layer its drawing (one SVG from paintDrawing,
// placed by the layer's matrix) and its text (paintPage of the layer's TextPage, placed by its text matrix), so text
// stays selectable, findable and visible to screen readers. Pictures load through the session (`image`) as blob URLs
// and repaint the layers that show them; the bitmaps a drawing carries (a metafile's embedded images) take theirs at
// once, under the names the worker gives them. The URLs are shared by every paint of the session (the next slide, the show, a slide
// painted again) and kept, least recently used out, up to a byte budget once no paint shows them;
// releaseSlidePictures revokes a closed session's. Effects beyond the drawing's own shadow are an SVG filter (inner
// shadow, soft edge), CSS filters (glow, blur, further outer shadows) and a masked mirror copy (reflection), on the
// drawing, or on the text of a shape with no fill or line (SlideLayer.effectsOnText).

// Types the page shows natively (an SVG in <image> runs no script).
const SHOWN_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/svg+xml"])
const MAX_PX = 1e6
// Shaded meshes (3D scenes) are rasterised at this many device pixels per drawing px, rounded up to a power of two. One raster's pixels, and all of one paint's, are bounded.
const SHADE_OVERSAMPLE = 1
const MAX_SHADE_PIXELS = 2048 * 1024
const MAX_SHADE_TOTAL = 16 * 1024 * 1024
// Rasters one paint makes at most (each a PNG and a URL); past them a mesh shows its mean colour.
const MAX_SHADE_RASTERS = 256
// The page rasterises and encodes meshes in slices of at most this long, a macrotask apart.
const SHADE_SLICE_MS = 8
// Rasters asked of the worker at once.
const SHADE_IN_FLIGHT = 2

let painted = 0

type PageWindow = NonNullable<Document["defaultView"]>

// Encoded bytes of the pictures kept for later paints once no paint shows them.
export const SLIDE_PICTURE_BYTES = 48 * 1024 * 1024
// Pictures kept at most (parts that could not be shown are remembered too, at no bytes).
const MAX_PICTURES = 512

interface Picture {
	// Undefined while loading, or for a part that cannot be shown.
	url: string | undefined
	readonly loaded: Promise<string | undefined>
	bytes: number
	// Paints showing it.
	users: number
}

// The blob URLs of one session's pictures, in recency order (the first is evicted first).
class PictureCache {
	private readonly entries = new Map<string, Picture>()
	private idleBytes = 0
	private readonly urlApi: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">

	constructor(urlApi: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">) {
		this.urlApi = urlApi
	}

	get size(): number {
		return this.entries.size
	}

	acquire(key: string, session: PresentationSessionApi, window: PageWindow): Promise<string | undefined> {
		let entry = this.entries.get(key)

		if (entry === undefined) {
			const created: Picture = {
				url: undefined,
				bytes: 0,
				users: 0,
				loaded: session.image(key).then(
					result => {
						if (result === null || !SHOWN_TYPES.has(result.type) || this.entries.get(key) !== created) return undefined

						created.url = this.urlApi.createObjectURL(
							new window.Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.type })
						)
						created.bytes = result.bytes.byteLength

						if (created.users === 0) this.idle(created.bytes)

						return created.url
					},
					() => {
						if (this.entries.get(key) === created) this.entries.delete(key)

						return undefined
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

	// A picture already loaded, taken at once (a paint draws it in its first pass instead of again when it arrives).
	take(key: string): string | undefined {
		const entry = this.entries.get(key)

		if (entry?.url === undefined) return undefined

		this.entries.delete(key)
		this.entries.set(key, entry)

		if (entry.users === 0) this.idleBytes -= entry.bytes

		entry.users++

		return entry.url
	}

	// A bitmap a drawing carries, under its content key: one blob URL however many paints show it.
	hold(key: string, bytes: Uint8Array, type: string, window: PageWindow): string {
		const taken = this.take(key)

		if (taken !== undefined) return taken

		const url = this.urlApi.createObjectURL(new window.Blob([bytes as Uint8Array<ArrayBuffer>], { type }))

		this.entries.delete(key)
		this.entries.set(key, { url, loaded: Promise.resolve(url), bytes: bytes.byteLength, users: 1 })

		return url
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
			if (this.idleBytes <= SLIDE_PICTURE_BYTES && this.entries.size <= MAX_PICTURES) break
			if (entry.users > 0) continue

			this.drop(key, entry)
		}
	}

	private drop(key: string, entry: Picture): void {
		this.entries.delete(key)

		if (entry.users === 0) this.idleBytes -= entry.bytes
		if (entry.url !== undefined) this.urlApi.revokeObjectURL(entry.url)
	}

	clear(): void {
		for (const [key, entry] of [...this.entries]) this.drop(key, entry)
	}
}

const pictureCaches = new WeakMap<PresentationSessionApi, PictureCache>()

function picturesOf(session: PresentationSessionApi, window: PageWindow): PictureCache {
	let cache = pictureCaches.get(session)

	if (cache === undefined) {
		cache = new PictureCache(window.URL)
		pictureCaches.set(session, cache)
	}

	return cache
}

// Revokes every picture URL of a session (when its deck closes).
export function releaseSlidePictures(session: PresentationSessionApi): void {
	pictureCaches.get(session)?.clear()
	pictureCaches.delete(session)
}

// Pictures a session's cache holds (tests and diagnostics).
export function slidePictureCount(session: PresentationSessionApi): number {
	return pictureCaches.get(session)?.size ?? 0
}

function finite(value: number | undefined): number {
	const v = value ?? 0

	return Number.isFinite(v) ? Math.max(-MAX_PX, Math.min(MAX_PX, v)) : 0
}

function cssMatrix(matrix: readonly number[]): string {
	return `matrix(${[0, 1, 2, 3, 4, 5].map(k => String(Math.round(finite(matrix[k]) * 10000) / 10000)).join(",")})`
}

function cssColor(color: Rgba): string {
	const value = color >>> 0

	return `rgba(${String((value >>> 24) & 255)},${String((value >>> 16) & 255)},${String((value >>> 8) & 255)},${String(Math.round(((value & 255) / 255) * 1000) / 1000)})`
}

// MIME types of the encodings a drawing may carry inline (a metafile's embedded bitmap) that the page shows.
const INLINE_TYPES: Readonly<Partial<Record<DrawingImage["format"], string>>> = {
	png: "image/png",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp"
}

function imageKey(image: DrawingImage): string | undefined {
	const key = image.svgPartName ?? image.partName

	return typeof key === "string" ? key : undefined
}

const SVG_NS = "http://www.w3.org/2000/svg"

function primitive(document: Document, parent: Element, name: string, attributes: Readonly<Record<string, string>>): Element {
	const element = document.createElementNS(SVG_NS, name)

	for (const key in attributes) element.setAttribute(key, attributes[key] as string)

	parent.append(element)

	return element
}

// The SVG filter (in a zero-size SVG) of the effects no CSS filter function draws: an inner shadow (§20.1.8.40: the
// colour, offset and blurred, shown inside the shape's alpha only) and a soft edge (§20.1.8.53: the alpha eroded by
// half the radius and blurred, so the edge fades out over it); undefined for neither.
function effectSvg(document: Document, effects: RenderEffects | undefined, id: string): SVGSVGElement | undefined {
	let inner: Extract<RenderEffects[number], { kind: "outerShadow" | "innerShadow" }> | undefined
	let soft: Extract<RenderEffects[number], { kind: "softEdge" }> | undefined

	for (const effect of effects ?? []) {
		if (effect.kind === "innerShadow") inner ??= effect
		else if (effect.kind === "softEdge" && finite(effect.radius) > 0) soft ??= effect
	}

	if (inner === undefined && soft === undefined) return undefined

	const svg = document.createElementNS(SVG_NS, "svg")
	const filter = primitive(document, svg, "filter", { id, "color-interpolation-filters": "sRGB" })
	let current = "SourceGraphic"

	svg.setAttribute("aria-hidden", "true")
	svg.setAttribute("width", "0")
	svg.setAttribute("height", "0")
	svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden"

	if (inner !== undefined) {
		const value = inner.color >>> 0

		// The shape's alpha offset and blurred, inverted (blurring first keeps the region edge out of it).
		primitive(document, filter, "feOffset", {
			in: "SourceAlpha",
			dx: String(finite(inner.dx)),
			dy: String(finite(inner.dy)),
			result: "io"
		})
		primitive(document, filter, "feGaussianBlur", { in: "io", stdDeviation: String(Math.max(0, finite(inner.blur)) / 2), result: "ib" })
		primitive(document, primitive(document, filter, "feComponentTransfer", { in: "ib", result: "ii" }), "feFuncA", {
			type: "table",
			tableValues: "1 0"
		})
		primitive(document, filter, "feFlood", {
			"flood-color": `rgb(${String(value >>> 24)},${String((value >>> 16) & 255)},${String((value >>> 8) & 255)})`,
			"flood-opacity": String(Math.round(((value & 255) / 255) * 1000) / 1000),
			result: "ic"
		})
		primitive(document, filter, "feComposite", { in: "ic", in2: "ii", operator: "in", result: "is" })
		primitive(document, filter, "feComposite", { in: "is", in2: "SourceAlpha", operator: "in", result: "it" })

		const merge = primitive(document, filter, "feMerge", { result: "inner" })

		primitive(document, merge, "feMergeNode", { in: current })
		primitive(document, merge, "feMergeNode", { in: "it" })
		current = "inner"
	}

	if (soft !== undefined) {
		const radius = finite(soft.radius)

		primitive(document, filter, "feMorphology", { in: "SourceAlpha", operator: "erode", radius: String(radius / 2), result: "se" })
		primitive(document, filter, "feGaussianBlur", { in: "se", stdDeviation: String(radius / 4), result: "sb" })
		primitive(document, filter, "feComposite", { in: current, in2: "sb", operator: "in", result: "soft" })
	}

	return svg
}

// The CSS filter of a layer's effects (those a filter can draw), after the SVG filter `svg` (effectSvg) when given.
function effectFilter(effects: RenderEffects | undefined, svg: string | undefined): string {
	if (effects === undefined) return ""

	const out: string[] = svg === undefined ? [] : [`url(#${svg})`]

	for (const effect of effects) {
		switch (effect.kind) {
			case "glow":
				out.push(`drop-shadow(0 0 ${String(finite(effect.radius))}px ${cssColor(effect.color)})`)
				break
			case "blur":
				out.push(`blur(${String(finite(effect.radius))}px)`)
				break
			case "outerShadow":
				out.push(
					`drop-shadow(${String(finite(effect.dx))}px ${String(finite(effect.dy))}px ${String(finite(effect.blur) / 2)}px ${cssColor(effect.color)})`
				)
				break
			default:
				break
		}
	}

	return out.join(" ")
}

function invert(m: readonly number[]): number[] | undefined {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m
	const det = a * d - b * c

	if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return undefined

	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

function positioned(document: Document, className: string, matrix: readonly number[]): HTMLElement {
	const element = document.createElement("div")

	element.className = className
	element.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:${cssMatrix(matrix)}`

	return element
}

type ShadedPaint = Extract<Paint, { kind: "shaded" }>

interface ShadeRequest {
	readonly image: SVGImageElement
	readonly paint: ShadedPaint
	// Drawing units per local unit where it is drawn.
	readonly scale: number
	bucket: number
}

interface QueuedShade {
	// The plan: its size and extent (the worker plans the same meshes, scale and pixels alike).
	readonly job: ShadeJob
	readonly entry: ShadeEntry
	readonly meshes: readonly ShadedMesh[]
	readonly scale: number
	readonly maxPixels: number
	png?: PngSteps
}

// The pixels a raster planned at `full` keeps when a paint's budget is shared out at `factor` (linear).
function scaledPixels(full: ShadeJob, factor: number, left: number): number {
	return Math.min(Math.floor(full.width * full.height * factor * factor), left)
}

interface ShadeEntry {
	url: string | undefined
	readonly waiting: SVGImageElement[]
	// The joint raster's extent in the meshes' local units, once planned; undefined for a mean colour.
	bounds: readonly [number, number, number, number] | undefined
	// The images showing it, placed over the extent once it is planned.
	readonly images: SVGImageElement[]
}

// A number per shaded paint, for the keys of the rasters that hold it.
const shadeIds = new WeakMap<ShadedPaint, number>()
let shadeCount = 0

function shadeId(paint: ShadedPaint): number {
	let id = shadeIds.get(paint)

	if (id === undefined) {
		id = ++shadeCount
		shadeIds.set(paint, id)
	}

	return id
}

// The transforms from `element` up to the drawing's SVG: the local space it is drawn in.
function spaceOf(element: Element, svg: Element): string {
	let space = ""

	for (let at = element.parentElement; at !== null && at !== svg; at = at.parentElement) space += `${at.getAttribute("transform") ?? ""};`

	return space
}

// 1 x 1 PNGs of mean colours, as data URLs (no blob URL to revoke).
const meanColors = new Map<number, string>()
const MAX_MEAN_COLORS = 1024

function meanColorUrl(meshes: readonly ShadedMesh[], window: PageWindow): string {
	let r = 0
	let g = 0
	let b = 0
	let a = 0
	let n = 0

	for (const mesh of meshes) {
		for (const color of mesh.colors) {
			r += color >>> 24
			g += (color >>> 16) & 255
			b += (color >>> 8) & 255
			a += color & 255
			n++
		}
	}

	const mean = n === 0 ? 0 : ((Math.round(r / n) << 24) | (Math.round(g / n) << 16) | (Math.round(b / n) << 8) | Math.round(a / n)) >>> 0
	const known = meanColors.get(mean)

	if (known !== undefined) return known
	if (meanColors.size >= MAX_MEAN_COLORS) meanColors.clear()

	const png = encodePng(Uint8Array.of(mean >>> 24, (mean >>> 16) & 255, (mean >>> 8) & 255, mean & 255), 1, 1)
	const url = `data:image/png;base64,${window.btoa(String.fromCharCode(...png))}`

	meanColors.set(mean, url)

	return url
}

// The image at `url` decoded (an engine without decode() decodes it when it is shown).
async function decoded(window: PageWindow, url: string): Promise<void> {
	const Image = (window as unknown as { Image?: typeof HTMLImageElement }).Image

	if (typeof Image !== "function") return

	const image = new Image()

	if (typeof image.decode !== "function") return

	image.src = url
	await image.decode().catch(() => undefined)
}

// A timer turn of the page: other tasks and the page's own timers run between slices (a chain of MessageChannel
// turns runs back to back in Chromium and starves its timers for the whole raster).
function pageTurn(window: PageWindow): () => Promise<void> {
	return () => new Promise(resolve => window.setTimeout(resolve, 0))
}

export const paintSlide: SlidePainter = (render, context) => paint(render, context, false)

// The editor's compositor: paintSlide plus the empty placeholders' prompts (SlideLayer.prompt, in a .fo-slide-prompt
// holder the text editor hides while the shape is edited). The show, the presenter and the viewer paint with
// paintSlide, so they never draw a prompt even from the editor's renders.
export const paintEditorSlide: SlidePainter = (render, context) => paint(render, context, true)

function paint(render: Parameters<SlidePainter>[0], context: Parameters<SlidePainter>[1], prompts: boolean): ReturnType<SlidePainter> {
	const { document, session, signal } = context
	const id = ++painted
	const root = document.createElement("div")
	const width = finite(render.background.width)
	const height = finite(render.background.height)
	const urls = new Map<string, string>()
	const pending = new Map<string, (() => void)[]>()
	// The pictures this paint holds in the session's cache.
	const held: string[] = []
	const window = document.defaultView
	let released = false

	root.className = "fo-slide"
	root.dataset["foSlide"] = String(render.index)
	root.style.cssText = `position:relative;width:${String(width)}px;height:${String(height)}px;overflow:hidden;background:#fff`

	// Pictures the drawings carry as bytes (no part to load): held in the session's cache under the name the worker
	// gives each bitmap (bytesKey), so every paint of the session shares one blob URL per bitmap; unnamed, or without a
	// session, one URL each for this paint, revoked on release. A cache key that starts with a space is no part name.
	const inline = new Map<DrawingImage, string>()
	const ownInline: string[] = []
	// Shaded meshes (3D scenes, metafile gradient triangles): a drawing's meshes drawn in one local space at one
	// resolution share one raster (each image shows it clipped to its own outline, so later triangles over earlier
	// ones as drawn), rasterised in slices off the paint's own task; by the meshes it holds, the URL once made and the
	// images waiting for it.
	const shades = new Map<string, ShadeEntry>()
	const queue: QueuedShade[] = []
	// Rasters asked for and not planned yet: planned together at the start of the next slice, so the paint's pixel
	// budget is shared by all of them (each scaled alike), not spent by the first ones painted.
	const unplanned: { readonly entry: ShadeEntry; readonly meshes: readonly ShadedMesh[]; readonly bucket: number }[] = []
	let running = false
	let shadePixels = MAX_SHADE_TOTAL
	let shadeRasters = MAX_SHADE_RASTERS
	const settle = (entry: ShadeEntry, url: string): void => {
		entry.url = url

		for (const waiting of entry.waiting) waiting.setAttribute("href", url)

		entry.waiting.length = 0
	}
	const place = (entry: ShadeEntry, image: SVGImageElement): void => {
		const bounds = entry.bounds

		if (bounds !== undefined) {
			image.setAttribute("x", String(bounds[0]))
			image.setAttribute("y", String(bounds[1]))
			image.setAttribute("width", String(bounds[2]))
			image.setAttribute("height", String(bounds[3]))
		}
	}
	const plan = (): void => {
		if (window === null || unplanned.length === 0) return

		const batch = unplanned.splice(0)
		const wanted = batch.map((asked, k) =>
			k < shadeRasters && shadePixels > 0 ? ShadeJob.plan(asked.meshes, asked.bucket, MAX_SHADE_PIXELS) : undefined
		)
		const total = wanted.reduce((sum, job) => sum + (job === undefined ? 0 : job.width * job.height), 0)
		const factor = total > shadePixels ? Math.sqrt(shadePixels / total) : 1

		batch.forEach((asked, k) => {
			const full = wanted[k]
			const job =
				full === undefined || shadePixels <= 0
					? undefined
					: factor < 1
						? ShadeJob.plan(asked.meshes, asked.bucket, scaledPixels(full, factor, shadePixels))
						: full

			if (job === undefined) {
				asked.entry.images.length = 0
				settle(asked.entry, meanColorUrl(asked.meshes, window))

				return
			}

			asked.entry.bounds = job.bounds

			for (const image of asked.entry.images) place(asked.entry, image)

			asked.entry.images.length = 0

			shadePixels -= job.width * job.height
			shadeRasters--
			queue.push({
				job,
				entry: asked.entry,
				meshes: asked.meshes,
				scale: asked.bucket,
				maxPixels:
					full !== undefined && factor < 1 ? scaledPixels(full, factor, shadePixels + job.width * job.height) : MAX_SHADE_PIXELS
			})
		})
	}
	const remote = async (next: QueuedShade): Promise<void> => {
		if (session === undefined || window === null) return

		const answer = await session.shade(next.meshes, next.scale, next.maxPixels).catch(() => null)

		if (released) return
		if (answer === null) {
			settle(next.entry, meanColorUrl(next.meshes, window))

			return
		}

		const url = window.URL.createObjectURL(answer.png as unknown as Blob)

		ownInline.push(url)
		await decoded(window, url)

		if (!released) settle(next.entry, url)
	}
	// The queued rasters: asked of the session's worker, or (without a session) made here in slices of at most
	// SHADE_SLICE_MS, a timer turn apart.
	const run = async (): Promise<void> => {
		if (running || window === null) return

		running = true

		const now = (): number => window.performance.now()
		const turn = pageTurn(window)

		try {
			// Never in the paint's own task.
			await turn()

			// The session's worker rasterises and encodes (a few at a time); the page only makes the URL and decodes the
			// image before it shows it.
			if (session !== undefined) {
				for (plan(); queue.length > 0 && !released && !signal.aborted; plan()) {
					await Promise.all(queue.splice(0, SHADE_IN_FLIGHT).map(next => remote(next)))
				}

				return
			}

			for (plan(); queue.length > 0 && !released && !signal.aborted; plan()) {
				const deadline = now() + SHADE_SLICE_MS
				const stop = (): boolean => now() >= deadline

				while (queue.length > 0 && !stop()) {
					const next = queue[0] as (typeof queue)[number]

					if (!next.job.step(stop)) break

					const raster = next.job.result()

					next.png ??= new PngSteps(raster.rgba, raster.width, raster.height)

					if (!next.png.step(stop)) break

					queue.shift()

					const url = window.URL.createObjectURL(new window.Blob([...next.png.result()], { type: "image/png" }))

					ownInline.push(url)
					// Decoded off the thread before it is shown, one raster at a time: a large one decoded at paint blocks the frame.
					await decoded(window, url)

					if (released) return

					settle(next.entry, url)
				}

				if (queue.length > 0) await turn()
			}
		} finally {
			running = false
			queue.length = 0
		}
	}
	// The images paintDrawing made for a drawing's shaded paints, once its SVG is built (their local space is the
	// transforms around them).
	const shadeAll = (requests: readonly ShadeRequest[], svg: Element): void => {
		if (window === null || requests.length === 0) return

		const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
		const groups = new Map<string, ShadeRequest[]>()

		for (const request of requests) {
			const wanted = request.scale * ratio * SHADE_OVERSAMPLE
			const bucket = 2 ** Math.ceil(Math.log2(Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.max(wanted, 1 / 64), 64) : 1))
			// A ramp is a paint's own: its mesh is rasterised alone.
			const key = `${String(bucket)}|${spaceOf(request.image, svg)}${request.paint.ramp === null ? "" : `|${String(shadeId(request.paint))}`}`
			const group = groups.get(key)

			request.bucket = bucket

			if (group === undefined) groups.set(key, [request])
			else group.push(request)
		}

		for (const [key, group] of groups) {
			const meshes: ShadedMesh[] = []
			let signature = key

			for (const request of group) {
				if (meshes.at(-1) !== request.paint) {
					meshes.push(request.paint)
					signature += `,${String(shadeId(request.paint))}`
				}
			}

			let entry = shades.get(signature)

			if (entry === undefined) {
				entry = { url: undefined, waiting: [], bounds: undefined, images: [] }
				shades.set(signature, entry)
				unplanned.push({ entry, meshes, bucket: group[0]?.bucket ?? 1 })
			}

			for (const request of group) {
				// Placed now when planned, else once it is.
				if (entry.bounds === undefined && entry.url === undefined) entry.images.push(request.image)
				else place(entry, request.image)

				if (entry.url === undefined) entry.waiting.push(request.image)
				else request.image.setAttribute("href", entry.url)
			}
		}

		void run()
	}

	const imageUrl = (image: DrawingImage): string | undefined => {
		const key = imageKey(image)

		return key === undefined ? inline.get(image) : urls.get(key)
	}
	const carried = (data: DrawingData): void => {
		if (window === null) return

		for (const image of data.images) {
			const type = image?.bytes === undefined || imageKey(image) !== undefined ? undefined : INLINE_TYPES[image.format]

			if (type === undefined || inline.has(image) || image.bytes === undefined) continue

			if (session === undefined || image.bytesKey === undefined) {
				const url = window.URL.createObjectURL(new window.Blob([image.bytes as Uint8Array<ArrayBuffer>], { type }))

				ownInline.push(url)
				inline.set(image, url)

				continue
			}

			const key = ` ${image.bytesKey}`

			held.push(key)
			inline.set(image, picturesOf(session, window).hold(key, image.bytes, type, window))
		}
	}

	// Paints `data` into `holder` now, and again whenever one of its pictures arrives.
	const drawInto = (holder: HTMLElement, data: DrawingData, prefix: string): void => {
		// The holder is the drawing's frame: paintDrawing's SVG fills its parent (100%), and an unsized absolute holder
		// would leave it at the SVG default 300 x 150. A flat frame (a straight line) gets 1 px on its flat side, in
		// unscaled units, since a zero-size SVG renders nothing; the stroke overflows it.
		const frameWidth = Math.max(1, finite(data.width))
		const frameHeight = Math.max(1, finite(data.height))
		const paint = (): void => {
			const requests: ShadeRequest[] = []
			const shade = (image: SVGImageElement, paint: ShadedPaint, scale: number): void => {
				requests.push({ image, paint, scale, bucket: 1 })
			}
			const svg = paintDrawing(mergeShadedRuns(data), { document, idPrefix: prefix, imageUrl, shade })

			shadeAll(requests, svg)

			svg.setAttribute("width", String(frameWidth))
			svg.setAttribute("height", String(frameHeight))
			svg.setAttribute("viewBox", `0 0 ${String(frameWidth)} ${String(frameHeight)}`)
			// Block, not inline: an inline SVG sits on the holder's text baseline, which moves a drawing shorter than the
			// line box down by the line's ascent minus its height.
			svg.style.display = "block"
			holder.replaceChildren(svg)
		}

		holder.style.width = `${String(frameWidth)}px`
		holder.style.height = `${String(frameHeight)}px`
		carried(data)

		const images = session === undefined || window === null ? [] : drawingImages(data)
		const cache = session === undefined || window === null ? undefined : picturesOf(session, window)

		for (const image of images) {
			const key = imageKey(image)

			if (key === undefined || urls.has(key) || pending.has(key)) continue

			const url = cache?.take(key)

			if (url !== undefined) {
				held.push(key)
				urls.set(key, url)
			}
		}

		paint()

		for (const image of images) {
			const key = imageKey(image)

			if (key === undefined || urls.has(key)) continue

			let waiting = pending.get(key)

			if (waiting === undefined) {
				waiting = []
				pending.set(key, waiting)
				load(key)
			}

			waiting.push(paint)
		}
	}

	const load = (key: string): void => {
		if (signal.aborted || session === undefined || window === null) return

		held.push(key)
		void picturesOf(session, window)
			.acquire(key, session, window)
			.then(url => {
				const waiting = pending.get(key) ?? []

				pending.delete(key)

				if (url === undefined || released || signal.aborted) return

				urls.set(key, url)

				for (const repaint of waiting) repaint()
			})
	}

	// A text page's picture bullets: each object box shows its picture, now when the session holds it, else once it
	// arrives (as a drawing's pictures do).
	const bulletPictures = (painted: PaintedPage, text: TextPage): void => {
		for (const object of painted.objects) {
			const key = object.kind === PICTURE_BULLET_OBJECT ? text.images?.[object.id] : undefined

			if (key === undefined) continue

			const show = (): void => {
				const url = urls.get(key)

				if (url !== undefined)
					object.element.style.background = `center / contain no-repeat url("${url.replace(/["\\]/gu, "\\$&")}")`
			}

			if (!urls.has(key) && !pending.has(key)) {
				const url = session === undefined || window === null ? undefined : picturesOf(session, window).take(key)

				if (url !== undefined) {
					held.push(key)
					urls.set(key, url)
				}
			}

			if (urls.has(key)) {
				show()

				continue
			}

			let waiting = pending.get(key)

			if (waiting === undefined) {
				waiting = []
				pending.set(key, waiting)
				load(key)
			}

			waiting.push(show)
		}
	}

	const background = document.createElement("div")

	background.className = "fo-slide-background"
	background.style.cssText = "position:absolute;left:0;top:0"
	drawInto(background, render.background, `fo-s${String(id)}-bg-`)
	root.append(background)

	render.layers.forEach((layer: SlideLayer, index) => {
		const element = document.createElement("div")

		// The layer box is the drawing's frame placed by the layer's matrix; its drawing fills it and its text is
		// placed relative to it (the text matrix through the layer's inverse). A layer whose matrix cannot be inverted
		// stays at the slide's origin and places each part by its own matrix.
		const inverse = invert(layer.matrix)
		const own = inverse === undefined ? layer.matrix : IDENTITY
		const width = Math.max(1, finite(layer.drawing.width))
		const height = Math.max(1, finite(layer.drawing.height))

		element.className = "fo-slide-layer"
		element.dataset["foLayer"] = String(index)
		element.style.cssText =
			inverse === undefined
				? "position:absolute;left:0;top:0;width:0;height:0"
				: `position:absolute;left:0;top:0;width:${String(width)}px;height:${String(height)}px;transform-origin:0 0;transform:${cssMatrix(layer.matrix)}`

		// A shape with no fill or line draws its effects on its text (effectsOnText), else on its drawing.
		const onText = layer.effectsOnText === true && layer.text !== undefined
		const svgId = `fo-s${String(id)}-${String(index)}-fx`
		const svg = effectSvg(document, layer.effects, svgId)
		const filter = effectFilter(layer.effects, svg === undefined ? undefined : svgId)
		const textMatrix = layer.textMatrix ?? layer.matrix
		const textPlace = inverse === undefined ? textMatrix : multiply(inverse, textMatrix)
		const textInto = (holder: HTMLElement, text: TextPage): void => {
			// The TextPage is both the page's tables and the DrawingML paint tables its styles index.
			const page = paintPage(text.page, { document, tables: text, paints: text })

			// paintPage marks its own stacking layers with data-fo-layer (nothing reads them); a slide layer's mark must be
			// the nearest one to its links, so they go.
			for (const inner of page.root.querySelectorAll<HTMLElement>("[data-fo-layer]")) delete inner.dataset["foLayer"]

			bulletPictures(page, text)
			holder.append(page.root)
		}
		// Mirror copies under the shape, each faded from startAlpha to endAlpha over endPos of its height.
		const reflect = (fill: (inner: HTMLElement) => void): void => {
			for (const effect of layer.effects ?? []) {
				if (effect.kind !== "reflection") continue

				const mirror = positioned(document, "fo-slide-reflection", own)
				const inner = document.createElement("div")
				const h = finite(layer.drawing.height)
				const end = Math.max(0, Math.min(1, effect.endPos)) * 100
				const filters = [svg === undefined ? "" : `url(#${svgId})`, effect.blur > 0 ? `blur(${String(finite(effect.blur))}px)` : ""]
					.filter(part => part !== "")
					.join(" ")

				inner.style.cssText =
					`transform-origin:0 0;transform:translate(0,${String(2 * h + finite(effect.distance))}px) scale(1,-1);` +
					`mask-image:linear-gradient(to top,rgba(0,0,0,${String(effect.startAlpha)}) 0%,rgba(0,0,0,${String(effect.endAlpha)}) ${String(end)}%,transparent ${String(end)}%)` +
					(filters === "" ? "" : `;filter:${filters}`)
				mirror.setAttribute("aria-hidden", "true")
				fill(inner)
				mirror.append(inner)
				element.append(mirror)
			}
		}

		if (svg !== undefined) element.append(svg)

		if (layer.drawing.itemCount > 0) {
			const drawing = positioned(document, "fo-slide-drawing", own)

			if (filter !== "" && !onText) drawing.style.filter = filter
			if (layer.alt !== undefined) {
				drawing.setAttribute("role", "img")
				drawing.setAttribute("aria-label", layer.alt)
			}

			drawInto(drawing, layer.drawing, `fo-s${String(id)}-${String(index)}-`)

			if (!onText) reflect(inner => drawInto(inner, layer.drawing, `fo-s${String(id)}-${String(index)}-r-`))

			element.append(drawing)
		}

		const prompt = prompts && layer.text === undefined ? layer.prompt : undefined
		const text = layer.text ?? prompt

		if (text !== undefined) {
			const holder = positioned(document, prompt === undefined ? "fo-slide-text" : "fo-slide-prompt", textPlace)

			// A prompt is no content: screen readers, selection and find skip it.
			if (prompt !== undefined) {
				holder.setAttribute("aria-hidden", "true")
				holder.dataset["foPrompt"] = ""
				holder.style.userSelect = "none"
			}

			// The text's mirror copy is inert (its links take no focus or pointer; selection and find skip it). A layer
			// whose matrix cannot be inverted has no local space to mirror the text in (its drawing's mirror collapses too).
			if (onText) {
				if (filter !== "") holder.style.filter = filter
				if (inverse !== undefined) {
					reflect(inner => {
						const copy = positioned(document, "fo-slide-reflection-text", textPlace)

						copy.setAttribute("inert", "")
						copy.style.pointerEvents = "none"
						copy.style.userSelect = "none"
						textInto(copy, text)
						inner.append(copy)
					})
				}
			}

			textInto(holder, text)
			element.append(holder)
		}

		root.append(element)
	})

	return {
		root,
		release: () => {
			if (released) return

			released = true
			pending.clear()
			urls.clear()

			for (const url of ownInline) window?.URL.revokeObjectURL(url)

			ownInline.length = 0
			inline.clear()
			shades.clear()
			queue.length = 0

			const cache = session === undefined ? undefined : pictureCaches.get(session)

			for (const key of held) cache?.release(key)

			held.length = 0
		}
	}
}

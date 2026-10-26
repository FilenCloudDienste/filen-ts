import { IDENTITY, multiply, type DrawingData, type DrawingImage, type Rgba } from "../../../core/drawingml/index"
import type { RenderEffects, SlideLayer } from "../../../core/presentation/output"
import type { PresentationSessionApi } from "../../../dom/presentation/protocol"
import { drawingImages, paintDrawing } from "../../docx/paint/drawing"
import { paintPage } from "../../docx/paint/page"
import type { SlidePainter } from "../SlideView"

// The slide compositor: a SlideRender as DOM. The background, then per layer its drawing (one SVG from paintDrawing,
// placed by the layer's matrix) and its text (paintPage of the layer's TextPage, placed by its text matrix), so text
// stays selectable, findable and visible to screen readers. Pictures load through the session (`image`) as blob URLs
// and repaint the layers that show them; the bitmaps a drawing carries (a metafile's embedded images) take theirs at
// once, under the names the worker gives them. The URLs are shared by every paint of the session (the next slide, the show, a slide
// painted again) and kept, least recently used out, up to a byte budget once no paint shows them;
// releaseSlidePictures revokes a closed session's. Effects beyond the drawing's own shadow are CSS
// filters (glow, blur, further outer shadows) and a masked mirror copy (reflection); soft edges and inner shadows are
// not drawn.

// Types the page shows natively (an SVG in <image> runs no script).
const SHOWN_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/svg+xml"])
const MAX_PX = 1e6

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

// The CSS filter of a layer's effects (those a filter can draw).
function effectFilter(effects: RenderEffects | undefined): string {
	if (effects === undefined) return ""

	const out: string[] = []

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

export const paintSlide: SlidePainter = (render, context) => {
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
			const svg = paintDrawing(data, { document, idPrefix: prefix, imageUrl })

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

		if (layer.drawing.itemCount > 0) {
			const drawing = positioned(document, "fo-slide-drawing", own)
			const filter = effectFilter(layer.effects)

			if (filter !== "") drawing.style.filter = filter
			if (layer.alt !== undefined) {
				drawing.setAttribute("role", "img")
				drawing.setAttribute("aria-label", layer.alt)
			}

			drawInto(drawing, layer.drawing, `fo-s${String(id)}-${String(index)}-`)

			for (const effect of layer.effects ?? []) {
				if (effect.kind !== "reflection") continue

				// A mirror copy under the shape, faded from startAlpha to endAlpha over endPos of its height.
				const mirror = positioned(document, "fo-slide-reflection", own)
				const inner = document.createElement("div")
				const h = finite(layer.drawing.height)
				const end = Math.max(0, Math.min(1, effect.endPos)) * 100

				inner.style.cssText =
					`transform-origin:0 0;transform:translate(0,${String(2 * h + finite(effect.distance))}px) scale(1,-1);` +
					`mask-image:linear-gradient(to top,rgba(0,0,0,${String(effect.startAlpha)}) 0%,rgba(0,0,0,${String(effect.endAlpha)}) ${String(end)}%,transparent ${String(end)}%)` +
					(effect.blur > 0 ? `;filter:blur(${String(finite(effect.blur))}px)` : "")
				mirror.setAttribute("aria-hidden", "true")
				drawInto(inner, layer.drawing, `fo-s${String(id)}-${String(index)}-r-`)
				mirror.append(inner)
				element.append(mirror)
			}

			element.append(drawing)
		}

		const text = layer.text

		if (text !== undefined) {
			const textMatrix = layer.textMatrix ?? layer.matrix
			const holder = positioned(document, "fo-slide-text", inverse === undefined ? textMatrix : multiply(inverse, textMatrix))
			// The TextPage is both the page's tables and the DrawingML paint tables its styles index.
			const page = paintPage(text.page, { document, tables: text, paints: text })

			// paintPage marks its own stacking layers with data-fo-layer (nothing reads them); a slide layer's mark must be
			// the nearest one to its links, so they go.
			for (const inner of page.root.querySelectorAll<HTMLElement>("[data-fo-layer]")) delete inner.dataset["foLayer"]

			holder.append(page.root)
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

			const cache = session === undefined ? undefined : pictureCaches.get(session)

			for (const key of held) cache?.release(key)

			held.length = 0
		}
	}
}

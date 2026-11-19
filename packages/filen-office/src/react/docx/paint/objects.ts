import { shadeRaster, type DrawingImage, type Paint } from "../../../core/drawingml/index"
import { encodePng } from "../../../core/metafile/dib"
import type { DocxObjectData, DocxSessionApi } from "../../../dom/docx/protocol"
import type { DocxMediaCache } from "../media"
import { drawingImages, imageMime, inlineImageUrls, paintDrawing } from "./drawing"
import { paintMath } from "./math"
import type { PaintedObject } from "./page"

// Fills a painted page's object boxes: drawings as SVG (their images read from the package first), equations
// as MathML, separators as rules; anything that cannot be drawn becomes a placeholder box. Returns the
// cleanup that releases the images of the objects given, or of one of them (a patched page took it away).

let drawingCounter = 0

function placeholder(element: HTMLElement): void {
	element.classList.add("fo-docx-placeholder")
}

function mediaKey(image: DrawingImage): { partName: string; type: string } | undefined {
	const partName = image.svgPartName ?? image.partName
	const type = image.svgPartName !== undefined ? "image/svg+xml" : imageMime(image)

	return partName === undefined || type.length === 0 ? undefined : { partName, type }
}

// One measuring context per document, made when first asked for (null: the document has none); a document gone takes
// its context with it.
const measureContexts = new WeakMap<Document, CanvasRenderingContext2D | null>()

function measureContext(document: Document): CanvasRenderingContext2D | null {
	let context = measureContexts.get(document)

	if (context === undefined) {
		try {
			context = document.createElement("canvas").getContext("2d")
		} catch {
			context = null
		}

		measureContexts.set(document, context)
	}

	return context
}

// Advance widths through a canvas of the document (text a drawing wraps); NaN without one (the painter
// then estimates). Every painter of a document (pages, sheet charts and objects) shares one context: the font is set
// on each call.
export function textMeasurer(document: Document): (text: string, font: string) => number {
	let context: CanvasRenderingContext2D | null | undefined

	return (text, font) => {
		if (context === undefined) context = measureContext(document)
		if (context === null) return Number.NaN

		context.font = font

		return context.measureText(text).width
	}
}

// The names objects are given for assistive technology, in the host's language.
export interface DocxObjectLabels {
	// A legacy form check box (FORMCHECKBOX); its state is told by aria-checked.
	readonly checkbox: string
}

export const DOCX_OBJECT_LABELS: DocxObjectLabels = {
	checkbox: "Check box"
}

export interface ObjectPaintOptions {
	readonly document: Document
	readonly session: DocxSessionApi
	readonly media: DocxMediaCache
	// Stops painting when the page goes away first.
	readonly signal: { readonly aborted: boolean }
	// DOCX_OBJECT_LABELS without them.
	readonly labels?: DocxObjectLabels
}

// Pixels of one shaded raster, and of all a page's shaded rasters over its life.
const MAX_SHADE_PIXELS = 2048 * 2048
const MAX_SHADE_TOTAL = 32 * 1024 * 1024
// Quiet time after the last zoom or resize before the rasters are made again: a pinch or wheel zoom crosses its 2×
// steps without rasterising the ones it only passes (each raster is synchronous, up to MAX_SHADE_PIXELS). Meanwhile
// the previous raster stays, scaled.
const SHADE_SETTLE_MS = 40

interface ShadeEntry {
	readonly object: PaintedObject
	readonly drawingWidth: number
	readonly image: SVGImageElement
	readonly paint: Extract<Paint, { kind: "shaded" }>
	readonly localScale: number
	bucket: number
	key: string
}

// A page's shaded paints, rasterised at the device resolution they are drawn at (zoom × device pixel ratio,
// rounded up to a power of two) and again when the zoom settles across a 2× step; each raster is made once per
// paint and step, and every URL is revoked with the page.
class Shader {
	private readonly media: DocxMediaCache
	private readonly entries: ShadeEntry[] = []
	private readonly urls = new Map<string, { url: string; refs: number }>()
	private readonly ids = new WeakMap<object, number>()
	private nextId = 0
	private pixelsLeft = MAX_SHADE_TOTAL
	private observer: MutationObserver | null = null
	private resize: (() => void) | null = null
	private view: Window | null = null
	private settling: ReturnType<typeof setTimeout> | null = null
	private disposed = false

	constructor(media: DocxMediaCache) {
		this.media = media
	}

	register(
		object: PaintedObject,
		drawingWidth: number,
		image: SVGImageElement,
		paint: Extract<Paint, { kind: "shaded" }>,
		localScale: number
	): void {
		if (this.disposed) return

		const entry: ShadeEntry = { object, drawingWidth, image, paint, localScale, bucket: 0, key: "" }

		this.entries.push(entry)
		this.update(entry)
		this.watch(object.element)
	}

	// Device pixels per local unit of the entry's paint as drawn now.
	private deviceScale(entry: ShadeEntry): number {
		const element = entry.object.element
		const view = element.ownerDocument.defaultView
		const width = element.getBoundingClientRect().width || entry.object.width
		const ratio = view !== null && view.devicePixelRatio > 0 ? view.devicePixelRatio : 1

		return entry.drawingWidth > 0 ? (width / entry.drawingWidth) * ratio * entry.localScale : ratio
	}

	// Releases the rasters of an object taken away (the others' stay).
	forget(object: PaintedObject): void {
		for (let k = this.entries.length - 1; k >= 0; k--) {
			const entry = this.entries[k]

			if (entry?.object !== object) continue

			this.entries.splice(k, 1)
			this.drop(entry.key)
		}
	}

	private update(entry: ShadeEntry): void {
		const scale = this.deviceScale(entry)
		const bucket = 2 ** Math.ceil(Math.log2(Number.isFinite(scale) && scale > 0 ? Math.min(Math.max(scale, 1 / 64), 256) : 1))

		if (bucket === entry.bucket) return

		let id = this.ids.get(entry.paint)

		if (id === undefined) {
			id = ++this.nextId
			this.ids.set(entry.paint, id)
		}

		const key = `${id}@${bucket}`
		let held = this.urls.get(key)

		if (held === undefined) {
			const paint = entry.paint
			const raster =
				this.pixelsLeft > 0
					? shadeRaster(paint.points, paint.colors, paint.ramp, bucket, Math.min(MAX_SHADE_PIXELS, this.pixelsLeft))
					: undefined

			if (raster === undefined) return

			this.pixelsLeft -= raster.width * raster.height

			const url = this.media.createBytesUrl(encodePng(raster.rgba, raster.width, raster.height), "image/png")

			if (url === undefined) return

			held = { url, refs: 0 }
			this.urls.set(key, held)
		}

		held.refs++
		entry.image.setAttribute("href", held.url)
		this.drop(entry.key)
		entry.bucket = bucket
		entry.key = key
	}

	private drop(key: string): void {
		const held = this.urls.get(key)

		if (held === undefined || --held.refs > 0) return

		this.urls.delete(key)
		this.media.revokeBytesUrl(held.url)
	}

	// Zoom scales the page with a CSS transform, and the device pixel ratio changes with the window: either
	// re-checks the entries once they settle (SHADE_SETTLE_MS without another change).
	private watch(element: HTMLElement): void {
		if (this.resize !== null) return

		const view = element.ownerDocument.defaultView
		const schedule = (): void => {
			if (this.disposed) return
			if (this.settling !== null) clearTimeout(this.settling)

			this.settling = setTimeout(() => {
				this.settling = null

				// Entries forgotten meanwhile are no longer listed: they get no raster.
				if (!this.disposed) for (const entry of this.entries) this.update(entry)
			}, SHADE_SETTLE_MS)
		}
		const scaled = element.closest(".fo-docx-page-scale")

		this.resize = schedule
		this.view = view
		view?.addEventListener("resize", schedule)

		if (scaled !== null && typeof MutationObserver === "function") {
			this.observer = new MutationObserver(schedule)
			this.observer.observe(scaled, { attributes: true, attributeFilter: ["style"] })
		}
	}

	dispose(): void {
		if (this.disposed) return

		this.disposed = true
		this.observer?.disconnect()
		this.observer = null

		if (this.settling !== null) clearTimeout(this.settling)

		this.settling = null

		// The window the listener was added on: the entries may all be forgotten by now.
		if (this.resize !== null) this.view?.removeEventListener("resize", this.resize)

		this.resize = null
		this.view = null

		for (const held of this.urls.values()) this.media.revokeBytesUrl(held.url)

		this.urls.clear()
		this.entries.length = 0
	}
}

interface Holder {
	// Whether the object is still shown (neither the page nor the object went away).
	live(): boolean
	// Records an acquired image; false (and released at once) when the object already went away.
	hold(key: { partName: string; type: string }): boolean
	// Records an object URL made for bytes the drawing carries, revoked with the object's images.
	holdUrl(url: string): boolean
	readonly shader: Shader
}

async function paintDrawingObject(
	object: PaintedObject,
	data: Extract<DocxObjectData, { kind: "drawing" }>,
	options: ObjectPaintOptions,
	holder: Holder
): Promise<void> {
	const images = drawingImages(data.drawing)
	const urls = new Map<string, string | undefined>()

	await Promise.all(
		images.map(async image => {
			const key = mediaKey(image)

			if (key === undefined || urls.has(`${key.type}\u0000${key.partName}`)) return

			urls.set(`${key.type}\u0000${key.partName}`, undefined)

			const url = await options.media.acquire(key.partName, key.type)

			if (holder.hold(key)) urls.set(`${key.type}\u0000${key.partName}`, url)
		})
	)

	// Text the painter wraps is measured: wait for the faces the engine registered for it.
	if (Array.isArray(data.drawing.texts) && data.drawing.texts.some(text => text?.kind === "block"))
		await options.media.fontsReady().catch(() => undefined)

	if (options.signal.aborted || !holder.live()) return

	const inline = inlineImageUrls(data.drawing, (bytes, type) => {
		const created = options.media.createBytesUrl(bytes, type)

		return created !== undefined && holder.holdUrl(created) ? created : undefined
	})

	const svg = paintDrawing(data.drawing, {
		document: options.document,
		idPrefix: `fod${++drawingCounter}-`,
		measureText: textMeasurer(options.document),
		shade(image, paint, localScale) {
			holder.shader.register(object, data.drawing.width, image, paint, localScale)
		},
		imageUrl(image) {
			const own = inline.get(image)

			if (own !== undefined) return own

			const key = mediaKey(image)

			return key === undefined ? undefined : urls.get(`${key.type}\u0000${key.partName}`)
		}
	})

	object.element.appendChild(svg)
}

// What one object holds: images acquired and object URLs made for it.
interface Held {
	readonly keys: { partName: string; type: string }[]
	readonly urls: string[]
}

export function paintObjects(objects: readonly PaintedObject[], options: ObjectPaintOptions): (object?: PaintedObject) => void {
	const held = new Map<PaintedObject, Held>()
	const gone = new Set<PaintedObject>()
	const shader = new Shader(options.media)
	let released = false
	const releaseHeld = (entry: Held): void => {
		for (const key of entry.keys) options.media.release(key.partName, key.type)
		for (const url of entry.urls) options.media.revokeBytesUrl(url)

		entry.keys.length = 0
		entry.urls.length = 0
	}
	const release = (object?: PaintedObject): void => {
		if (released) return

		if (object !== undefined) {
			if (gone.has(object)) return

			gone.add(object)
			shader.forget(object)

			const entry = held.get(object)

			if (entry !== undefined) releaseHeld(entry)

			held.delete(object)

			// Every object of this call went one by one: nobody calls the batch release any more, so the shader's
			// window listener and observer go now.
			if (gone.size < objects.length) return
		}

		released = true
		shader.dispose()

		for (const entry of held.values()) releaseHeld(entry)

		held.clear()
	}
	const holderOf = (object: PaintedObject): Holder => {
		const live = (): boolean => !released && !gone.has(object)
		const entry = (): Held => {
			let found = held.get(object)

			if (found === undefined) {
				found = { keys: [], urls: [] }
				held.set(object, found)
			}

			return found
		}

		return {
			shader,
			live,
			hold(key) {
				if (!live()) {
					options.media.release(key.partName, key.type)

					return false
				}

				entry().keys.push(key)

				return true
			},
			holdUrl(url) {
				if (!live()) {
					options.media.revokeBytesUrl(url)

					return false
				}

				entry().urls.push(url)

				return true
			}
		}
	}

	if (objects.length > 0) {
		const byId = new Map<number, PaintedObject[]>()

		for (const object of objects) {
			const list = byId.get(object.id)

			if (list === undefined) byId.set(object.id, [object])
			else list.push(object)
		}

		void options.session
			.objects([...byId.keys()])
			.then(async results => {
				const work: Promise<void>[] = []

				for (const result of results) {
					for (const object of byId.get(result.id) ?? []) {
						if (options.signal.aborted || released) return
						if (gone.has(object)) continue

						switch (result.kind) {
							case "separator":
								object.element.classList.add("fo-docx-separator")

								break
							case "checkbox":
								object.element.classList.add("fo-docx-checkbox")

								if (result.checked) object.element.dataset["foChecked"] = ""

								// A check box to assistive technology, its state told; read-only, as only the viewer's pages
								// expose it (the editor's pages are aria-hidden, the Mobile view shows it as field text).
								object.element.setAttribute("role", "checkbox")
								object.element.setAttribute("aria-checked", result.checked ? "true" : "false")
								object.element.setAttribute("aria-readonly", "true")
								object.element.setAttribute("aria-label", (options.labels ?? DOCX_OBJECT_LABELS).checkbox)

								break
							case "math":
								try {
									const math = paintMath(result.tree, options.document)

									object.element.style.fontSize = `${Math.min(Math.max(result.fontSize, 1), 1000)}px`
									object.element.classList.add("fo-docx-math")
									object.element.appendChild(math)
								} catch {
									placeholder(object.element)
								}

								break
							case "drawing":
								// A picture with alternative text is an image to assistive technology, named by it (the
								// drawing's own SVG stays hidden from it).
								if (typeof result.alt === "string" && result.alt.length > 0) {
									object.element.setAttribute("role", "img")
									object.element.setAttribute("aria-label", result.alt)
								}

								work.push(
									paintDrawingObject(object, result, options, holderOf(object)).catch(() => {
										placeholder(object.element)
									})
								)

								break
							case "placeholder":
								placeholder(object.element)

								break
						}
					}
				}

				await Promise.all(work)
			})
			.catch(() => {
				for (const object of objects) placeholder(object.element)
			})
	}

	return release
}

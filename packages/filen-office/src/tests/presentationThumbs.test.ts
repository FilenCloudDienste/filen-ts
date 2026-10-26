import { afterEach, describe, expect, it } from "vitest"
import { DrawingList, IDENTITY, ItemKind, type DrawingImage } from "../core/drawingml/index"
import { slideRef, type SlideRef } from "../core/presentation/model"
import type { SlideRender } from "../core/presentation/output"
import type { CallContext, EngineSession } from "../dom/presentation/engine"
import { thumbsCapabilityOf } from "../dom/presentation/engine/thumbs"
import type { PresentationEvent } from "../dom/presentation/protocol"
import { installPresentationRealm, type RasterCanvas, type RasterImage, type RealmCanvas } from "../dom/presentation/services"
import { DecodedPictures, paintSlideCanvas, rasterizeSlide, ThumbnailCache } from "../dom/presentation/thumbs"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"
import { RecordingCanvas } from "./presentationCanvasRecorder"

// Thumbnails drawn on the canvas path: a slide's background, layers and text in order on white paper, pictures
// decoded once at the size they are drawn and closed after, the session's LRU cache, the bitmaps sent as copies, and
// every bitmap closed (counted).

class Bitmap implements RasterImage {
	static made = 0
	static closed = 0
	readonly width: number
	readonly height: number
	open = true

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
		Bitmap.made++
	}

	close(): void {
		if (this.open) Bitmap.closed++

		this.open = false
	}
}

class Canvas extends RecordingCanvas implements RasterCanvas {
	getContext(): RecordingCanvas {
		return this
	}

	transferToImageBitmap(): RasterImage {
		return new Bitmap(this.width, this.height)
	}

	close(): void {}
}

function realm(): { readonly canvases: Canvas[]; readonly decodes: [string, number][]; readonly canvas: RealmCanvas } {
	const canvases: Canvas[] = []
	const decodes: [string, number][] = []

	return {
		canvases,
		decodes,
		canvas: {
			canvas(width, height) {
				const made = new Canvas(Math.ceil(width), Math.ceil(height), `canvas${String(canvases.length)}`)

				canvases.push(made)

				return made
			},
			decode(bytes, type, maxSide) {
				decodes.push([type, maxSide])

				return Promise.resolve(new Bitmap(Math.min(maxSide, bytes.length), Math.min(maxSide, bytes.length)))
			},
			copy: image => Promise.resolve(new Bitmap(image.width, image.height)),
			fontsReady: () => Promise.resolve()
		}
	}
}

function session(): { readonly session: EngineSession; readonly events: PresentationEvent[]; close(): void } {
	const events: PresentationEvent[] = []
	const closers: (() => void)[] = []
	const deck = fixtureDeck(3)
	const value = {
		s: 1,
		deck,
		emit: (event: PresentationEvent) => events.push(event),
		onClose: (listener: () => void) => closers.push(listener)
	} as unknown as EngineSession

	return {
		session: value,
		events,
		close: () => {
			for (const closer of closers) closer()
		}
	}
}

function context(target: EngineSession): CallContext {
	return {
		session: target,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "background",
		slicing: { pause: () => new Promise(resolve => setTimeout(resolve, 0)), sliceMs: 8, now: () => Date.now() }
	}
}

const render = (call: CallContext, ref: SlideRef): Promise<SlideRender> =>
	Promise.resolve(fixtureSlideRender(call.session.deck, call.session.deck.slides.indexOf(ref)))

function withPicture(base: SlideRender): SlideRender {
	const list = new DrawingList()
	const picture: DrawingImage = {
		partName: "/ppt/media/image1.png",
		format: "png",
		handling: "native",
		svgPartName: undefined,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		alpha: 1,
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0,
		colorChange: null
	}

	list.width = 100
	list.height = 100
	list.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 100, 100, 0, 0, -1, -1, list.image(picture), -1, 0, 0, 0)

	const c = list.compact()
	const drawing = { ...c, clips: undefined, itemClips: undefined } as unknown as SlideRender["background"]
	const layer = { ...base.layers[0], drawing } as SlideRender["layers"][number]

	return { ...base, layers: [layer, layer] }
}

afterEach(() => {
	installPresentationRealm(undefined)
	Bitmap.made = 0
	Bitmap.closed = 0
})

describe("slide raster", () => {
	it("paints white paper, the background, then each layer's drawing and its text in order", () => {
		const deck = fixtureDeck(3)
		const ctx = new RecordingCanvas(192, 108)
		const slide = fixtureSlideRender(deck, 0)

		paintSlideCanvas(ctx, slide, 0.1, { image: () => undefined })

		const fills = ctx.ops("fill")

		expect(fills[0]?.fill).toBe("#ffffffff")
		expect(fills[0]?.transform).toEqual([0.1, 0, 0, 0.1, 0, 0])
		// Text of the title placeholder lands after its outline, at its layer's offset.
		expect(ctx.ops("fillText").length).toBeGreaterThan(0)
		expect(ctx.ops("fillText")[0]?.transform[4]).toBeCloseTo((838_200 / 9525) * 0.1)
	})

	it("decodes each picture part once, at most twice the thumbnail width, and closes it after", async () => {
		const place = realm()
		const reads: string[] = []
		const slide = withPicture(fixtureSlideRender(fixtureDeck(3), 0))
		const raster = await rasterizeSlide(slide, {
			canvas: place.canvas,
			size: { cx: 12_192_000, cy: 6_858_000 },
			widthPx: 192,
			read: part => {
				reads.push(part)

				return Promise.resolve(new Uint8Array(500))
			}
		})

		expect(raster?.width).toBe(192)
		expect(raster?.height).toBe(108)
		expect(reads).toEqual(["/ppt/media/image1.png"])
		expect(place.decodes).toEqual([["image/png", 384]])
		expect(place.canvases[0]?.ops("drawImage")).toHaveLength(2)
		// The decode is closed; the thumbnail is the caller's.
		expect(Bitmap.made - Bitmap.closed).toBe(1)
	})
})

describe("decoded pictures", () => {
	it("decodes a picture the slides share once, holds it while a slide draws and closes it with the session", async () => {
		const place = realm()
		const pictures = new DecodedPictures()
		const slides = [0, 1, 2].map(index => withPicture(fixtureSlideRender(fixtureDeck(3), index)))
		const options = {
			canvas: place.canvas,
			size: { cx: 12_192_000, cy: 6_858_000 },
			widthPx: 192,
			read: () => Promise.resolve(new Uint8Array(500)),
			pictures
		}
		const rasters = await Promise.all(slides.map(slide => rasterizeSlide(slide, options)))

		expect(place.decodes).toEqual([["image/png", 384]])
		expect(pictures.size).toBe(1)

		for (const raster of rasters) raster?.bitmap.close()

		// Idle within the budget: kept for the next slide, until the session goes.
		expect(Bitmap.made - Bitmap.closed).toBe(1)
		pictures.clear()
		expect(Bitmap.made).toBe(Bitmap.closed)
	})

	it("closes idle pictures beyond its byte budget, least recently used first, never one in use", async () => {
		const pictures = new DecodedPictures(2 * 100 * 100 * 4)
		const bitmaps = [0, 1, 2].map(() => new Bitmap(100, 100))

		for (const [index, bitmap] of bitmaps.entries()) await pictures.acquire(`p${String(index)}`, () => Promise.resolve(bitmap))

		pictures.release("p0")
		pictures.release("p1")
		expect(bitmaps.map(bitmap => bitmap.open)).toEqual([true, true, true])

		pictures.release("p2")
		expect(bitmaps.map(bitmap => bitmap.open)).toEqual([false, true, true])
		pictures.clear()
		expect(Bitmap.made).toBe(Bitmap.closed)
	})

	it("lets a picture that failed to load fail its slide, and tries it again on the next one", async () => {
		const place = realm()
		const pictures = new DecodedPictures()
		const slide = withPicture(fixtureSlideRender(fixtureDeck(3), 0))
		let reads = 0
		const options = {
			canvas: place.canvas,
			size: { cx: 12_192_000, cy: 6_858_000 },
			widthPx: 192,
			read: () => (++reads === 1 ? Promise.reject(new Error("port closed")) : Promise.resolve(new Uint8Array(500))),
			pictures
		}

		await expect(rasterizeSlide(slide, options)).rejects.toThrow("port closed")

		const raster = await rasterizeSlide(slide, options)

		expect(reads).toBe(2)
		raster?.bitmap.close()
		pictures.clear()
		expect(Bitmap.made).toBe(Bitmap.closed)
	})
})

describe("thumbnail cache", () => {
	it("evicts the least recently used beyond its byte budget, closing what it drops", () => {
		const cache = new ThumbnailCache(3 * 100 * 100 * 4)

		for (let slide = 0; slide < 3; slide++) cache.put(ThumbnailCache.key(slide, 0, 100), new Bitmap(100, 100))

		cache.get(ThumbnailCache.key(0, 0, 100))
		cache.put(ThumbnailCache.key(3, 0, 100), new Bitmap(100, 100))

		expect(cache.get(ThumbnailCache.key(1, 0, 100))).toBeUndefined()
		expect(cache.get(ThumbnailCache.key(0, 0, 100))).toBeDefined()
		expect(cache.closed).toBe(1)

		cache.invalidate(0, 5)
		expect(cache.get(ThumbnailCache.key(0, 0, 100))).toBeUndefined()

		cache.clear()
		expect(cache.size).toBe(0)
		expect(cache.bytes).toBe(0)
		expect(Bitmap.made).toBe(Bitmap.closed)
	})
})

describe("thumbnails capability", () => {
	it("sends every asked slide's thumbnail in order, a copy of the cached one the second time", async () => {
		const place = realm()

		installPresentationRealm({ text: undefined as never, canvas: place.canvas })

		const open = session()
		const capability = thumbsCapabilityOf(render, () => Promise.resolve(null))
		const refs = open.session.deck.slides

		await capability.thumbnails(context(open.session), refs, 192)
		await capability.thumbnails(context(open.session), refs, 192)

		const items = open.events.flatMap(event => (event.type === "thumbs" ? event.items : []))

		expect(items.map(item => item.slide)).toEqual([...refs, ...refs])
		// Rendered once per slide: the second round came from the cache.
		expect(place.canvases).toHaveLength(3)

		for (const item of items) item.bitmap.close()

		open.close()
		expect(Bitmap.made).toBe(Bitmap.closed)
	})

	it("decodes the pictures its slides share once for the session", async () => {
		const place = realm()

		installPresentationRealm({ text: undefined as never, canvas: place.canvas })

		const open = session()
		const capability = thumbsCapabilityOf(
			(call, ref) => render(call, ref).then(withPicture),
			() => Promise.resolve(new Uint8Array(500))
		)

		await capability.thumbnails(context(open.session), open.session.deck.slides, 192)

		const items = open.events.flatMap(event => (event.type === "thumbs" ? event.items : []))

		expect(items.map(item => item.slide)).toEqual(open.session.deck.slides)
		expect(place.decodes).toHaveLength(1)

		for (const item of items) item.bitmap.close()

		open.close()
		expect(Bitmap.made).toBe(Bitmap.closed)
	})

	it("refuses widths out of range, unknown slides and a realm without a canvas, typed", async () => {
		const open = session()
		const capability = thumbsCapabilityOf(render, () => Promise.resolve(null))

		await expect(capability.thumbnails(context(open.session), [slideRef(10)], 192)).rejects.toMatchObject({ reason: "notImplemented" })

		installPresentationRealm({ text: undefined as never, canvas: realm().canvas })

		await expect(capability.thumbnails(context(open.session), [slideRef(10)], 4)).rejects.toMatchObject({ reason: "tooLarge" })
		await expect(capability.thumbnails(context(open.session), [slideRef(99)], 192)).rejects.toMatchObject({ reason: "notFound" })
	})

	it("stops when aborted and closes the thumbnails it had not sent", async () => {
		installPresentationRealm({ text: undefined as never, canvas: realm().canvas })

		const open = session()
		const call = context(open.session)
		const signal = { aborted: false, onAbort: () => undefined }
		let rendered = 0
		const aborting = thumbsCapabilityOf(
			(c, ref) => {
				rendered++

				if (rendered === 2) signal.aborted = true

				return render(c, ref)
			},
			() => Promise.resolve(null)
		)

		await expect(aborting.thumbnails({ ...call, signal }, open.session.deck.slides, 192)).rejects.toMatchObject({ reason: "aborted" })
		expect(open.events).toHaveLength(0)

		open.close()
		expect(Bitmap.made).toBe(Bitmap.closed)
	})
})

import type { Canvas2DLike, CanvasSurface } from "../../core/drawingml/canvas"
import { geckoPngDecoder, type PngFrameDecoder } from "../../core/pdfwrite/images"
import { imageDimensions, imageWithinBudget, MEDIA_LIMITS } from "../../core/opc/mediaPolicy"
import { offscreenMeasurer } from "../canvasMeasurer"
import type { DocxEngineServices } from "../docx/engine"
import { macrotaskYield } from "../docx/host"
import { fetchFontAssets, type FontLocation } from "../docx/services"
import { fontFaceHost, type FontFaceScope } from "../fontFaceHost"
import type { BitmapLike } from "./protocol"

// What the presentation engine needs from the realm it runs in, beyond the protocol: the text services (faces
// registered in the realm's FontFaceSet, widths measured on an OffscreenCanvas: the one realm all text of a session
// is laid out in) and the canvas the raster path draws on (scratch OffscreenCanvases, picture decodes, bitmaps).
// A worker has exactly one realm, so the worker body installs it once (installPresentationRealm) and the capabilities
// read it per call; tests install a realm of their own.

// A decoded picture or a canvas the raster path draws on and with (ImageBitmap, OffscreenCanvas).
export type RasterImage = BitmapLike

export interface RasterCanvas extends RasterImage {
	getContext(kind: "2d"): Canvas2DLike<RasterImage> | null
	transferToImageBitmap(): RasterImage
}

export interface RealmCanvas {
	// A canvas of `width` x `height` pixels, or undefined when the realm has none (or the size is over budget).
	canvas(width: number, height: number): RasterCanvas | undefined
	// Decodes an encoded picture, at most `maxSide` pixels on its longer side (decoded smaller, never larger, than its
	// own size); undefined when the realm cannot decode it or it is over the pixel budget.
	decode(bytes: Uint8Array, type: string, maxSide: number): Promise<RasterImage | undefined>
	// An SVG picture rasterised at most `maxSide` pixels on its longer side. Workers cannot decode SVG (createImageBitmap
	// takes no SVG there), so a worker's realm asks the page, which decodes it through an <img> (where it runs no
	// script); undefined where nothing can.
	svg?(bytes: Uint8Array, maxSide: number): Promise<RasterImage | undefined>
	// A copy of a bitmap (the cache keeps its own while the copy is transferred); undefined when it cannot be made.
	copy(image: RasterImage): Promise<RasterImage | undefined>
	// Waits until the faces of these CSS fonts are loaded (fillText draws a fallback face for one still loading).
	fontsReady(fonts: readonly string[]): Promise<void>
}

export interface PresentationRealm {
	readonly text: DocxEngineServices
	readonly canvas: RealmCanvas
}

// Decoded pixels allowed per picture (§ hostile-input budgets: 50 M).
export const MAX_DECODED_PIXELS = MEDIA_LIMITS.decodedPixels
// A canvas side the raster path makes at most (browsers cap 2D canvases near 16k and 268 M pixels).
export const MAX_CANVAS_SIDE = 8192
export const MAX_CANVAS_PIXELS = 8192 * 8192

let realm: PresentationRealm | undefined

export function installPresentationRealm(installed: PresentationRealm | undefined): void {
	realm = installed
}

export function presentationRealm(): PresentationRealm | undefined {
	return realm
}

// A scratch surface for the canvas painters, from the realm's canvases.
export function realmSurface(canvas: RealmCanvas): (width: number, height: number) => CanvasSurface<RasterImage> | undefined {
	return (width, height) => {
		const made = canvas.canvas(width, height)
		const context = made?.getContext("2d") ?? null

		return made === undefined || context === null ? undefined : { canvas: made, context }
	}
}

interface OffscreenScope {
	readonly OffscreenCanvas: new (width: number, height: number) => RasterCanvas
	readonly createImageBitmap: (blob: unknown, options?: Record<string, unknown>) => Promise<RasterImage>
	readonly Blob: new (parts: readonly Uint8Array[], options: { type: string }) => unknown
	readonly fonts?: { check?(font: string): boolean; load?(font: string): Promise<unknown> }
	// WebCodecs' ImageDecoder, where PNGs go through it (geckoPngDecoder).
	readonly pngDecoder?: PngFrameDecoder
}

function offscreenScope(scope: unknown): OffscreenScope | undefined {
	if (typeof scope !== "object" || scope === null) return undefined

	const OffscreenCanvas: unknown = Reflect.get(scope, "OffscreenCanvas")
	const create: unknown = Reflect.get(scope, "createImageBitmap")
	const Blob: unknown = Reflect.get(scope, "Blob")
	const fonts: unknown = Reflect.get(scope, "fonts")
	const decoder = geckoPngDecoder(scope)

	if (typeof OffscreenCanvas !== "function" || typeof create !== "function" || typeof Blob !== "function") return undefined

	return {
		OffscreenCanvas: OffscreenCanvas as OffscreenScope["OffscreenCanvas"],
		// A method of the global scope: called through another object it throws.
		createImageBitmap: (blob, options) =>
			Reflect.apply(create, scope, options === undefined ? [blob] : [blob, options]) as Promise<RasterImage>,
		Blob: Blob as OffscreenScope["Blob"],
		...(typeof fonts === "object" && fonts !== null ? { fonts: fonts as NonNullable<OffscreenScope["fonts"]> } : {}),
		...(decoder === undefined ? {} : { pngDecoder: decoder })
	}
}

// A PNG through the platform's PNG decoder (Firefox), its frame closed once the bitmap is made; undefined without
// one or when it fails (the caller decodes the Blob).
async function decodedPng(platform: OffscreenScope, bytes: Uint8Array, options: Record<string, unknown>): Promise<RasterImage | undefined> {
	const Decoder = platform.pngDecoder

	if (Decoder === undefined) return undefined

	let decoder: InstanceType<PngFrameDecoder> | undefined

	try {
		decoder = new Decoder({ type: "image/png", data: bytes })

		const { image } = await decoder.decode()

		try {
			return await platform.createImageBitmap(image, options)
		} finally {
			image.close()
		}
	} catch {
		return undefined
	} finally {
		decoder?.close()
	}
}

// The canvases of a realm with OffscreenCanvas and createImageBitmap (workers and pages of every supported browser).
export function offscreenCanvas(scope: unknown): RealmCanvas | undefined {
	const platform = offscreenScope(scope)

	if (platform === undefined) return undefined

	const canvas = (width: number, height: number): RasterCanvas | undefined => {
		const w = Math.ceil(width)
		const h = Math.ceil(height)

		if (!(w >= 1 && h >= 1 && w <= MAX_CANVAS_SIDE && h <= MAX_CANVAS_SIDE && w * h <= MAX_CANVAS_PIXELS)) return undefined

		try {
			return new platform.OffscreenCanvas(w, h)
		} catch {
			return undefined
		}
	}

	return {
		canvas,
		async decode(bytes, type, maxSide) {
			// The pixel budget is checked from the header (all of it: a JPEG's frame header may follow long APP
			// segments), before anything is decoded.
			if (!imageWithinBudget(bytes)) return undefined

			const size = imageDimensions(bytes)

			const longer = size === undefined ? 0 : Math.max(size.width, size.height)
			const scale = longer > 0 ? Math.min(1, Math.max(1, Math.ceil(maxSide)) / longer) : 1
			// One side given: the other follows the picture's proportions, also when its orientation (EXIF) turns it.
			const options: Record<string, unknown> =
				size !== undefined && scale < 1 ? { resizeWidth: Math.max(1, Math.round(size.width * scale)), resizeQuality: "medium" } : {}
			let bitmap: RasterImage | undefined = type === "image/png" ? await decodedPng(platform, bytes, options) : undefined

			try {
				bitmap ??= await platform.createImageBitmap(new platform.Blob([bytes], { type }), options)
			} catch {
				return undefined
			}

			// A header that did not say: the decoded size is held to the budget.
			if (!(bitmap.width * bitmap.height <= MAX_DECODED_PIXELS)) {
				bitmap.close()

				return undefined
			}

			return bitmap
		},
		// Drawn onto a fresh canvas and handed off: createImageBitmap of a bitmap reads its pixels back (about 11 ms a
		// thumbnail in WebKit), a draw does not.
		async copy(image) {
			const target = canvas(image.width, image.height)
			const context = target?.getContext("2d") ?? null

			if (target !== undefined && context !== null) {
				context.drawImage(image, 0, 0, image.width, image.height)

				return target.transferToImageBitmap()
			}

			try {
				return await platform.createImageBitmap(image)
			} catch {
				return undefined
			}
		},
		async fontsReady(fonts) {
			const set = platform.fonts

			if (set === undefined || typeof set.load !== "function") return

			await Promise.all(fonts.filter(font => set.check?.(font) !== true).map(font => set.load?.(font).catch(() => undefined)))
		}
	}
}

function isFontFaceScope(scope: unknown): scope is FontFaceScope {
	return (
		typeof scope === "object" &&
		scope !== null &&
		typeof Reflect.get(scope, "FontFace") === "function" &&
		typeof Reflect.get(scope, "fonts") === "object"
	)
}

// The realm of a presentation worker: text services as the docx worker's (faces in the worker's FontFaceSet and
// replayed to the page, widths on an OffscreenCanvas; no OpenDocument text translator) and its OffscreenCanvases.
// Throws where the worker lacks either.
export function workerRealm(scope: unknown, fonts: FontLocation): PresentationRealm {
	const canvas = offscreenCanvas(scope)

	if (canvas === undefined) throw new Error("OffscreenCanvas is not available in this worker")
	if (!isFontFaceScope(scope)) throw new Error("The CSS Font Loading API is not available in this worker")

	return {
		text: {
			fontHost: fontFaceHost(scope),
			replayFonts: true,
			fontAssets: fetchFontAssets(fonts),
			measurer: offscreenMeasurer(scope),
			yield: macrotaskYield(),
			sliceMs: 8
		},
		canvas
	}
}

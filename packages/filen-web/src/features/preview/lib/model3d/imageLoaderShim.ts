import { imageDimensions } from "@filen/office/core/opc"
import { textureSize } from "@/features/preview/lib/model3d/preflight.logic"

// three's ImageLoader draws through an <img>, which a worker has none of. Every DOM-bound texture path goes through it
// (TextureLoader for MTL, FBX and 3MF; USDComposer for USDZ), so its `load` is replaced, once per worker: the bytes come
// through the sandboxed fetch, the header's dimensions are checked against the pixel budget before decoding, and the
// image is decoded to an ImageBitmap at its drawn size. Those loaders build textures with the default flipY, which
// WebGL ignores for an ImageBitmap, so the bitmap is decoded flipped.

export interface ImageLoaderLike {
	prototype: {
		load: (url: string, onLoad?: (image: never) => void, onProgress?: unknown, onError?: (error: unknown) => void) => unknown
		path?: string
		manager?: {
			resolveURL(url: string): string
			itemStart(url: string): void
			itemEnd(url: string): void
			itemError(url: string): void
		}
	}
}

export interface ImageLoaderShimOptions {
	readonly fetch: (url: string) => Promise<Response>
	readonly decode: (blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>
	// The longest side a texture is drawn at.
	readonly maxSide: number
	// Pixels the textures may still take; the shim spends from it.
	readonly budget: { pixels: number }
	// A texture that did not fit the budget, or did not decode.
	readonly onSkipped: (url: string) => void
}

// The ImageBitmap options for a texture drawn at `size`: flipped (see above), straight alpha, no colour conversion.
export function bitmapOptions(size: { width: number; height: number } | null): ImageBitmapOptions {
	return {
		imageOrientation: "flipY",
		premultiplyAlpha: "none",
		colorSpaceConversion: "none",
		...(size === null ? {} : { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" })
	}
}

async function loadImage(url: string, options: ImageLoaderShimOptions): Promise<ImageBitmap | null> {
	const response = await options.fetch(url)

	if (!response.ok) return null

	const blob = await response.blob()
	const dimensions = imageDimensions(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()))
	const size = dimensions === undefined ? null : textureSize(dimensions.width, dimensions.height, options.maxSide, options.budget.pixels)

	// Known dimensions that do not fit: skipped before anything is decoded.
	if (dimensions !== undefined && size === null) return null

	const bitmap = await options.decode(blob, bitmapOptions(size))

	options.budget.pixels -= bitmap.width * bitmap.height

	if (options.budget.pixels < 0) {
		bitmap.close()

		return null
	}

	return bitmap
}

export interface ImageLoaderShim {
	// Resolves once every texture asked for so far has loaded or been skipped, those its loads asked for included: the
	// loaders that go through ImageLoader return their scene before its textures arrive.
	settled(): Promise<void>
}

export function installImageLoaderShim(ImageLoader: ImageLoaderLike, options: ImageLoaderShimOptions): ImageLoaderShim {
	const pending = new Set<Promise<unknown>>()

	ImageLoader.prototype.load = function load(this: ImageLoaderLike["prototype"], url, onLoad, _onProgress, onError) {
		const resolved = this.manager?.resolveURL((this.path ?? "") + url) ?? url

		this.manager?.itemStart(resolved)

		const loading = loadImage(resolved, options).then(
			bitmap => {
				if (bitmap === null) {
					options.onSkipped(url)
					onError?.(new Error(`texture ${url} skipped`))
					this.manager?.itemError(resolved)
				} else {
					onLoad?.(bitmap as never)
				}

				this.manager?.itemEnd(resolved)
			},
			(error: unknown) => {
				options.onSkipped(url)
				onError?.(error)
				this.manager?.itemError(resolved)
				this.manager?.itemEnd(resolved)
			}
		)

		pending.add(loading)
		void loading.finally(() => pending.delete(loading))

		return undefined
	}

	return {
		settled: async () => {
			while (pending.size > 0) await Promise.allSettled([...pending])
		}
	}
}

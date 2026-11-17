import { imageDimensions } from "@filen/office/core/opc"
import { gifDimensions, ktx2Pixels, textureSize } from "@/features/preview/lib/model3d/preflight.logic"

// Every texture a loader reads goes through one pixel budget, in the 3D worker. three's image paths are replaced, once
// per worker: ImageLoader (an <img>, which a worker has none of: MTL, FBX, 3MF and USDZ textures), ImageBitmapLoader
// (glTF's) and KTX2Loader's transcode.
//   An image is read whole and its dimensions taken from its header (a JPEG's frame header may sit past large APPn
//   segments; a GIF is as large as its first frame reaches). One whose dimensions cannot be read is skipped, never
//   decoded.
//   Once its bytes are in, its full size is reserved against the budget in the same step as the check (nothing awaits
//   between them): textures requested together cannot all pass. One that does not fit is skipped.
//   Decodes run one at a time, each to an ImageBitmap at its drawn size; the full-size raster the decode makes first
//   is what was reserved, and only the drawn size stays charged once it is done.
//   A KTX2's pixels (every layer, face and mip level) are reserved from its header before it transcodes, and given back
//   when the transcode fails.
// ImageLoader's callers build textures with the default flipY, which WebGL ignores for an ImageBitmap, so those
// bitmaps are decoded flipped; ImageBitmapLoader keeps the options its caller set.

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

export interface ImageBitmapLoaderLike {
	prototype: ImageLoaderLike["prototype"] & { options?: ImageBitmapOptions }
}

export interface Ktx2LoaderLike {
	prototype: { _createTexture: (buffer: ArrayBuffer, config?: unknown) => Promise<unknown> }
}

export interface TextureBudget {
	// Pixels left, at TEXTURE_BPP bytes each.
	pixels: number
}

export interface ImageLoaderShimOptions {
	readonly fetch: (url: string) => Promise<Response>
	readonly decode: (blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>
	// The longest side a texture is drawn at.
	readonly maxSide: number
	readonly budget: TextureBudget
	// A texture that did not fit the budget, had no readable dimensions, or did not decode.
	readonly onSkipped: (url: string) => void
}

export class TextureSkippedError extends Error {
	constructor(url: string) {
		super(`texture ${url} skipped`)

		this.name = "TextureSkipped"
	}
}

// The ImageBitmap options for an ImageLoader texture drawn at `size`: flipped (see above), straight alpha, no colour
// conversion.
export function bitmapOptions(size: { width: number; height: number } | null): ImageBitmapOptions {
	return {
		imageOrientation: "flipY",
		premultiplyAlpha: "none",
		colorSpaceConversion: "none",
		...resizeOptions(size)
	}
}

function resizeOptions(size: { width: number; height: number } | null): ImageBitmapOptions {
	return size === null ? {} : { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" }
}

// Takes `pixels` from the budget if they fit, in the same call as the check.
export function reserve(budget: TextureBudget, pixels: number): boolean {
	if (!Number.isFinite(pixels) || pixels <= 0 || pixels > budget.pixels) return false

	budget.pixels -= pixels

	return true
}

export interface TextureShim {
	// Resolves once every texture asked for so far has loaded or been skipped, those its loads asked for included: the
	// loaders that go through ImageLoader return their scene before its textures arrive.
	settled(): Promise<void>
}

type Loader = ImageLoaderLike["prototype"]

export function installTextureShim(
	loaders: { ImageLoader: ImageLoaderLike; ImageBitmapLoader: ImageBitmapLoaderLike; KTX2Loader: Ktx2LoaderLike },
	options: ImageLoaderShimOptions
): TextureShim {
	const pending = new Set<Promise<unknown>>()
	// One decode at a time: the peak is one full-size raster.
	let decoding: Promise<unknown> = Promise.resolve()

	async function decodeImage(
		url: string,
		base: (size: { width: number; height: number } | null) => ImageBitmapOptions
	): Promise<ImageBitmap | null> {
		const response = await options.fetch(url)

		if (!response.ok) return null

		const bytes = new Uint8Array(await response.arrayBuffer())
		const dimensions = gifDimensions(bytes) ?? imageDimensions(bytes) ?? null

		if (dimensions === null) return null

		const full = dimensions.width * dimensions.height

		if (!reserve(options.budget, full)) return null

		const size = textureSize(dimensions.width, dimensions.height, options.maxSide)
		const decoded = decoding.then(() => options.decode(new Blob([bytes]), base(size)))

		decoding = decoded.catch(() => undefined)

		const bitmap = await decoded.catch(() => null)

		// Only what is drawn stays charged; a decode that failed gives everything back.
		options.budget.pixels += bitmap === null ? full : full - bitmap.width * bitmap.height

		return bitmap
	}

	function load(
		this: Loader,
		url: string,
		base: (size: { width: number; height: number } | null) => ImageBitmapOptions,
		onLoad?: (image: never) => void,
		onError?: (error: unknown) => void
	): undefined {
		const resolved = this.manager?.resolveURL((this.path ?? "") + url) ?? url
		const manager = this.manager

		manager?.itemStart(resolved)

		const loading = decodeImage(resolved, base).then(
			bitmap => {
				if (bitmap === null) {
					options.onSkipped(url)
					onError?.(new TextureSkippedError(url))
					manager?.itemError(resolved)
				} else {
					onLoad?.(bitmap as never)
				}

				manager?.itemEnd(resolved)
			},
			(error: unknown) => {
				options.onSkipped(url)
				onError?.(error)
				manager?.itemError(resolved)
				manager?.itemEnd(resolved)
			}
		)

		pending.add(loading)
		void loading.finally(() => pending.delete(loading))
	}

	loaders.ImageLoader.prototype.load = function (this: Loader, url, onLoad, _onProgress, onError) {
		load.call(this, url, bitmapOptions, onLoad, onError)
	}

	loaders.ImageBitmapLoader.prototype.load = function (this: ImageBitmapLoaderLike["prototype"], url, onLoad, _onProgress, onError) {
		const own = this.options ?? {}

		load.call(this, url, size => ({ ...own, colorSpaceConversion: "none", ...resizeOptions(size) }), onLoad, onError)
	}

	const transcode = loaders.KTX2Loader.prototype._createTexture

	loaders.KTX2Loader.prototype._createTexture = function (this: unknown, buffer, config) {
		const pixels = ktx2Pixels(new Uint8Array(buffer))

		if (pixels === null || !reserve(options.budget, pixels)) {
			options.onSkipped("ktx2")

			return Promise.reject(new TextureSkippedError("ktx2"))
		}

		// A transcode that fails gives its pixels back.
		return transcode.call(this, buffer, config).catch((error: unknown) => {
			options.budget.pixels += pixels

			throw error
		})
	}

	return {
		settled: async () => {
			while (pending.size > 0) await Promise.allSettled([...pending])
		}
	}
}

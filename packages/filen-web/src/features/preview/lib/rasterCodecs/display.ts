import { decodeJxl } from "@/features/preview/lib/rasterCodecs/jxl"
import { decodeQoi } from "@/features/preview/lib/rasterCodecs/qoi"
import { decodeEpsi } from "@/features/preview/lib/rasterCodecs/epsi"
import type { DecodedRaster, DisplayRasterFormat } from "@/features/preview/lib/rasterCodecs/raster"

// The raster decode pool's display path: our own decoders' RGBA turned into a bitmap the page draws as it is, scaled
// down in the worker when a display long side is asked, with no encode and no second decode.

export interface DisplayedRaster {
	readonly bitmap: ImageBitmap
	// The image's own size; the bitmap's is smaller when it was scaled down.
	readonly width: number
	readonly height: number
}

const DECODERS: Readonly<Record<DisplayRasterFormat, (bytes: Uint8Array, maxPixels: number) => DecodedRaster | Promise<DecodedRaster>>> = {
	qoi: decodeQoi,
	jxl: decodeJxl,
	epsi: decodeEpsi
}

// The whole image as RGBA; `maxPixels` refuses a header naming more before anything is allocated.
export async function decodeRaster(format: DisplayRasterFormat, bytes: Uint8Array, maxPixels: number): Promise<DecodedRaster> {
	return await DECODERS[format](bytes, maxPixels)
}

// The size `width`×`height` takes with its long side at most `maxLongSide` (null: unchanged).
export function fitLongSide(width: number, height: number, maxLongSide: number | null): { width: number; height: number } {
	const scale = maxLongSide === null ? 1 : Math.min(1, maxLongSide / Math.max(width, height))

	return scale === 1
		? { width, height }
		: { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// The size `width`×`height` takes with at most `maxPixels` pixels: never larger than its own.
export function fitArea(width: number, height: number, maxPixels: number): { width: number; height: number } {
	const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))

	return scale >= 1
		? { width, height }
		: { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

// What "full resolution" draws a `width`×`height` image at: its own size, or the largest a canvas of this device holds
// (`canvasPixels`); null when that is no larger than the view at `reducedLongSide` already shows.
export function fullResolution(
	width: number,
	height: number,
	reducedLongSide: number,
	canvasPixels: number
): { width: number; height: number } | null {
	const full = fitArea(width, height, canvasPixels)

	return Math.max(full.width, full.height) > reducedLongSide ? full : null
}

// A scale where createImageBitmap ignores the resize options (an engine without them): drawn smaller on a canvas.
function drawnSmaller(full: ImageBitmap, width: number, height: number): ImageBitmap {
	const canvas = new OffscreenCanvas(width, height)
	const context = canvas.getContext("2d")

	if (context === null) {
		return full
	}

	context.imageSmoothingQuality = "high"
	context.drawImage(full, 0, 0, width, height)
	full.close()

	return canvas.transferToImageBitmap()
}

export async function displayBitmap(raster: DecodedRaster, maxLongSide: number | null): Promise<DisplayedRaster> {
	const image = new ImageData(raster.data, raster.width, raster.height)
	const size = fitLongSide(raster.width, raster.height, maxLongSide)
	const scaled = size.width !== raster.width || size.height !== raster.height
	const bitmap = scaled
		? await createImageBitmap(image, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" })
		: await createImageBitmap(image)
	const shown = bitmap.width === size.width && bitmap.height === size.height ? bitmap : drawnSmaller(bitmap, size.width, size.height)

	return { bitmap: shown, width: raster.width, height: raster.height }
}

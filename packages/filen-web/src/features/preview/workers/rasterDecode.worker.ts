/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { Semaphore } from "@filen/shared"
import { runHeicDecodeRgba, runHeicTransform, productionDeps } from "@/features/preview/lib/rasterCodecs/heic"
import { decodeRaster, displayBitmap, type DisplayedRaster } from "@/features/preview/lib/rasterCodecs/display"
import type { DecodedRaster, DisplayRasterFormat, RasterFormat } from "@/features/preview/lib/rasterCodecs/raster"

// Thin glue only — the codec modules own every real step (decode, orientation, freeing WASM handles, encode, error
// normalization). One of rasterDecode.ts's two pooled workers, each spun up lazily; every call while it lives reuses
// this same instance, so each codec's own decoder memoization applies across calls.
//
// Comlink runs an async handler per message without waiting for the previous one, and a decode yields mid-way
// (display callback, convertToBlob, a wasm load), so without this lock every queued message would start its decode
// and hold a full RGBA frame plus its share of the wasm heap at the same time.
const decodeLock = new Semaphore(1)

async function locked<T>(run: () => Promise<T>): Promise<T> {
	await decodeLock.acquire()

	try {
		return await run()
	} finally {
		decodeLock.release()
	}
}

const api = {
	transform: (bytes: Uint8Array): Promise<Blob> => locked(() => runHeicTransform(bytes, productionDeps)),
	// The RGBA frame goes back transferred, never cloned. `maxPixels` bounds the formats decoded by our own code; a
	// HEIC is decoded at any size, as it always was.
	decodeRgba: (format: RasterFormat, bytes: Uint8Array, maxPixels: number): Promise<DecodedRaster> =>
		locked(async () => {
			const decoded =
				format === "heic" ? await runHeicDecodeRgba(bytes, productionDeps) : await decodeRaster(format, bytes, maxPixels)

			return Comlink.transfer(decoded, [decoded.data.buffer])
		}),
	// The image as a bitmap no longer on its long side than `maxLongSide` (null: at its own size), transferred.
	display: (format: DisplayRasterFormat, bytes: Uint8Array, maxPixels: number, maxLongSide: number | null): Promise<DisplayedRaster> =>
		locked(async () => {
			const shown = await displayBitmap(await decodeRaster(format, bytes, maxPixels), maxLongSide)

			return Comlink.transfer(shown, [shown.bitmap])
		})
}

export type RasterDecodeWorkerApi = typeof api

Comlink.expose(api)

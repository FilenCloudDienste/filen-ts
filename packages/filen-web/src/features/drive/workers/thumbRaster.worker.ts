/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { encodeCanvasThumb, fitWithin } from "@/features/drive/lib/thumbGenerators.logic"

// Thumbnails of images only the browser decodes (JPEG XL where it has a decoder): codec-free, the browser's own
// decode of the bytes scaled straight to the tile, then WebP (JPEG or PNG where an engine cannot encode WebP). One
// thumbnail at a time; the bytes are this worker's (transferred), its bitmap closed as soon as it is drawn.
const api = {
	thumbnail: async (bytes: Uint8Array, type: string, width: number, height: number, maxDim: number): Promise<Uint8Array> => {
		const size = fitWithin(width, height, maxDim)
		const tile = { width: Math.max(1, size.width), height: Math.max(1, size.height) }
		const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), {
			resizeWidth: tile.width,
			resizeHeight: tile.height,
			resizeQuality: "high"
		})
		const canvas = new OffscreenCanvas(tile.width, tile.height)
		const context = canvas.getContext("2d")

		if (context === null) {
			bitmap.close()

			throw new Error("no 2d context for the thumbnail")
		}

		context.imageSmoothingQuality = "high"
		context.drawImage(bitmap, 0, 0, tile.width, tile.height)
		bitmap.close()

		const encoded = new Uint8Array(await (await encodeCanvasThumb(canvas, { alpha: true })).arrayBuffer())

		return Comlink.transfer(encoded, [encoded.buffer])
	}
}

export type ThumbRasterWorkerApi = typeof api

Comlink.expose(api)

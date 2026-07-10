/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { fitWithin, encodeCanvasThumb } from "@/features/drive/lib/thumbGenerators.logic"

// Client-side image thumbnail decode, off the main thread. createImageBitmap + OffscreenCanvas are
// both fully worker-spec'd (Chromium, Firefox, Safari 16.4+), so a multi-megapixel photo never blocks
// the tab, and the only thing crossing back over Comlink is the small encoded thumbnail — never the
// raw source bytes or a full-resolution bitmap. The browser, not the SDK's wasm decoder, owns decode
// now: whatever createImageBitmap accepts (jpeg/png/gif/webp/bmp/avif, plus anything else a given
// engine supports) produces a thumbnail; anything it can't decode THROWS here, which the caller maps
// to a null generation, and the service blacklists after three strikes. No format is claimed
// supported up front — the decode attempt itself is the probe.
async function generate(bytes: Uint8Array, maxDim: number): Promise<Uint8Array> {
	// Narrows the generic parameter only (Uint8Array<ArrayBuffer>): these bytes arrive via
	// Comlink.transfer from the caller (a fresh ArrayBuffer, never a SharedArrayBuffer), so wrapping
	// them in a Blob for createImageBitmap is a plain widening, not a shape change. A Blob (not the raw
	// buffer) is what createImageBitmap content-sniffs a format from.
	const blob = new Blob([bytes as Uint8Array<ArrayBuffer>])
	const bitmap = await createImageBitmap(blob)

	try {
		const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDim)
		const canvas = new OffscreenCanvas(width, height)
		const ctx = canvas.getContext("2d")

		if (ctx === null) {
			throw new Error("could not create an OffscreenCanvas 2D context")
		}

		ctx.drawImage(bitmap, 0, 0, width, height)

		const encoded = await encodeCanvasThumb(canvas)

		return new Uint8Array(await encoded.arrayBuffer())
	} finally {
		// createImageBitmap allocates a bitmap on the worker heap that GC won't reclaim on its own —
		// close() releases it whether the encode above succeeds or throws.
		bitmap.close()
	}
}

const api = {
	generate
}

export type ImageThumbWorkerApi = typeof api

Comlink.expose(api)

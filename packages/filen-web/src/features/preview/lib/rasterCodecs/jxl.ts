import decodeJxlImage, { init as initJxl } from "@jsquash/jxl/decode"
// Emitted by Vite as a hashed asset of this build and handed to the codec, whose own `new URL(…, import.meta.url)`
// lookup would point into the dependency pre-bundle in dev. CSP's 'wasm-unsafe-eval' admits the compile.
import jxlWasmUrl from "@jsquash/jxl/codec/dec/jxl_dec.wasm?url"
import { sniffJxl } from "@/features/preview/lib/imageSniff/jxl"
import { anyTranslucent, RasterBudgetError, type DecodedRaster } from "@/features/preview/lib/rasterCodecs/raster"

// JPEG XL where the browser has no decoder of its own: libjxl through @jsquash/jxl, in the raster decode pool. The
// first frame of an animation is what it gives. Its wasm heap grows to the largest image decoded and never shrinks;
// the pool's idle termination is what returns it, and a failed decode ends the worker (rasterDecode.ts).

let ready: Promise<unknown> | null = null

function ensureDecoder(): Promise<unknown> {
	ready ??= initJxl({ locateFile: () => jxlWasmUrl }).catch((error: unknown) => {
		// A failed instantiation (the wasm fetch failed) is kept by the codec for good; the next decode starts over.
		ready = null

		throw error
	})

	return ready
}

// The whole image as RGBA. `maxPixels` refuses a header naming more before the decoder is even loaded; a header the
// sniffer cannot read is refused too, as its size would be unknown until decoded.
export async function decodeJxl(bytes: Uint8Array, maxPixels: number): Promise<DecodedRaster> {
	const header = sniffJxl(bytes, bytes.length)

	if (header === null) {
		throw new Error("not a JPEG XL image the sniffer reads")
	}

	if (header.width * header.height > maxPixels) {
		throw new RasterBudgetError(`${String(header.width)}×${String(header.height)} is above the pixel budget`)
	}

	await ensureDecoder()

	const buffer =
		bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
			? bytes.buffer
			: bytes.slice().buffer
	// A decode that failed may have aborted the module (out of memory): the next one starts a fresh instance.
	const image = await decodeJxlImage(buffer).catch((error: unknown) => {
		ready = null

		throw error
	})

	// libjxl hands back RGBA whether or not the file has an alpha channel.
	return { width: image.width, height: image.height, data: image.data, hasAlpha: anyTranslucent(image.data) }
}

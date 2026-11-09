import encodeJpeg, { init as initJpeg } from "@jsquash/jpeg/encode"
// Emitted by Vite as a hashed asset of this build and handed to the codec, whose own `new URL(…, import.meta.url)`
// lookup would point into the dependency pre-bundle in dev. CSP's 'wasm-unsafe-eval' admits the compile.
import mozjpegWasmUrl from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url"
import { buildJpeg } from "@/features/preview/imageEdit/lib/jpegMeta"
import { buildPng } from "@/features/preview/imageEdit/lib/pngMeta"
import { buildWebp } from "@/features/preview/imageEdit/lib/webpMeta"
import { encodePng } from "@/features/preview/imageEdit/worker/pngEncoder"

// The export's encoders: RGBA in, a finished file out, with the original's Exif and ICC profile carried over by the
// metadata builders. Each consumes the pixel buffer it is given; the caller does not reuse it.

export interface ExportMeta {
	exif: Uint8Array | null
	icc: Uint8Array | null
	hasAlpha: boolean
	webpLossless: boolean
}

// The metadata builders allocate their output on a plain ArrayBuffer; viewing it as such costs no copy.
function blobOf(bytes: Uint8Array, type: string): Blob {
	const part = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice()

	return new Blob([part], { type })
}

let jpegReady: Promise<void> | null = null

// Awaited before every encode: an encode that ran ahead of it would instantiate the codec itself, from the URL
// the pre-bundle resolves.
function ensureJpeg(): Promise<void> {
	jpegReady ??= initJpeg({ locateFile: () => mozjpegWasmUrl })

	return jpegReady
}

// MozJPEG through @jsquash/jpeg (progressive, optimised Huffman, 4:2:0) at `quality` 0..1, on the T.81 Annex K
// quantisation tables (quant_table 0) rather than its default ImageMagick set: the source quality estimate is
// calibrated on Annex K, so a file saved at q92 reads back as q92 and repeated saves do not ratchet the quality down.
async function toJpeg(pixels: Uint8Array<ArrayBuffer>, width: number, height: number, quality: number, meta: ExportMeta): Promise<Blob> {
	await ensureJpeg().catch((error: unknown) => {
		jpegReady = null

		throw error
	})

	const image = new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height)
	const encoded = new Uint8Array(
		await encodeJpeg(image, { quality: Math.round(Math.min(1, Math.max(0, quality)) * 100), quant_table: 0 }).catch(
			(error: unknown) => {
				// The codec keeps a failed instantiation (a wasm fetch that failed) for good; the next export starts over.
				jpegReady = null

				throw error
			}
		)
	)
	const file = buildJpeg(encoded, { exif: meta.exif, icc: meta.icc, width, height })

	return blobOf(file, "image/jpeg")
}

async function toPng(pixels: Uint8Array<ArrayBuffer>, width: number, height: number, meta: ExportMeta): Promise<Blob> {
	const encoded = await encodePng(pixels, width, height, meta.hasAlpha)
	const file = buildPng(encoded, { icc: meta.icc === null ? null : await pngIccData(meta.icc), exif: meta.exif })

	return blobOf(file, "image/png")
}

// A raw ICC profile (from a WebP, HEIF or JPEG source; ICC.1 §7.2: "acsp" at byte 36) becomes iCCP chunk data:
// a profile name, a NUL, compression method 0, then the zlib stream (PNG 3rd ed. §11.3.3.3). A PNG source's
// own iCCP data passes through as it was read.
async function pngIccData(icc: Uint8Array): Promise<Uint8Array> {
	if (icc.length < 40 || icc[36] !== 0x61 || icc[37] !== 0x63 || icc[38] !== 0x73 || icc[39] !== 0x70) {
		return icc
	}

	const zlib = new Uint8Array(
		await new Response(new Blob([icc.slice()]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()
	)
	const data = new Uint8Array(ICC_NAME.length + 2 + zlib.length)

	data.set(ICC_NAME)
	data.set(zlib, ICC_NAME.length + 2)

	return data
}

const ICC_NAME = new TextEncoder().encode("ICC profile")

function isWebp(bytes: Uint8Array): boolean {
	const fourcc = (at: number): string => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)

	return bytes.length >= 12 && fourcc(0) === "RIFF" && fourcc(8) === "WEBP"
}

// The engine's own WebP encoder behind OffscreenCanvas.convertToBlob (HTML § OffscreenCanvas). An engine without
// one silently returns PNG instead, so the bytes are checked, not the blob's type alone. Lossless sources ask for
// quality 1, which Chromium encodes losslessly.
async function toWebp(pixels: Uint8Array<ArrayBuffer>, width: number, height: number, quality: number, meta: ExportMeta): Promise<Blob> {
	const canvas = new OffscreenCanvas(width, height)
	const ctx = canvas.getContext("2d")

	if (ctx === null) {
		throw new Error("2D canvas unavailable")
	}

	ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0)

	const blob = await canvas.convertToBlob({ type: "image/webp", quality: meta.webpLossless ? 1 : quality })

	// Free the canvas's backing store now rather than at collection.
	canvas.width = 0
	canvas.height = 0

	const encoded = new Uint8Array(await blob.arrayBuffer())

	if (!isWebp(encoded)) {
		throw new Error("this browser cannot encode WebP")
	}

	const file = buildWebp(encoded, { icc: meta.icc, exif: meta.exif, width, height, hasAlpha: meta.hasAlpha })

	return blobOf(file, "image/webp")
}

export async function encodeImage(
	pixels: Uint8Array<ArrayBuffer>,
	width: number,
	height: number,
	target: { mime: "image/jpeg" | "image/png" | "image/webp"; quality: number },
	meta: ExportMeta
): Promise<Blob> {
	switch (target.mime) {
		case "image/jpeg":
			return await toJpeg(pixels, width, height, target.quality, meta)
		case "image/png":
			return await toPng(pixels, width, height, meta)
		case "image/webp":
			return await toWebp(pixels, width, height, target.quality, meta)
	}
}

let webpProbe: Promise<boolean> | null = null

// Whether convertToBlob really encodes WebP here, from a 1×1 canvas; asked once per worker.
export function canEncodeWebp(): Promise<boolean> {
	webpProbe ??= (async () => {
		const canvas = new OffscreenCanvas(1, 1)

		if (canvas.getContext("2d") === null) {
			return false
		}

		const blob = await canvas.convertToBlob({ type: "image/webp" })

		return blob.type === "image/webp" && isWebp(new Uint8Array(await blob.arrayBuffer()))
	})().catch(() => false)

	return webpProbe
}

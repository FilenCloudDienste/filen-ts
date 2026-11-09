import { crc32 } from "@/features/preview/imageEdit/lib/crc32"
import { normalizeExif } from "@/features/preview/imageEdit/lib/jpegMeta"

// PNG chunk reading and writing (PNG 3rd ed. §5). Inputs are never written to.

export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const CHUNK_IHDR = 0x49484452 // "IHDR"
export const CHUNK_IDAT = 0x49444154 // "IDAT"
export const CHUNK_IEND = 0x49454e44 // "IEND"
export const CHUNK_ICCP = 0x69434350 // "iCCP"
export const CHUNK_EXIF = 0x65584966 // "eXIf"
export const CHUNK_TRNS = 0x74524e53 // "tRNS"
export const CHUNK_ACTL = 0x6163544c // "acTL"
const CHUNK_SRGB = 0x73524742 // "sRGB"
const CHUNK_GAMA = 0x67414d41 // "gAMA"
const CHUNK_CHRM = 0x6348524d // "cHRM"
const CHUNK_CICP = 0x63494350 // "cICP"

// Colour-space chunks an encoder may add: they would contradict (or, cICP, override — §11.3.2.6) the original's
// iCCP, which is written instead.
const COLOUR_CHUNKS = new Set([CHUNK_SRGB, CHUNK_GAMA, CHUNK_CHRM, CHUNK_ICCP, CHUNK_CICP, CHUNK_EXIF])

export interface PngChunk {
	type: number
	// The length field.
	start: number
	data: number
	// After the CRC.
	end: number
}

export function isPng(bytes: Uint8Array): boolean {
	return bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)
}

// Walks the chunks after the signature until IEND, a chunk cut off by the end of `bytes`, or `visit` returning false.
// Returns the offset the walk stopped at, or -1 when the bytes are not PNG.
export function walkPngChunks(bytes: Uint8Array, visit: (chunk: PngChunk) => boolean): number {
	if (!isPng(bytes)) {
		return -1
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let at = 8

	while (at + 12 <= bytes.length) {
		const length = view.getUint32(at)
		const end = at + 12 + length

		if (end > bytes.length) {
			return at
		}

		const chunk = { type: view.getUint32(at + 4), start: at, data: at + 8, end }

		if (!visit(chunk) || chunk.type === CHUNK_IEND) {
			return end
		}

		at = end
	}

	return at
}

// One chunk: length, type, data, CRC over type and data (§5.3).
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, data.length)

	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i)
	}

	out.set(data, 8)
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))

	return out
}

// Re-wraps an encoder's PNG with the original's metadata: the encoder's colour chunks and eXIf dropped, the raw
// iCCP chunk data right after IHDR (it must precede PLTE and IDAT, §5.6), and eXIf (Orientation 1, no IFD1,
// dimensions from IHDR) before the first IDAT.
export function buildPng(encoded: Uint8Array, meta: { icc: Uint8Array | null; exif: Uint8Array | null }): Uint8Array {
	const kept: [number, number][] = []
	let width = 0
	let height = 0
	let ihdrEnd = -1
	let firstIdat = -1
	const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
	const stop = walkPngChunks(encoded, chunk => {
		if (chunk.type === CHUNK_IHDR) {
			width = view.getUint32(chunk.data)
			height = view.getUint32(chunk.data + 4)
			ihdrEnd = chunk.end
		} else if (chunk.type === CHUNK_IDAT && firstIdat < 0) {
			firstIdat = chunk.start
		}

		if (!COLOUR_CHUNKS.has(chunk.type)) {
			kept.push([chunk.start, chunk.end])
		}

		return true
	})

	if (stop < 0 || ihdrEnd < 0 || firstIdat < 0) {
		throw new Error("the encoder's output is not a PNG")
	}

	const iccp = meta.icc === null ? null : pngChunk("iCCP", meta.icc)
	const exifData = meta.exif === null ? null : normalizeExif(meta.exif, { width, height })
	const exif = exifData === null ? null : pngChunk("eXIf", exifData)
	let total = 8 + (iccp?.length ?? 0) + (exif?.length ?? 0)

	for (const [start, end] of kept) {
		total += end - start
	}

	const out = new Uint8Array(total)
	let at = 8

	out.set(PNG_SIGNATURE)

	for (const [start, end] of kept) {
		if (start === firstIdat && exif !== null) {
			out.set(exif, at)
			at += exif.length
		}

		out.set(encoded.subarray(start, end), at)
		at += end - start

		if (end === ihdrEnd && iccp !== null) {
			out.set(iccp, at)
			at += iccp.length
		}
	}

	return out
}

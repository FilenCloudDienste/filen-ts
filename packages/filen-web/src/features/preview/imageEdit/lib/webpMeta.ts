import { normalizeExif } from "@/features/preview/imageEdit/lib/jpegMeta"

// WebP RIFF container reading and writing (RFC 9649 §2.7, the WebP container). Inputs are never written to.

export const CHUNK_VP8 = 0x56503820 // "VP8 "
export const CHUNK_VP8L = 0x5650384c // "VP8L"
export const CHUNK_VP8X = 0x56503858 // "VP8X"
export const CHUNK_ALPH = 0x414c5048 // "ALPH"
export const CHUNK_ANIM = 0x414e494d // "ANIM"
export const CHUNK_ICCP = 0x49434350 // "ICCP"
export const CHUNK_EXIF = 0x45584946 // "EXIF"

// VP8X flags (RFC 9649 §2.7): Rsv Rsv I L E X A R, most significant bit first.
export const VP8X_ICC = 0x20
export const VP8X_ALPHA = 0x10
export const VP8X_EXIF = 0x08
export const VP8X_ANIMATION = 0x02

// The VP8L header's signature byte (RFC 9649 §3.2.1).
const VP8L_SIGNATURE = 0x2f

export interface RiffChunk {
	type: number
	start: number
	data: number
	// The payload's size as stored (without the pad byte).
	size: number
	// After the pad byte.
	end: number
}

function isWebp(view: DataView): boolean {
	return view.byteLength >= 12 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250 // "RIFF" … "WEBP"
}

// Walks the chunks after the RIFF header until one is cut off by the end of `bytes` or `visit` returns false.
// Returns the offset the walk stopped at, or -1 when the bytes are not WebP.
export function walkWebpChunks(bytes: Uint8Array, visit: (chunk: RiffChunk) => boolean): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (!isWebp(view)) {
		return -1
	}

	let at = 12

	while (at + 8 <= bytes.length) {
		const size = view.getUint32(at + 4, true)
		const data = at + 8

		if (data + size > bytes.length) {
			return at
		}

		// Odd payloads are padded to an even length (RFC 9649 §2.2); a missing final pad is tolerated.
		const chunk = { type: view.getUint32(at), start: at, data, size, end: Math.min(bytes.length, data + size + (size & 1)) }

		if (!visit(chunk)) {
			return chunk.end
		}

		at = chunk.end
	}

	return at
}

// The VP8L bitstream's alpha_is_used bit (RFC 9649 §3.2.1: 14 bits width − 1, 14 bits height − 1, then it).
export function vp8lHasAlpha(bytes: Uint8Array, chunk: RiffChunk): boolean {
	return chunk.size >= 5 && bytes[chunk.data] === VP8L_SIGNATURE && ((bytes[chunk.data + 4] ?? 0) & 0x10) !== 0
}

function writeChunkHeader(view: DataView, at: number, type: number, size: number): number {
	view.setUint32(at, type)
	view.setUint32(at + 4, size, true)

	return at + 8
}

function paddedSize(size: number): number {
	return size + (size & 1)
}

// Re-wraps a browser-encoded WebP as an extended file carrying the original's metadata: VP8X (canvas size, I/L/E
// flags), ICCP, the encoder's ALPH and VP8/VP8L, then EXIF (Orientation 1, no IFD1, dimensions rewritten), in the
// order RFC 9649 §2.7 lays out. Without metadata the encoder's file is returned as it is.
export function buildWebp(
	encoded: Uint8Array,
	meta: { icc: Uint8Array | null; exif: Uint8Array | null; width: number; height: number; hasAlpha: boolean }
): Uint8Array {
	const image: RiffChunk[] = []
	const stop = walkWebpChunks(encoded, chunk => {
		if (chunk.type === CHUNK_ALPH || chunk.type === CHUNK_VP8 || chunk.type === CHUNK_VP8L) {
			image.push(chunk)
		}

		return true
	})
	const alpha = image.some(
		chunk => chunk.type === CHUNK_ALPH || (chunk.type === CHUNK_VP8L && (meta.hasAlpha || vp8lHasAlpha(encoded, chunk)))
	)

	if (stop < 0 || !image.some(chunk => chunk.type !== CHUNK_ALPH)) {
		throw new Error("the encoder's output is not a WebP")
	}

	const icc = meta.icc !== null && meta.icc.length > 0 ? meta.icc : null
	const exif = meta.exif === null ? null : normalizeExif(meta.exif, { width: meta.width, height: meta.height })

	if (icc === null && exif === null) {
		return encoded
	}

	if (meta.width < 1 || meta.height < 1 || meta.width > 1 << 24 || meta.height > 1 << 24) {
		throw new RangeError("the canvas size does not fit VP8X")
	}

	let total = 12 + 8 + 10

	if (icc !== null) {
		total += 8 + paddedSize(icc.length)
	}

	for (const chunk of image) {
		total += 8 + paddedSize(chunk.size)
	}

	if (exif !== null) {
		total += 8 + paddedSize(exif.length)
	}

	// Zero-filled: reserved bits and pad bytes stay 0.
	const out = new Uint8Array(total)
	const view = new DataView(out.buffer)

	view.setUint32(0, 0x52494646)
	view.setUint32(4, total - 8, true)
	view.setUint32(8, 0x57454250)

	let at = writeChunkHeader(view, 12, CHUNK_VP8X, 10)

	out[at] = (icc === null ? 0 : VP8X_ICC) | (alpha ? VP8X_ALPHA : 0) | (exif === null ? 0 : VP8X_EXIF)
	view.setUint16(at + 4, (meta.width - 1) & 0xffff, true)
	out[at + 6] = (meta.width - 1) >>> 16
	view.setUint16(at + 7, (meta.height - 1) & 0xffff, true)
	out[at + 9] = (meta.height - 1) >>> 16
	at += 10

	if (icc !== null) {
		at = writeChunkHeader(view, at, CHUNK_ICCP, icc.length)
		out.set(icc, at)
		at += paddedSize(icc.length)
	}

	for (const chunk of image) {
		at = writeChunkHeader(view, at, chunk.type, chunk.size)
		out.set(encoded.subarray(chunk.data, chunk.data + chunk.size), at)
		at += paddedSize(chunk.size)
	}

	if (exif !== null) {
		at = writeChunkHeader(view, at, CHUNK_EXIF, exif.length)
		out.set(exif, at)
	}

	return out
}

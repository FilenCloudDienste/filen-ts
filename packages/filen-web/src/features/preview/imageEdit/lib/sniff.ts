import { sniffHeif } from "@/features/preview/imageEdit/lib/heifMeta"
import { MARKER_SOS, isExifPayload, isIccPayload, readExifOrientation, walkJpegSegments } from "@/features/preview/imageEdit/lib/jpegMeta"
import {
	CHUNK_ACTL,
	CHUNK_EXIF,
	CHUNK_ICCP,
	CHUNK_IDAT,
	CHUNK_IHDR,
	CHUNK_TRNS,
	walkPngChunks
} from "@/features/preview/imageEdit/lib/pngMeta"
import {
	CHUNK_ALPH,
	CHUNK_ANIM,
	CHUNK_EXIF as WEBP_EXIF,
	CHUNK_ICCP as WEBP_ICCP,
	CHUNK_VP8,
	CHUNK_VP8L,
	CHUNK_VP8X,
	VP8X_ALPHA,
	VP8X_ANIMATION,
	VP8X_EXIF,
	vp8lHasAlpha,
	walkWebpChunks
} from "@/features/preview/imageEdit/lib/webpMeta"
import type { Orientation, SourceInfo } from "@/features/preview/imageEdit/types"

// What an image's leading bytes say about it, from its magic and headers (never its name). `head` is the start of
// the file (the whole file when small), `totalSize` the file's length. Retained metadata (ICC, Exif) is copied out
// of `head`: a view would keep the whole head alive and drag it along every postMessage.

type Base = Omit<SourceInfo, "mime" | "width" | "height">

const BASE: Readonly<Base> = {
	orientation: 1,
	hasAlpha: false,
	animated: false,
	pngTruecolor8: false,
	webpLossless: false,
	jpegQuality: null,
	icc: null,
	exif: null,
	needsTail: false
}

// Orientations 5..8 swap the axes.
function swapsAxes(orientation: Orientation): boolean {
	return orientation >= 5
}

function viewOf(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

// ITU-T T.81 Annex K.1 Table K.1, the luminance table the IJG quality scaling multiplies.
const LUMINANCE_BASE = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22,
	37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
]
// Zig-zag sequence index → natural (row-major) index: a DQT stores its 64 entries zig-zag (T.81 Figure A.6).
const ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56,
	57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
]

// IJG libjpeg scales the base by s = q < 50 ? 5000 / q : 200 − 2q (percent), clamping each entry to 1..255. The
// unclamped entries' sum over their bases' sum recovers s, and from it q: exact to ±1 for every IJG quality.
// `table` is in zig-zag order.
function estimateQuality(table: readonly number[]): number {
	let sum = 0
	let baseSum = 0
	let allOnes = true

	for (let i = 0; i < table.length; i++) {
		const value = table[i] ?? 0

		allOnes &&= value === 1

		if (value > 1 && value < 255) {
			sum += value
			baseSum += LUMINANCE_BASE[ZIGZAG[i] ?? 0] ?? 0
		}
	}

	if (baseSum === 0) {
		return allOnes ? 100 : 1
	}

	const scale = (sum * 100) / baseSum
	const quality = scale <= 100 ? (200 - scale) / 2 : 5000 / scale

	return Math.min(100, Math.max(1, Math.round(quality)))
}

// The quality of the first luminance (Tq 0) table in a DQT payload (T.81 B.2.4.1), or null.
function dqtQuality(view: DataView, start: number, end: number): number | null {
	let at = start

	while (at < end) {
		const pqTq = view.getUint8(at)
		const wide = pqTq >> 4 === 1
		const tableEnd = at + 1 + (wide ? 128 : 64)

		if (tableEnd > end) {
			return null
		}

		if ((pqTq & 0xf) === 0) {
			const table: number[] = []

			for (let i = 0; i < 64; i++) {
				table.push(wide ? view.getUint16(at + 1 + i * 2) : view.getUint8(at + 1 + i))
			}

			return estimateQuality(table)
		}

		at = tableEnd
	}

	return null
}

// Start-of-frame markers carry the size (T.81 B.2.2); C4 DHT, C8 JPG and CC DAC share the range but are not frames.
function isSof(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function concatChunks(chunks: (Uint8Array | undefined)[]): Uint8Array | null {
	let total = 0

	for (const chunk of chunks) {
		if (chunk === undefined) {
			return null
		}

		total += chunk.length
	}

	const out = new Uint8Array(total)
	let at = 0

	for (const chunk of chunks) {
		if (chunk !== undefined) {
			out.set(chunk, at)
			at += chunk.length
		}
	}

	return out
}

function sniffJpeg(head: Uint8Array): SourceInfo | null {
	const view = viewOf(head)
	// Written by the walk's callback (an object, so the reads after it are not narrowed to the initial values).
	const found: {
		width: number
		height: number
		quality: number | null
		exif: Uint8Array | null
		iccChunks: (Uint8Array | undefined)[] | null
		iccBroken: boolean
	} = { width: 0, height: 0, quality: null, exif: null, iccChunks: null, iccBroken: false }
	const stop = walkJpegSegments(head, segment => {
		const { marker, payloadStart: at, end } = segment

		if (marker === MARKER_SOS) {
			return false
		}

		if (marker === 0xe1 && found.exif === null && isExifPayload(head, at)) {
			found.exif = head.slice(at + 6, end)
		} else if (marker === 0xe2 && isIccPayload(head, at) && at + 14 <= end) {
			// "ICC_PROFILE\0", 1-based sequence number, chunk count (ICC.1 Annex B.4).
			const sequence = view.getUint8(at + 12)
			const count = view.getUint8(at + 13)

			found.iccChunks ??= Array.from({ length: count })

			if (sequence < 1 || sequence > count || count !== found.iccChunks.length) {
				found.iccBroken = true
			} else {
				found.iccChunks[sequence - 1] = head.slice(at + 14, end)
			}
		} else if (marker === 0xdb && found.quality === null) {
			found.quality = dqtQuality(view, at, end)
		} else if (isSof(marker) && found.width === 0 && at + 5 <= end) {
			found.height = view.getUint16(at + 1)
			found.width = view.getUint16(at + 3)
		}

		return true
	})
	const { width, height, exif, iccChunks } = found

	// A height of 0 defers to a DNL marker after the first scan (T.81 B.2.5): not known from the head.
	if (stop < 0 || width === 0 || height === 0) {
		return null
	}

	const orientation = exif === null ? 1 : readExifOrientation(exif)
	const swap = swapsAxes(orientation)

	return {
		...BASE,
		mime: "image/jpeg",
		width: swap ? height : width,
		height: swap ? width : height,
		orientation,
		jpegQuality: found.quality,
		icc: iccChunks === null || found.iccBroken ? null : concatChunks(iccChunks),
		exif
	}
}

// ── PNG ──────────────────────────────────────────────────────────────────────

function sniffPng(head: Uint8Array): SourceInfo | null {
	const view = viewOf(head)
	const found: {
		width: number
		height: number
		bitDepth: number
		colourType: number
		transparency: boolean
		animated: boolean
		idatSeen: boolean
		icc: Uint8Array | null
		exif: Uint8Array | null
		first: boolean
	} = {
		width: 0,
		height: 0,
		bitDepth: 0,
		colourType: -1,
		transparency: false,
		animated: false,
		idatSeen: false,
		icc: null,
		exif: null,
		first: true
	}
	const stop = walkPngChunks(head, chunk => {
		const isFirst = found.first

		found.first = false

		// IHDR comes first (PNG 3rd ed. §5.6).
		if (isFirst !== (chunk.type === CHUNK_IHDR)) {
			return false
		}

		const dataEnd = chunk.end - 4

		switch (chunk.type) {
			case CHUNK_IHDR: {
				if (dataEnd - chunk.data >= 13) {
					found.width = view.getUint32(chunk.data)
					found.height = view.getUint32(chunk.data + 4)
					found.bitDepth = view.getUint8(chunk.data + 8)
					found.colourType = view.getUint8(chunk.data + 9)
				}

				break
			}

			case CHUNK_TRNS: {
				found.transparency = true

				break
			}

			// APNG: acTL counts only before the first IDAT; after it the file is a plain PNG to every decoder.
			case CHUNK_ACTL: {
				found.animated ||= !found.idatSeen

				break
			}

			case CHUNK_IDAT: {
				found.idatSeen = true

				break
			}

			// The raw chunk data (profile name, method, zlib stream): kept compressed for buildPng.
			case CHUNK_ICCP: {
				found.icc ??= head.slice(chunk.data, dataEnd)

				break
			}

			case CHUNK_EXIF: {
				found.exif ??= head.slice(chunk.data, dataEnd)

				break
			}
		}

		return true
	})
	const { width, height, colourType, exif } = found

	if (stop < 0 || width === 0 || height === 0 || colourType < 0) {
		return null
	}

	const orientation = exif === null ? 1 : readExifOrientation(exif)
	const swap = swapsAxes(orientation)

	return {
		...BASE,
		mime: "image/png",
		width: swap ? height : width,
		height: swap ? width : height,
		orientation,
		// Colour types 4 and 6 carry alpha; tRNS adds it to the others (§11.3.1.1).
		hasAlpha: colourType === 4 || colourType === 6 || found.transparency,
		animated: found.animated,
		pngTruecolor8: (colourType === 2 || colourType === 6) && found.bitDepth === 8,
		icc: found.icc,
		exif
	}
}

// ── WebP ─────────────────────────────────────────────────────────────────────

function sniffWebp(head: Uint8Array, totalSize: number): SourceInfo | null {
	const view = viewOf(head)
	const found: {
		width: number
		height: number
		flags: number
		alpha: boolean
		animated: boolean
		lossless: boolean
		icc: Uint8Array | null
		exif: Uint8Array | null
		first: boolean
	} = { width: 0, height: 0, flags: -1, alpha: false, animated: false, lossless: false, icc: null, exif: null, first: true }
	const stop = walkWebpChunks(head, chunk => {
		const isFirst = found.first

		found.first = false

		if (isFirst && chunk.type === CHUNK_VP8X && chunk.size >= 10) {
			// Flags, 3 reserved bytes, canvas width − 1 and height − 1 as 24-bit little endian (RFC 9649 §2.7).
			found.flags = view.getUint8(chunk.data)
			found.width = 1 + view.getUint16(chunk.data + 4, true) + (view.getUint8(chunk.data + 6) << 16)
			found.height = 1 + view.getUint16(chunk.data + 7, true) + (view.getUint8(chunk.data + 9) << 16)
		}

		switch (chunk.type) {
			// A key frame starts with the 9D 01 2A start code, then 14-bit width and height (RFC 6386 §9.1).
			case CHUNK_VP8: {
				if (isFirst && chunk.size >= 10 && view.getUint32(chunk.data + 3) >>> 8 === 0x9d012a) {
					found.width = view.getUint16(chunk.data + 6, true) & 0x3fff
					found.height = view.getUint16(chunk.data + 8, true) & 0x3fff
				}

				break
			}

			case CHUNK_VP8L: {
				found.lossless = true
				found.alpha ||= vp8lHasAlpha(head, chunk)

				if (isFirst && chunk.size >= 5) {
					const bits = view.getUint32(chunk.data + 1, true)

					found.width = (bits & 0x3fff) + 1
					found.height = ((bits >>> 14) & 0x3fff) + 1
				}

				break
			}

			case CHUNK_ALPH: {
				found.alpha = true

				break
			}

			case CHUNK_ANIM: {
				found.animated = true

				break
			}

			case WEBP_ICCP: {
				found.icc ??= head.slice(chunk.data, chunk.data + chunk.size)

				break
			}

			// Raw TIFF per the container spec, though some writers keep the JPEG "Exif\0\0" prefix.
			case WEBP_EXIF: {
				found.exif ??= head.slice(chunk.data + (isExifPayload(head, chunk.data) ? 6 : 0), chunk.data + chunk.size)

				break
			}
		}

		return true
	})
	const { width, height, flags, exif } = found

	if (stop < 0 || width === 0 || height === 0) {
		return null
	}

	const extended = flags >= 0
	const animated = found.animated || (extended && (flags & VP8X_ANIMATION) !== 0)

	return {
		...BASE,
		mime: "image/webp",
		// Engines differ on applying a WebP's Exif orientation, so the size stays as encoded; the reported value
		// is informational.
		width,
		height,
		orientation: exif === null ? 1 : readExifOrientation(exif),
		hasAlpha: found.alpha || (extended && (flags & VP8X_ALPHA) !== 0),
		animated,
		// An animation's frames may mix both; only a still is classified.
		webpLossless: found.lossless && !animated,
		icc: found.icc,
		exif,
		// The EXIF chunk sits after the image data (RFC 9649 §2.7), beyond a head of a large file.
		needsTail: extended && (flags & VP8X_EXIF) !== 0 && exif === null && head.length < totalSize
	}
}

// ── GIF ──────────────────────────────────────────────────────────────────────

// Skips a run of data sub-blocks (GIF89a §15); returns the offset after the terminator, or -1 when cut off.
function skipSubBlocks(head: Uint8Array, at: number): number {
	let pos = at

	while (pos < head.length) {
		const size = head[pos] ?? 0

		if (size === 0) {
			return pos + 1
		}

		pos += 1 + size
	}

	return -1
}

function sniffGif(head: Uint8Array, totalSize: number): SourceInfo | null {
	if (head.length < 13) {
		return null
	}

	const view = viewOf(head)
	const width = view.getUint16(6, true)
	const height = view.getUint16(8, true)
	const screenFlags = view.getUint8(10)
	let pos = 13 + ((screenFlags & 0x80) !== 0 ? 3 * 2 ** ((screenFlags & 7) + 1) : 0)
	let frames = 0
	let looping = false
	let transparent = false
	let complete = false

	while (pos < head.length && frames < 2) {
		const introducer = head[pos]

		if (introducer === 0x3b) {
			complete = true

			break
		}

		if (introducer === 0x21) {
			const label = head[pos + 1]

			// Graphic Control Extension (§23): the transparency flag of the frame it precedes.
			if (label === 0xf9 && frames === 0 && pos + 3 < head.length) {
				transparent ||= ((head[pos + 3] ?? 0) & 1) === 1
			}

			// Application Extension (§26): NETSCAPE2.0 is the looping animation block.
			if (label === 0xff && pos + 14 <= head.length) {
				looping ||= String.fromCharCode(...head.subarray(pos + 3, pos + 14)) === "NETSCAPE2.0"
			}

			pos = skipSubBlocks(head, pos + 2)
		} else if (introducer === 0x2c) {
			// Image Descriptor (§20): 9 bytes, an optional local colour table, the LZW code size, then the data.
			const flags = head[pos + 9] ?? 0

			frames++
			pos = skipSubBlocks(head, pos + 10 + ((flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1)
		} else {
			break
		}

		if (pos < 0) {
			break
		}
	}

	if (width === 0 || height === 0) {
		return null
	}

	// The whole file read: the count is exact. Only a head: a second frame may be beyond it; a looping block
	// says the file is meant to animate, so treat it as animated rather than edit one frame of many.
	const truncated = !complete && frames < 2 && head.length < totalSize

	return {
		...BASE,
		mime: "image/gif",
		width,
		height,
		hasAlpha: transparent,
		animated: frames > 1 || (truncated && looping)
	}
}

// ── BMP / ICO ────────────────────────────────────────────────────────────────

function sniffBmp(head: Uint8Array): SourceInfo | null {
	if (head.length < 26) {
		return null
	}

	const view = viewOf(head)
	const headerSize = view.getUint32(14, true)

	// BITMAPCOREHEADER: 16-bit sizes, no compression field, no alpha.
	if (headerSize === 12) {
		return { ...BASE, mime: "image/bmp", width: view.getUint16(18, true), height: view.getUint16(20, true) }
	}

	if (head.length < 34) {
		return null
	}

	const width = Math.abs(view.getInt32(18, true))
	// Negative height: rows stored top-down.
	const height = Math.abs(view.getInt32(22, true))
	const bitCount = view.getUint16(28, true)
	const compression = view.getUint32(30, true)
	// The alpha mask follows R, G and B at 66 in a V3+ header, or in a 40-byte header with BI_ALPHABITFIELDS (6).
	const alphaMask = (headerSize >= 56 || compression === 6) && head.length >= 70 ? view.getUint32(66, true) : 0
	const hasAlpha = bitCount === 32 && (compression === 3 || compression === 6) && alphaMask !== 0

	return width === 0 || height === 0 ? null : { ...BASE, mime: "image/bmp", width, height, hasAlpha }
}

// The largest image in the directory: what a browser shows of an icon.
function sniffIco(head: Uint8Array): SourceInfo | null {
	const view = viewOf(head)
	const count = view.getUint16(4, true)
	let width = 0
	let height = 0

	for (let i = 0; i < count && 6 + (i + 1) * 16 <= head.length; i++) {
		// A stored 0 means 256.
		const w = view.getUint8(6 + i * 16) || 256
		const h = view.getUint8(7 + i * 16) || 256

		if (w * h > width * height) {
			width = w
			height = h
		}
	}

	return width === 0 ? null : { ...BASE, mime: "image/x-icon", width, height, hasAlpha: true }
}

// ── Entry ────────────────────────────────────────────────────────────────────

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
	return bytes.length >= at + magic.length && magic.every((byte, i) => bytes[at + i] === byte)
}

export function sniffImage(head: Uint8Array, totalSize: number): SourceInfo | null {
	if (startsWith(head, [0xff, 0xd8, 0xff])) {
		return sniffJpeg(head)
	}

	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) {
		return sniffPng(head)
	}

	// "RIFF" … "WEBP"
	if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
		return sniffWebp(head, totalSize)
	}

	// "GIF87a" / "GIF89a"
	if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
		return sniffGif(head, totalSize)
	}

	// "BM"
	if (startsWith(head, [0x42, 0x4d])) {
		return sniffBmp(head)
	}

	// Reserved 0, type 1 (icon; 2 is a cursor).
	if (startsWith(head, [0, 0, 1, 0]) && head.length >= 6) {
		return sniffIco(head)
	}

	// An ISOBMFF "ftyp" box at the start.
	if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) {
		const heif = sniffHeif(head)

		return heif === null ? null : { ...BASE, ...heif }
	}

	return null
}

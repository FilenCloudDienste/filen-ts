import { RasterBudgetError, type DecodedRaster } from "@/features/preview/lib/rasterCodecs/raster"

// An EPSI preview (Adobe EPSF 3.0, Technical Note 5002, Appendix E): after its "%%BeginPreview: width height depth
// lines" line (parsed once, by the EPS sniffer), comment lines ("%" and hex) up to "%%EndPreview", the image's rows of
// `depth` bits a sample, each row padded to a byte. 0 is white and the depth's maximum black (§6.1: the opposite of
// setgray). The specification puts the first sample at the lower left, but the writers in use (ps2epsi, ImageMagick)
// write the top row first, so the rows are read top first.
//
// The decoder is handed what packEpsi builds: the declared size (width and height as 32-bit big endian, then the
// depth), then the preview's lines as read.

export interface EpsiSize {
	readonly width: number
	readonly height: number
	readonly depth: 1 | 2 | 4 | 8
}

const SIZE_BYTES = 9

// The most hex an EPSI preview may hold.
export const EPSI_MAX_HEX_DIGITS = 16 * 1024 * 1024

export function isEpsiDepth(value: number): value is 1 | 2 | 4 | 8 {
	return value === 1 || value === 2 || value === 4 || value === 8
}

// The hex digits the image's rows take.
export function epsiHexDigits(size: EpsiSize): number {
	return Math.ceil((size.width * size.depth) / 8) * size.height * 2
}

export function packEpsi(size: EpsiSize, lines: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(SIZE_BYTES + lines.length)
	const view = new DataView(bytes.buffer)

	view.setUint32(0, size.width)
	view.setUint32(4, size.height)
	bytes[8] = size.depth
	bytes.set(lines, SIZE_BYTES)

	return bytes
}

// The size packEpsi wrote; null for bytes too short to hold one, or naming none.
export function epsiSize(bytes: Uint8Array): EpsiSize | null {
	if (bytes.length < SIZE_BYTES) {
		return null
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const width = view.getUint32(0)
	const height = view.getUint32(4)
	const depth = bytes[8] ?? 0

	return width > 0 && height > 0 && isEpsiDepth(depth) ? { width, height, depth } : null
}

function hexValue(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x37
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x57

	return -1
}

const PERCENT = 0x25
const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d

// The preview as opaque grey RGBA. Refused before anything is allocated: a size over `maxPixels`, more hex than a
// preview may hold, or fewer bytes than its rows' hex. The hex ends at the first line starting "%%" (%%EndPreview, or
// whatever follows a short preview): a preview whose hex ends before its image does is refused, never filled from the
// PostScript after it.
export function decodeEpsi(bytes: Uint8Array, maxPixels: number): DecodedRaster {
	const size = epsiSize(bytes)

	if (size === null) {
		throw new Error("not an EPSI preview")
	}

	const { width, height, depth } = size

	if (width * height > maxPixels) {
		throw new RasterBudgetError(`${String(width)}×${String(height)} is above the pixel budget`)
	}

	const digits = epsiHexDigits(size)

	if (digits > EPSI_MAX_HEX_DIGITS || digits > bytes.length - SIZE_BYTES) {
		throw new Error("the preview's hex ends before its image does")
	}

	const rowBytes = Math.ceil((width * depth) / 8)
	const packed = new Uint8Array(rowBytes * height)
	let filled = 0
	let high = -1
	let lineStart = true

	for (let at = SIZE_BYTES; at < bytes.length && filled < packed.length; at++) {
		const byte = bytes[at] ?? 0

		if (byte === LINE_FEED || byte === CARRIAGE_RETURN) {
			lineStart = true

			continue
		}

		if (lineStart && byte === PERCENT && bytes[at + 1] === PERCENT) {
			break
		}

		lineStart = false

		const value = hexValue(byte)

		if (value < 0) {
			continue
		}

		if (high < 0) {
			high = value
		} else {
			packed[filled++] = (high << 4) | value
			high = -1
		}
	}

	if (filled < packed.length) {
		throw new Error("the preview's hex ends before its image does")
	}

	const data = new Uint8ClampedArray(width * height * 4)
	const max = (1 << depth) - 1

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const bit = x * depth
			const sample = ((packed[y * rowBytes + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & max
			const grey = 255 - Math.round((sample * 255) / max)
			const out = (y * width + x) * 4

			data[out] = grey
			data[out + 1] = grey
			data[out + 2] = grey
			data[out + 3] = 255
		}
	}

	return { width, height, data, hasAlpha: false }
}

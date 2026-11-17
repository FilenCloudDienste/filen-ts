import { RasterBudgetError, type DecodedRaster } from "@/features/preview/lib/rasterCodecs/raster"

// An EPSI preview (Adobe EPSF 3.0, Technical Note 5002, Appendix E): "%%BeginPreview: width height depth lines", then
// `lines` comment lines ("%" and hex), the image's rows of `depth` bits a sample, each row padded to a byte, 0 black and
// the depth's maximum white, top row first. The bytes handed here start at the %%BeginPreview line.

const BEGIN_PREVIEW = "%%BeginPreview:"

export interface EpsiSize {
	readonly width: number
	readonly height: number
	readonly depth: 1 | 2 | 4 | 8
	readonly lines: number
}

function isDepth(value: number): value is 1 | 2 | 4 | 8 {
	return value === 1 || value === 2 || value === 4 || value === 8
}

// The size the %%BeginPreview line at the bytes' start declares, and where its hex begins; null when it declares none.
export function epsiHeader(bytes: Uint8Array): (EpsiSize & { readonly dataStart: number }) | null {
	let end = 0

	while (end < bytes.length && end < 256 && bytes[end] !== 0x0a && bytes[end] !== 0x0d) {
		end++
	}

	const line = new TextDecoder("latin1").decode(bytes.subarray(0, end))

	if (!line.startsWith(BEGIN_PREVIEW) || end === bytes.length) {
		return null
	}

	const fields = line.slice(BEGIN_PREVIEW.length).trim().split(/\s+/)

	if (fields.length !== 4 || !fields.every(field => /^\d{1,9}$/.test(field))) {
		return null
	}

	const [width = 0, height = 0, depth = 0, lines = 0] = fields.map(Number)

	if (width === 0 || height === 0 || lines === 0 || !isDepth(depth)) {
		return null
	}

	return { width, height, depth, lines, dataStart: end + (bytes[end] === 0x0d && bytes[end + 1] === 0x0a ? 2 : 1) }
}

function hexValue(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x37
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x57

	return -1
}

// The preview as opaque grey RGBA. Refuses a size over `maxPixels` before allocating, and hex that ends before the
// image does.
export function decodeEpsi(bytes: Uint8Array, maxPixels: number): DecodedRaster {
	const header = epsiHeader(bytes)

	if (header === null) {
		throw new Error("not an EPSI preview")
	}

	const { width, height, depth } = header

	if (width * height > maxPixels) {
		throw new RasterBudgetError(`${String(width)}×${String(height)} is above the pixel budget`)
	}

	const rowBytes = Math.ceil((width * depth) / 8)
	const packed = new Uint8Array(rowBytes * height)
	let filled = 0
	let high = -1
	// At a line's start: its "%" is skipped.
	for (let at = header.dataStart; at < bytes.length && filled < packed.length; at++) {
		const byte = bytes[at] ?? 0
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
			const grey = Math.round((sample * 255) / max)
			const out = (y * width + x) * 4

			data[out] = grey
			data[out + 1] = grey
			data[out + 2] = grey
			data[out + 3] = 255
		}
	}

	return { width, height, data, hasAlpha: false }
}

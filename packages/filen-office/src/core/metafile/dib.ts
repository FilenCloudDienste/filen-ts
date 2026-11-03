import { zlibSync } from "fflate"
import type { Rgba } from "../drawingml/displayList"
import { crc32 } from "../opc/crc32"
import type { Bytes } from "./bytes"
import { MAX_DECODE_PIXELS } from "./limits"
import type { EmbeddedImage } from "./output"

// Device-independent bitmaps ([MS-WMF] 2.2.2.9) as images a browser shows: wrapped as a BMP file when it can
// draw them as stored (no pixel is touched), else decoded to RGBA and written as PNG (alpha, colour keys,
// masks, palette-indexed colour tables, 32-bit pixels whose fourth byte GDI ignores). JPEG and PNG
// compressed bitmaps pass through.

const BI_RGB = 0
const BI_RLE8 = 1
const BI_RLE4 = 2
const BI_BITFIELDS = 3
const BI_JPEG = 4
const BI_PNG = 5
const BI_ALPHABITFIELDS = 6

const MAX_DIMENSION = 65_535

export interface Dib {
	readonly bytes: Bytes
	readonly bmiOffset: number
	readonly width: number
	readonly height: number
	readonly topDown: boolean
	readonly bitCount: number
	readonly compression: number
	readonly headerSize: number
	// Colour table: absolute offset, entries, bytes per entry (3 for core headers; 2 for palette indices).
	readonly paletteOffset: number
	readonly paletteCount: number
	readonly paletteStride: number
	// Channel masks (red, green, blue, alpha) of 16- and 32-bit bitmaps.
	readonly masks: readonly [number, number, number, number]
	readonly bitsOffset: number
	readonly bitsSize: number
	readonly stride: number
}

// How pixels become transparent.
export type DibTransparency =
	| { readonly kind: "none" }
	// AC_SRC_ALPHA: the fourth byte is premultiplied alpha.
	| { readonly kind: "alpha" }
	// A colour key (TransparentBlt), 0xRRGGBB.
	| { readonly kind: "key"; readonly color: number }
	// Pixels of one colour (0xRRGGBB) drop out: white for an AND-ed mask, black for OR and XOR.
	| { readonly kind: "drop"; readonly color: number }
	// A monochrome mask bitmap: 0 bits are transparent.
	| { readonly kind: "mask"; readonly mask: Dib }

export const OPAQUE: DibTransparency = { kind: "none" }

// Palette lookup for DIB_PAL_COLORS colour tables (indices into the logical palette).
export type PaletteLookup = (index: number) => Rgba

// The pixels a conversion may still decode; spend() is false (and spends nothing) beyond it.
export interface PixelBudget {
	spend(pixels: number): boolean
}

export function parseDib(
	bytes: Bytes,
	bmiOffset: number,
	bmiSize: number,
	bitsOffset: number,
	bitsSize: number,
	usage: number
): Dib | undefined {
	if (bmiSize < 12 || !bytes.has(bmiOffset, 12)) return undefined

	const headerSize = bytes.u32(bmiOffset)
	let width: number
	let height: number
	let bitCount: number
	let compression = BI_RGB
	let colorsUsed = 0

	if (headerSize === 12) {
		width = bytes.u16(bmiOffset + 4)
		height = bytes.i16(bmiOffset + 6)
		bitCount = bytes.u16(bmiOffset + 10)
	} else if (headerSize >= 40 && headerSize <= 124 && bytes.has(bmiOffset, 40)) {
		width = bytes.i32(bmiOffset + 4)
		height = bytes.i32(bmiOffset + 8)
		bitCount = bytes.u16(bmiOffset + 14)
		compression = bytes.u32(bmiOffset + 16)
		colorsUsed = bytes.u32(bmiOffset + 32)
	} else {
		return undefined
	}

	const topDown = height < 0
	const rows = Math.abs(height)

	if (width <= 0 || rows === 0 || width > MAX_DIMENSION || rows > MAX_DIMENSION) return undefined

	const compressed = compression === BI_JPEG || compression === BI_PNG

	if (!compressed && ![1, 4, 8, 16, 24, 32].includes(bitCount)) return undefined

	let masks: [number, number, number, number] = [0, 0, 0, 0]
	let paletteOffset = bmiOffset + headerSize

	if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
		// After a 40-byte header, or inside the larger ones at the same offset.
		const maskOffset = bmiOffset + 40

		masks = [
			bytes.u32(maskOffset),
			bytes.u32(maskOffset + 4),
			bytes.u32(maskOffset + 8),
			headerSize >= 56 || compression === BI_ALPHABITFIELDS ? bytes.u32(maskOffset + 12) : 0
		]

		if (headerSize === 40) paletteOffset += compression === BI_ALPHABITFIELDS ? 16 : 12
	} else if (bitCount === 16) {
		masks = [0x7c00, 0x03e0, 0x001f, 0]
	} else if (bitCount === 32) {
		masks = [0xff0000, 0xff00, 0xff, 0]
	}

	const paletteCount = bitCount <= 8 && !compressed ? Math.min(1 << bitCount, colorsUsed === 0 ? 1 << bitCount : colorsUsed) : 0
	const paletteStride = usage === 1 ? 2 : headerSize === 12 ? 3 : 4
	const stride = (((width * bitCount + 31) >>> 5) * 4) >>> 0

	return {
		bytes,
		bmiOffset,
		width,
		height: rows,
		topDown,
		bitCount,
		compression,
		headerSize,
		paletteOffset,
		paletteCount,
		paletteStride,
		masks,
		bitsOffset,
		bitsSize: Math.max(0, Math.min(bitsSize, bytes.length - bitsOffset)),
		stride
	}
}

function paletteColor(dib: Dib, index: number, lookup: PaletteLookup | undefined): Rgba {
	if (index >= dib.paletteCount) return 0x000000ff

	const at = dib.paletteOffset + index * dib.paletteStride

	if (dib.paletteStride === 2) {
		const entry = dib.bytes.u16(at)

		if (lookup !== undefined) return lookup(entry)

		const gray = entry & 255

		return ((gray << 24) | (gray << 16) | (gray << 8) | 255) >>> 0
	}

	const bytes = dib.bytes

	return ((bytes.u8(at + 2) << 24) | (bytes.u8(at + 1) << 16) | (bytes.u8(at) << 8) | 255) >>> 0
}

function maskShift(mask: number): number {
	if (mask === 0) return 0

	let shift = 0

	while (((mask >>> shift) & 1) === 0 && shift < 32) shift++

	return shift
}

function maskScale(mask: number, shift: number): number {
	const max = mask >>> shift

	return max === 0 ? 0 : 255 / max
}

// The bitmap's pixels as top-down RGBA, or undefined when it cannot be decoded (compressed, too large, or
// its bits are missing). Palette indices and channel masks are resolved; alpha is 255 unless `alpha`.
export function decodeDib(dib: Dib, alpha: boolean, budget: PixelBudget, lookup?: PaletteLookup): Uint8Array | undefined {
	const { width, height, bitCount, stride, bytes } = dib

	if (width * height > MAX_DECODE_PIXELS || dib.bitsSize < stride * height) return undefined
	if (dib.compression !== BI_RGB && dib.compression !== BI_BITFIELDS && dib.compression !== BI_ALPHABITFIELDS) return undefined
	if (!budget.spend(width * height)) return undefined

	const out = new Uint8Array(width * height * 4)
	const palette = new Uint32Array(Math.max(1, dib.paletteCount))

	for (let k = 0; k < dib.paletteCount; k++) palette[k] = paletteColor(dib, k, lookup)

	const [rMask, gMask, bMask, aMask] = dib.masks
	const rShift = maskShift(rMask)
	const gShift = maskShift(gMask)
	const bShift = maskShift(bMask)
	const aShift = maskShift(aMask)
	const rScale = maskScale(rMask, rShift)
	const gScale = maskScale(gMask, gShift)
	const bScale = maskScale(bMask, bShift)
	const aScale = maskScale(aMask, aShift)
	const src = bytes.bytes
	const end = Math.min(bytes.length, dib.bitsOffset + dib.bitsSize)

	for (let y = 0; y < height; y++) {
		const row = dib.bitsOffset + (dib.topDown ? y : height - 1 - y) * stride
		let o = y * width * 4

		if (row + stride > end) {
			// Missing rows stay transparent black.
			continue
		}

		switch (bitCount) {
			case 1:
			case 4:
			case 8: {
				const perByte = 8 / bitCount
				const valueMask = (1 << bitCount) - 1

				for (let x = 0; x < width; x++) {
					const byte = src[row + Math.floor(x / perByte)] ?? 0
					const shift = 8 - bitCount * ((x % perByte) + 1)
					const color = palette[(byte >>> shift) & valueMask] ?? 0x000000ff

					out[o++] = color >>> 24
					out[o++] = (color >>> 16) & 255
					out[o++] = (color >>> 8) & 255
					out[o++] = 255
				}

				break
			}
			case 24:
				for (let x = 0, p = row; x < width; x++, p += 3) {
					out[o++] = src[p + 2] ?? 0
					out[o++] = src[p + 1] ?? 0
					out[o++] = src[p] ?? 0
					out[o++] = 255
				}

				break
			case 16:
			case 32: {
				const step = bitCount / 8

				for (let x = 0, p = row; x < width; x++, p += step) {
					const value =
						step === 2
							? (src[p] ?? 0) | ((src[p + 1] ?? 0) << 8)
							: ((src[p] ?? 0) | ((src[p + 1] ?? 0) << 8) | ((src[p + 2] ?? 0) << 16) | ((src[p + 3] ?? 0) << 24)) >>> 0

					out[o++] = Math.round(((value & rMask) >>> rShift) * rScale)
					out[o++] = Math.round(((value & gMask) >>> gShift) * gScale)
					out[o++] = Math.round(((value & bMask) >>> bShift) * bScale)
					out[o++] = alpha
						? aMask !== 0
							? Math.round(((value & aMask) >>> aShift) * aScale)
							: step === 4
								? (src[p + 3] ?? 0)
								: 255
						: 255
				}

				break
			}
			default:
				break
		}
	}

	return out
}

function applyTransparency(rgba: Uint8Array, width: number, height: number, transparency: DibTransparency, budget: PixelBudget): void {
	switch (transparency.kind) {
		case "alpha":
			// Premultiplied: colours divide back out.
			for (let p = 0; p < rgba.length; p += 4) {
				const a = rgba[p + 3] ?? 0

				if (a === 0 || a === 255) continue

				rgba[p] = Math.min(255, Math.round(((rgba[p] ?? 0) * 255) / a))
				rgba[p + 1] = Math.min(255, Math.round(((rgba[p + 1] ?? 0) * 255) / a))
				rgba[p + 2] = Math.min(255, Math.round(((rgba[p + 2] ?? 0) * 255) / a))
			}

			break
		case "key":
		case "drop": {
			const r = (transparency.color >>> 16) & 255
			const g = (transparency.color >>> 8) & 255
			const b = transparency.color & 255

			for (let p = 0; p < rgba.length; p += 4) if (rgba[p] === r && rgba[p + 1] === g && rgba[p + 2] === b) rgba[p + 3] = 0

			break
		}
		case "mask": {
			const mask = transparency.mask
			const bits = decodeDib(mask, false, budget)

			if (bits === undefined) break

			for (let y = 0; y < height; y++) {
				const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / height))

				for (let x = 0; x < width; x++) {
					const mx = Math.min(mask.width - 1, Math.floor((x * mask.width) / width))

					if ((bits[(my * mask.width + mx) * 4] ?? 0) < 128) rgba[(y * width + x) * 4 + 3] = 0
				}
			}

			break
		}
		default:
			break
	}
}

// Whether a browser draws the bitmap as GDI does when it is wrapped as a BMP file unchanged.
function wrappable(dib: Dib): boolean {
	// The browser decodes every pixel, however small the (run-length) data.
	if (dib.paletteStride === 2 || dib.width * dib.height > MAX_DECODE_PIXELS) return false
	if (dib.headerSize !== 12 && dib.headerSize !== 40 && dib.headerSize !== 108 && dib.headerSize !== 124) return false
	if (!dib.bytes.has(dib.paletteOffset, dib.paletteCount * dib.paletteStride)) return false

	switch (dib.compression) {
		case BI_RGB:
			return dib.bitCount !== 32 && dib.bitsSize >= dib.stride * dib.height
		case BI_RLE8:
			return dib.bitCount === 8
		case BI_RLE4:
			return dib.bitCount === 4
		case BI_BITFIELDS:
			return dib.bitCount === 16 && dib.headerSize === 40 && dib.bitsSize >= dib.stride * dib.height
		default:
			return false
	}
}

// A BMP file of the bitmap as stored: file header, info header (with masks and colour table), bits.
function wrapBmp(dib: Dib): Uint8Array {
	const bytes = dib.bytes
	const masksBytes = dib.compression === BI_BITFIELDS && dib.headerSize === 40 ? 12 : 0
	const infoSize = dib.headerSize + masksBytes + dib.paletteCount * dib.paletteStride
	const bitsSize = dib.compression === BI_RGB || dib.compression === BI_BITFIELDS ? dib.stride * dib.height : dib.bitsSize
	const total = 14 + infoSize + bitsSize
	const out = new Uint8Array(total)
	const view = new DataView(out.buffer)

	out[0] = 0x42
	out[1] = 0x4d
	view.setUint32(2, total, true)
	view.setUint32(10, 14 + infoSize, true)
	// The header and masks, then the colour table from wherever it starts.
	out.set(bytes.sub(dib.bmiOffset, dib.headerSize + masksBytes), 14)
	out.set(bytes.sub(dib.paletteOffset, dib.paletteCount * dib.paletteStride), 14 + dib.headerSize + masksBytes)
	out.set(bytes.sub(dib.bitsOffset, bitsSize), 14 + infoSize)

	return out
}

// PNG of top-down RGBA pixels (colour type 6, no filtering).
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
	const rowBytes = width * 4
	const raw = new Uint8Array((rowBytes + 1) * height)

	for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1)

	const data = zlibSync(raw, { level: 3 })
	const out = new Uint8Array(8 + 25 + 12 + data.length + 12)
	const view = new DataView(out.buffer)
	let at = 0
	const chunk = (type: string, body: Uint8Array): void => {
		view.setUint32(at, body.length)

		for (let k = 0; k < 4; k++) out[at + 4 + k] = type.charCodeAt(k)

		out.set(body, at + 8)
		view.setUint32(at + 8 + body.length, crc32(body, crc32(out.subarray(at + 4, at + 8))) >>> 0)
		at += 12 + body.length
	}

	out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
	at = 8

	const header = new Uint8Array(13)
	const headerView = new DataView(header.buffer)

	headerView.setUint32(0, width)
	headerView.setUint32(4, height)
	header[8] = 8
	header[9] = 6
	chunk("IHDR", header)
	chunk("IDAT", data)
	chunk("IEND", new Uint8Array(0))

	return out
}

// The format of an encoded image by its signature, or undefined for one a browser does not show.
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "gif" | "bmp" | undefined {
	const b0 = bytes[0] ?? 0
	const b1 = bytes[1] ?? 0

	if (b0 === 0x89 && b1 === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
	if (b0 === 0xff && b1 === 0xd8) return "jpeg"
	if (b0 === 0x47 && b1 === 0x49 && bytes[2] === 0x46) return "gif"
	if (b0 === 0x42 && b1 === 0x4d) return "bmp"

	return undefined
}

// The pixel dimensions an encoded image declares (what a browser allocates to decode it), or undefined
// when they cannot be read.
export function encodedSize(bytes: Uint8Array, format: "png" | "jpeg" | "gif" | "bmp"): [number, number] | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const length = bytes.length

	switch (format) {
		case "png":
			return length >= 24 ? [view.getUint32(16), view.getUint32(20)] : undefined
		case "gif":
			return length >= 10 ? [view.getUint16(6, true), view.getUint16(8, true)] : undefined
		case "bmp": {
			if (length < 26) return undefined

			const header = view.getUint32(14, true)

			return header === 12
				? [view.getUint16(18, true), view.getUint16(20, true)]
				: length >= 26
					? [Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true))]
					: undefined
		}
		case "jpeg": {
			// The first start-of-frame marker (SOF0..SOF15 but DHT, JPG and DAC).
			let at = 2

			while (at + 9 < length) {
				if (bytes[at] !== 0xff) return undefined

				const marker = bytes[at + 1] ?? 0

				if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
					at += 2
					continue
				}

				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
					return [view.getUint16(at + 7), view.getUint16(at + 5)]

				at += 2 + view.getUint16(at + 2)
			}

			return undefined
		}
	}
}

// An encoded image to pass through: shown only when its declared size is within the per-image bound and
// the conversion's decoding budget.
export function passThrough(bytes: Uint8Array, budget: PixelBudget): EmbeddedImage | undefined {
	const format = sniffImage(bytes)
	const size = format === undefined ? undefined : encodedSize(bytes, format)

	if (format === undefined || size === undefined) return undefined

	const pixels = size[0] * size[1]

	return pixels > 0 && pixels <= MAX_DECODE_PIXELS && budget.spend(pixels) ? { format, bytes } : undefined
}

// The bitmap as an image to embed, or undefined when it cannot be shown.
// Pixel changes of a raster operation: inverted (NOTSRCCOPY, MERGEPAINT), multiplied by the brush colour
// (MERGECOPY).
export interface PixelAdjust {
	readonly invert: boolean
	readonly tint: Rgba | undefined
}

export const NO_ADJUST: PixelAdjust = { invert: false, tint: undefined }

function adjustPixels(rgba: Uint8Array, adjust: PixelAdjust): void {
	const tint = adjust.tint

	for (let p = 0; p < rgba.length; p += 4) {
		for (let c = 0; c < 3; c++) {
			let value = rgba[p + c] ?? 0

			if (adjust.invert) value = 255 - value
			if (tint !== undefined) value = Math.round((value * ((tint >>> (24 - c * 8)) & 255)) / 255)

			rgba[p + c] = value
		}
	}
}

export function dibImage(
	dib: Dib,
	transparency: DibTransparency,
	budget: PixelBudget,
	lookup?: PaletteLookup,
	adjust: PixelAdjust = NO_ADJUST
): EmbeddedImage | undefined {
	const plain = transparency.kind === "none" && !adjust.invert && adjust.tint === undefined

	if (dib.compression === BI_JPEG || dib.compression === BI_PNG)
		return plain ? passThrough(dib.bytes.sub(dib.bitsOffset, dib.bitsSize).slice(), budget) : undefined

	if (plain && wrappable(dib)) return budget.spend(dib.width * dib.height) ? { format: "bmp", bytes: wrapBmp(dib) } : undefined

	const rgba = decodeDib(dib, transparency.kind === "alpha", budget, lookup)

	if (rgba === undefined)
		return plain && wrappable(dib) && budget.spend(dib.width * dib.height) ? { format: "bmp", bytes: wrapBmp(dib) } : undefined

	applyTransparency(rgba, dib.width, dib.height, transparency, budget)

	if (!plain) adjustPixels(rgba, adjust)

	return { format: "png", bytes: encodePng(rgba, dib.width, dib.height) }
}

// A packed DIB (BITMAPINFO followed by its bits) occupying [offset, offset + size).
export function packedDib(bytes: Bytes, offset: number, size: number, usage: number): Dib | undefined {
	const headerSize = bytes.u32(offset)

	if (headerSize !== 12 && (headerSize < 40 || headerSize > 124)) return undefined

	const core = headerSize === 12
	const bitCount = core ? bytes.u16(offset + 10) : bytes.u16(offset + 14)
	const compression = core ? BI_RGB : bytes.u32(offset + 16)
	const colorsUsed = core ? 0 : bytes.u32(offset + 32)
	// JPEG and PNG bitmaps carry no colour table.
	const compressed = compression === BI_JPEG || compression === BI_PNG
	const entries = compressed ? 0 : colorsUsed !== 0 ? Math.min(colorsUsed, 1 << 16) : bitCount <= 8 ? 1 << bitCount : 0
	const stride = usage === 1 ? 2 : core ? 3 : 4
	const masks = headerSize === 40 ? (compression === BI_BITFIELDS ? 12 : compression === BI_ALPHABITFIELDS ? 16 : 0) : 0
	const bmiSize = headerSize + masks + entries * stride

	if (bmiSize > size) return undefined

	return parseDib(bytes, offset, bmiSize, offset + bmiSize, size - bmiSize, usage)
}

// A monochrome pattern (1 = set bit) as a tile: 0 bits in `zero`, 1 bits in `one` (a mono brush draws 0
// bits in the text colour and 1 bits in the background colour).
export function monoTile(bits: Uint8Array, width: number, height: number, zero: Rgba, one: Rgba): EmbeddedImage {
	const rgba = new Uint8Array(width * height * 4)

	for (let k = 0; k < width * height; k++) {
		const color = (bits[k] ?? 0) !== 0 ? one : zero

		rgba[k * 4] = color >>> 24
		rgba[k * 4 + 1] = (color >>> 16) & 255
		rgba[k * 4 + 2] = (color >>> 8) & 255
		rgba[k * 4 + 3] = color & 255
	}

	return { format: "png", bytes: encodePng(rgba, width, height) }
}

// The bits (0 or 1, top-down) of a 1-bit bitmap, or undefined for another depth or missing bits.
export function dibBits(dib: Dib, budget: PixelBudget): Uint8Array | undefined {
	if (dib.bitCount !== 1 || dib.compression !== BI_RGB || dib.bitsSize < dib.stride * dib.height) return undefined
	if (dib.width * dib.height > MAX_DECODE_PIXELS || !budget.spend(dib.width * dib.height)) return undefined

	const out = new Uint8Array(dib.width * dib.height)
	const src = dib.bytes.bytes

	for (let y = 0; y < dib.height; y++) {
		const row = dib.bitsOffset + (dib.topDown ? y : dib.height - 1 - y) * dib.stride

		for (let x = 0; x < dib.width; x++) out[y * dib.width + x] = ((src[row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1
	}

	return out
}

import { unzlibSync, zlibSync } from "fflate"
import { crc32 } from "../../../core/opc/crc32"

// Slide images compared by their ink: the pixels a side draws over its own background. Each side is measured
// against a background image of the same slide with every shape hidden (lo_slides.py --bg for LibreOffice), so a
// background that differs between the renderers (a gradient's banding, an off-white) counts nothing, and a shape
// that is missing, moved or misshapen counts in full. Ink within `dilate` pixels of the other side's ink matches,
// which absorbs anti-aliasing and sub-pixel placement.

export interface RgbaImage {
	readonly width: number
	readonly height: number
	// Straight RGBA, row by row, 4 bytes per pixel.
	readonly data: Uint8Array
}

export interface InkOptions {
	// The largest per-channel difference from the background that is still background.
	readonly tolerance?: number
	// Chebyshev radius within which ink on one side matches ink on the other.
	readonly dilate?: number
}

export interface InkResult {
	// Mismatched ink pixels over the union of both inks (0 where neither side draws anything).
	readonly inkMismatch: number
	// Pixels whose colours differ by more than the tolerance between the two slides, over all pixels.
	readonly mismatchRatio: number
	readonly oursInk: number
	readonly loInk: number
	readonly union: number
	readonly mismatched: number
	// A background image was missing or of another size, so the slide's modal colour stood in for it.
	readonly flagged: boolean
}

export const INK_TOLERANCE = 32
export const INK_DILATE = 2

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// A PNG larger than this many pixels is refused rather than decoded (8K × 8K).
const MAX_PIXELS = 64 * 1024 * 1024

function readU32(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) * 0x1000000 + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))) >>> 0
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c
	const pa = Math.abs(p - a)
	const pb = Math.abs(p - b)
	const pc = Math.abs(p - c)

	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// PNG (ISO/IEC 15948) to straight RGBA: every colour type and bit depth, no interlace (neither renderer writes
// Adam7). Sixteen-bit samples keep their high byte; transparency is kept as alpha.
export function decodePng(bytes: Uint8Array): RgbaImage {
	if (!PNG_SIGNATURE.every((byte, k) => bytes[k] === byte)) throw new Error("Not a PNG")

	let width = 0
	let height = 0
	let depth = 0
	let colour = 0
	let interlace = 0
	let palette: Uint8Array | undefined
	let transparency: Uint8Array | undefined
	const idat: Uint8Array[] = []
	let at = 8

	while (at + 8 <= bytes.length) {
		const length = readU32(bytes, at)
		const type = String.fromCharCode(bytes[at + 4] ?? 0, bytes[at + 5] ?? 0, bytes[at + 6] ?? 0, bytes[at + 7] ?? 0)
		const data = bytes.subarray(at + 8, at + 8 + length)

		at += 12 + length

		if (type === "IHDR") {
			width = readU32(data, 0)
			height = readU32(data, 4)
			depth = data[8] ?? 0
			colour = data[9] ?? 0
			interlace = data[12] ?? 0
		} else if (type === "PLTE") palette = data
		else if (type === "tRNS") transparency = data
		else if (type === "IDAT") idat.push(data)
		else if (type === "IEND") break
	}

	if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error(`PNG of ${String(width)}×${String(height)} refused`)
	if (interlace !== 0) throw new Error("Interlaced PNG")

	const channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 3 ? 1 : colour === 4 ? 2 : colour === 6 ? 4 : 0

	if (channels === 0) throw new Error(`PNG colour type ${String(colour)}`)

	const joined = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0))
	let offset = 0

	for (const chunk of idat) {
		joined.set(chunk, offset)
		offset += chunk.length
	}

	const raw = unzlibSync(joined)
	const bitsPerPixel = channels * depth
	const stride = Math.ceil((width * bitsPerPixel) / 8)
	const bpp = Math.max(1, bitsPerPixel >> 3)

	if (raw.length < (stride + 1) * height) throw new Error("PNG data is short")

	const rows = new Uint8Array(stride * height)

	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)] ?? 0
		const source = y * (stride + 1) + 1
		const target = y * stride

		for (let x = 0; x < stride; x++) {
			const value = raw[source + x] ?? 0
			const left = x >= bpp ? (rows[target + x - bpp] ?? 0) : 0
			const up = y > 0 ? (rows[target - stride + x] ?? 0) : 0
			const corner = x >= bpp && y > 0 ? (rows[target - stride + x - bpp] ?? 0) : 0
			const predicted =
				filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0

			rows[target + x] = (value + predicted) & 0xff
		}
	}

	const out = new Uint8Array(width * height * 4)
	const max = (1 << depth) - 1
	const sample = (row: number, index: number): number => {
		if (depth === 8) return rows[row + index] ?? 0
		if (depth === 16) return rows[row + index * 2] ?? 0

		const bit = index * depth
		const value = ((rows[row + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & max

		return colour === 3 ? value : Math.round((value * 255) / max)
	}
	const key = (index: number): number =>
		depth === 16 ? (transparency?.[index * 2] ?? -1) : depth === 8 ? (transparency?.[index * 2 + 1] ?? -1) : -1

	for (let y = 0; y < height; y++) {
		const row = y * stride

		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4

			if (colour === 3) {
				const index = sample(row, x)

				out[o] = palette?.[index * 3] ?? 0
				out[o + 1] = palette?.[index * 3 + 1] ?? 0
				out[o + 2] = palette?.[index * 3 + 2] ?? 0
				out[o + 3] = transparency?.[index] ?? 255
			} else if (colour === 0 || colour === 4) {
				const grey = sample(row, x * channels)

				out[o] = grey
				out[o + 1] = grey
				out[o + 2] = grey
				out[o + 3] = colour === 4 ? sample(row, x * channels + 1) : transparency !== undefined && grey === key(0) ? 0 : 255
			} else {
				const r = sample(row, x * channels)
				const g = sample(row, x * channels + 1)
				const b = sample(row, x * channels + 2)

				out[o] = r
				out[o + 1] = g
				out[o + 2] = b
				out[o + 3] =
					colour === 6
						? sample(row, x * channels + 3)
						: transparency !== undefined && r === key(0) && g === key(1) && b === key(2)
							? 0
							: 255
			}
		}
	}

	return { width, height, data: out }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, data.length)

	for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k)

	out.set(data, 8)
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length), 0) >>> 0)

	return out
}

// Straight RGBA to an 8-bit RGBA PNG (filter 0): diff images for triage, and test inputs.
export function encodePng(image: RgbaImage): Uint8Array {
	const stride = image.width * 4
	const raw = new Uint8Array((stride + 1) * image.height)

	for (let y = 0; y < image.height; y++) raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)

	const header = new Uint8Array(13)
	const view = new DataView(header.buffer)

	view.setUint32(0, image.width)
	view.setUint32(4, image.height)
	header[8] = 8
	header[9] = 6
	const parts = [
		Uint8Array.from(PNG_SIGNATURE),
		chunk("IHDR", header),
		chunk("IDAT", zlibSync(raw, { level: 6 })),
		chunk("IEND", new Uint8Array(0))
	]
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

// The image composited over white and sampled to `width`×`height` (nearest pixel): the renderers' heights can
// round apart by a pixel, and transparency means the page behind.
function opaqueAt(image: RgbaImage, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height * 3)

	for (let y = 0; y < height; y++) {
		const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height))

		for (let x = 0; x < width; x++) {
			const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width))
			const s = (sy * image.width + sx) * 4
			const alpha = image.data[s + 3] ?? 255
			const o = (y * width + x) * 3

			for (let c = 0; c < 3; c++) out[o + c] = Math.round(((image.data[s + c] ?? 0) * alpha + 255 * (255 - alpha)) / 255)
		}
	}

	return out
}

// The most frequent colour (5 bits per channel, so noise and dithering fall into one bucket), as an image.
function modal(pixels: Uint8Array, count: number): Uint8Array {
	const buckets = new Uint32Array(1 << 15)
	let best = 0

	for (let k = 0; k < count; k++) {
		const index = (((pixels[k * 3] ?? 0) >> 3) << 10) | (((pixels[k * 3 + 1] ?? 0) >> 3) << 5) | ((pixels[k * 3 + 2] ?? 0) >> 3)
		const value = (buckets[index] ?? 0) + 1

		buckets[index] = value

		if (value > (buckets[best] ?? 0)) best = index
	}

	// The bucket's mean colour, from the pixels in it.
	const sums = [0, 0, 0]
	let members = 0

	for (let k = 0; k < count; k++) {
		const index = (((pixels[k * 3] ?? 0) >> 3) << 10) | (((pixels[k * 3 + 1] ?? 0) >> 3) << 5) | ((pixels[k * 3 + 2] ?? 0) >> 3)

		if (index !== best) continue

		members++

		for (let c = 0; c < 3; c++) sums[c] = (sums[c] ?? 0) + (pixels[k * 3 + c] ?? 0)
	}

	const out = new Uint8Array(count * 3)
	const colour = sums.map(sum => Math.round(sum / Math.max(1, members)))

	for (let k = 0; k < count; k++) for (let c = 0; c < 3; c++) out[k * 3 + c] = colour[c] ?? 0

	return out
}

function differs(a: Uint8Array, b: Uint8Array, k: number, tolerance: number): boolean {
	const o = k * 3

	return (
		Math.abs((a[o] ?? 0) - (b[o] ?? 0)) > tolerance ||
		Math.abs((a[o + 1] ?? 0) - (b[o + 1] ?? 0)) > tolerance ||
		Math.abs((a[o + 2] ?? 0) - (b[o + 2] ?? 0)) > tolerance
	)
}

function inkMask(slide: Uint8Array, background: Uint8Array, count: number, tolerance: number): Uint8Array {
	const mask = new Uint8Array(count)

	for (let k = 0; k < count; k++) if (differs(slide, background, k, tolerance)) mask[k] = 1

	return mask
}

// Chebyshev dilation by `radius`: a separable running maximum, rows then columns.
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
	if (radius <= 0) return mask

	const rows = new Uint8Array(mask.length)

	for (let y = 0; y < height; y++) {
		const base = y * width
		// Ink pixels in the window [x - radius, x + radius], kept as a running count.
		let count = 0

		for (let x = 0; x < Math.min(width, radius); x++) count += mask[base + x] ?? 0

		for (let x = 0; x < width; x++) {
			if (x + radius < width) count += mask[base + x + radius] ?? 0
			if (x - radius - 1 >= 0) count -= mask[base + x - radius - 1] ?? 0
			if (count > 0) rows[base + x] = 1
		}
	}

	const out = new Uint8Array(mask.length)

	for (let x = 0; x < width; x++) {
		let count = 0

		for (let y = 0; y < Math.min(height, radius); y++) count += rows[y * width + x] ?? 0

		for (let y = 0; y < height; y++) {
			if (y + radius < height) count += rows[(y + radius) * width + x] ?? 0
			if (y - radius - 1 >= 0) count -= rows[(y - radius - 1) * width + x] ?? 0
			if (count > 0) out[y * width + x] = 1
		}
	}

	return out
}

// Ink mismatch of our slide against LibreOffice's, each side's ink taken against its own background image.
// Compared at LibreOffice's size. Without a usable background (undefined, or a size other than its slide's) the
// slide's modal colour is the background and the result is flagged.
export function inkMismatch(
	ours: RgbaImage,
	oursBg: RgbaImage | undefined,
	lo: RgbaImage,
	loBg: RgbaImage | undefined,
	options: InkOptions = {}
): InkResult {
	const tolerance = options.tolerance ?? INK_TOLERANCE
	const radius = options.dilate ?? INK_DILATE
	const { width, height } = lo
	const count = width * height
	const usable = (slide: RgbaImage, bg: RgbaImage | undefined): bg is RgbaImage =>
		bg !== undefined && bg.width === slide.width && bg.height === slide.height
	const flagged = !usable(ours, oursBg) || !usable(lo, loBg)
	const oursPixels = opaqueAt(ours, width, height)
	const loPixels = opaqueAt(lo, width, height)
	const oursBack = usable(ours, oursBg) ? opaqueAt(oursBg, width, height) : modal(oursPixels, count)
	const loBack = usable(lo, loBg) ? opaqueAt(loBg, width, height) : modal(loPixels, count)
	const a = inkMask(oursPixels, oursBack, count, tolerance)
	const b = inkMask(loPixels, loBack, count, tolerance)
	const nearA = dilateMask(a, width, height, radius)
	const nearB = dilateMask(b, width, height, radius)
	let oursInk = 0
	let loInk = 0
	let union = 0
	let mismatched = 0
	let different = 0

	for (let k = 0; k < count; k++) {
		const inA = a[k] === 1
		const inB = b[k] === 1

		if (inA) oursInk++
		if (inB) loInk++
		if (inA || inB) union++
		if ((inA && nearB[k] !== 1) || (inB && nearA[k] !== 1)) mismatched++
		if (differs(oursPixels, loPixels, k, tolerance)) different++
	}

	return {
		inkMismatch: union === 0 ? 0 : mismatched / union,
		mismatchRatio: count === 0 ? 0 : different / count,
		oursInk,
		loInk,
		union,
		mismatched,
		flagged
	}
}

// Median and p90 (nearest rank) of a distribution, for the fidelity baselines.
export function distribution(values: readonly number[]): { readonly median: number; readonly p90: number; readonly count: number } {
	const sorted = [...values].sort((x, y) => x - y)
	const rank = (q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0

	return { median: rank(0.5), p90: rank(0.9), count: sorted.length }
}

import { zlibSync } from "fflate"
import { describe, expect, it } from "vitest"
import { decodePng, dilateMask, distribution, encodePng, inkMismatch, type RgbaImage } from "./pixel"

// The slide comparison every presentation fidelity acceptance uses, on synthetic slides: what it must ignore
// (anti-aliasing offsets, a background the renderers paint differently) and what it must catch (a missing title).

const W = 320
const H = 180

type Rgb = readonly [number, number, number]

function canvas(fill: Rgb): RgbaImage & { readonly data: Uint8Array } {
	const data = new Uint8Array(W * H * 4)

	for (let k = 0; k < W * H; k++) {
		data[k * 4] = fill[0]
		data[k * 4 + 1] = fill[1]
		data[k * 4 + 2] = fill[2]
		data[k * 4 + 3] = 255
	}

	return { width: W, height: H, data }
}

function rect(image: RgbaImage, x: number, y: number, w: number, h: number, colour: Rgb): void {
	for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
		for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
			const o = (yy * W + xx) * 4

			image.data[o] = colour[0]
			image.data[o + 1] = colour[1]
			image.data[o + 2] = colour[2]
		}
	}
}

// Text-like ink: glyph strokes two pixels wide with gaps, as a line of text draws.
function textLine(image: RgbaImage, x: number, y: number, glyphs: number, size: number, colour: Rgb): void {
	for (let g = 0; g < glyphs; g++) {
		const gx = x + g * Math.round(size * 0.6)

		rect(image, gx, y, 2, size, colour)
		rect(image, gx, y, Math.round(size * 0.4), 2, colour)
		rect(image, gx, y + size - 2, Math.round(size * 0.4), 2, colour)
	}
}

const INK: Rgb = [20, 20, 30]

function slide(options: { readonly title?: boolean; readonly shift?: number; readonly bg?: Rgb } = {}): {
	slide: RgbaImage
	bg: RgbaImage
} {
	const background: Rgb = options.bg ?? [255, 255, 255]
	const image = canvas(background)
	const dx = options.shift ?? 0

	if (options.title !== false) textLine(image, 20 + dx, 14, 16, 26, INK)

	for (let line = 0; line < 4; line++) {
		rect(image, 24 + dx, 72 + line * 24, 6, 6, INK)
		textLine(image, 40 + dx, 66 + line * 24, 20, 14, INK)
	}

	return { slide: image, bg: canvas(background) }
}

describe("ink mismatch between our slide and LibreOffice's", () => {
	it("scores identical images 0", () => {
		const a = slide()
		const result = inkMismatch(a.slide, a.bg, a.slide, a.bg)

		expect(result.inkMismatch).toBe(0)
		expect(result.mismatchRatio).toBe(0)
		expect(result.union).toBeGreaterThan(0)
		expect(result.flagged).toBe(false)
	})

	it("scores a one-pixel shift 0 with a dilation of 2, and above 0 without one", () => {
		const ours = slide({ shift: 1 })
		const lo = slide()

		expect(inkMismatch(ours.slide, ours.bg, lo.slide, lo.bg, { tolerance: 32, dilate: 2 }).inkMismatch).toBe(0)
		expect(inkMismatch(ours.slide, ours.bg, lo.slide, lo.bg, { tolerance: 32, dilate: 0 }).inkMismatch).toBeGreaterThan(0.1)
	})

	it("scores a slide with its title removed above 25%", () => {
		const ours = slide({ title: false })
		const lo = slide()
		const result = inkMismatch(ours.slide, ours.bg, lo.slide, lo.bg)

		expect(result.inkMismatch).toBeGreaterThan(0.25)
		expect(result.oursInk).toBeLessThan(result.loInk)
	})

	it("scores 0 ink where only the background differs, white against off-white", () => {
		const ours = slide({ bg: [244, 242, 236] })
		const lo = slide()
		const result = inkMismatch(ours.slide, ours.bg, lo.slide, lo.bg)

		expect(result.inkMismatch).toBe(0)
	})

	it("scores 0 ink for a background change on both sides of an empty slide, while the whole-slide ratio sees it", () => {
		const ours = canvas([255, 255, 255])
		const lo = canvas([255, 255, 255])

		rect(lo, 0, 0, W, H / 2, [180, 200, 255])
		const result = inkMismatch(ours, canvas([255, 255, 255]), lo, lo)

		expect(result.inkMismatch).toBe(0)
		expect(result.union).toBe(0)
		expect(result.mismatchRatio).toBeCloseTo(0.5, 2)
	})

	it("takes the modal colour as the background and flags the slide when a background image is missing", () => {
		const ours = slide({ title: false })
		const lo = slide()
		const result = inkMismatch(ours.slide, undefined, lo.slide, lo.bg)

		expect(result.flagged).toBe(true)
		expect(result.inkMismatch).toBeCloseTo(inkMismatch(ours.slide, ours.bg, lo.slide, lo.bg).inkMismatch, 6)
	})

	it("compares at LibreOffice's size when the heights round a pixel apart", () => {
		const lo = slide()
		const taller: RgbaImage = { width: W, height: H + 1, data: new Uint8Array(W * (H + 1) * 4) }

		taller.data.set(lo.slide.data)
		taller.data.fill(255, lo.slide.data.length)

		const tallerBg: RgbaImage = { width: W, height: H + 1, data: new Uint8Array(W * (H + 1) * 4).fill(255) }

		expect(inkMismatch(taller, tallerBg, lo.slide, lo.bg).inkMismatch).toBe(0)
	})

	it("composites transparency over white", () => {
		const lo = slide()
		const clear: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) }

		expect(inkMismatch(clear, clear, lo.bg, lo.bg).mismatchRatio).toBe(0)
	})
})

describe("mask dilation", () => {
	it("grows one pixel into a (2r+1)² square, clipped at the edges", () => {
		const mask = new Uint8Array(25)

		mask[12] = 1
		expect(dilateMask(mask, 5, 5, 1).reduce((sum, v) => sum + v, 0)).toBe(9)
		expect(dilateMask(mask, 5, 5, 2).reduce((sum, v) => sum + v, 0)).toBe(25)

		const corner = new Uint8Array(25)

		corner[0] = 1
		expect(dilateMask(corner, 5, 5, 1).reduce((sum, v) => sum + v, 0)).toBe(4)
	})
})

describe("PNG", () => {
	it("round-trips RGBA", () => {
		const a = slide()

		expect(decodePng(encodePng(a.slide))).toEqual({ width: W, height: H, data: a.slide.data })
	})

	it("decodes a 1-bit grey image with sub-filtered rows and a palette image", () => {
		const png = (ihdr: number[], raw: number[], extra: Uint8Array[] = []): Uint8Array => {
			const chunks = [
				Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				framed("IHDR", Uint8Array.from(ihdr)),
				...extra,
				framed("IDAT", zlibSync(Uint8Array.from(raw))),
				framed("IEND", new Uint8Array(0))
			]
			const out = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0))
			let at = 0

			for (const part of chunks) {
				out.set(part, at)
				at += part.length
			}

			return out
		}

		// 4×2, 1-bit grey: row 0 = 1010 unfiltered, row 1 = 0110 sub-filtered (whole bytes, so the first byte is as is).
		const grey = decodePng(png([0, 0, 0, 4, 0, 0, 0, 2, 1, 0, 0, 0, 0], [0, 0b10100000, 1, 0b01100000]))

		expect(Array.from(grey.data.filter((_, k) => k % 4 === 0))).toEqual([255, 0, 255, 0, 0, 255, 255, 0])

		// 2×1, 8-bit palette with transparency on entry 1.
		const indexed = decodePng(
			png(
				[0, 0, 0, 2, 0, 0, 0, 1, 8, 3, 0, 0, 0],
				[0, 0, 1],
				[framed("PLTE", Uint8Array.from([10, 20, 30, 40, 50, 60])), framed("tRNS", Uint8Array.from([255, 0]))]
			)
		)

		expect(Array.from(indexed.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 0])
	})
})

describe("distribution", () => {
	it("reports the nearest-rank median and p90", () => {
		expect(distribution([5, 1, 4, 2, 3, 10, 9, 8, 7, 6])).toEqual({ median: 5, p90: 9, count: 10 })
		expect(distribution([])).toEqual({ median: 0, p90: 0, count: 0 })
	})
})

function framed(type: string, data: Uint8Array): Uint8Array {
	// A chunk with its CRC (bitwise, independent of the decoder's table).
	const out = new Uint8Array(12 + data.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, data.length)

	for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k)

	out.set(data, 8)

	let crc = 0xffffffff

	for (const byte of out.subarray(4, 8 + data.length)) {
		crc ^= byte

		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
	}

	view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0)

	return out
}

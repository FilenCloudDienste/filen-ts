import { describe, expect, it } from "vitest"
import { ItemInt, ItemKind } from "../core/drawingml/displayList"
import { Bytes } from "../core/metafile/bytes"
import { convertPict, isPict } from "../core/metafile/pict"
import { SYMBOL_CHARSET, decodeAnsi } from "../core/metafile/text"
import { decodePng } from "./oracles/presentation/pixel"

// A version 2 picture (Inside Macintosh: Imaging With QuickDraw, Appendix A): big-endian words, opcodes word-aligned.
class Pict {
	private readonly out: number[] = []

	word(...values: number[]): this {
		for (const value of values) this.out.push((value >> 8) & 255, value & 255)

		return this
	}

	long(value: number): this {
		return this.word((value >>> 16) & 0xffff, value & 0xffff)
	}

	byte(...values: number[]): this {
		this.out.push(...values.map(value => value & 255))

		return this
	}

	align(): this {
		if (this.out.length % 2 === 1) this.out.push(0)

		return this
	}

	done(): Uint8Array {
		return Uint8Array.from(this.out)
	}
}

// picSize, picFrame (top, left, bottom, right), version 2 and a standard header (-1, 72 dpi frame).
function picture(width: number, height: number, body: (p: Pict) => void): Uint8Array {
	const p = new Pict().word(0, 0, 0, height, width, 0x0011, 0x02ff, 0x0c00)

	p.word(0xffff, 0xffff).word(0, 0, 0, 0, 0, height, 0, width).word(0, 0)
	body(p)
	p.align().word(0x00ff)

	return p.done()
}

// A QuickTime-compressed image (opcode 0x8200): identity matrix, a 2x2 source rectangle, no matte or mask, an empty
// image description and then `data`.
function quickTime(p: Pict, data: readonly number[]): void {
	const body = new Pict().word(0)

	for (const value of [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]) body.long(value)

	body.long(0)
		.word(0, 0, 0, 0)
		.word(0)
		.word(0, 0, 2, 2)
		.long(0)
		.long(0)
		.long(4)
		.byte(...data)
		.align()

	const bytes = body.done()

	p.word(0x8200)
		.long(bytes.length)
		.byte(...bytes)
}

// A PNG signature and IHDR chunk declaring `width` x `height`.
function pngHeader(width: number, height: number): number[] {
	const be = (value: number): number[] => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]

	return [
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...be(13),
		0x49,
		0x48,
		0x44,
		0x52,
		...be(width),
		...be(height),
		8,
		6,
		0,
		0,
		0,
		...be(0)
	]
}

// A BkPixPat (0x0012) of type 1 whose `width` x `height` pixmap has empty packed rows but the first, which is 255
// PackBits no-ops (flag 128): read as opcodes instead of stepped over, its count would end the picture (0x00FF).
function emptyPixPattern(p: Pict, width: number, height: number, rowBytes: number, pixelSize: number): void {
	p.word(0x0012, 1).word(0, 0, 0, 0)
	p.word(0x8000 | rowBytes, 0, 0, height, width)
	p.word(0, 0)
		.long(0)
		.long(0x480000)
		.long(0x480000)
		.word(0, pixelSize, pixelSize === 32 ? 3 : 1, 8)
		.long(0)
		.long(0)
		.long(0)

	if (pixelSize <= 8) p.long(0).word(0, 0).word(0, 0, 0, 0)

	p.word(255).byte(...new Array<number>(255).fill(128))

	for (let row = 1; row < height; row++) p.word(0)

	p.align()
}

describe("QuickDraw pictures", () => {
	it("draws rectangles and ovals in the RGB foreground colour, frames inside their rectangle", () => {
		const bytes = picture(72, 72, p => {
			p.word(0x001a, 0xffff, 0, 0)
			p.word(0x0031, 0, 0, 36, 36)
			p.word(0x0007, 4, 4)
			p.word(0x0050, 36, 36, 72, 72)
		})

		expect(isPict(new Bytes(bytes))).toBe(true)

		const result = convertPict(new Bytes(bytes))

		if (!result.ok) throw new Error(result.reason)

		// 72 points are 96 px.
		expect(result.frame).toEqual([0, 0, 96, 96])
		expect(result.list.itemCount).toBe(2)
		expect(result.list.paints[result.list.itemInt(0, ItemInt.FILL)]).toMatchObject({ kind: "solid", color: 0xff0000ff })
		expect(result.list.itemInt(1, ItemInt.FILL)).toBe(-1)
		expect(result.list.strokes[result.list.itemInt(1, ItemInt.STROKE)]?.width).toBeCloseTo(4 * (96 / 72), 6)
	})

	it("draws text at the pen location in Mac Roman", () => {
		const bytes = picture(200, 50, p => {
			p.word(0x000d, 18)
			p.word(0x0028, 30, 10).byte(4, 0x43, 0x61, 0xca, 0x8e)
		})
		const result = convertPict(new Bytes(bytes))

		if (!result.ok) throw new Error(result.reason)

		const text = result.list.texts[0]

		expect(result.list.kind(0)).toBe(ItemKind.TEXT)
		expect(text?.kind === "glyphs" ? text.run.text : undefined).toBe("Ca\u00a0é")
	})

	it("unpacks a PackBits pixmap through its colour table and a 32-bit direct pixmap's component planes", () => {
		const bytes = picture(4, 2, p => {
			// 8-bit indexed 4x2: rows packed (rowBytes 8), colour 0 red and 1 blue.
			p.word(0x0098, 0x8008, 0, 0, 2, 4)
			p.word(0, 0).long(0).long(0x480000).long(0x480000).word(0, 8, 1, 8).long(0).long(0).long(0)
			p.long(0).word(0, 1).word(0, 0xffff, 0, 0).word(1, 0, 0, 0xffff)
			p.word(0, 0, 2, 4).word(0, 0, 2, 4).word(0)
			// Row 0: four literal bytes 0 1 0 1 (then pad); row 1: 0 repeated 8 times.
			p.byte(9, 7, 0, 1, 0, 1, 0, 0, 0, 0).byte(2, 0xf9, 0)
			p.align()
			// 32-bit direct 2x1, packType 4, three planes R, G, B.
			p.word(0x009a).long(0xff).word(0x8008, 0, 0, 1, 2)
			p.word(0, 4).long(0).long(0x480000).long(0x480000).word(16, 32, 3, 8).long(0).long(0).long(0)
			p.word(0, 0, 1, 2).word(0, 0, 1, 2).word(0)
			p.byte(7, 5, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60)
		})
		const result = convertPict(new Bytes(bytes))

		if (!result.ok) throw new Error(result.reason)

		const images = result.list.images.map(image => decodePng(image.bytes ?? new Uint8Array(0)))

		expect(images.length).toBe(2)
		expect(Array.from(images[0]?.data.subarray(0, 8) ?? [])).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
		expect(Array.from(images[1]?.data ?? [])).toEqual([0x10, 0x30, 0x50, 255, 0x20, 0x40, 0x60, 255])
		expect(result.truncated).toBe(false)
	})

	it("refuses a bitmap whose rows claim more than its pixels need, or than the picture holds, before allocating them", () => {
		const before = process.resourceUsage().maxRSS
		// A PackBitsRect 1 px wide and 32767 rows tall claiming 16383 bytes a row (half a gigabyte unpacked).
		const tall = picture(72, 72, p => {
			p.word(0x0098, 0x3fff, 0, 0, 0x7fff, 1)
			p.word(0, 0, 1, 1, 0, 0, 1, 1, 0)

			for (let row = 0; row < 0x7fff; row++) p.word(2, 0x0001)
		})
		const result = convertPict(new Bytes(tall))

		if (!result.ok) throw new Error(result.reason)

		expect(result.truncated).toBe(true)
		expect(result.list.images.length).toBe(0)
		expect((process.resourceUsage().maxRSS - before) / 1024).toBeLessThan(64)
	})

	it("embeds QuickTime PNG and JPEG images only within the per-image pixel bound", () => {
		const jpeg = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 8, 0, 2, 0, 2, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]
		const small = convertPict(
			new Bytes(
				picture(72, 72, p => {
					quickTime(p, pngHeader(2, 2))
					quickTime(p, jpeg)
				})
			)
		)

		if (!small.ok) throw new Error(small.reason)

		expect(small.list.images.map(image => image.format)).toEqual(["png", "jpeg"])
		expect(small.unsupported).toBe(0)

		const bomb = convertPict(new Bytes(picture(72, 72, p => quickTime(p, pngHeader(60000, 60000)))))

		if (!bomb.ok) throw new Error(bomb.reason)

		expect(bomb.list.images.length).toBe(0)
		expect(bomb.unsupported).toBeGreaterThan(0)
	})

	it("steps over a pixel pattern's rows without unpacking them", () => {
		const bytes = picture(72, 72, p => {
			// Three 16-megapixel 8-bit patterns, then a 32-bit one whose rows unpack past the decoding bound.
			for (let k = 0; k < 3; k++) emptyPixPattern(p, 4096, 4096, 4096, 8)

			emptyPixPattern(p, 512, 32767, 2051, 32)
			p.word(0x001a, 0xffff, 0, 0)
			p.word(0x0031, 0, 0, 36, 36)
		})
		const result = convertPict(new Bytes(bytes))

		if (!result.ok) throw new Error(result.reason)

		expect(result.truncated).toBe(false)
		expect(result.list.itemCount).toBe(1)
		expect(result.list.paints[result.list.itemInt(0, ItemInt.FILL)]).toMatchObject({ kind: "solid", color: 0xff0000ff })
	})

	it("refuses a direct pixmap with more than four components or an unknown pixel size, typed", () => {
		for (const [pixelSize, cmpCount] of [
			[32, 60000],
			[24, 3]
		] as const) {
			const bytes = picture(4, 2, p => {
				p.word(0x009a).long(0xff).word(0x8010, 0, 0, 2, 4)
				p.word(0, 4).long(0).long(0x480000).long(0x480000).word(16, pixelSize, cmpCount, 8).long(0).long(0).long(0)
				p.word(0, 0, 2, 4).word(0, 0, 2, 4).word(0)
				p.byte(1, 0, 1, 0)
			})
			const result = convertPict(new Bytes(bytes))

			if (!result.ok) throw new Error(result.reason)

			expect(result.truncated).toBe(true)
			expect(result.list.images.length).toBe(0)
		}
	})

	it("ends a picture cut short with what it drew, and refuses what is no picture", () => {
		const bytes = picture(72, 72, p => {
			p.word(0x001a, 0, 0xffff, 0)
			p.word(0x0031, 0, 0, 36, 36)
			p.word(0x0098, 0x8008)
		})
		const result = convertPict(new Bytes(bytes.subarray(0, bytes.length - 2)))

		if (!result.ok) throw new Error(result.reason)

		expect(result.list.itemCount).toBe(1)
		expect(result.truncated).toBe(true)
		expect(convertPict(new Bytes(new Uint8Array(64)))).toEqual({ ok: false, reason: "malformed" })
	})
})

// LOGFONT text decodes through the same charset tables as RTF font text.
describe("metafile text charsets", () => {
	const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

	it("keeps symbol-charset codes as they are", () => {
		expect(decodeAnsi(bytes(0x61, 0x80, 0xb7), SYMBOL_CHARSET)).toBe("a\u0080\u00b7")
	})

	it("reads ANSI and DEFAULT as Windows-1252", () => {
		expect(decodeAnsi(bytes(0x80, 0x81, 0xe9), 0)).toBe("\u20ac\u0081\u00e9")
		expect(decodeAnsi(bytes(0x80, 0x93, 0xe9), 1)).toBe("\u20ac\u201c\u00e9")
	})

	it("falls back to Windows-1252 for Johab and unknown charsets", () => {
		expect(decodeAnsi(bytes(0x80, 0xe9), 130)).toBe("\u20ac\u00e9")
		expect(decodeAnsi(bytes(0x80, 0xe9), 99)).toBe("\u20ac\u00e9")
	})

	it("decodes Mac and OEM charsets", () => {
		expect(decodeAnsi(bytes(0x8e, 0xa5), 77)).toBe("\u00e9\u2022")
		expect(decodeAnsi(bytes(0x82, 0xb0), 255)).toBe("\u00e9\u2591")
	})

	it("decodes double-byte charsets", () => {
		expect(decodeAnsi(bytes(0x82, 0xa0), 128)).toBe("\u3042")
	})
})

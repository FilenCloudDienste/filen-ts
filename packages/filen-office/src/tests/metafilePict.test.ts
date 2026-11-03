import { describe, expect, it } from "vitest"
import { ItemInt, ItemKind } from "../core/drawingml/displayList"
import { Bytes } from "../core/metafile/bytes"
import { convertPict, isPict } from "../core/metafile/pict"
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
			p.word(0x0028, 30, 10).byte(3, 0x43, 0x61, 0x8e)
		})
		const result = convertPict(new Bytes(bytes))

		if (!result.ok) throw new Error(result.reason)

		const text = result.list.texts[0]

		expect(result.list.kind(0)).toBe(ItemKind.TEXT)
		expect(text?.kind === "glyphs" ? text.run.text : undefined).toBe("Caé")
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

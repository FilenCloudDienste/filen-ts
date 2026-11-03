import { zlibSync } from "fflate"
import { describe, expect, it } from "vitest"
import { ItemInt, ItemKind } from "../core/drawingml/displayList"
import { Bytes } from "../core/metafile/bytes"
import { convertSvm, isSvm } from "../core/metafile/svm"
import { budget, cpuMs } from "./timing"

// StarView metafile bytes, little-endian, written field by field.
class Writer {
	private readonly out: number[] = []

	u8(value: number): this {
		this.out.push(value & 255)

		return this
	}

	u16(value: number): this {
		return this.u8(value).u8(value >> 8)
	}

	u32(value: number): this {
		return this.u16(value & 0xffff).u16((value >>> 16) & 0xffff)
	}

	i32(value: number): this {
		return this.u32(value >>> 0)
	}

	bytes(values: Uint8Array): this {
		for (const value of values) this.out.push(value)

		return this
	}

	get length(): number {
		return this.out.length
	}

	done(): Uint8Array {
		return Uint8Array.from(this.out)
	}
}

// A VersionCompat block: version, length, then the body.
function compat(version: number, body: Writer): Uint8Array {
	const data = body.done()

	return new Writer().u16(version).u32(data.length).bytes(data).done()
}

function mapMode(unit: number, x = 0, y = 0): Uint8Array {
	return compat(1, new Writer().u16(unit).i32(x).i32(y).i32(1).i32(1).i32(1).i32(1).u8(0))
}

function action(type: number, version: number, body: Writer): Uint8Array {
	const data = body.done()

	return new Writer().u16(type).u16(version).u32(data.length).bytes(data).done()
}

// A metafile in 1/100 mm, `width` x `height`.
function svm(width: number, height: number, actions: readonly Uint8Array[]): Uint8Array {
	const header = new Writer().u32(0).bytes(mapMode(0)).i32(width).i32(height).u32(actions.length)
	const out = new Writer().bytes(new TextEncoder().encode("VCLMTF")).bytes(compat(1, header))

	for (const item of actions) out.bytes(item)

	return out.done()
}

function utf16(text: string): Writer {
	const out = new Writer()

	for (let k = 0; k < text.length; k++) out.u16(text.charCodeAt(k))

	return out
}

const FILL_RED = action(133, 1, new Writer().u32(0x00ff0000).u8(1))
const NO_LINE = action(132, 1, new Writer().u32(0).u8(0))

describe("StarView metafiles", () => {
	it("draws rectangles and polygons in the fill colour, mapped from the metafile's units to px", () => {
		const bytes = svm(2540, 2540, [
			FILL_RED,
			NO_LINE,
			action(103, 1, new Writer().i32(0).i32(0).i32(1270).i32(1270)),
			action(111, 2, new Writer().u16(1).u16(3).i32(0).i32(2540).i32(2540).i32(2540).i32(1270).i32(1270).u16(0))
		])

		expect(isSvm(new Bytes(bytes))).toBe(true)

		const result = convertSvm(new Bytes(bytes))

		if (!result.ok) throw new Error(result.reason)

		// One inch (2540 hundredths of a millimetre) is 96 px.
		expect(result.frame).toEqual([0, 0, 96, 96])
		expect(result.list.itemCount).toBe(2)
		expect(result.list.paints[result.list.itemInt(0, ItemInt.FILL)]).toMatchObject({ kind: "solid", color: 0xff0000ff })
		expect(result.unsupported).toBe(0)
		expect(result.truncated).toBe(false)
	})

	it("draws text array actions in their font, the Unicode form whichever way the stream wrote its text", () => {
		const font = action(
			138,
			1,
			new Writer().bytes(
				compat(
					1,
					new Writer()
						.u16(5)
						.bytes(new TextEncoder().encode("Arial"))
						.u16(0)
						.i32(0)
						.i32(494)
						.u16(0)
						.u16(0)
						.u16(2)
						.u16(8)
						.u16(0)
						.u16(0)
						.u16(0)
						.u16(0x0409)
						.u16(0)
						.u16(0)
						.u8(0)
						.u8(0)
						.u8(0)
						.u8(0)
				)
			)
		)
		// "Hi" as UTF-16 with a 32-bit length, then index, length, the character ends, and the Unicode copy.
		const text = action(
			113,
			2,
			new Writer()
				.i32(100)
				.i32(500)
				.u32(2)
				.bytes(utf16("Hi").done())
				.u16(0)
				.u16(2)
				.u32(2)
				.i32(200)
				.i32(400)
				.u16(2)
				.bytes(utf16("Hi").done())
		)
		const result = convertSvm(new Bytes(svm(2540, 1000, [font, action(136, 1, new Writer().u16(1)), text])))

		if (!result.ok) throw new Error(result.reason)

		const texts = Array.from({ length: result.list.itemCount }, (_, item) => item).filter(
			item => result.list.kind(item) === ItemKind.TEXT
		)

		expect(texts.length).toBe(1)
		const drawnText = result.list.texts[0]

		expect(drawnText?.kind === "glyphs" ? drawnText.run.text : undefined).toBe("Hi")
	})

	it("clips to an intersected rectangle and restores the clip a push saved", () => {
		const result = convertSvm(
			new Bytes(
				svm(2540, 2540, [
					action(139, 1, new Writer().u16(0x20)),
					action(129, 1, new Writer().i32(0).i32(0).i32(1270).i32(1270)),
					FILL_RED,
					action(103, 1, new Writer().i32(0).i32(0).i32(2540).i32(2540)),
					action(140, 1, new Writer()),
					action(103, 1, new Writer().i32(0).i32(0).i32(2540).i32(2540))
				])
			)
		)

		if (!result.ok) throw new Error(result.reason)

		expect(result.list.itemClip(0)).toBeGreaterThanOrEqual(0)
		expect(result.list.itemClip(1)).toBe(-1)
	})

	it("skips actions it does not know by their length, and ends a truncated metafile with what it drew", () => {
		const unknown = action(999, 1, new Writer().u32(1).u32(2))
		const rect = action(103, 1, new Writer().i32(0).i32(0).i32(100).i32(100))
		const whole = svm(2540, 2540, [FILL_RED, unknown, rect, rect])
		const result = convertSvm(new Bytes(whole.subarray(0, whole.length - 10)))

		if (!result.ok) throw new Error(result.reason)

		expect(result.list.itemCount).toBe(1)
		expect(result.truncated).toBe(true)
	})

	it("plays a nested picture (EPS substitute) within its own action, whatever count its header claims", () => {
		// The substitute's header claims every action after it; played to the file's end, each EPS would replay all the
		// later ones (and their EPS actions, to the nesting limit).
		const nested = new Writer()
			.bytes(new TextEncoder().encode("VCLMTF"))
			.bytes(compat(1, new Writer().u32(0).bytes(mapMode(0)).i32(2540).i32(2540).u32(0xffffffff)))
			.done()
		const eps = action(
			143,
			1,
			new Writer()
				.bytes(compat(1, new Writer().u16(0).u32(0)))
				.i32(0)
				.i32(0)
				.i32(100)
				.i32(100)
				.bytes(nested)
		)
		const xor = action(141, 1, new Writer().u16(1))
		const polygon = new Writer().u16(65535)

		for (let k = 0; k < 65535; k++) polygon.i32(k).i32(k)

		const line = action(109, 1, polygon)
		const actions: Uint8Array[] = []

		for (let k = 0; k < 24; k++) actions.push(eps, xor, line)

		const bytes = svm(2540, 2540, actions)
		const start = cpuMs()
		const result = convertSvm(new Bytes(bytes))

		expect(result.ok).toBe(true)
		// One pass over 12.6 MB of points.
		expect(cpuMs() - start).toBeLessThan(budget(1000))
	}, 120_000)

	it("refuses an EPS whose PostScript runs past its action, and counts it", () => {
		const eps = action(
			143,
			1,
			new Writer()
				.bytes(compat(1, new Writer().u16(0).u32(0x7fffffff)))
				.i32(0)
				.i32(0)
				.i32(100)
				.i32(100)
		)
		const result = convertSvm(new Bytes(svm(2540, 2540, [FILL_RED, eps, action(103, 1, new Writer().i32(0).i32(0).i32(100).i32(100))])))

		if (!result.ok) throw new Error(result.reason)

		expect(result.unsupported).toBe(1)
		expect(result.list.itemCount).toBe(1)
	})

	it("reads a complex (Bézier) polygon after its own version header, bounded by its length", () => {
		// A PolyPolygon (version 2) whose one polygon is replaced by a complex one: a curve from (0, 0) through two
		// control points to (2540, 0), then a line back down, its points flagged 0 1 1 0 0.
		const curve = new Writer()
			.u16(5)
			.i32(0)
			.i32(0)
			.i32(800)
			.i32(2540)
			.i32(1700)
			.i32(2540)
			.i32(2540)
			.i32(0)
			.i32(1270)
			.i32(1270)
			.u8(1)
			.bytes(Uint8Array.of(0, 1, 1, 0, 0))
		const shape = new Writer().u16(1).u16(2).i32(0).i32(0).i32(10).i32(10).u16(1).u16(0).bytes(compat(1, curve))
		const result = convertSvm(new Bytes(svm(2540, 2540, [FILL_RED, NO_LINE, action(111, 2, shape)])))

		if (!result.ok) throw new Error(result.reason)

		const list = result.list
		let maxX = 0
		let maxY = 0

		for (let k = 0; k < list.coordCount; k += 2) {
			maxX = Math.max(maxX, list.coords[k] ?? 0)
			maxY = Math.max(maxY, list.coords[k + 1] ?? 0)
		}

		// The curve's end at the frame's right edge, its control points within the frame, a cubic among the commands.
		expect(maxX).toBeCloseTo(96, 3)
		expect(maxY).toBeLessThanOrEqual(96)
		expect(Array.from(list.commands.subarray(0, list.commandCount))).toContain(2)
	})

	it("draws a bitmap whose pixels the stream compressed (a ZCodec DIB)", () => {
		// 2 x 1, 24-bit, bottom-up: a red and a blue pixel (BGR), the row padded to 8 bytes.
		const pixels = Uint8Array.of(0, 0, 255, 255, 0, 0, 0, 0)
		const coded = zlibSync(pixels)
		const info = new Writer().u32(40).i32(2).i32(1).u16(1).u16(24).u32(0x01004453).u32(pixels.length).i32(0).i32(0).u32(0).u32(0)
		const dib = new Writer()
			.u8(0x42)
			.u8(0x4d)
			// The file size VCL writes is the uncompressed one; the stream ends after the coded bytes.
			.u32(14 + 40 + pixels.length + 4096)
			.u32(0)
			.u32(54)
			.bytes(info.done())
			.u32(coded.length)
			.u32(pixels.length)
			.u32(0)
			.bytes(coded)
		const bitmap = action(117, 1, new Writer().bytes(dib.done()).i32(0).i32(0).i32(2540).i32(1270))
		const after = action(103, 1, new Writer().i32(0).i32(0).i32(2540).i32(1270))
		const result = convertSvm(new Bytes(svm(2540, 1270, [bitmap, after])))

		if (!result.ok) throw new Error(result.reason)

		expect(result.unsupported).toBe(0)
		expect(result.list.images.length).toBe(1)
		// The destination after the bitmap is read from where the coded bytes end: the bitmap and the rectangle.
		expect(result.list.itemCount).toBe(2)

		const image = result.list.images[0]
		const bmp = new Bytes(image?.bytes ?? new Uint8Array(0))

		// Wrapped as a plain BMP: the compression the stream named, then the inflated rows.
		expect(image?.format).toBe("bmp")
		expect(bmp.u32(30)).toBe(0)
		expect(Array.from(bmp.sub(bmp.u32(10), 8))).toEqual(Array.from(pixels))
	})

	it("refuses bytes without the header as malformed", () => {
		expect(convertSvm(new Bytes(new Uint8Array(40)))).toEqual({ ok: false, reason: "malformed" })
		expect(convertSvm(new Bytes(svm(0, 0, [])))).toEqual({ ok: false, reason: "malformed" })
	})
})

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { ctfToTtf, decodeEot, decodeMtx, embeddedFontData, isEot, lzcompDecompress, readEotHeader } from "../core/fonts/eot"
import { FontError } from "../core/fonts/errors"
import { readSfnt } from "../core/fonts/sfnt"
import { corpusFonts } from "./embeddedFontFixtures"
import { budget, cpuMs } from "./timing"

const ARIMO = join(import.meta.dirname, "..", "..", "assets", "fonts", "arimo", "Arimo-Regular.ttf.gz")

function utf16(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2)

	for (let i = 0; i < text.length; i++) {
		out[i * 2] = text.charCodeAt(i) & 255
		out[i * 2 + 1] = text.charCodeAt(i) >> 8
	}

	return out
}

// An EOT (version 0x00020001) around `font`, with `flags`.
function eot(font: Uint8Array, flags: number, family = "Test"): Uint8Array {
	const names = [utf16(family), utf16("Regular"), utf16("Version 1"), utf16(`${family} Regular`)]
	const rootString = new Uint8Array(0)
	let size = 82 + names.reduce((sum, name, k) => sum + (k === 0 ? 2 : 4) + name.length, 0) + 4 + rootString.length + font.length
	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)

	view.setUint32(4, font.length, true)
	view.setUint32(8, 0x00020001, true)
	view.setUint32(12, flags, true)
	view.setUint32(28, 400, true)
	view.setUint16(34, 0x504c, true)

	let at = 82

	names.forEach((name, k) => {
		if (k > 0) at += 2

		view.setUint16(at, name.length, true)
		out.set(name, at + 2)
		at += 2 + name.length
	})

	at += 2
	view.setUint16(at, rootString.length, true)
	at += 2
	size = at + font.length
	out.set(font, at)
	view.setUint32(0, size, true)

	return out.subarray(0, size)
}

function arimo(): Uint8Array {
	return gunzipSync(readFileSync(ARIMO))
}

// A compact-table-format first block (MicroType Express §5): an sfnt directory whose glyf, cvt, hdmx and VDMX tables
// are in their compact forms and whose loca is empty.
function ctf(tables: Record<string, Uint8Array>): Uint8Array {
	const tags = Object.keys(tables).sort()
	let at = 12 + tags.length * 16
	const offsets: number[] = []

	for (const tag of tags) {
		offsets.push(at)
		at += ((tables[tag]?.length ?? 0) + 3) & ~3
	}

	const out = new Uint8Array(at)
	const view = new DataView(out.buffer)

	view.setUint32(0, 0x00010000)
	view.setUint16(4, tags.length)
	tags.forEach((tag, k) => {
		const table = tables[tag] ?? new Uint8Array(0)

		for (let c = 0; c < 4; c++) out[12 + k * 16 + c] = tag.charCodeAt(c)

		view.setUint32(12 + k * 16 + 8, tag === "loca" ? 0 : (offsets[k] ?? 0))
		view.setUint32(12 + k * 16 + 12, tag === "loca" ? 0 : table.length)
		out.set(table, offsets[k] ?? 0)
	})

	return out
}

function be(...words: number[]): Uint8Array {
	const out = new Uint8Array(words.length * 2)

	words.forEach((word, k) => {
		out[k * 2] = (word >> 8) & 255
		out[k * 2 + 1] = word & 255
	})

	return out
}

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values)
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

// head (unitsPerEm 1000, short loca), maxp (3 glyphs), hhea (3 metrics), hmtx: the tables the decoder reads.
function baseTables(): Record<string, Uint8Array> {
	const head = new Uint8Array(54)
	const headView = new DataView(head.buffer)

	headView.setUint32(0, 0x00010000)
	headView.setUint32(12, 0x5f0f3cf5)
	headView.setUint16(18, 1000)

	const maxp = be(0x0000, 0x5000, 3)
	const hhea = new Uint8Array(36)

	new DataView(hhea.buffer).setUint16(34, 3)

	return { head, maxp, hhea, hmtx: be(500, 0, 600, 100, 700, 0), loca: new Uint8Array(0) }
}

describe("MicroType Express compact tables", () => {
	it("rebuilds glyf and loca from compact glyphs with their push data and programs", () => {
		// Glyph 0 empty; glyph 1 a triangle (one contour, end point 2: (0, 100), (200, 100), (200, 300)), its program a push burst of
		// [5, 300, 5, 7, 5] written with a Hop3 code and 2 instruction bytes; glyph 2 a composite of glyph 1.
		const glyf = concat(
			be(0),
			be(1),
			bytes(2),
			bytes(0x01, 0x0b, 0x01),
			bytes(100, 200, 200),
			bytes(5, 2),
			be(0xffff, 100, 0, 300, 200),
			be(0x0002, 1),
			bytes(10, 20)
		)
		const push = bytes(5, 255, 50, 251, 7)
		const code = bytes(0x2f, 0x2f)
		const font = ctfToTtf(ctf({ ...baseTables(), glyf }), push, code)
		const sfnt = readSfnt(font)

		expect(sfnt.numGlyphs).toBe(3)

		const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
		const tables = new Map<string, [number, number]>()

		for (let k = 0; k < view.getUint16(4); k++) {
			const tag = String.fromCharCode(...font.subarray(12 + k * 16, 16 + k * 16))

			tables.set(tag, [view.getUint32(12 + k * 16 + 8), view.getUint32(12 + k * 16 + 12)])
		}

		const [locaAt] = tables.get("loca") ?? [0, 0]
		const [glyfAt, glyfLength] = tables.get("glyf") ?? [0, 0]
		const loca = [0, 1, 2, 3].map(k => view.getUint16(locaAt + k * 2) * 2)

		expect(loca[0]).toBe(0)
		expect(loca[1]).toBe(0)
		expect(loca[3]).toBe(glyfLength)

		const triangle = glyfAt + (loca[1] ?? 0)

		// One contour, its box from the points: (0, 100), (200, 100), (200, 300).
		expect(view.getInt16(triangle)).toBe(1)
		expect([
			view.getInt16(triangle + 2),
			view.getInt16(triangle + 4),
			view.getInt16(triangle + 6),
			view.getInt16(triangle + 8)
		]).toEqual([0, 100, 200, 300])
		expect(view.getUint16(triangle + 10)).toBe(2)

		// PUSHB [5], PUSHW [300], PUSHB [5, 7, 5], then the two instruction bytes.
		const length = view.getUint16(triangle + 12)
		const program = Array.from(font.subarray(triangle + 14, triangle + 14 + length))

		expect(program).toEqual([0xb0, 5, 0xb8, 0x01, 0x2c, 0xb2, 5, 7, 5, 0x2f, 0x2f])

		const composite = glyfAt + (loca[2] ?? 0)

		expect(view.getInt16(composite)).toBe(-1)
		expect(view.getUint16(composite + 10)).toBe(0x0002)
		expect(view.getUint16(composite + 12)).toBe(1)
	})

	it("expands cvt deltas and the hdmx and VDMX predictions", () => {
		// cvt: 3 values as deltas: 10, -5 (239, 5) and 268 (248, 30: 238 + 30).
		const cvt = concat(be(3), bytes(10, 239, 5, 248, 30))
		// hdmx: one record at 10 ppem; widths predicted from 500/600/700 units: 5, 6, 7; surprises 0, +1, -1.
		const hdmx = concat(be(0, 1), bytes(0, 0, 0, 8), bytes(10, 8), bytes(0b01010010))
		// VDMX: one ratio, one group of one record at 9 ppem (predicted 8, +1); yMax 9*2048/2048 = 9 (+0), yMin -9 (+0).
		const vdmx = concat(be(1, 1, 1), bytes(1, 1, 1, 1), be(12), be(1, 2048, 2048), bytes(0b00000001))
		const font = ctfToTtf(
			ctf({ ...baseTables(), glyf: be(0, 0, 0), "cvt ": cvt, hdmx, VDMX: vdmx }),
			new Uint8Array(0),
			new Uint8Array(0)
		)
		const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
		const table = (name: string): number => {
			for (let k = 0; k < view.getUint16(4); k++)
				if (String.fromCharCode(...font.subarray(12 + k * 16, 16 + k * 16)) === name) return view.getUint32(12 + k * 16 + 8)

			return -1
		}

		const cvtAt = table("cvt ")

		expect([view.getInt16(cvtAt), view.getInt16(cvtAt + 2), view.getInt16(cvtAt + 4)]).toEqual([10, 5, 273])

		const hdmxAt = table("hdmx")

		expect(Array.from(font.subarray(hdmxAt + 8, hdmxAt + 13))).toEqual([10, 8, 5, 7, 6])

		const vdmxAt = table("VDMX")
		const group = vdmxAt + view.getUint16(vdmxAt + 10)

		expect([view.getUint16(group), font[group + 2], font[group + 3]]).toEqual([1, 9, 9])
		expect([view.getUint16(group + 4), view.getInt16(group + 6), view.getInt16(group + 8)]).toEqual([9, 9, -9])
	})

	it("clears a cmap subtable's language outside the Macintosh platform (browsers' sanitisers refuse one that is set)", () => {
		// One (3, 10) format 12 subtable of one group, its language field written as garbage (as PowerPoint's subsetter does).
		const subtable = concat(be(12, 0), be(0, 28), be(0xb6c2, 0x01d0), be(0, 1), be(0, 0x41, 0, 0x5a, 0, 1))
		const cmap = concat(be(0, 1), be(3, 10), be(0, 12), subtable)
		const font = ctfToTtf(ctf({ ...baseTables(), glyf: be(0, 0, 0), cmap }), new Uint8Array(0), new Uint8Array(0))
		const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
		let at = -1

		for (let k = 0; k < view.getUint16(4); k++)
			if (String.fromCharCode(...font.subarray(12 + k * 16, 16 + k * 16)) === "cmap") at = view.getUint32(12 + k * 16 + 8)

		expect(view.getUint32(at + 12 + 8)).toBe(0)
		// The group itself is kept.
		expect(view.getUint32(at + 12 + 16 + 8)).toBe(1)

		// The same in an uncompressed EOT's font, its checksums kept consistent.
		const plain = decodeEot(
			eot(
				font.map((byte, k) => (k === at + 12 + 8 ? 0x55 : byte)),
				0
			)
		)
		const plainView = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)

		expect(plainView.getUint32(at + 12 + 8)).toBe(0)
	})

	it("refuses a VDMX that expands past the font limit while expanding it, not after", () => {
		// 150 groups of 65535 records, each record three zero bits: 1.2 MB of input expanding to 59 MB.
		const records = 0xffff
		const group = 6 + Math.ceil((records * 3) / 8)
		const vdmx = new Uint8Array(12 + 150 * group)
		const view = new DataView(vdmx.buffer)

		view.setUint16(2, 150)
		view.setUint16(4, 1)
		view.setUint16(10, 12)

		for (let g = 0; g < 150; g++) view.setUint16(12 + g * group, records)

		const start = cpuMs()

		expect(() =>
			ctfToTtf(ctf({ ...baseTables(), glyf: be(0, 0, 0), VDMX: vdmx }), new Uint8Array(0), new Uint8Array(0), 4 * 1024 * 1024)
		).toThrow(expect.objectContaining({ code: "tooLarge" }))
		// Refused at the group that passes 4 MiB, not after decoding 29 million values.
		expect(cpuMs() - start).toBeLessThan(budget(150))
	})

	it("refuses a compact glyph that runs past its table with a typed error", () => {
		expect(() => ctfToTtf(ctf({ ...baseTables(), glyf: be(1, 0) }), new Uint8Array(0), new Uint8Array(0))).toThrow(FontError)
	})
})

describe("Embedded OpenType", () => {
	it("passes a plain TrueType font through and decodes uncompressed and XOR-encrypted EOT", () => {
		const font = arimo()
		const xored = font.map(byte => byte ^ 0x50)

		expect(embeddedFontData(font)).toBe(font)
		expect(decodeEot(eot(font, 0))).toEqual(font)
		expect(decodeEot(eot(xored, 0x10000000))).toEqual(font)
		expect(readEotHeader(eot(font, 0, "Fancy")).familyName).toBe("Fancy")
		expect(isEot(eot(font, 0))).toBe(true)
	})

	it("refuses what is not a font, a truncated header and a font over the size limit, typed", () => {
		const font = arimo()

		expect(() => embeddedFontData(new Uint8Array(200))).toThrow(FontError)
		expect(() => readEotHeader(eot(font, 0).subarray(0, 40))).toThrow(FontError)
		expect(() => decodeEot(eot(font, 0), { maxFontBytes: 1024 })).toThrow(expect.objectContaining({ code: "tooLarge" }))
		expect(() => decodeMtx(new Uint8Array(4))).toThrow(FontError)
	})

	it("ends on hostile compressed bytes with a typed refusal", () => {
		let seed = 7
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff

			return seed & 255
		}

		for (let k = 0; k < 50; k++) {
			const block = Uint8Array.from({ length: 64 + k * 13 }, random)

			try {
				lzcompDecompress(block, 3, 100_000, 1 << 20)
			} catch (error) {
				expect(error).toBeInstanceOf(FontError)
			}

			const mtx = concat(bytes(3, 0, 0x10, 0, 0, 0, 30, 0, 0, 50), Uint8Array.from({ length: 80 }, random))

			expect(() => decodeMtx(mtx)).toThrow(FontError)
		}
	})
})

const FONTS = corpusFonts()

describe.skipIf(FONTS.length === 0)("the corpus's embedded fonts", () => {
	it("decode every .fntdata to a font whose glyphs number as its maxp says, its glyph boxes on its side bearings", () => {
		expect(FONTS.length).toBeGreaterThanOrEqual(17)

		for (const { name, bytes } of FONTS) {
			const font = readSfnt(decodeEot(bytes))
			const data = new DataView(font.bytes.buffer, font.bytes.byteOffset, font.bytes.byteLength)
			const maxp = font.table("maxp")
			const loca = font.table("loca")
			const glyf = font.table("glyf")

			expect(maxp, name).toBeDefined()
			expect(font.numGlyphs, name).toBe(data.getUint16((maxp?.offset ?? 0) + 4))

			if (font.cff || loca === undefined || glyf === undefined) continue

			const long = data.getInt16((font.table("head")?.offset ?? 0) + 50) === 1

			// One more loca entry than glyphs, ascending, the last at the end of glyf.
			expect(loca.length, name).toBe((font.numGlyphs + 1) * (long ? 4 : 2))

			const offset = (k: number): number => (long ? data.getUint32(loca.offset + k * 4) : data.getUint16(loca.offset + k * 2) * 2)

			expect(offset(font.numGlyphs), name).toBe(glyf.length)

			const hmtx = font.table("hmtx")
			const metrics = data.getUint16((font.table("hhea")?.offset ?? 0) + 34)

			for (let g = 0; g < font.numGlyphs; g++) {
				const start = offset(g)

				if (offset(g + 1) === start) continue

				const xMin = data.getInt16(glyf.offset + start + 2)
				const lsb =
					g < metrics
						? data.getInt16((hmtx?.offset ?? 0) + g * 4 + 2)
						: data.getInt16((hmtx?.offset ?? 0) + metrics * 4 + (g - metrics) * 2)

				expect(xMin, `${name} glyph ${String(g)}`).toBe(lsb)
			}
		}
	})

	it("refuses a damaged compressed font typed", () => {
		const first = FONTS.find(font => font.name.endsWith(".fntdata"))

		if (first === undefined) return

		const header = readEotHeader(first.bytes)
		const damaged = first.bytes.slice()

		for (let at = header.fontOffset + 10; at < damaged.length; at += 97) damaged[at] = (damaged[at] ?? 0) ^ 0xa5

		expect(() => decodeEot(damaged)).toThrow(FontError)
	})
})

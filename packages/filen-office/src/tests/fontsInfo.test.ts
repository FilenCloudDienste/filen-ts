import { readFileSync } from "node:fs"
import { brotliCompressSync, deflateSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	FONT_INFO_TABLES,
	FontError,
	WOFF2_MAX_STREAM_BYTES,
	decompressBrotli,
	fontContainer,
	fontInfoTables,
	readFontInfo,
	readWoff2Directory,
	readWoffTables,
	sfntInfoTables
} from "@filen/office/core/fonts"
import { ASSETS } from "../scripts/fontTables"
import { buildSfnt, sfntFromWoff2 } from "../scripts/woff2Tables"

function asset(file: string): Uint8Array {
	return new Uint8Array(readFileSync(`${ASSETS}${file}`))
}

async function codeOf(run: () => unknown): Promise<string | undefined> {
	try {
		await run()
	} catch (error) {
		return error instanceof FontError ? error.code : `not a FontError: ${String(error)}`
	}

	return undefined
}

function table(size: number, write: (view: DataView) => void): Uint8Array {
	const bytes = new Uint8Array(size)

	write(new DataView(bytes.buffer))

	return bytes
}

function head(): Uint8Array {
	return table(54, view => {
		view.setUint32(12, 0x5f0f3cf5)
		view.setUint16(18, 2048)
		view.setUint16(44, 0b10)
	})
}

function maxp(glyphs: number): Uint8Array {
	return table(6, view => view.setUint16(4, glyphs))
}

// A name table of Windows Unicode US-English records.
function nameTable(records: readonly [number, string][]): Uint8Array {
	const strings = records.map(([, value]) => value)
	const storageLength = strings.reduce((sum, value) => sum + value.length * 2, 0)
	const out = new Uint8Array(6 + records.length * 12 + storageLength)
	const view = new DataView(out.buffer)
	let at = 0

	view.setUint16(2, records.length)
	view.setUint16(4, 6 + records.length * 12)
	records.forEach(([id, value], i) => {
		const record = 6 + i * 12

		view.setUint16(record, 3)
		view.setUint16(record + 2, 1)
		view.setUint16(record + 4, 0x0409)
		view.setUint16(record + 6, id)
		view.setUint16(record + 8, value.length * 2)
		view.setUint16(record + 10, at)

		for (let k = 0; k < value.length; k++) view.setUint16(6 + records.length * 12 + at + k * 2, value.charCodeAt(k))

		at += value.length * 2
	})

	return out
}

// cmap with one format-12 subtable (platform 3, encoding 10) of [start, end, startGlyph] groups.
function cmap12(groups: readonly [number, number, number][]): Uint8Array {
	const subtable = 16 + groups.length * 12
	const out = new Uint8Array(12 + subtable)
	const view = new DataView(out.buffer)

	view.setUint16(2, 1)
	view.setUint16(4, 3)
	view.setUint16(6, 10)
	view.setUint32(8, 12)
	view.setUint16(12, 12)
	view.setUint32(16, subtable)
	view.setUint32(24, groups.length)
	groups.forEach(([start, end, glyph], g) => {
		view.setUint32(28 + g * 12, start)
		view.setUint32(32 + g * 12, end)
		view.setUint32(36 + g * 12, glyph)
	})

	return out
}

function fvar(axes: readonly [string, number, number, number, number][]): Uint8Array {
	const out = new Uint8Array(16 + axes.length * 20)
	const view = new DataView(out.buffer)

	view.setUint16(0, 1)
	view.setUint16(4, 16)
	view.setUint16(8, axes.length)
	view.setUint16(10, 20)
	axes.forEach(([tag, min, value, max, nameId], i) => {
		const at = 16 + i * 20

		for (let k = 0; k < 4; k++) view.setUint8(at + k, tag.charCodeAt(k))

		view.setInt32(at + 4, min * 65536)
		view.setInt32(at + 8, value * 65536)
		view.setInt32(at + 12, max * 65536)
		view.setUint16(at + 18, nameId)
	})

	return out
}

function syntheticTables(): Map<string, Uint8Array> {
	return new Map([
		["head", head()],
		["maxp", maxp(10)],
		[
			"name",
			nameTable([
				[1, "Probe"],
				[2, "Bold"],
				[13, "Licensed to test"],
				[19, "Sample"],
				[256, "Weight"],
				[99, "unwanted"]
			])
		],
		[
			"cmap",
			cmap12([
				[0x41, 0x43, 1],
				[0x44, 0x45, 4],
				[0x1f600, 0x1f6ff, 6]
			])
		],
		["fvar", fvar([["wght", 100, 400, 900, 256]])],
		["glyf", new Uint8Array(4)],
		["hmtx", new Uint8Array(40)]
	])
}

// A WOFF 1.0 wrapping `tables`, each zlib-compressed when that is smaller.
function woff(flavor: number, tables: ReadonlyMap<string, Uint8Array>): Uint8Array {
	const entries = [...tables].map(([tag, data]) => {
		const deflated = new Uint8Array(deflateSync(data))

		return { tag, data, stored: deflated.length < data.length ? deflated : data }
	})
	const directoryEnd = 44 + entries.length * 20
	const size = entries.reduce((sum, entry) => sum + ((entry.stored.length + 3) & ~3), directoryEnd)
	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)
	let offset = directoryEnd

	view.setUint32(0, 0x774f4646)
	view.setUint32(4, flavor)
	view.setUint32(8, size)
	view.setUint16(12, entries.length)
	entries.forEach(({ tag, data, stored }, i) => {
		const entry = 44 + i * 20

		for (let k = 0; k < 4; k++) view.setUint8(entry + k, tag.charCodeAt(k))

		view.setUint32(entry + 4, offset)
		view.setUint32(entry + 8, stored.length)
		view.setUint32(entry + 12, data.length)
		out.set(stored, offset)
		offset += (stored.length + 3) & ~3
	})

	return out
}

// A WOFF2 with arbitrary-tag entries (index 63); `transform` names tables stored transformed.
function woff2(tables: ReadonlyMap<string, Uint8Array>, transform: ReadonlySet<string> = new Set()): Uint8Array {
	const directory: number[] = []
	const base128 = (value: number): number[] => {
		const out = [value & 0x7f]

		for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) out.unshift((rest & 0x7f) | 0x80)

		return out
	}

	for (const [tag, data] of tables) {
		const glyfLike = tag === "glyf" || tag === "loca"
		const transformed = transform.has(tag)
		const version = glyfLike ? (transformed ? 0 : 3) : transformed ? 1 : 0

		directory.push((version << 6) | 63, ...[...tag].map(char => char.charCodeAt(0)), ...base128(data.length))

		if (transformed) directory.push(...base128(data.length))
	}

	const stream = new Uint8Array(brotliCompressSync(Buffer.concat([...tables.values()])))
	const out = new Uint8Array(48 + directory.length + stream.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, 0x774f4632)
	view.setUint32(4, 0x00010000)
	view.setUint32(8, out.length)
	view.setUint16(12, tables.size)
	view.setUint32(20, stream.length)
	out.set(directory, 48)
	out.set(stream, 48 + directory.length)

	return out
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("font containers", () => {
	it("tells sfnt, WOFF and WOFF2 apart by signature", () => {
		expect(fontContainer(Uint8Array.of(0, 1, 0, 0))).toBe("sfnt")
		expect(fontContainer(new TextEncoder().encode("OTTO"))).toBe("sfnt")
		expect(fontContainer(new TextEncoder().encode("wOFF"))).toBe("woff")
		expect(fontContainer(new TextEncoder().encode("wOF2"))).toBe("woff2")
		expect(fontContainer(new TextEncoder().encode("ttcf"))).toBeNull()
		expect(fontContainer(new Uint8Array(2))).toBeNull()
	})
})

describe("readFontInfo", () => {
	it("reads names, design facts, axes and merged code point runs from an sfnt's tables", () => {
		const set = sfntInfoTables(buildSfnt(0x00010000, syntheticTables()))
		const info = readFontInfo(set)

		// Only the info tables cross; glyf and hmtx stay behind.
		expect([...set.tables.keys()].sort()).toEqual(["cmap", "fvar", "head", "maxp", "name"])
		expect(set.tags).toContain("glyf")
		expect(info).toMatchObject({
			container: "sfnt",
			outlines: "trueType",
			glyphCount: 10,
			unitsPerEm: 2048,
			weight: 400,
			italic: true,
			fsType: 0
		})
		expect(info.names).toEqual([
			{ id: 1, value: "Probe" },
			{ id: 2, value: "Bold" },
			{ id: 13, value: "Licensed to test" },
			{ id: 19, value: "Sample" }
		])
		expect(info.axes).toEqual([{ tag: "wght", min: 100, default: 400, max: 900, name: "Weight", hidden: false }])
		// 0x41–0x45 are two touching groups; the emoji group runs past glyph 9 and is cut there.
		expect([...info.codePoints]).toEqual([0x41, 0x45, 0x1f600, 0x1f603])
		expect(info.codePointCount).toBe(9)
	})

	it("refuses a font without head or maxp, and a bad head magic", async () => {
		const tables = syntheticTables()

		tables.delete("maxp")
		expect(await codeOf(() => readFontInfo(sfntInfoTables(buildSfnt(0x00010000, tables))))).toBe("corrupt")

		const bad = syntheticTables()

		bad.set(
			"head",
			table(54, view => view.setUint32(12, 1))
		)
		expect(await codeOf(() => readFontInfo(sfntInfoTables(buildSfnt(0x00010000, bad))))).toBe("corrupt")
	})

	it("drops an axis whose default lies outside its range", () => {
		const tables = syntheticTables()

		tables.set(
			"fvar",
			fvar([
				["wdth", 75, 50, 100, 256],
				["wght", 100, 400, 900, 256]
			])
		)

		expect(readFontInfo(sfntInfoTables(buildSfnt(0x00010000, tables))).axes.map(axis => axis.tag)).toEqual(["wght"])
	})

	it("reads a bundled variable WOFF2 face like the sfnt the build script makes of it", async () => {
		const bytes = asset("arimo/Arimo-VF.woff2")
		const info = readFontInfo(await fontInfoTables(bytes))
		const sfnt = readFontInfo(sfntInfoTables(sfntFromWoff2(bytes, [...FONT_INFO_TABLES])))

		expect(info.container).toBe("woff2")
		expect(info.outlines).toBe("trueType")
		expect(info.names.find(name => name.id === 1)?.value).toBe("Arimo")
		expect(info.axes.map(axis => axis.tag)).toContain("wght")
		expect(info.codePointCount).toBeGreaterThan(500)
		expect({ ...info, container: "sfnt" }).toEqual({ ...sfnt, outlines: info.outlines })
	})

	it("decodes WOFF2 with the JavaScript brotli decoder where the platform has none", async () => {
		const bytes = asset("arimo/Arimo-VF.woff2")
		const native = readFontInfo(await fontInfoTables(bytes))

		vi.stubGlobal("DecompressionStream", undefined)

		expect(readFontInfo(await fontInfoTables(bytes))).toEqual(native)
	})
})

describe("WOFF", () => {
	it("inflates only the wanted tables of a WOFF 1.0 file", () => {
		const set = readWoffTables(woff(0x00010000, syntheticTables()), FONT_INFO_TABLES)

		expect(set.container).toBe("woff")
		expect([...set.tables.keys()].sort()).toEqual(["cmap", "fvar", "head", "maxp", "name"])
		expect(readFontInfo(set).names[0]).toEqual({ id: 1, value: "Probe" })
	})

	it("refuses a table that inflates past its declared length", async () => {
		const bytes = woff(0x00010000, new Map([["name", new Uint8Array(4096)]]))
		const view = new DataView(bytes.buffer)

		view.setUint32(44 + 12, 100)

		expect(await codeOf(() => readWoffTables(bytes, FONT_INFO_TABLES))).toBe("corrupt")
	})

	it("refuses a table outside the file, a collection and a cut directory", async () => {
		const bytes = woff(0x00010000, new Map([["head", head()]]))

		new DataView(bytes.buffer).setUint32(44 + 4, bytes.length)
		expect(await codeOf(() => readWoffTables(bytes, FONT_INFO_TABLES))).toBe("truncated")

		const collection = woff(0x74746366, new Map([["head", head()]]))

		expect(await codeOf(() => readWoffTables(collection, FONT_INFO_TABLES))).toBe("unsupported")
		expect(await codeOf(() => readWoffTables(bytes.subarray(0, 50), FONT_INFO_TABLES))).toBe("truncated")
	})
})

describe("WOFF2", () => {
	it("skips transformed tables and reads the rest", async () => {
		const tables = syntheticTables()
		const set = await fontInfoTables(woff2(tables, new Set(["glyf", "hmtx", "cmap"])))

		expect(set.tables.has("cmap")).toBe(false)
		expect(set.tags).toEqual([...tables.keys()])
		expect(readFontInfo(set).codePointCount).toBe(0)
	})

	it("refuses a stream declared past the bound and a stream outside the file", async () => {
		const huge = woff2(new Map([["head", head()]]))
		// The head entry's length: a 5-byte UIntBase128 of 2^31.
		const directory = Uint8Array.of(63, ...[..."head"].map(char => char.charCodeAt(0)), 0x88, 0x80, 0x80, 0x80, 0x00)
		const declared = new Uint8Array(48 + directory.length)

		declared.set(huge.subarray(0, 48))
		declared.set(directory, 48)
		new DataView(declared.buffer).setUint32(20, 0)

		expect(2 ** 31).toBeGreaterThan(WOFF2_MAX_STREAM_BYTES)
		expect(await codeOf(() => readWoff2Directory(declared))).toBe("tooLarge")

		const cut = huge.slice()

		new DataView(cut.buffer).setUint32(20, cut.length)
		expect(await codeOf(() => readWoff2Directory(cut))).toBe("truncated")
	})

	it("refuses a leading-zero UIntBase128", async () => {
		const bytes = new Uint8Array(48 + 7)
		const view = new DataView(bytes.buffer)

		view.setUint32(0, 0x774f4632)
		view.setUint32(4, 0x00010000)
		view.setUint16(12, 1)
		bytes.set([63, 0x68, 0x65, 0x61, 0x64, 0x80, 0x01], 48)

		expect(await codeOf(() => readWoff2Directory(bytes))).toBe("corrupt")
	})

	it("stops the platform decoder at the bytes wanted, and refuses a stream that ends early", async () => {
		const data = new Uint8Array(1 << 20).map((_, i) => i % 251)
		const compressed = new Uint8Array(brotliCompressSync(data))

		expect(await decompressBrotli(compressed, data.length, 1000)).toEqual(data.subarray(0, 1000))
		expect(await codeOf(() => decompressBrotli(compressed, data.length + 10))).toBe("truncated")
	})
})

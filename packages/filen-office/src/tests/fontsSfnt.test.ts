import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	BUNDLED_FACES,
	FontError,
	LINE_METRICS,
	SUBSTITUTIONS,
	deobfuscateFont,
	lineSpacingUnits,
	parseFontKey,
	readSfnt
} from "@filen/office/core/fonts"
import { ASSETS, bundledFaceTable, readManifest } from "../scripts/fontTables"
import { buildSfnt, sfntFromWoff2 } from "../scripts/woff2Tables"

function asset(file: string): Uint8Array {
	return new Uint8Array(readFileSync(`${ASSETS}${file}`))
}

function sfntOf(file: string): Uint8Array {
	return sfntFromWoff2(asset(file))
}

async function codeOf(run: () => unknown): Promise<string | undefined> {
	try {
		await run()
	} catch (error) {
		return error instanceof FontError ? error.code : `not a FontError: ${String(error)}`
	}

	return undefined
}

// Minimal hand-built fonts for the cases real fonts do not reach.
interface TableSpec {
	upem?: number
	numGlyphs?: number
	advances?: number[]
	cmap?: Uint8Array
	os2?: Uint8Array
	name?: Uint8Array
	magic?: number
}

function table(size: number, write: (view: DataView) => void): Uint8Array {
	const bytes = new Uint8Array(size)

	write(new DataView(bytes.buffer))

	return bytes
}

function synthetic(spec: TableSpec = {}): Uint8Array {
	const advances = spec.advances ?? [500, 600, 700]
	const tables = new Map<string, Uint8Array>([
		[
			"head",
			table(54, view => {
				view.setUint32(12, spec.magic ?? 0x5f0f3cf5)
				view.setUint16(18, spec.upem ?? 1000)
				view.setUint16(44, 0b11)
			})
		],
		[
			"hhea",
			table(36, view => {
				view.setInt16(4, 800)
				view.setInt16(6, -200)
				view.setInt16(8, 90)
				view.setUint16(34, advances.length)
			})
		],
		["maxp", table(6, view => view.setUint16(4, spec.numGlyphs ?? advances.length))],
		["hmtx", table(advances.length * 4, view => advances.forEach((advance, i) => view.setUint16(i * 4, advance)))]
	])

	if (spec.cmap !== undefined) tables.set("cmap", spec.cmap)
	if (spec.os2 !== undefined) tables.set("OS/2", spec.os2)
	if (spec.name !== undefined) tables.set("name", spec.name)

	return buildSfnt(0x00010000, tables)
}

// cmap with one subtable.
function cmap(platform: number, encoding: number, subtable: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + subtable.length)
	const view = new DataView(out.buffer)

	view.setUint16(2, 1)
	view.setUint16(4, platform)
	view.setUint16(6, encoding)
	view.setUint32(8, 12)
	out.set(subtable, 12)

	return out
}

// Format 4 from [start, end, delta, glyphs?] segments (glyphs: explicit ids through idRangeOffset).
function format4(segments: [number, number, number, number[]?][]): Uint8Array {
	const all = [...segments, [0xffff, 0xffff, 1] as [number, number, number]]
	const count = all.length
	const glyphArrays = all.map(segment => segment[3] ?? [])
	const glyphTotal = glyphArrays.reduce((sum, list) => sum + list.length, 0)
	const out = new Uint8Array(16 + count * 8 + glyphTotal * 2)
	const view = new DataView(out.buffer)
	const ends = 14
	const starts = ends + count * 2 + 2
	const deltas = starts + count * 2
	const rangeOffsets = deltas + count * 2
	let glyphAt = rangeOffsets + count * 2

	view.setUint16(0, 4)
	view.setUint16(2, out.length)
	view.setUint16(6, count * 2)
	all.forEach(([start, end, delta], s) => {
		view.setUint16(ends + s * 2, end)
		view.setUint16(starts + s * 2, start)
		view.setUint16(deltas + s * 2, delta & 0xffff)

		const glyphs = glyphArrays[s] ?? []

		if (glyphs.length > 0) {
			view.setUint16(rangeOffsets + s * 2, glyphAt - (rangeOffsets + s * 2))
			glyphs.forEach(glyph => {
				view.setUint16(glyphAt, glyph)
				glyphAt += 2
			})
		}
	})

	return out
}

function format12(groups: [number, number, number][]): Uint8Array {
	const out = new Uint8Array(16 + groups.length * 12)
	const view = new DataView(out.buffer)

	view.setUint16(0, 12)
	view.setUint32(4, out.length)
	view.setUint32(12, groups.length)
	groups.forEach(([start, end, glyph], g) => {
		view.setUint32(16 + g * 12, start)
		view.setUint32(20 + g * 12, end)
		view.setUint32(24 + g * 12, glyph)
	})

	return out
}

function nameTable(records: [platform: number, encoding: number, language: number, id: number, value: string][]): Uint8Array {
	const strings: number[] = []
	const header: number[] = []
	const u16 = (out: number[], value: number): void => {
		out.push((value >>> 8) & 0xff, value & 0xff)
	}

	for (const [platform, encoding, language, id, value] of records) {
		const bytes: number[] = []

		for (const char of value) {
			if (platform === 1) bytes.push(char.charCodeAt(0) & 0xff)
			else u16(bytes, char.charCodeAt(0))
		}

		for (const field of [platform, encoding, language, id, bytes.length, strings.length]) u16(header, field)

		strings.push(...bytes)
	}

	const out: number[] = []

	u16(out, 0)
	u16(out, records.length)
	u16(out, 6 + header.length)

	return new Uint8Array([...out, ...header, ...strings])
}

describe("sfnt reader on the bundled fonts", () => {
	it("reads every face with the metrics the generated table holds", () => {
		for (const face of BUNDLED_FACES) {
			const font = readSfnt(sfntOf(face.file))
			const family = readManifest().families.find(entry => entry.id === face.family)

			expect(font.names.typographicFamily ?? font.names.family, face.file).toMatch(new RegExp(`^${family?.name ?? "?"}`))
			expect(font.italic, face.file).toBe(face.italic)
			expect({ ...font.metrics }, face.file).toEqual(face.metrics)
			expect(font.glyphId(0x1f600), face.file).toBe(0)
		}
	})

	it("maps code points through cmap and hmtx", () => {
		const cousine = readSfnt(sfntOf("cousine/Cousine-Regular.woff2"))

		// A monospaced font: every printable ASCII character has the same advance.
		for (let c = 0x21; c < 0x7f; c++) {
			expect(cousine.hasGlyph(c), String.fromCharCode(c)).toBe(true)
			expect(cousine.advanceOf(c), String.fromCharCode(c)).toBe(1229)
		}

		const carlito = readSfnt(sfntOf("carlito/Carlito-Regular.woff2"))
		const digit = carlito.advanceOf(0x30)

		// Tabular figures, as in Calibri.
		for (let c = 0x31; c <= 0x39; c++) expect(carlito.advanceOf(c)).toBe(digit)

		expect(carlito.advanceOf(0x416)).toBeGreaterThan(0)
		expect(carlito.hasGlyph(0x416)).toBe(true)
		expect(carlito.names.family).toBe("Carlito")
		expect(carlito.familyNames).toContain("Carlito")
		expect(carlito.weight).toBe(400)
		expect(carlito.fsType).toBe(0)
	})

	it("computes default line spacing by both rules", () => {
		const tinos = readSfnt(sfntOf("tinos/Tinos-Regular.woff2")).metrics
		const caladea = readSfnt(sfntOf("caladea/Caladea-Regular.woff2")).metrics

		// win 1825 + 443, plus the hhea gap that win does not cover.
		expect(lineSpacingUnits(tinos, "gdi")).toBe(2355)
		expect(lineSpacingUnits(tinos, "typoWhenFlagged")).toBe(2355)
		expect(lineSpacingUnits(caladea, "gdi")).toBe(1300)
		expect(lineSpacingUnits(caladea, "typoWhenFlagged")).toBe(1150)
	})
})

describe("generated tables", () => {
	it("match the assets and their recorded checksums", () => {
		expect(bundledFaceTable(readManifest())).toEqual(BUNDLED_FACES)
	})

	it("hold an entry for every substituted family", () => {
		expect([...LINE_METRICS.keys()].sort()).toEqual([...SUBSTITUTIONS.keys()].sort())
		expect(LINE_METRICS.get("times new roman")).toMatchObject({ basis: "original", metrics: { winAscent: 1825, hheaLineGap: 87 } })
		expect(LINE_METRICS.get("aptos")).toEqual({ basis: "substitute" })
	})
})

describe("sfnt reader on hand-built fonts", () => {
	it("follows format 4 deltas and glyph arrays", () => {
		const font = readSfnt(
			synthetic({
				advances: [500, 600, 700, 800],
				cmap: cmap(
					3,
					1,
					format4([
						[0x41, 0x42, 1 - 0x41],
						[0x100, 0x102, 0, [3, 0, 2]]
					])
				)
			})
		)

		expect([font.glyphId(0x41), font.glyphId(0x42), font.glyphId(0x43)]).toEqual([1, 2, 0])
		expect([font.glyphId(0x100), font.glyphId(0x101), font.glyphId(0x102)]).toEqual([3, 0, 2])
		expect(font.glyphId(0x40)).toBe(0)
		expect(font.glyphId(0x1f600)).toBe(0)
		expect(font.advanceOf(0x100)).toBe(800)
		// Glyphs past numberOfHMetrics take the last advance.
		expect(font.advance(99)).toBe(800)
	})

	it("prefers format 12 and searches its groups", () => {
		const font = readSfnt(
			synthetic({
				advances: [1, 2, 3, 4, 5, 6],
				cmap: cmap(
					3,
					10,
					format12([
						[0x20, 0x21, 1],
						[0x4e00, 0x4e01, 3],
						[0x20000, 0x20000, 5]
					])
				)
			})
		)

		expect([font.glyphId(0x21), font.glyphId(0x4e01), font.glyphId(0x20000), font.glyphId(0x22), font.glyphId(0x30000)]).toEqual([
			2, 4, 5, 0, 0
		])
	})

	it("ignores cmaps it cannot search and glyph ids past the font", () => {
		const unsorted = readSfnt(
			synthetic({
				cmap: cmap(
					3,
					10,
					format12([
						[0x50, 0x60, 1],
						[0x20, 0x30, 1]
					])
				)
			})
		)

		expect(unsorted.glyphId(0x25)).toBe(0)

		const beyond = readSfnt(synthetic({ numGlyphs: 3, cmap: cmap(3, 1, format4([[0x41, 0x41, 50]])) }))

		expect(beyond.glyphId(0x41)).toBe(0)
	})

	it("reads names by platform preference, localized family names included", () => {
		const font = readSfnt(
			synthetic({
				name: nameTable([
					[1, 0, 0, 1, "Mac Name"],
					[3, 1, 0x0411, 1, "ＭＳ 明朝"],
					[3, 1, 0x0409, 1, "MS Mincho"],
					[3, 1, 0x0409, 6, "MS-Mincho"]
				])
			})
		)

		expect(font.names.family).toBe("MS Mincho")
		expect(font.names.postScriptName).toBe("MS-Mincho")
		expect(font.familyNames).toEqual(expect.arrayContaining(["Mac Name", "ＭＳ 明朝", "MS Mincho"]))
	})

	it("decodes symbol-encoded names and bounds what a name table can make it keep", () => {
		const symbol = readSfnt(synthetic({ name: nameTable([[3, 0, 0x0409, 1, "Wingdings"]]) }))

		expect(symbol.names.family).toBe("Wingdings")

		const records: [number, number, number, number, string][] = []

		for (let i = 0; i < 3000; i++) records.push([3, 1, i, 1, `Family ${i}`])

		const flood = readSfnt(synthetic({ name: nameTable(records) }))

		expect(flood.familyNames.length).toBe(64)
		expect(flood.names.family).toBe("Family 1033")
	})

	it("falls back to hhea and macStyle without an OS/2 table", () => {
		const font = readSfnt(synthetic())

		expect(font.metrics).toMatchObject({ winAscent: 800, winDescent: 200, typoLineGap: 90, useTypoMetrics: false })
		expect(font.weight).toBe(700)
		expect(font.italic).toBe(true)
		expect(font.names.family).toBeUndefined()
	})

	it("reads OS/2 metrics, flags and weight", () => {
		const os2 = table(96, view => {
			view.setUint16(0, 4)
			view.setUint16(4, 6) // a 1-9 weight class
			view.setUint16(8, 0x0002)
			view.setUint16(62, 0x80)
			view.setInt16(68, 750)
			view.setInt16(70, -250)
			view.setInt16(72, 0)
			view.setUint16(74, 900)
			view.setUint16(76, 300)
			view.setInt16(86, 480)
			view.setInt16(88, 700)
		})
		const font = readSfnt(synthetic({ os2 }))

		expect(font.weight).toBe(600)
		expect(font.fsType).toBe(2)
		expect(font.xHeight).toBe(480)
		expect(font.capHeight).toBe(700)
		expect(font.metrics).toMatchObject({ typoAscender: 750, winDescent: 300, useTypoMetrics: true })
		expect(lineSpacingUnits(font.metrics, "typoWhenFlagged")).toBe(1000)
		expect(lineSpacingUnits(font.metrics, "gdi")).toBe(1200)
	})
})

describe("malformed fonts", () => {
	it("refuses what is not a usable font", async () => {
		const good = synthetic()
		const badMagic = synthetic({ magic: 1 })
		const noUnits = synthetic({ upem: 0 })
		const directoryCut = good.slice(0, 40)
		const woff2 = asset("selawik/selawk.woff2")
		const collection = new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 200])

		expect(await codeOf(() => readSfnt(new Uint8Array(3)))).toBe("truncated")
		expect(await codeOf(() => readSfnt(new Uint8Array(64)))).toBe("notSfnt")
		expect(await codeOf(() => readSfnt(woff2))).toBe("unsupported")
		expect(await codeOf(() => readSfnt(directoryCut))).toBe("truncated")
		expect(await codeOf(() => readSfnt(badMagic))).toBe("corrupt")
		expect(await codeOf(() => readSfnt(noUnits))).toBe("corrupt")
		expect(await codeOf(() => readSfnt(collection))).toBe("truncated")
		expect(await codeOf(() => readSfnt(collection, 3))).toBe("corrupt")
	})

	it("never fails with anything but a FontError on truncated or damaged real fonts", () => {
		const original = sfntOf("carlito/Carlito-Regular.woff2")
		let seed = 1
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff

			return seed / 0x7fffffff
		}

		const exercise = (bytes: Uint8Array): void => {
			try {
				const font = readSfnt(bytes)

				for (const c of [0x20, 0x41, 0x416, 0x4e00, 0x1f600]) expect(Number.isInteger(font.advanceOf(c))).toBe(true)
			} catch (error) {
				expect(error).toBeInstanceOf(FontError)
			}
		}

		for (let i = 0; i < 300; i++) exercise(original.subarray(0, Math.floor(random() * original.length)))

		for (let i = 0; i < 300; i++) {
			const damaged = original.slice()

			// Damage the directory and headers, where offsets and counts live.
			for (let k = 0; k < 8; k++) damaged[Math.floor(random() * Math.min(damaged.length, 4096))] = Math.floor(random() * 256)

			exercise(damaged)
		}
	})
})

describe("embedded font obfuscation", () => {
	it("reverses the GUID's bytes into the key", () => {
		// The header of a real obfuscated Word font: the key turns it back into an sfnt header.
		const header = new Uint8Array(32)

		header.set([0x00, 0x01, 0x00, 0x00, 0x00, 0x15, 0x01, 0x00])

		const obfuscated = deobfuscateFont(header, "{75E47363-20F1-45D4-9A84-815E26C8EAAE}")

		expect(Buffer.from(obfuscated.subarray(0, 8)).toString("hex")).toBe("aeebc8265e94859a")
		expect([...parseFontKey("75e47363-20f1-45d4-9a84-815e26c8eaae").subarray(0, 3)]).toEqual([0xae, 0xea, 0xc8])
	})

	it("round-trips a real font and leaves the input alone unless asked", () => {
		const font = sfntOf("caladea/Caladea-Regular.woff2")
		const key = "{1DF903E3-2F14-4575-8028-881FEBABF2AB}"
		const obfuscated = deobfuscateFont(font, key)

		expect(obfuscated).not.toBe(font)
		expect(Buffer.compare(obfuscated.subarray(32), font.subarray(32))).toBe(0)
		expect(Buffer.compare(obfuscated.subarray(0, 32), font.subarray(0, 32))).not.toBe(0)
		expect(() => readSfnt(obfuscated)).toThrow(FontError)

		const restored = deobfuscateFont(obfuscated, key, true)

		expect(restored).toBe(obfuscated)
		expect(Buffer.compare(restored, font)).toBe(0)
		expect(readSfnt(restored).names.family).toBe("Caladea")
	})

	it("rejects bad keys and short data", async () => {
		expect(await codeOf(() => parseFontKey("{not-a-guid}"))).toBe("invalidKey")
		expect(await codeOf(() => deobfuscateFont(new Uint8Array(64), new Uint8Array(8)))).toBe("invalidKey")
		expect(await codeOf(() => deobfuscateFont(new Uint8Array(31), "{75E47363-20F1-45D4-9A84-815E26C8EAAE}"))).toBe("truncated")
	})
})

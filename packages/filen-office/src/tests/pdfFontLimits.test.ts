import { createReadStream, readFileSync } from "node:fs"
import { Readable } from "node:stream"
import { gunzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import type { PdfFaceSource } from "../core/fonts/manager"
import { readSfnt } from "../core/fonts/sfnt"
import { PdfWriter } from "../core/pdfwrite"
import type { PdfByteStream, PdfFontAssets } from "../core/pdfwrite/fonts/assets"
import { PdfFontSet, type PdfFontFaceRequest, type PdfShapedText } from "../core/pdfwrite/fonts/fontSet"
import { wouldSubstitute } from "../core/pdfwrite/fonts/gsub"
import { LayoutTable } from "../core/pdfwrite/fonts/otl"
import { ShapingFace } from "../core/pdfwrite/fonts/shape"
import { scriptOf } from "../core/pdfwrite/fonts/unicode"
import { directoryRecord, gsubTable, multiply, recurse, withTable } from "./pdfFontLimitsFixtures"
import { budget, cpuMs } from "./timing"

// Fonts whose layout tables or glyph data are hostile: shaping stays within HarfBuzz's buffer limits and a font
// that cannot be subset gives way to its substitute, so the export finishes either way.

const ASSETS = new URL("../../assets/fonts/", import.meta.url)
const assets: PdfFontAssets = {
	open: file => Promise.resolve(Readable.toWeb(createReadStream(new URL(file, ASSETS))) as unknown as PdfByteStream)
}
const CALADEA = new Uint8Array(gunzipSync(readFileSync(new URL("caladea/Caladea-Regular.ttf.gz", ASSETS))))
const SFNT = readSfnt(CALADEA)
const GLYPH_A = SFNT.glyphId(0x61)
const GLYPH_X = SFNT.glyphId(0x78)
const GLYPH_LAST = SFNT.numGlyphs - 1
const REQUEST: PdfFontFaceRequest = { family: "Embedded", bold: false, italic: false, slot: "hAnsi" }
// How many times the feature lists the lookups of the ligature, rule set and nested record cases.
const LISTED = 16
const RECORDS_LISTED = 1000

// Caladea with its GSUB replaced.
function withGsub(table: Uint8Array): Uint8Array {
	return withTable(CALADEA, "GSUB", table)
}

function patched(mutate: (view: DataView, record: (tag: string) => number) => void): Uint8Array {
	const out = CALADEA.slice()
	const view = new DataView(out.buffer)

	mutate(view, tag => directoryRecord(out, tag))

	return out
}

function source(bytes: Uint8Array): PdfFaceSource {
	return {
		kind: "embedded",
		key: "hostile",
		read: () => Promise.resolve(bytes),
		fsType: 0,
		weight: 400,
		italic: false,
		substitute: "arimo"
	}
}

async function shaped(
	bytes: Uint8Array,
	text: string
): Promise<{ readonly fonts: PdfFontSet; readonly shaped: PdfShapedText; readonly ms: number }> {
	const fonts = new PdfFontSet({ assets, resolve: () => source(bytes) })
	const pending = fonts.prepare(text, 0, text.length, REQUEST)

	if (pending !== undefined) await pending

	const started = cpuMs()
	const result = fonts.shape(text, 0, text.length, REQUEST, { level: 0, flags: 0 })

	return { fonts, shaped: result, ms: cpuMs() - started }
}

function words(...values: number[]): number[] {
	return values.flatMap(value => [(value >>> 8) & 0xff, value & 0xff])
}

// A GSUB (or GPOS) whose `tag` feature (DFLT and latn) runs `count` lookups at `lookup`, `stride` bytes apart (0: one
// lookup table).
function aliasedGsub(count: number, lookup: readonly number[], stride = 0, tag = "ccmp"): Uint8Array {
	const lookupList = 48 + count * 2
	const indices = Array.from({ length: count }, (_, k) => k)
	const out = [
		...words(1, 0, 10, 36, lookupList),
		...words(2),
		..."DFLT".split("").map(char => char.charCodeAt(0)),
		...words(14),
		..."latn".split("").map(char => char.charCodeAt(0)),
		...words(14, 4, 0, 0, 0xffff, 1, 0, 1),
		...tag.split("").map(char => char.charCodeAt(0)),
		...words(8, 0, count, ...indices, count, ...indices.map(k => 2 + count * 2 + k * stride))
	]

	return Uint8Array.from([...out, ...lookup])
}

// SingleSubst lookup with `count` subtable offsets that all point at one subtable, whose Coverage format 2 has 65535
// ranges, each over every glyph id.
function aliasedSubtables(count: number): number[] {
	const out = words(1, 0, count, ...new Array<number>(count).fill(6 + count * 2), 1, 6, 0, 2, 0xffff)

	for (let k = 0; k < 0xffff; k++) out.push(0, 0, 0xff, 0xff, 0, 0)

	return out
}

// Lookup of `type` (1: SingleSubst, 2: MultipleSubst) with `count` distinct subtables sharing one Coverage that
// lists glyph "a" out of order, so it is in the first glyphs but no subtable applies to it.
function distinctSubtables(count: number, type = 1): number[] {
	const subtables = 6 + count * 2
	const coverage = subtables + count * 6

	return words(
		type,
		0,
		count,
		...Array.from({ length: count }, (_, k) => subtables + k * 6),
		...Array.from({ length: count }, (_, k) => [1, coverage - subtables - k * 6, 0]).flat(),
		1,
		2,
		GLYPH_LAST,
		GLYPH_A
	)
}

// Lookup tables two bytes apart over one run of words, so each reads its type, flag, subtable count and subtable
// offsets from the words after the one before it: thousands of distinct subtables apiece, of an unknown type whose
// Coverage has an unknown format, so each lookup gets an empty digest and is never tried.
function overlappingLookups(count: number): number[] {
	const out: number[] = []

	for (let k = 0; k < count + 0x4000; k++) {
		const value = 0x800 + ((k * 2) % 0x1600)

		out.push(value >>> 8, value & 0xff)
	}

	return out
}

// A GSUB whose DFLT language system lists `count` feature indices, each a feature record whose tag is `tag(k)` and
// whose Feature table is one shared table naming lookup 0 (a SingleSubst of "a" that changes nothing) 65535 times.
function repeatedFeatures(count: number, index: (k: number) => number, tag: (k: number) => string, records: number): Uint8Array {
	const lookupList = 28 + count * 2
	const featureList = lookupList + 24
	const feature = 2 + records * 6

	return Uint8Array.from([
		...words(1, 0, 10, featureList, lookupList, 1),
		..."DFLT".split("").map(char => char.charCodeAt(0)),
		...words(8, 4, 0, 0, 0xffff, count, ...Array.from({ length: count }, (_, k) => index(k))),
		...words(1, 4, 1, 0, 1, 8, 1, 6, 0, 1, 1, GLYPH_A),
		...words(records),
		...Array.from({ length: records }, (_, k) => [
			...tag(k)
				.split("")
				.map(char => char.charCodeAt(0)),
			...words(feature)
		]).flat(),
		...words(0, 0xffff, ...new Array<number>(0xffff).fill(0))
	])
}

// Lookup of `type` (4: LigatureSubst; 5, 6: SequenceContext, ChainedSequenceContext of `format` 1 or 2) with `count`
// distinct subtables sharing one Coverage of glyph "a", one ClassDef that gives every glyph class 0, and one set of
// 65535 entries. Every entry offset is 4, so each names the same entry inside the offsets: a ligature or rule of four
// glyphs (or classes) 4, which never matches.
function sharedSet(count: number, type: number, format = 1): number[] {
	const classDefs = format === 1 ? 0 : type === 5 ? 1 : 3
	const size = 8 + classDefs * 2
	const subtables = 6 + count * 2
	const coverage = subtables + count * size
	const classDef = coverage + 6
	const set = classDef + 4

	return [
		...words(type, 0, count, ...Array.from({ length: count }, (_, k) => subtables + k * size)),
		...Array.from({ length: count }, (_, k) => {
			const at = subtables + k * size

			return words(format, coverage - at, ...new Array<number>(classDefs).fill(classDef - at), 1, set - at)
		}).flat(),
		...words(1, 1, GLYPH_A, 2, 0, 0xffff, ...new Array<number>(0xffff).fill(4))
	]
}

// SequenceContext format 1 whose one rule matches "a" and lists 65535 nested lookup records, none for a matched glyph.
function manyRecords(): number[] {
	return [...words(5, 0, 1, 8, 1, 8, 1, 14, 1, 1, GLYPH_A, 1, 4, 1, 0xffff), ...Array.from({ length: 0xffff }, () => words(1, 0)).flat()]
}

// ReverseChainSingleSubst of "a" (to itself) after `backtrack` glyphs "a".
function longReverseChain(backtrack: number): number[] {
	const coverage = 12 + backtrack * 2

	return words(8, 0, 1, 8, 1, coverage, backtrack, ...new Array<number>(backtrack).fill(coverage), 0, 1, GLYPH_A, 1, 1, GLYPH_A)
}

// LigatureSubst of "a" whose set lists one ligature 30000 times: 64 components, 62 "a" and then glyph 0, so matching
// it steps over 62 glyphs of a run of "a" before it fails.
function deepLigature(): number[] {
	const count = 30000

	return [
		...words(4, 0, 1, 8, 1, 8, 1, 14, 1, 1, GLYPH_A),
		...words(count, ...new Array<number>(count).fill(2 + count * 2)),
		...words(GLYPH_A, 64, ...new Array<number>(62).fill(GLYPH_A), 0)
	]
}

// ChainedSequenceContext format 2 of "a" whose ClassDef has 1000 ranges of class 0 and whose one rule set lists one
// rule 25000 times: 64 backtrack, 64 input and 64 lookahead classes, all 0 but the last lookahead class 1.
function deepChainedClassRule(): number[] {
	const ranges = 1000
	const rules = 25000
	const classDef = 20
	const set = classDef + 4 + ranges * 6

	return [
		...words(6, 0, 1, 8),
		...words(2, 14, classDef, classDef, classDef, 1, set),
		...words(1, 1, GLYPH_A),
		...words(2, ranges, ...Array.from({ length: ranges }, (_, k) => [k, k, 0]).flat()),
		...words(rules, ...new Array<number>(rules).fill(2 + rules * 2)),
		...words(64, ...new Array<number>(64).fill(0), 64, ...new Array<number>(63).fill(0), 64, ...new Array<number>(63).fill(0), 1, 0)
	]
}

// MarkBasePos (4) or MarkMarkPos (6) lookup with `count` distinct subtables sharing a mark Coverage of every glyph but
// the last (whatever Caladea's own GSUB makes of the marks) and a base (or second mark) Coverage of the last glyph, so
// each finds the glyph the mark attaches to, misses it, and leaves the mark to the next subtable.
function markSubtables(type: 4 | 6, count: number): number[] {
	const subtables = 6 + count * 2
	const marks = subtables + count * 12

	return [
		...words(type, 0, count, ...Array.from({ length: count }, (_, k) => subtables + k * 12)),
		...Array.from({ length: count }, (_, k) => {
			const at = subtables + k * 12

			return words(1, marks - at, marks + 10 - at, 1, 0, 0)
		}).flat(),
		...words(2, 1, 0, GLYPH_LAST - 1, 0, 1, 1, GLYPH_LAST)
	]
}

// A GSUB whose ccmp feature runs `count` - 1 lookups at one contextual lookup of glyph "x" with 16000 nested records,
// each running the last lookup at it: a ligature of the one component "x", formed again and again at that glyph.
function repeatedOneComponentLigature(count: number): Uint8Array {
	const records = 16000
	const context = words(
		5,
		0,
		1,
		8,
		3,
		1,
		records,
		8 + records * 4,
		...new Array<number[]>(records).fill([0, count - 1]).flat(),
		1,
		1,
		GLYPH_X
	)
	const ligature = words(4, 0, 1, 8, 1, 8, 1, 14, 1, 1, GLYPH_X, 1, 4, GLYPH_X, 1)
	const gsub = aliasedGsub(count, [...context, ...ligature])
	const view = new DataView(gsub.buffer)
	const lookupList = 48 + count * 2

	view.setUint16(lookupList + 2 + (count - 1) * 2, 2 + count * 2 + context.length)

	return gsub
}

const DEVANAGARI = new Uint8Array(gunzipSync(readFileSync(new URL("noto/noto-sans-devanagari/NotoSansDevanagari-Regular.ttf.gz", ASSETS))))
const DEVANAGARI_SFNT = readSfnt(DEVANAGARI)

// A GSUB like gsubTable's with its one feature retagged (the tag sits at a fixed offset of that layout).
function retagged(gsub: Uint8Array, tag: string): Uint8Array {
	for (let k = 0; k < 4; k++) gsub[38 + k] = tag.charCodeAt(k)

	return gsub
}

// A GSUB (DFLT) whose 'ccmp' multiplies `glyph` by `first` and then by `second`, and whose 'pref' is one chained
// context lookup of 2047 format 3 subtables that cover `glyph` then never cover it again, so no pair of it matches
// and every check of a pair tries the whole lookup.
function prefGsub(glyph: number, first: number, second: number): Uint8Array {
	const subtables = 2047
	const subtablesAt = 6 + subtables * 2
	const coverage = subtablesAt + subtables * 14
	const others = Array.from({ length: 20001 }, (_, k) => k + 1).filter(id => id !== glyph)
	const pref = [
		...words(6, 0, subtables, ...Array.from({ length: subtables }, (_, k) => subtablesAt + k * 14)),
		...Array.from({ length: subtables }, (_, k) =>
			words(3, 0, 2, coverage - subtablesAt - k * 14, coverage + 6 - subtablesAt - k * 14, 0, 0)
		).flat(),
		...words(1, 1, glyph),
		...words(1, others.length, ...others)
	]
	const multiplying = (count: number): number[] => [...words(2, 0, 1, 8), ...multiply(glyph, count)()]
	const lookups = [multiplying(first), multiplying(second), pref]
	const offsets = lookups.reduce<number[]>((list, lookup, k) => [...list, (list[k] ?? 0) + lookup.length], [8])
	const tag = (value: string): number[] => value.split("").map(char => char.charCodeAt(0))

	return Uint8Array.from([
		...words(1, 0, 10, 32, 60),
		...words(1),
		...tag("DFLT"),
		...words(8, 4, 0, 0, 0xffff, 2, 0, 1),
		...words(2),
		...tag("ccmp"),
		...words(14),
		...tag("pref"),
		...words(22, 0, 2, 0, 1, 0, 1, 2),
		...words(3, ...offsets.slice(0, 3)),
		...lookups.flat()
	])
}

// Caladea with its GPOS replaced and a GDEF without glyph classes (so they follow the characters).
function withGpos(table: Uint8Array): Uint8Array {
	return withTable(withTable(CALADEA, "GPOS", table), "GDEF", Uint8Array.from(words(1, 0, 0, 0, 0, 0)))
}

// A GSUB with `count` script records, none of them a script the shaper asks for.
function manyScripts(count: number): Uint8Array {
	return Uint8Array.from([
		...words(1, 0, 14, 10, 12, 0, 0, count),
		...Array.from({ length: count }, () => [..."zzzz".split("").map(char => char.charCodeAt(0)), 0, 0]).flat()
	])
}

function shapeOne(face: ShapingFace, cp: number, rtl: boolean, language: string | undefined): ReturnType<ShapingFace["shape"]> {
	return face.shape({
		cps: Uint32Array.of(cp),
		clusters: Uint32Array.of(0),
		count: 1,
		before: [],
		after: [],
		script: scriptOf(cp),
		rtl,
		language
	})
}

// Letters of scripts the default shaper takes: Latin, Greek, Cyrillic, Armenian, Hebrew, Georgian, Ethiopic, Cherokee.
const SCRIPT_SAMPLES = [0x61, 0x3b1, 0x431, 0x561, 0x5d0, 0x10d0, 0x1200, 0x13a0]
const OPEN_TYPE_LANGUAGES = ["ja", "ko", "ar", "fa", "ur", "he", "hi", "mr", "ne", "bn", "pa", "gu", "ta", "te", "kn", "ml", "th"].concat([
	"hy",
	"ka",
	"am",
	"ru",
	"uk",
	"be",
	"bg",
	"sr",
	"mk",
	"kk",
	"ky",
	"zh-tw",
	"zh-hk",
	"zh"
])

function glyphCount(text: PdfShapedText): number {
	return text.runs.reduce((sum, run) => sum + run.glyphs.length, 0)
}

async function written(text: PdfShapedText): Promise<void> {
	const writer = await PdfWriter.create({ deflate: null })
	const page = writer.beginPage(200, 200)

	page.text(text.runs, { x: 10, y: 10, size: 12 })

	await writer.endPage(page)
	await writer.finish()
}

describe("PDF font limits", () => {
	it("keeps a font's multiplying substitutions that stay within the limits", async () => {
		const { fonts, shaped: result } = await shaped(
			withGsub(gsubTable(Array.from({ length: 12 }, () => [2, multiply(GLYPH_A, 2)] as const))),
			"a"
		)

		expect(glyphCount(result)).toBe(4096)
		expect(fonts.unshaped()).toBe(0)
		fonts.close()
	})

	it("draws a run unshaped, quickly, when a font's substitutions would multiply it past the length limit", async () => {
		const {
			fonts,
			shaped: result,
			ms
		} = await shaped(withGsub(gsubTable(Array.from({ length: 24 }, () => [2, multiply(GLYPH_A, 2)] as const))), "aaaaaaaaaa")

		expect(glyphCount(result)).toBe(10)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("draws a run unshaped when a font's contextual lookups recurse past the operations limit", async () => {
		const { fonts, shaped: result, ms } = await shaped(withGsub(gsubTable([[5, recurse(GLYPH_A, 4)]])), "aaaa")

		expect(glyphCount(result)).toBe(4)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("shapes the next run of the same font again after one went past the limits", async () => {
		// 4096 glyphs for each character: five go past the length limit's floor of 16384.
		const { fonts, shaped: long } = await shaped(
			withGsub(gsubTable(Array.from({ length: 12 }, () => [2, multiply(GLYPH_A, 2)] as const))),
			"aaaaa"
		)
		const short = fonts.shape("a", 0, 1, REQUEST, { level: 0, flags: 0 })

		expect(glyphCount(long)).toBe(5)
		expect(glyphCount(short)).toBe(4096)
		expect(fonts.unshaped()).toBe(1)
		fonts.close()
	})

	it("shapes quickly with a lookup whose aliased subtables cover every glyph id 65535 times over", async () => {
		const { fonts, shaped: result, ms } = await shaped(withGsub(aliasedGsub(1000, aliasedSubtables(1000))), "aaaa")

		expect(glyphCount(result)).toBe(4)
		expect(fonts.unshaped()).toBe(0)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("charges each subtable tried, so lookups with thousands of subtables stop at the operations limit", async () => {
		const { fonts, shaped: result, ms } = await shaped(withGsub(aliasedGsub(8000, distinctSubtables(8000))), "a".repeat(100))

		expect(glyphCount(result)).toBe(100)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("charges each subtable tried by a multiple substitution, so its lookups stop at the operations limit", async () => {
		const { fonts, shaped: result, ms } = await shaped(withGsub(aliasedGsub(8000, distinctSubtables(8000, 2))), "a".repeat(100))

		expect(glyphCount(result)).toBe(100)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("bounds the subtables one would-substitute check tries, with lookups of thousands of subtables", () => {
		const gsub = aliasedGsub(8000, distinctSubtables(8000))
		const table = new LayoutTable(new DataView(gsub.buffer), 0, 7, SFNT.numGlyphs)
		const lookups = Array.from({ length: 8000 }, (_, k) => k)
		const started = cpuMs()

		// An Indic run asks once per syllable and feature.
		for (let k = 0; k < 10; k++) expect(wouldSubstitute(table, lookups, [GLYPH_A])).toBe(false)

		expect(cpuMs() - started).toBeLessThan(budget(500))
	})

	const sets: readonly (readonly [string, number, number])[] = [
		["ligature set", 4, 1],
		["context rule set", 5, 1],
		["context class rule set", 5, 2],
		["chained context rule set", 6, 1],
		["chained context class rule set", 6, 2]
	]

	for (const [name, type, format] of sets) {
		it(`charges each entry tried of a ${name} of 65535 entries, so its lookups stop at the operations limit`, async () => {
			const { fonts, shaped: result, ms } = await shaped(withGsub(aliasedGsub(LISTED, sharedSet(32, type, format))), "a".repeat(100))

			expect(glyphCount(result)).toBe(100)
			expect(fonts.unshaped()).toBe(1)
			expect(ms).toBeLessThan(budget(500))
			fonts.close()
		})
	}

	for (const [name, type, format] of sets.filter(([, , format], k) => k === 0 || format === 2)) {
		it(`bounds the entries one would-substitute check tries, with a ${name} of 65535 entries`, () => {
			const gsub = aliasedGsub(1, sharedSet(2048, type, format))
			const table = new LayoutTable(new DataView(gsub.buffer), 0, 7, SFNT.numGlyphs)
			const started = cpuMs()

			for (let k = 0; k < 10; k++) expect(wouldSubstitute(table, [0], [GLYPH_A, GLYPH_A])).toBe(false)

			expect(cpuMs() - started).toBeLessThan(budget(500))
		})
	}

	it("charges the nested lookup records of a rule, so a rule of 65535 records stops at the operations limit", async () => {
		const { fonts, shaped: result, ms } = await shaped(withGsub(aliasedGsub(RECORDS_LISTED, manyRecords())), "a".repeat(100))

		expect(glyphCount(result)).toBe(100)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	const deep: readonly (readonly [string, Uint8Array, string])[] = [
		[
			"a ligature set whose entries skip a long run of default ignorables",
			aliasedGsub(LISTED, sharedSet(32, 4)),
			`a${"\u200b".repeat(100)}`
		],
		["a ligature set of thousands of 64-component ligatures", aliasedGsub(64, deepLigature()), "a".repeat(40)],
		["a chained class rule set of thousands of rules with 64-glyph contexts", aliasedGsub(64, deepChainedClassRule()), "a".repeat(40)]
	]

	for (const [name, gsub, text] of deep) {
		it(`charges each glyph matching steps over, so ${name} stops at the operations limit`, async () => {
			const { fonts, shaped: result, ms } = await shaped(withGsub(gsub), text)

			expect(glyphCount(result)).toBe(text.startsWith("a\u200b") ? 1 : text.length)
			expect(fonts.unshaped()).toBe(1)
			expect(ms).toBeLessThan(budget(500))
			fonts.close()
		})
	}

	const attachments: readonly (readonly [string, 4 | 6, string])[] = [
		["mark-to-base subtables that step back over a long run of marks", 4, `a${"\u0301".repeat(200)}`],
		["mark-to-mark subtables that step back over a long run of default ignorables", 6, `a\u0301${"\u200b".repeat(300)}\u0301`]
	]

	for (const [name, type, text] of attachments) {
		it(`charges each glyph a mark attachment steps over, so ${name} stop at the operations limit`, async () => {
			const { fonts, ms } = await shaped(withGpos(aliasedGsub(256, markSubtables(type, 8000), 0, "mark")), text)

			expect(fonts.unshaped()).toBe(1)
			expect(ms).toBeLessThan(budget(500))
			fonts.close()
		})
	}

	it("charges the marks a ligature tags after its last component, so a one-component ligature formed again and again stops at the operations limit", async () => {
		const marks = 500
		const text = `x${"a".repeat(marks)}`
		const font = withTable(
			withGsub(repeatedOneComponentLigature(Math.ceil(marks / 12) + 4)),
			"GDEF",
			Uint8Array.from(words(1, 0, 12, 0, 0, 0, 2, 1, GLYPH_A, GLYPH_A, 3))
		)
		const { fonts, shaped: result, ms } = await shaped(font, text)

		expect(glyphCount(result)).toBe(text.length)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("charges the Indic walk back from each ZWNJ, so a font that multiplies one ZWNJ into a whole syllable stops at the operations limit", async () => {
		const zwnj = DEVANAGARI_SFNT.glyphId(0x200c)
		const font = withTable(DEVANAGARI, "GSUB", gsubTable([[2, multiply(zwnj, 2)] as const, [2, multiply(zwnj, 8158)] as const]))
		const { fonts, ms } = await shaped(font, "\u0915\u200c\u094d\u0915")

		expect(zwnj).toBeGreaterThan(0)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(200))
		fonts.close()
	})

	it("charges the cluster merge of each moved left matra, so a font that multiplies a left matra into a whole syllable stops at the operations limit", async () => {
		const matra = DEVANAGARI_SFNT.glyphId(0x93f)
		const text = `\u0915\u094d\u0915\u093f${"\u0915".repeat(996)}`
		const font = withTable(
			DEVANAGARI,
			"GSUB",
			retagged(gsubTable([[2, multiply(matra, 4)] as const, [2, multiply(matra, 15734)] as const]), "nukt")
		)
		const { fonts, shaped: result, ms } = await shaped(font, text)

		expect(matra).toBeGreaterThan(0)
		expect(glyphCount(result)).toBe(text.length)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(200))
		fonts.close()
	})

	it("charges each pre-base-reordering check to the run, so a font that multiplies the glyphs after the base and never forms pref stops at the operations limit", async () => {
		const matra = DEVANAGARI_SFNT.glyphId(0x93e)
		const font = withTable(DEVANAGARI, "GSUB", prefGsub(matra, 2, 8159))
		const { fonts, ms } = await shaped(font, "\u0915\u093e")

		expect(matra).toBeGreaterThan(0)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(200))
		fonts.close()
	})

	it("charges the walk back from each halant after a left matra, so a face without a dotted circle whose font multiplies both stops at the operations limit", () => {
		const matra = DEVANAGARI_SFNT.glyphId(0x93f)
		const halant = DEVANAGARI_SFNT.glyphId(0x94d)
		const font = withTable(
			DEVANAGARI,
			"GSUB",
			gsubTable([
				[2, multiply(matra, 2)],
				[2, multiply(matra, 4075)],
				[2, multiply(halant, 2)],
				[2, multiply(halant, 4075)]
			])
		)

		// Without GPOS, whose mark attachment would stop the run on its own.
		font[directoryRecord(font, "GPOS")] = 0x58

		const sfnt = readSfnt(font)
		const glyphId = sfnt.glyphId.bind(sfnt)

		// Without a dotted circle the broken syllable keeps every halant with the left matras.
		sfnt.glyphId = cp => (cp === 0x25cc ? 0 : glyphId(cp))

		const started = cpuMs()
		const result = new ShapingFace(sfnt).shape({
			cps: Uint32Array.of(0x93f, 0x94d),
			clusters: Uint32Array.of(0, 1),
			count: 2,
			before: [],
			after: [],
			script: scriptOf(0x93f),
			rtl: false,
			language: undefined
		})

		expect(DEVANAGARI_SFNT.glyphId(0x25cc)).toBeGreaterThan(0)
		expect(matra * halant).toBeGreaterThan(0)
		expect(result.limited).toBe(true)
		expect(cpuMs() - started).toBeLessThan(budget(200))
	})

	it("counts each lookup of a would-substitute check as a try, with a feature of thousands of empty lookups", () => {
		const gsub = aliasedGsub(30000, words(1, 0, 0))
		const table = new LayoutTable(new DataView(gsub.buffer), 0, 7, SFNT.numGlyphs)
		const lookups = Array.from({ length: 30000 }, (_, k) => k)
		const started = cpuMs()

		// An Indic run asks once per syllable for the reph and pre-base forms: a few long paragraphs.
		for (let k = 0; k < 8000; k++) expect(wouldSubstitute(table, lookups, [GLYPH_A, GLYPH_A])).toBe(false)

		expect(cpuMs() - started).toBeLessThan(budget(500))
	})

	it("does not match a reverse chain whose context is longer than any real one", async () => {
		const { fonts, shaped: result, ms } = await shaped(withGsub(aliasedGsub(16, longReverseChain(30000))), "a".repeat(4000))

		expect(glyphCount(result)).toBe(4000)
		expect(fonts.unshaped()).toBe(0)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("charges each lookup run over the run, so thousands of lookups that never apply stop at the operations limit", async () => {
		const { fonts, shaped: first } = await shaped(withGsub(aliasedGsub(30000, words(1, 0, 0))), "a")
		const started = cpuMs()

		for (let k = 0; k < 200; k++) expect(glyphCount(fonts.shape("a", 0, 1, REQUEST, { level: 0, flags: 0 }))).toBe(1)

		expect(cpuMs() - started).toBeLessThan(budget(500))
		expect(glyphCount(first)).toBe(1)
		expect(fonts.unshaped()).toBe(201)
		fonts.close()
	})

	it("reads a table's script records once, however many plans the runs need", () => {
		const face = new ShapingFace(readSfnt(withGsub(manyScripts(0xffff))))
		const started = cpuMs()

		for (const cp of SCRIPT_SAMPLES) {
			for (const rtl of [false, true]) {
				for (const language of OPEN_TYPE_LANGUAGES) expect(shapeOne(face, cp, rtl, language).broken).toBe(false)
			}
		}

		expect(cpuMs() - started).toBeLessThan(budget(500))
	})

	it("builds one plan per OpenType language system, however many document languages name it", () => {
		const face = new ShapingFace(
			readSfnt(
				withGsub(
					repeatedFeatures(
						1,
						() => 0,
						() => "ccmp",
						1
					)
				)
			)
		)

		for (let k = 0; k < 300; k++) expect(shapeOne(face, 0x61, false, `x-${String(k)}`).broken).toBe(false)
	})

	it("stops reading feature lookups for plans past the table's allowance, drawing the face unshaped", () => {
		const face = new ShapingFace(
			readSfnt(
				withGsub(
					repeatedFeatures(
						1,
						() => 0,
						() => "ccmp",
						1
					)
				)
			)
		)
		const started = cpuMs()

		expect(shapeOne(face, 0x61, false, undefined).broken).toBe(false)

		for (const rtl of [false, true]) {
			for (const cp of [0x61, 0x3b1, 0x431]) for (const language of OPEN_TYPE_LANGUAGES) shapeOne(face, cp, rtl, language)
		}

		expect(shapeOne(face, 0x61, false, undefined).broken).toBe(true)
		expect(cpuMs() - started).toBeLessThan(budget(500))
	})

	it("bounds the subtables read over the table, with thousands of lookup tables that overlap", async () => {
		const { fonts, shaped: result, ms } = await shaped(withGsub(aliasedGsub(16000, overlappingLookups(16000), 2)), "a".repeat(100))

		expect(glyphCount(result)).toBe(100)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("reads a feature listed thousands of times once, with a language system that repeats it", async () => {
		const {
			fonts,
			shaped: result,
			ms
		} = await shaped(
			withGsub(
				repeatedFeatures(
					30000,
					() => 0,
					() => "ccmp",
					1
				)
			),
			"aaaa"
		)

		expect(glyphCount(result)).toBe(4)
		expect(fonts.unshaped()).toBe(0)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	it("draws a run unshaped, and counts it, when a language system's features name too many lookups", async () => {
		const count = 10000
		const tag = (k: number): string =>
			String.fromCharCode(0x61 + (k % 26), 0x61 + (Math.floor(k / 26) % 26), 0x61 + (Math.floor(k / 676) % 26), 0x7a)
		const { fonts, shaped: result, ms } = await shaped(withGsub(repeatedFeatures(count, k => k, tag, count)), "aaaa")

		expect(glyphCount(result)).toBe(4)
		expect(fonts.unshaped()).toBe(1)
		expect(ms).toBeLessThan(budget(500))
		fonts.close()
	})

	const malformed: readonly (readonly [string, (view: DataView) => void])[] = [
		["a ScriptList past the end of the font", view => view.setUint16(4, 0xfff0)],
		["a lookup past the end of the font", view => view.setUint16(view.getUint16(8) + 2, 0xfff0)]
	]

	for (const [name, mutate] of malformed) {
		it(`draws every run unshaped, and counts it, with a GSUB that has ${name}`, async () => {
			const table = gsubTable([[2, multiply(GLYPH_A, 2)]])

			mutate(new DataView(table.buffer))

			const { fonts, shaped: first } = await shaped(withGsub(table), "aa")
			const second = fonts.shape("a", 0, 1, REQUEST, { level: 0, flags: 0 })

			expect(glyphCount(first)).toBe(2)
			expect(glyphCount(second)).toBe(1)
			expect(first.runs[0]?.font.postScriptName).toMatch(/^Caladea/)
			expect(fonts.unshaped()).toBe(2)
			fonts.close()
		})
	}

	it("shapes with glyph classes from the characters when the GDEF GlyphClassDef is past the end of the font", async () => {
		const { fonts, shaped: result } = await shaped(withTable(CALADEA, "GDEF", Uint8Array.from(words(1, 0, 0xfff0, 0, 0, 0))), "office")

		expect(glyphCount(result)).toBeGreaterThan(0)
		expect(fonts.unshaped()).toBe(0)
		fonts.close()
	})

	it("shapes a long run with many default ignorables in linear time", async () => {
		const text = "a​".repeat(20000)
		const { fonts, shaped: result, ms } = await shaped(CALADEA, text)

		expect(glyphCount(result)).toBe(20000)
		expect(ms).toBeLessThan(budget(1000))
		fonts.close()
	})

	const unsubsettable: readonly (readonly [string, Uint8Array])[] = [
		["without loca", patched((view, record) => view.setUint8(record("loca"), 0x78))],
		["with a loca too short for its glyphs", patched((view, record) => view.setUint32(record("loca") + 12, 2))],
		["without glyf", patched((view, record) => view.setUint8(record("glyf"), 0x78))],
		["with a short head", patched((view, record) => view.setUint32(record("head") + 12, 40))]
	]

	for (const [name, bytes] of unsubsettable) {
		it(`draws with the substitute an embedded TrueType font ${name}`, async () => {
			const { fonts, shaped: result } = await shaped(bytes, "office")

			expect(result.runs[0]?.font.postScriptName).toMatch(/^Arimo/)
			await expect(written(result)).resolves.toBeUndefined()
			fonts.close()
		})
	}
})

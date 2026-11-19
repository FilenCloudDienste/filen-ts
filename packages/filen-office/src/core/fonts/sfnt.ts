import { FontError } from "./errors"
import type { VerticalMetrics } from "./metrics"

// A reader for the few TrueType/OpenType tables layout needs: head, hhea, maxp, OS/2, hmtx, cmap (formats 4
// and 12) and name. Every read is bounds-checked, so a hostile file fails with a FontError instead of
// reading garbage. WOFF/WOFF2 are refused: documents embed raw sfnt data, and the bundled web fonts ship
// with precomputed metrics.

const SFNT_TRUETYPE = 0x00010000
const SFNT_CFF = 0x4f54544f // "OTTO"
const SFNT_APPLE = 0x74727565 // "true"
const COLLECTION = 0x74746366 // "ttcf"
const WOFF = 0x774f4646 // "wOFF"
const WOFF2 = 0x774f4632 // "wOF2"

const TAG_HEAD = 0x68656164
const TAG_HHEA = 0x68686561
const TAG_MAXP = 0x6d617870
const TAG_OS2 = 0x4f532f32
const TAG_HMTX = 0x686d7478
const TAG_CMAP = 0x636d6170
const TAG_NAME = 0x6e616d65

const HEAD_MAGIC = 0x5f0f3cf5
const MAX_TABLES = 256
// Bounds on name-table work, whatever the table claims.
const MAX_NAME_BYTES = 1024
const MAX_NAME_RECORDS = 4096
const MAX_FAMILY_NAMES = 64
const MAX_TOTAL_NAME_BYTES = 64 * 1024

const NAME_FAMILY = 1
const NAME_SUBFAMILY = 2
const NAME_FULL = 4
const NAME_POSTSCRIPT = 6
const NAME_TYPOGRAPHIC_FAMILY = 16
const NAME_TYPOGRAPHIC_SUBFAMILY = 17
const WANTED_NAMES = new Set([NAME_FAMILY, NAME_SUBFAMILY, NAME_FULL, NAME_POSTSCRIPT, NAME_TYPOGRAPHIC_FAMILY, NAME_TYPOGRAPHIC_SUBFAMILY])
const FAMILY_NAMES = new Set([NAME_FAMILY, NAME_TYPOGRAPHIC_FAMILY])

// Mac OS Roman 0x80-0xFF (Unicode's ROMAN.TXT mapping): fonts whose only names are Macintosh records, PICT text.
export const MAC_ROMAN =
	"ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u00A0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ"

export interface SfntNames {
	readonly family: string | undefined
	readonly subfamily: string | undefined
	readonly fullName: string | undefined
	readonly postScriptName: string | undefined
	readonly typographicFamily: string | undefined
	readonly typographicSubfamily: string | undefined
}

// A table's byte range in the file.
export interface SfntTable {
	readonly offset: number
	readonly length: number
}

type Table = SfntTable

type CodePointLookup = (codePoint: number) => number

export class SfntFont {
	readonly unitsPerEm: number
	readonly numGlyphs: number
	readonly metrics: VerticalMetrics
	// usWeightClass, 1-1000.
	readonly weight: number
	readonly italic: boolean
	// OS/2 fsType: embedding permissions (0 when the font has no OS/2 table, which means installable).
	readonly fsType: number
	readonly xHeight: number | undefined
	readonly capHeight: number | undefined
	// CFF outlines ("OTTO") rather than TrueType glyf.
	readonly cff: boolean
	// The file the font was read from (a collection when faceIndex was given).
	readonly bytes: Uint8Array
	private readonly data: DataView
	private readonly tables: Map<number, Table>
	private readonly nameTable: Table | undefined
	private parsedNames: { names: SfntNames; familyNames: string[] } | null = null
	private readonly hmtxOffset: number
	private readonly numberOfHMetrics: number
	private readonly cmap: Table | undefined
	private lookup: CodePointLookup | null = null

	constructor(bytes: Uint8Array, faceIndex: number = 0) {
		const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		this.data = data
		this.bytes = bytes

		const base = sfntOffset(data, faceIndex)
		const signature = data.getUint32(base)

		this.cff = signature === SFNT_CFF

		const tables = readDirectory(data, base)

		this.tables = tables
		const head = required(tables, TAG_HEAD, 54, "head")
		const hhea = required(tables, TAG_HHEA, 36, "hhea")
		const maxp = required(tables, TAG_MAXP, 6, "maxp")
		const hmtx = required(tables, TAG_HMTX, 0, "hmtx")

		if (data.getUint32(head.offset + 12) !== HEAD_MAGIC) throw new FontError("corrupt", "Bad head table magic")

		const unitsPerEm = data.getUint16(head.offset + 18)

		if (unitsPerEm < 16 || unitsPerEm > 16384) throw new FontError("corrupt", `unitsPerEm ${unitsPerEm} is out of range`)

		this.unitsPerEm = unitsPerEm
		this.numGlyphs = data.getUint16(maxp.offset + 4)

		const numberOfHMetrics = data.getUint16(hhea.offset + 34)

		if (numberOfHMetrics === 0 || numberOfHMetrics > Math.max(1, this.numGlyphs) || numberOfHMetrics * 4 > hmtx.length) {
			throw new FontError("corrupt", "hmtx does not hold numberOfHMetrics entries")
		}

		this.hmtxOffset = hmtx.offset
		this.numberOfHMetrics = numberOfHMetrics

		const macStyle = data.getUint16(head.offset + 44)
		const hheaAscender = data.getInt16(hhea.offset + 4)
		const hheaDescender = data.getInt16(hhea.offset + 6)
		const hheaLineGap = data.getInt16(hhea.offset + 8)
		const os2 = tables.get(TAG_OS2)

		// Version 0 tables from before typo/win metrics existed stop at 68 bytes; hhea stands in for them.
		if (os2 !== undefined && os2.length >= 78) {
			const o = os2.offset
			const version = data.getUint16(o)
			const fsSelection = data.getUint16(o + 62)

			this.weight = normalizeWeight(data.getUint16(o + 4))
			this.italic = (fsSelection & 1) !== 0 || (macStyle & 2) !== 0
			this.fsType = data.getUint16(o + 8)
			this.metrics = {
				unitsPerEm,
				hheaAscender,
				hheaDescender,
				hheaLineGap,
				typoAscender: data.getInt16(o + 68),
				typoDescender: data.getInt16(o + 70),
				typoLineGap: data.getInt16(o + 72),
				winAscent: data.getUint16(o + 74),
				winDescent: data.getUint16(o + 76),
				useTypoMetrics: (fsSelection & 0x80) !== 0
			}

			const hasHeights = version >= 2 && os2.length >= 90

			this.xHeight = hasHeights ? data.getInt16(o + 86) : undefined
			this.capHeight = hasHeights ? data.getInt16(o + 88) : undefined
		} else {
			this.weight = (macStyle & 1) !== 0 ? 700 : 400
			this.italic = (macStyle & 2) !== 0
			this.fsType = 0
			this.metrics = {
				unitsPerEm,
				hheaAscender,
				hheaDescender,
				hheaLineGap,
				typoAscender: hheaAscender,
				typoDescender: hheaDescender,
				typoLineGap: hheaLineGap,
				winAscent: Math.max(0, hheaAscender),
				winDescent: Math.max(0, -hheaDescender),
				useTypoMetrics: false
			}
			this.xHeight = undefined
			this.capHeight = undefined
		}

		this.cmap = tables.get(TAG_CMAP)
		this.nameTable = tables.get(TAG_NAME)
	}

	// A table's byte range in `bytes`, by its tag ("glyf", "OS/2", "cvt "). Read-only access for writers
	// that copy or subset tables.
	table(tag: string): { readonly offset: number; readonly length: number } | undefined {
		return tag.length === 4 ? this.tables.get(tagValue(tag)) : undefined
	}

	// Parsed on first use: layout never needs them, and a hostile name table should cost nothing then.
	get names(): SfntNames {
		return this.readNames().names
	}

	// Every family name (IDs 1 and 16) in every language, so localized names in a document still match.
	get familyNames(): readonly string[] {
		return this.readNames().familyNames
	}

	private readNames(): { names: SfntNames; familyNames: string[] } {
		this.parsedNames ??= this.nameTable === undefined ? { names: NO_NAMES, familyNames: [] } : readNames(this.data, this.nameTable)

		return this.parsedNames
	}

	// Glyph id for a code point; 0 (.notdef) when the font does not map it.
	glyphId(codePoint: number): number {
		this.lookup ??= this.buildLookup()

		const glyph = this.lookup(codePoint)

		return glyph < this.numGlyphs ? glyph : 0
	}

	hasGlyph(codePoint: number): boolean {
		return this.glyphId(codePoint) !== 0
	}

	// Advance width of a glyph in font units.
	advance(glyphId: number): number {
		const index = Math.min(glyphId, this.numberOfHMetrics - 1)

		return this.data.getUint16(this.hmtxOffset + index * 4)
	}

	advanceOf(codePoint: number): number {
		return this.advance(this.glyphId(codePoint))
	}

	private buildLookup(): CodePointLookup {
		if (this.cmap === undefined) return noGlyph

		for (const subtable of cmapSubtables(this.data, this.cmap)) {
			const lookup =
				subtable.format === 12
					? format12(this.data, subtable.offset, subtable.end)
					: format4(this.data, subtable.offset, subtable.end)

			if (lookup !== null) return lookup
		}

		return noGlyph
	}
}

export function readSfnt(bytes: Uint8Array, faceIndex: number = 0): SfntFont {
	return new SfntFont(bytes, faceIndex)
}

// The sfnt version (0x00010000, "OTTO" or "true") and the table directory of a TrueType/OpenType file, by tag; reads
// the directory only (at most 12 + 16 × 256 bytes). Collections and WOFF are refused.
export function sfntDirectory(bytes: Uint8Array): { readonly flavor: number; readonly tables: ReadonlyMap<string, SfntTable> } {
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (data.byteLength >= 4 && data.getUint32(0) === COLLECTION) throw new FontError("unsupported", "Font collections are not read here")

	const base = sfntOffset(data, 0)
	const tables = new Map<string, SfntTable>()

	for (const [tag, table] of readDirectory(data, base)) tables.set(tagName(tag), table)

	return { flavor: data.getUint32(base), tables }
}

const NO_NAMES: SfntNames = {
	family: undefined,
	subfamily: undefined,
	fullName: undefined,
	postScriptName: undefined,
	typographicFamily: undefined,
	typographicSubfamily: undefined
}

function noGlyph(): number {
	return 0
}

function sfntOffset(data: DataView, faceIndex: number): number {
	if (data.byteLength < 12) throw new FontError("truncated", "Too short for a font")

	const signature = data.getUint32(0)

	if (signature === WOFF || signature === WOFF2) throw new FontError("unsupported", "WOFF data is not read here")

	if (signature === COLLECTION) {
		const count = data.getUint32(8)

		if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= count || 16 + faceIndex * 4 > data.byteLength) {
			throw new FontError("corrupt", `No face ${faceIndex} in the collection`)
		}

		const offset = data.getUint32(12 + faceIndex * 4)

		if (offset + 12 > data.byteLength) throw new FontError("truncated", "Collection face lies outside the file")

		return checkSignature(data, offset)
	}

	return checkSignature(data, 0)
}

function checkSignature(data: DataView, offset: number): number {
	const signature = data.getUint32(offset)

	if (signature !== SFNT_TRUETYPE && signature !== SFNT_CFF && signature !== SFNT_APPLE) {
		throw new FontError("notSfnt", "Not a TrueType or OpenType font")
	}

	return offset
}

function readDirectory(data: DataView, base: number): Map<number, Table> {
	const numTables = data.getUint16(base + 4)

	if (numTables > MAX_TABLES) throw new FontError("corrupt", `${numTables} tables`)
	if (base + 12 + numTables * 16 > data.byteLength) throw new FontError("truncated", "Table directory is cut off")

	const tables = new Map<number, Table>()

	for (let i = 0; i < numTables; i++) {
		const record = base + 12 + i * 16
		const tag = data.getUint32(record)
		const offset = data.getUint32(record + 8)
		const length = data.getUint32(record + 12)

		if (offset + length > data.byteLength) throw new FontError("truncated", `Table ${tagName(tag)} lies outside the file`)

		// Duplicate tags are invalid; the first one wins, as in most rasterizers.
		if (!tables.has(tag)) tables.set(tag, { offset, length })
	}

	return tables
}

function required(tables: Map<number, Table>, tag: number, minimum: number, name: string): Table {
	const table = tables.get(tag)

	if (table === undefined) throw new FontError("corrupt", `No ${name} table`)
	if (table.length < minimum) throw new FontError("truncated", `${name} table is too short`)

	return table
}

function tagValue(tag: string): number {
	return ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0
}

function tagName(tag: number): string {
	return String.fromCharCode((tag >>> 24) & 0xff, (tag >>> 16) & 0xff, (tag >>> 8) & 0xff, tag & 0xff)
}

// Some old fonts store weight classes 1-9 meaning 100-900.
export function normalizeWeight(value: number): number {
	if (value >= 1 && value <= 9) return value * 100
	if (value < 1 || value > 1000) return 400

	return value
}

// Preference among cmap subtables: full Unicode first, then BMP, then the symbol encoding Wingdings-style
// fonts use (code points F020-F0FF, exactly what documents store for them).
function subtableRank(platform: number, encoding: number, format: number): number {
	if (format === 12) {
		if (platform === 3 && encoding === 10) return 6
		if (platform === 0) return 5
	} else if (format === 4) {
		if (platform === 3 && encoding === 1) return 4
		if (platform === 0) return 3
		if (platform === 3 && encoding === 0) return 2
	}

	return 0
}

// A Unicode cmap subtable the readers here understand (format 4 or 12).
export interface CmapSubtable {
	readonly format: 4 | 12
	// Its range in the file.
	readonly offset: number
	readonly end: number
}

// The cmap's usable subtables, most preferred first (subtableRank).
export function cmapSubtables(data: DataView, cmap: SfntTable): readonly CmapSubtable[] {
	if (cmap.length < 4) return []

	const end = cmap.offset + cmap.length
	const count = data.getUint16(cmap.offset + 2)

	if (4 + count * 8 > cmap.length) return []

	const ranked: { rank: number; subtable: CmapSubtable }[] = []

	for (let i = 0; i < count; i++) {
		const record = cmap.offset + 4 + i * 8
		const offset = cmap.offset + data.getUint32(record + 4)

		if (offset + 4 > end) continue

		const format = data.getUint16(offset)
		const rank = subtableRank(data.getUint16(record), data.getUint16(record + 2), format)

		if (rank > 0 && (format === 4 || format === 12)) ranked.push({ rank, subtable: { format, offset, end } })
	}

	return ranked.sort((a, b) => b.rank - a.rank).map(({ subtable }) => subtable)
}

// The code points the best readable subtable maps to a glyph below `numGlyphs`, as [first, last] pairs (inclusive),
// ascending and merged. Format 4 is walked code point by code point (at most 65,535); format 12 by group.
export function cmapCoverage(data: DataView, cmap: SfntTable, numGlyphs: number): Uint32Array {
	for (const subtable of cmapSubtables(data, cmap)) {
		const runs = subtable.format === 12 ? format12Runs(data, subtable, numGlyphs) : format4Runs(data, subtable, numGlyphs)

		if (runs !== null) return runs
	}

	return new Uint32Array(0)
}

const MAX_CODE_POINT = 0x10ffff

// Appends [first, last] to `runs`, merging it into the previous run when they touch.
function pushRun(runs: number[], first: number, last: number): void {
	const previous = runs.length - 1

	if (previous > 0 && (runs[previous] ?? 0) + 1 >= first) runs[previous] = Math.max(runs[previous] ?? 0, last)
	else runs.push(first, last)
}

function format4Runs(data: DataView, subtable: CmapSubtable, numGlyphs: number): Uint32Array | null {
	const lookup = format4(data, subtable.offset, subtable.end)

	if (lookup === null) return null

	const segments = data.getUint16(subtable.offset + 6) >>> 1
	const ends = subtable.offset + 14
	const starts = ends + segments * 2 + 2
	const runs: number[] = []
	let previousEnd = -1

	for (let s = 0; s < segments; s++) {
		const last = Math.min(data.getUint16(ends + s * 2), 0xfffe)
		const first = Math.max(data.getUint16(starts + s * 2), previousEnd + 1)

		for (let codePoint = first; codePoint <= last; codePoint++) {
			const glyph = lookup(codePoint)

			if (glyph !== 0 && glyph < numGlyphs) pushRun(runs, codePoint, codePoint)
		}

		previousEnd = Math.max(previousEnd, last)
	}

	return Uint32Array.from(runs)
}

function format12Runs(data: DataView, subtable: CmapSubtable, numGlyphs: number): Uint32Array | null {
	if (format12(data, subtable.offset, subtable.end) === null) return null

	const count = data.getUint32(subtable.offset + 12)
	const runs: number[] = []

	for (let g = 0; g < count; g++) {
		const at = subtable.offset + 16 + g * 12
		const start = data.getUint32(at)
		const startGlyph = data.getUint32(at + 8)

		if (start > MAX_CODE_POINT || startGlyph >= numGlyphs) continue

		// .notdef is no glyph; ids past the font's are none either.
		const first = startGlyph === 0 ? start + 1 : start
		const last = Math.min(data.getUint32(at + 4), MAX_CODE_POINT, start + (numGlyphs - 1 - startGlyph))

		if (first <= last) pushRun(runs, first, last)
	}

	return Uint32Array.from(runs)
}

function format4(data: DataView, offset: number, end: number): CodePointLookup | null {
	if (offset + 14 > end) return null

	const segments = data.getUint16(offset + 6) >>> 1
	const ends = offset + 14
	const starts = ends + segments * 2 + 2
	const deltas = starts + segments * 2
	const rangeOffsets = deltas + segments * 2

	if (segments === 0 || rangeOffsets + segments * 2 > end) return null

	const endCodes = new Uint16Array(segments)

	for (let s = 0; s < segments; s++) {
		const code = data.getUint16(ends + s * 2)

		// Binary search needs ascending end codes.
		if (s > 0 && code < (endCodes[s - 1] ?? 0)) return null

		endCodes[s] = code
	}

	return (codePoint: number): number => {
		if (codePoint > 0xffff) return 0

		let low = 0
		let high = segments - 1

		while (low < high) {
			const middle = (low + high) >>> 1

			if ((endCodes[middle] ?? 0) < codePoint) low = middle + 1
			else high = middle
		}

		if ((endCodes[low] ?? 0) < codePoint) return 0

		const start = data.getUint16(starts + low * 2)

		if (codePoint < start) return 0

		const delta = data.getUint16(deltas + low * 2)
		const rangeOffsetAt = rangeOffsets + low * 2
		const rangeOffset = data.getUint16(rangeOffsetAt)

		if (rangeOffset === 0) return (codePoint + delta) & 0xffff

		const at = rangeOffsetAt + rangeOffset + (codePoint - start) * 2

		if (at + 2 > end) return 0

		const glyph = data.getUint16(at)

		return glyph === 0 ? 0 : (glyph + delta) & 0xffff
	}
}

function format12(data: DataView, offset: number, end: number): CodePointLookup | null {
	if (offset + 16 > end) return null

	const count = data.getUint32(offset + 12)

	if (count === 0 || count > (end - offset - 16) / 12) return null

	// start, end, start glyph per group, copied once so lookups are a binary search over a typed array.
	const groups = new Uint32Array(count * 3)

	for (let g = 0; g < count; g++) {
		const at = offset + 16 + g * 12
		const start = data.getUint32(at)
		const last = data.getUint32(at + 4)

		if (last < start || (g > 0 && start <= (groups[g * 3 - 2] ?? 0))) return null

		groups[g * 3] = start
		groups[g * 3 + 1] = last
		groups[g * 3 + 2] = data.getUint32(at + 8)
	}

	return (codePoint: number): number => {
		let low = 0
		let high = count - 1

		while (low < high) {
			const middle = (low + high) >>> 1

			if ((groups[middle * 3 + 1] ?? 0) < codePoint) low = middle + 1
			else high = middle
		}

		const start = groups[low * 3] ?? 0

		if (codePoint < start || codePoint > (groups[low * 3 + 1] ?? 0)) return 0

		return (groups[low * 3 + 2] ?? 0) + (codePoint - start)
	}
}

// Every wanted name record the table holds, decoded, with how much each platform's record is preferred: Windows
// Unicode (US English first), then Unicode, then Mac Roman. Bounded however many records or bytes the table claims.
function scanNames(
	data: DataView,
	table: Table,
	wanted: ReadonlySet<number>,
	visit: (nameId: number, rank: number, value: string) => void
): void {
	if (table.length < 6) return

	const count = Math.min(data.getUint16(table.offset + 2), MAX_NAME_RECORDS)
	const storage = table.offset + data.getUint16(table.offset + 4)
	const end = table.offset + table.length
	let decoded = 0

	if (6 + count * 12 > table.length) return

	for (let i = 0; i < count && decoded < MAX_TOTAL_NAME_BYTES; i++) {
		const record = table.offset + 6 + i * 12
		const nameId = data.getUint16(record + 6)

		if (!wanted.has(nameId)) continue

		const platform = data.getUint16(record)
		const encoding = data.getUint16(record + 2)
		const language = data.getUint16(record + 4)
		const length = Math.min(data.getUint16(record + 8), MAX_NAME_BYTES)
		const start = storage + data.getUint16(record + 10)

		if (start + length > end) continue

		decoded += length

		let value: string
		let rank: number

		// Encoding 0 (symbol fonts) is UTF-16 too.
		if (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10)) {
			value = utf16(data, start, length)
			rank = language === 0x0409 ? 4 : 3
		} else if (platform === 0) {
			value = utf16(data, start, length)
			rank = 2
		} else if (platform === 1 && encoding === 0) {
			value = macRoman(data, start, length)
			rank = language === 0 ? 1 : 0
		} else {
			continue
		}

		if (value.length > 0) visit(nameId, rank, value)
	}
}

// The preferred value of each wanted name ID the table holds (`table` is a range of `data`).
export function readNameValues(data: DataView, table: SfntTable, wanted: ReadonlySet<number>): ReadonlyMap<number, string> {
	const found = new Map<number, { rank: number; value: string }>()

	scanNames(data, table, wanted, (nameId, rank, value) => {
		const current = found.get(nameId)

		if (current === undefined || rank > current.rank) found.set(nameId, { rank, value })
	})

	return new Map([...found].map(([nameId, { value }]) => [nameId, value]))
}

function readNames(data: DataView, table: Table): { names: SfntNames; familyNames: string[] } {
	const familyNames = new Set<string>()

	scanNames(data, table, FAMILY_NAMES, (_nameId, _rank, value) => {
		if (familyNames.size < MAX_FAMILY_NAMES) familyNames.add(value)
	})

	const found = readNameValues(data, table, WANTED_NAMES)

	return {
		names: {
			family: found.get(NAME_FAMILY),
			subfamily: found.get(NAME_SUBFAMILY),
			fullName: found.get(NAME_FULL),
			postScriptName: found.get(NAME_POSTSCRIPT),
			typographicFamily: found.get(NAME_TYPOGRAPHIC_FAMILY),
			typographicSubfamily: found.get(NAME_TYPOGRAPHIC_SUBFAMILY)
		},
		familyNames: [...familyNames]
	}
}

function utf16(data: DataView, start: number, length: number): string {
	let out = ""

	for (let k = 0; k + 1 < length; k += 2) out += String.fromCharCode(data.getUint16(start + k))

	return out
}

function macRoman(data: DataView, start: number, length: number): string {
	let out = ""

	for (let k = 0; k < length; k++) {
		const byte = data.getUint8(start + k)

		out += byte < 0x80 ? String.fromCharCode(byte) : (MAC_ROMAN[byte - 0x80] ?? "�")
	}

	return out
}

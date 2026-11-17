import { FontError } from "./errors"
import { cmapCoverage, normalizeWeight, readNameValues, sfntDirectory, type SfntTable } from "./sfnt"
import { fontContainer, readWoff2Tables, readWoffTables, type FontContainer, type FontTableSet } from "./woff"

// What a font file says about itself, for a viewer: its names, design facts, variation axes and the code points it
// draws. Read from the few tables that hold them, never the outlines or hmtx, so a font's info costs a few hundred
// KB however large its glyph data is.

// The tables readFontInfo reads.
export const FONT_INFO_TABLES: ReadonlySet<string> = new Set(["head", "maxp", "OS/2", "name", "cmap", "fvar"])

// Name IDs shown: copyright to license URL (0–14), typographic family and subfamily (16, 17), sample text (19).
export const FONT_INFO_NAME_IDS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19])

const HEAD_MAGIC = 0x5f0f3cf5
const SFNT_CFF = 0x4f54544f
const MAX_AXES = 64

export type FontOutlines = "trueType" | "cff" | "cff2" | "bitmap"

export interface FontAxis {
	readonly tag: string
	readonly min: number
	readonly default: number
	readonly max: number
	// Its name (name ID axisNameID), when the name table holds one.
	readonly name: string | undefined
	// Flagged hidden from user interfaces.
	readonly hidden: boolean
}

export interface FontName {
	readonly id: number
	readonly value: string
}

export interface FontInfo {
	readonly container: FontContainer
	readonly outlines: FontOutlines
	readonly glyphCount: number
	readonly unitsPerEm: number
	// usWeightClass, 1–1000 (400 without an OS/2 table).
	readonly weight: number
	readonly italic: boolean
	// OS/2 fsType: embedding permissions; 0 when the font has no OS/2 table.
	readonly fsType: number
	// The wanted names it holds, by ascending ID.
	readonly names: readonly FontName[]
	readonly axes: readonly FontAxis[]
	// The code points it draws, as [first, last] pairs (inclusive), ascending.
	readonly codePoints: Uint32Array
	readonly codePointCount: number
}

// The wanted tables of a TrueType/OpenType file, as copies of only their bytes (what crosses to a worker).
export function sfntInfoTables(bytes: Uint8Array): FontTableSet {
	const { flavor, tables } = sfntDirectory(bytes)
	const wanted = new Map<string, Uint8Array>()

	for (const [tag, table] of tables) {
		if (FONT_INFO_TABLES.has(tag)) wanted.set(tag, bytes.slice(table.offset, table.offset + table.length))
	}

	return { container: "sfnt", flavor, tags: [...tables.keys()], tables: wanted }
}

// The wanted tables of any supported font file.
export async function fontInfoTables(bytes: Uint8Array): Promise<FontTableSet> {
	switch (fontContainer(bytes)) {
		case "sfnt":
			return sfntInfoTables(bytes)
		case "woff":
			return readWoffTables(bytes, FONT_INFO_TABLES)
		case "woff2":
			return await readWoff2Tables(bytes, FONT_INFO_TABLES)
		case null:
			throw new FontError("notSfnt", "Not a TrueType, OpenType or WOFF font")
	}
}

function view(table: Uint8Array): DataView {
	return new DataView(table.buffer, table.byteOffset, table.byteLength)
}

function whole(table: Uint8Array): SfntTable {
	return { offset: 0, length: table.byteLength }
}

function requiredTable(set: FontTableSet, tag: string, minimum: number): Uint8Array {
	const table = set.tables.get(tag)

	if (table === undefined) throw new FontError("corrupt", `No ${tag} table`)
	if (table.length < minimum) throw new FontError("truncated", `${tag} table is too short`)

	return table
}

function outlinesOf(set: FontTableSet): FontOutlines {
	if (set.tags.includes("CFF2")) return "cff2"
	if (set.flavor === SFNT_CFF || set.tags.includes("CFF ")) return "cff"
	if (set.tags.includes("glyf")) return "trueType"

	return "bitmap"
}

function fixed(data: DataView, offset: number): number {
	return data.getInt32(offset) / 65536
}

function readAxes(fvar: Uint8Array | undefined, names: (id: number) => string | undefined): FontAxis[] {
	if (fvar === undefined || fvar.length < 16) return []

	const data = view(fvar)
	const axesOffset = data.getUint16(4)
	const count = Math.min(data.getUint16(8), MAX_AXES)
	const size = data.getUint16(10)

	if (size < 20) return []

	const axes: FontAxis[] = []

	for (let i = 0; i < count; i++) {
		const at = axesOffset + i * size

		if (at + 20 > fvar.length) break

		const min = fixed(data, at + 4)
		const value = fixed(data, at + 8)
		const max = fixed(data, at + 12)

		// An axis whose range does not hold its default is malformed.
		if (!(min <= value && value <= max)) continue

		axes.push({
			tag: String.fromCharCode(data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3)),
			min,
			default: value,
			max,
			name: names(data.getUint16(at + 18)),
			hidden: (data.getUint16(at + 16) & 1) !== 0
		})
	}

	return axes
}

function countCodePoints(runs: Uint32Array): number {
	let count = 0

	for (let i = 0; i + 1 < runs.length; i += 2) count += (runs[i + 1] ?? 0) - (runs[i] ?? 0) + 1

	return count
}

// Reads a font's info from its tables (sfntInfoTables / fontInfoTables). head and maxp are required.
export function readFontInfo(set: FontTableSet): FontInfo {
	const head = view(requiredTable(set, "head", 54))
	const maxp = view(requiredTable(set, "maxp", 6))

	if (head.getUint32(12) !== HEAD_MAGIC) throw new FontError("corrupt", "Bad head table magic")

	const unitsPerEm = head.getUint16(18)
	const macStyle = head.getUint16(44)
	const glyphCount = maxp.getUint16(4)
	const os2 = set.tables.get("OS/2")
	const os2View = os2 !== undefined && os2.length >= 64 ? view(os2) : null
	const name = set.tables.get("name")
	const allNames = new Set([...FONT_INFO_NAME_IDS])
	const fvar = set.tables.get("fvar")

	// fvar axis names live in the name table at IDs 256 and up.
	if (fvar !== undefined && fvar.length >= 16) {
		const data = view(fvar)
		const axesOffset = data.getUint16(4)
		const size = data.getUint16(10)

		for (let i = 0; i < Math.min(data.getUint16(8), MAX_AXES) && size >= 20 && axesOffset + i * size + 20 <= fvar.length; i++) {
			allNames.add(data.getUint16(axesOffset + i * size + 18))
		}
	}

	const values = name === undefined ? new Map<number, string>() : readNameValues(view(name), whole(name), allNames)
	const cmap = set.tables.get("cmap")
	const codePoints = cmap === undefined ? new Uint32Array(0) : cmapCoverage(view(cmap), whole(cmap), glyphCount)

	return {
		container: set.container,
		outlines: outlinesOf(set),
		glyphCount,
		unitsPerEm,
		weight: os2View === null ? ((macStyle & 1) !== 0 ? 700 : 400) : normalizeWeight(os2View.getUint16(4)),
		italic: (os2View !== null && (os2View.getUint16(62) & 1) !== 0) || (macStyle & 2) !== 0,
		fsType: os2View === null ? 0 : os2View.getUint16(8),
		names: [...FONT_INFO_NAME_IDS].flatMap(id => {
			const value = values.get(id)

			return value === undefined ? [] : [{ id, value }]
		}),
		axes: readAxes(fvar, id => values.get(id)),
		codePoints,
		codePointCount: countCodePoints(codePoints)
	}
}

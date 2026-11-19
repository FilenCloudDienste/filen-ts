// OpenType layout common tables (OpenType 1.9 "OpenType Layout common table formats"): script and feature
// selection, lookup headers, Coverage and ClassDef, plus GDEF glyph classes. Reads go through a DataView;
// a malformed table throws a RangeError, which the shaper catches (the run is then drawn unshaped).

export const LookupFlag = {
	RIGHT_TO_LEFT: 0x0001,
	IGNORE_BASE_GLYPHS: 0x0002,
	IGNORE_LIGATURES: 0x0004,
	IGNORE_MARKS: 0x0008,
	USE_MARK_FILTERING_SET: 0x0010,
	MARK_ATTACHMENT_TYPE: 0xff00
} as const

export const GlyphClass = { UNKNOWN: 0, BASE: 1, LIGATURE: 2, MARK: 3, COMPONENT: 4 } as const

export interface Lookup {
	// Of the lookup table.
	readonly offset: number
	readonly type: number
	readonly flag: number
	readonly markFilteringSet: number
	// Subtable offsets, extension subtables already resolved, each once.
	readonly subtables: readonly number[]
}

const DEFAULT_LANGUAGE = "dflt"
// Work a lookup's first-glyph digest may take (one unit per subtable, Coverage glyph or range, and 32 glyphs of a
// range or of the bit set) per glyph of the font, past a floor; a lookup that needs more gets no digest and is searched instead.
const DIGEST_WORK_PER_GLYPH = 8
const DIGEST_WORK_MIN = 4096
// Work all digests of one table may take together, so lookups that each stay under their own cap cannot add up;
// past it, lookups get no digest and are searched (charged to the shaping budget).
const DIGEST_TABLE_WORK_PER_GLYPH = 128
const DIGEST_TABLE_WORK_MIN = 1 << 20
// Bytes from the LookupList in which every lookup's subtable offsets lie (Offset16 lookup tables, each a 6-byte
// header, up to 65535 Offset16 subtable offsets and a mark filtering set), so lookups that do not overlap cannot
// list more subtables than half of it.
const LOOKUP_SPAN = 0xffff + 6 + 0xffff * 2 + 2
// Lookup indices a language system's features may name together, each feature table read once per tag; far past
// any real font, and a table that goes past it fails the plan (the face is drawn unshaped and counted).
const FEATURE_LOOKUPS_MAX = 1 << 18
// Language system records, feature indices and lookup indices all plans of one table may read together, so plans
// that each stay under FEATURE_LOOKUPS_MAX cannot add up; past it the plan fails as above. A real font's plan reads
// a few thousand.
const FEATURE_TABLE_WORK = 1 << 22

export function tagAt(view: DataView, offset: number): string {
	return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
}

// Coverage index of `glyph`, or -1.
export function coverageIndex(view: DataView, offset: number, glyph: number): number {
	const format = view.getUint16(offset)

	if (format === 1) {
		let low = 0
		let high = view.getUint16(offset + 2) - 1

		while (low <= high) {
			const middle = (low + high) >>> 1
			const value = view.getUint16(offset + 4 + middle * 2)

			if (value === glyph) return middle
			if (value < glyph) low = middle + 1
			else high = middle - 1
		}

		return -1
	}

	if (format === 2) {
		let low = 0
		let high = view.getUint16(offset + 2) - 1

		while (low <= high) {
			const middle = (low + high) >>> 1
			const record = offset + 4 + middle * 6
			const start = view.getUint16(record)

			if (glyph < start) high = middle - 1
			else if (glyph > view.getUint16(record + 2)) low = middle + 1
			else return view.getUint16(record + 4) + glyph - start
		}
	}

	return -1
}

export function classOf(view: DataView, offset: number, glyph: number): number {
	const format = view.getUint16(offset)

	if (format === 1) {
		const start = view.getUint16(offset + 2)
		const count = view.getUint16(offset + 4)

		return glyph >= start && glyph < start + count ? view.getUint16(offset + 6 + (glyph - start) * 2) : 0
	}

	if (format === 2) {
		let low = 0
		let high = view.getUint16(offset + 2) - 1

		while (low <= high) {
			const middle = (low + high) >>> 1
			const record = offset + 4 + middle * 6

			if (glyph < view.getUint16(record)) high = middle - 1
			else if (glyph > view.getUint16(record + 2)) low = middle + 1
			else return view.getUint16(record + 4)
		}
	}

	return 0
}

// GSUB or GPOS header. `extensionType` is the lookup type that wraps others (GSUB 7, GPOS 9).
export class LayoutTable {
	readonly view: DataView
	private readonly scriptList: number
	private readonly featureList: number
	private readonly lookupList: number
	private readonly extensionType: number
	private readonly numGlyphs: number
	// Parsed lookups and their digests by lookup table offset, so lookup indices that share a table share the work.
	private readonly lookups = new Map<number, Lookup>()
	private readonly digests = new Map<number, Uint32Array | null>()
	private scratch: Uint32Array | null = null
	// Script table offsets by tag (the last record of a tag wins), read once.
	private scripts: Map<string, number> | null = null
	// Subtable offsets lookup() may still read, and digest and feature work still allowed, over the table's life.
	private subtablesLeft: number
	private digestWorkLeft: number
	private featureWorkLeft = FEATURE_TABLE_WORK

	constructor(view: DataView, offset: number, extensionType: number, numGlyphs: number) {
		this.view = view
		this.extensionType = extensionType
		this.numGlyphs = numGlyphs

		const major = view.getUint16(offset)

		if (major !== 1) throw new RangeError("Unsupported layout table version")

		this.scriptList = offset + view.getUint16(offset + 4)
		this.featureList = offset + view.getUint16(offset + 6)
		this.lookupList = offset + view.getUint16(offset + 8)
		this.subtablesLeft = Math.max(0, Math.min(view.byteLength - this.lookupList, LOOKUP_SPAN)) >>> 1
		this.digestWorkLeft = DIGEST_TABLE_WORK_MIN + numGlyphs * DIGEST_TABLE_WORK_PER_GLYPH
	}

	// The first script tag the table has, of `tags` in preference order, else DFLT, else none.
	scriptOffset(tags: readonly string[]): { readonly tag: string; readonly offset: number } | undefined {
		const view = this.view
		let found = this.scripts

		if (found === null) {
			const count = view.getUint16(this.scriptList)

			found = new Map()

			for (let i = 0; i < count; i++) {
				const record = this.scriptList + 2 + i * 6

				found.set(tagAt(view, record), this.scriptList + view.getUint16(record + 4))
			}

			this.scripts = found
		}

		for (const tag of [...tags, "DFLT", "dflt", "latn"]) {
			const offset = found.get(tag)

			if (offset !== undefined) return { tag, offset }
		}

		return undefined
	}

	// Lookup indices per feature tag for a script and language system, each list ascending.
	featureLookups(scriptTags: readonly string[], language: string | undefined): Map<string, number[]> {
		const out = new Map<string, number[]>()
		const script = this.scriptOffset(scriptTags)

		if (script === undefined) return out

		const view = this.view
		let langSys = view.getUint16(script.offset) === 0 ? 0 : script.offset + view.getUint16(script.offset)
		const langCount = view.getUint16(script.offset + 2)

		if (language !== undefined && language !== DEFAULT_LANGUAGE) {
			this.chargeFeatureWork(langCount)

			for (let i = 0; i < langCount; i++) {
				const record = script.offset + 4 + i * 6

				if (tagAt(view, record) === language) {
					langSys = script.offset + view.getUint16(record + 4)
					break
				}
			}
		}

		if (langSys === 0) return out

		const required = view.getUint16(langSys + 2)
		const featureCount = view.getUint16(langSys + 4)
		const indices: number[] = []

		this.chargeFeatureWork(featureCount)

		if (required !== 0xffff) indices.push(required)

		for (let i = 0; i < featureCount; i++) indices.push(view.getUint16(langSys + 6 + i * 2))

		const totalFeatures = view.getUint16(this.featureList)
		const totalLookups = this.lookupCount
		const takenIndices = new Set<number>()
		// Feature table offsets already read, per tag.
		const takenTables = new Map<string, Set<number>>()
		let left = FEATURE_LOOKUPS_MAX

		for (const index of indices) {
			if (index >= totalFeatures || takenIndices.has(index)) continue

			takenIndices.add(index)

			const record = this.featureList + 2 + index * 6
			const tag = tagAt(view, record)
			const feature = this.featureList + view.getUint16(record + 4)
			let tables = takenTables.get(tag)

			if (tables === undefined) {
				tables = new Set()
				takenTables.set(tag, tables)
			} else if (tables.has(feature)) continue

			tables.add(feature)

			const lookupCount = view.getUint16(feature + 2)

			left -= lookupCount

			if (left < 0) throw new RangeError("Too many feature lookups")

			this.chargeFeatureWork(lookupCount)

			let list = out.get(tag)

			if (list === undefined) {
				list = []
				out.set(tag, list)
			}

			for (let k = 0; k < lookupCount; k++) {
				const lookup = view.getUint16(feature + 4 + k * 2)

				// lookup() skips an index the table does not have.
				if (lookup < totalLookups) list.push(lookup)
			}
		}

		for (const list of out.values()) {
			list.sort((a, b) => a - b)

			let used = 0

			for (const lookup of list) if (used === 0 || list[used - 1] !== lookup) list[used++] = lookup

			list.length = used
		}

		return out
	}

	private chargeFeatureWork(units: number): void {
		this.featureWorkLeft -= units

		if (this.featureWorkLeft < 0) throw new RangeError("Too many feature lookups")
	}

	get lookupCount(): number {
		return this.view.getUint16(this.lookupList)
	}

	// The glyphs a lookup can start at, as a bit set over the font's glyph ids, or null (search its coverage).
	digest(index: number): Uint32Array | null {
		const lookup = this.lookup(index)

		if (lookup === undefined) return null

		let digest = this.digests.get(lookup.offset)

		if (digest !== undefined) return digest

		digest = lookup.type === 0 ? null : this.firstGlyphs(lookup)
		this.digests.set(lookup.offset, digest)

		return digest
	}

	private firstGlyphs(lookup: Lookup): Uint32Array | null {
		const gsub = this.extensionType === 7
		const words = (this.numGlyphs + 31) >>> 5

		if (lookup.subtables.length === 0) return new Uint32Array(0)

		const allowed = Math.min(DIGEST_WORK_MIN + this.numGlyphs * DIGEST_WORK_PER_GLYPH, this.digestWorkLeft)
		// Clearing the bit set costs a unit per word, as filling a range does.
		let work = allowed - words

		if (work < 0) return null

		if (this.scratch === null || this.scratch.length < words) this.scratch = new Uint32Array(words)

		const bits = this.scratch.subarray(0, words).fill(0)

		for (const subtable of lookup.subtables) {
			const coverage = firstCoverage(this.view, lookup.type, subtable, gsub)

			if (coverage < 0) {
				this.digestWorkLeft -= allowed - work + 1

				return null
			}

			work = addCoverage(this.view, coverage, bits, this.numGlyphs, work - 1)

			if (work < 0) {
				// The work spent before the Coverage ran out or proved unsorted is not known; charge it all.
				this.digestWorkLeft -= allowed

				return null
			}
		}

		this.digestWorkLeft -= allowed - work

		let used = words

		while (used > 0 && bits[used - 1] === 0) used--

		return bits.slice(0, used)
	}

	lookup(index: number): Lookup | undefined {
		if (index >= this.lookupCount) return undefined

		const view = this.view
		const offset = this.lookupList + view.getUint16(this.lookupList + 2 + index * 2)
		let lookup = this.lookups.get(offset)

		if (lookup !== undefined) return lookup

		const declared = view.getUint16(offset)
		let type = declared
		const flag = view.getUint16(offset + 2)
		const count = view.getUint16(offset + 4)

		// Past what lookups that do not overlap could list, a lookup is skipped (as one the table does not have).
		if (count > this.subtablesLeft) return undefined

		this.subtablesLeft -= count

		const subtables: number[] = []
		const seen = new Set<number>()

		for (let i = 0; i < count; i++) {
			let subtable = offset + view.getUint16(offset + 6 + i * 2)

			if (declared === this.extensionType) {
				// Every extension subtable of a lookup wraps the same type.
				const wrapped = view.getUint16(subtable + 2)

				subtable += view.getUint32(subtable + 4)

				if (subtables.length === 0 && type === declared) type = wrapped
				else if (wrapped !== type) continue
			}

			// A subtable listed again cannot apply where it did not the first time.
			if (seen.has(subtable)) continue

			seen.add(subtable)
			subtables.push(subtable)
		}

		if (type === this.extensionType) type = 0

		lookup = {
			offset,
			type,
			flag,
			markFilteringSet: flag & LookupFlag.USE_MARK_FILTERING_SET ? view.getUint16(offset + 6 + count * 2) : 0,
			subtables
		}
		this.lookups.set(offset, lookup)

		return lookup
	}
}

// The glyphs a lookup can start at (the union of its subtables' first coverage), as a bit set, so most glyphs
// are rejected without a coverage search. Null when a subtable's first glyph is not given by a coverage table.
function firstCoverage(view: DataView, type: number, offset: number, gsub: boolean): number {
	const context = gsub ? type === 5 || type === 6 : type === 7 || type === 8

	if (!context) return offset + view.getUint16(offset + 2)

	const format = view.getUint16(offset)

	if (format !== 3) return offset + view.getUint16(offset + 2)

	const chained = gsub ? type === 6 : type === 8

	if (!chained) return view.getUint16(offset + 2) === 0 ? -1 : offset + view.getUint16(offset + 6)

	const backtrack = view.getUint16(offset + 2)
	const inputCountAt = offset + 4 + backtrack * 2

	return view.getUint16(inputCountAt) === 0 ? -1 : offset + view.getUint16(inputCountAt + 2)
}

// Adds a Coverage table's glyphs below `numGlyphs` to `bits`. Returns the work left, or -1 when it runs out or the
// table is not in ascending order (which its binary search needs, so a digest of it would not match the search).
function addCoverage(view: DataView, offset: number, bits: Uint32Array, numGlyphs: number, work: number): number {
	const format = view.getUint16(offset)
	const count = view.getUint16(offset + 2)
	let previous = -1

	if (format === 1) {
		if (count > work) return -1

		for (let i = 0; i < count; i++) {
			const glyph = view.getUint16(offset + 4 + i * 2)

			if (glyph <= previous) return -1

			previous = glyph

			if (glyph < numGlyphs) bits[glyph >>> 5] = (bits[glyph >>> 5] ?? 0) | (1 << (glyph & 31))
		}

		return work - count
	}

	if (format !== 2) return work

	for (let i = 0; i < count; i++) {
		const record = offset + 4 + i * 6
		const first = view.getUint16(record)
		const end = view.getUint16(record + 2)

		if (first <= previous || end < first) return -1

		previous = end

		const last = Math.min(end, numGlyphs - 1)

		work -= 1 + (first <= last ? (last >>> 5) - (first >>> 5) + 1 : 0)

		if (work < 0) return -1
		if (first <= last) setRange(bits, first, last)
	}

	return work
}

// Sets bits first..last, a word at a time.
function setRange(bits: Uint32Array, first: number, last: number): void {
	const firstWord = first >>> 5
	const lastWord = last >>> 5
	const head = 0xffffffff << (first & 31)
	const tail = 0xffffffff >>> (31 - (last & 31))

	if (firstWord === lastWord) {
		bits[firstWord] = (bits[firstWord] ?? 0) | (head & tail)

		return
	}

	bits[firstWord] = (bits[firstWord] ?? 0) | head
	bits.fill(0xffffffff, firstWord + 1, lastWord)
	bits[lastWord] = (bits[lastWord] ?? 0) | tail
}

// GDEF glyph classes, mark attachment classes and mark glyph sets, expanded per glyph on first use. A class
// definition that reaches past the font is dropped then, as if the GDEF had none.
export class GlyphDefinitions {
	private readonly view: DataView | null
	private glyphClassDef: number
	private markClassDef: number
	private readonly markSets: number
	private classes: Uint8Array | null = null
	private markClasses: Uint8Array | null = null
	private readonly numGlyphs: number

	constructor(view: DataView | null, offset: number, numGlyphs: number) {
		this.numGlyphs = numGlyphs

		if (view === null) {
			this.view = null
			this.glyphClassDef = 0
			this.markClassDef = 0
			this.markSets = 0

			return
		}

		this.view = view

		const minor = view.getUint16(offset + 2)

		this.glyphClassDef = view.getUint16(offset + 4) === 0 ? 0 : offset + view.getUint16(offset + 4)
		this.markClassDef = view.getUint16(offset + 10) === 0 ? 0 : offset + view.getUint16(offset + 10)
		this.markSets = minor >= 2 && view.getUint16(offset + 12) !== 0 ? offset + view.getUint16(offset + 12) : 0
	}

	get hasClasses(): boolean {
		return this.glyphClassDef !== 0
	}

	glyphClass(glyph: number): number {
		if (this.view === null || this.glyphClassDef === 0) return GlyphClass.UNKNOWN

		this.classes ??= this.expand(this.glyphClassDef)

		if (this.classes === null) {
			this.glyphClassDef = 0

			return GlyphClass.UNKNOWN
		}

		return this.classes[glyph] ?? 0
	}

	markClass(glyph: number): number {
		if (this.view === null || this.markClassDef === 0) return 0

		this.markClasses ??= this.expand(this.markClassDef)

		if (this.markClasses === null) {
			this.markClassDef = 0

			return 0
		}

		return this.markClasses[glyph] ?? 0
	}

	inMarkSet(set: number, glyph: number): boolean {
		const view = this.view

		if (view === null || this.markSets === 0 || set >= view.getUint16(this.markSets + 2)) return false

		return coverageIndex(view, this.markSets + view.getUint32(this.markSets + 4 + set * 4), glyph) >= 0
	}

	// The class of every glyph, or null when the ClassDef reaches past the font.
	private expand(offset: number): Uint8Array | null {
		const out = new Uint8Array(this.numGlyphs)
		const view = this.view

		if (view === null) return out

		try {
			const format = view.getUint16(offset)

			if (format === 1) {
				const start = view.getUint16(offset + 2)
				const count = view.getUint16(offset + 4)

				for (let i = 0; i < count && start + i < out.length; i++) out[start + i] = view.getUint16(offset + 6 + i * 2)
			} else if (format === 2) {
				const count = view.getUint16(offset + 2)
				// Ranges are ascending; one that overlaps the ranges before it fills only past them, so the fills
				// together stay within the glyph count.
				let filled = 0

				for (let i = 0; i < count; i++) {
					const record = offset + 4 + i * 6
					const end = Math.min(out.length, view.getUint16(record + 2) + 1)
					const start = Math.max(filled, view.getUint16(record))

					if (start < end) {
						out.fill(view.getUint16(record + 4), start, end)
						filled = end
					}
				}
			}
		} catch (error) {
			if (error instanceof RangeError) return null

			throw error
		}

		return out
	}
}

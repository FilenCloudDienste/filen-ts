import type { GlyphBuffer } from "./buffer"
import { GlyphClass, LookupFlag, classOf, coverageIndex, type GlyphDefinitions, type LayoutTable, type Lookup } from "./otl"
import { isDefaultIgnorable } from "./unicode"

// Lookup application shared by GSUB and GPOS (OpenType 1.9, "OpenType Layout common table formats": lookup
// flags, contextual and chained contextual subtables). Glyph skipping follows the lookup flag and mark
// filtering set; default-ignorable characters (ZWJ unless the feature handles it itself) are skipped while
// matching context, ZWNJ never is.

// Nested lookups beyond this depth are not run. Every lookup application is charged to the run's operations
// budget (GlyphBuffer.limit), which ends the run's shaping when spent.
const MAX_NESTING = 16
export const MAX_CONTEXT = 64
// Trying a lookup at a position costs one operation, and one more per this many subtables tried past the first; the
// same holds for the ligatures or rules of one set and the nested lookup records of one rule.
export const SUBTABLES_PER_OP = 32
// Running a lookup over the run costs one operation, and one more per this many glyphs it scans.
const POSITIONS_PER_OP = 32
// Matching costs one operation per this many glyphs it steps to or over, so one try's work is bounded however many
// glyphs it skips or a context lists.
const VISITS_PER_OP = 64

export const ZWNJ = 0x200c
export const ZWJ = 0x200d

export interface LookupSettings {
	// Feature mask the lookup applies under.
	readonly mask: number
	// Matching stays inside one syllable (Indic and other per-syllable features).
	readonly perSyllable: boolean
	// ZWJ is skipped while matching (false where the feature itself handles ZWJ).
	readonly autoZwj: boolean
}

export abstract class LookupApplier {
	readonly buffer: GlyphBuffer
	readonly table: LayoutTable
	readonly gdef: GlyphDefinitions
	readonly view: DataView
	protected lookup!: Lookup
	protected settings!: LookupSettings
	protected nesting = 0
	// Glyphs stepped to or over since the last operation charged for them.
	private visits = 0

	constructor(buffer: GlyphBuffer, table: LayoutTable, gdef: GlyphDefinitions) {
		this.buffer = buffer
		this.table = table
		this.gdef = gdef
		this.view = table.view
	}

	applyLookup(index: number, settings: LookupSettings): void {
		// Charged before anything is read, so a plan of thousands of lookups that never apply stops at the budget.
		this.buffer.spend(1 + Math.floor(this.buffer.length / POSITIONS_PER_OP))
		this.visits = 0

		const lookup = this.table.lookup(index)

		if (lookup === undefined || lookup.type === 0) return

		this.settings = settings

		const firstGlyphs = this.table.digest(index)

		if (this.isReverse(lookup)) {
			for (let i = this.buffer.length - 1; i >= 0; i--) {
				this.lookup = lookup

				const glyph = this.buffer.glyph[i] ?? 0

				if (firstGlyphs !== null && ((firstGlyphs[glyph >>> 5] ?? 0) & (1 << (glyph & 31))) === 0) continue
				if (this.eligible(i)) this.applyAt(lookup, i)
			}

			return
		}

		this.lookup = lookup

		if (this.applyPass(lookup, firstGlyphs)) return

		const digest = firstGlyphs
		let i = 0

		while (i < this.buffer.length) {
			this.lookup = lookup

			const glyph = this.buffer.glyph[i] ?? 0
			const covered = digest === null || ((digest[glyph >>> 5] ?? 0) & (1 << (glyph & 31))) !== 0
			const next = covered && this.eligible(i) ? this.applyAt(lookup, i) : -1

			i = next < 0 ? i + 1 : Math.max(next, i + 1)
		}
	}

	protected abstract isReverse(lookup: Lookup): boolean

	// Applies a whole forward lookup in one pass of its own, where the type allows it; false: not handled.
	protected applyPass(_lookup: Lookup, _digest: Uint32Array | null): boolean {
		return false
	}

	// Applies the lookup's first matching subtable at `i`. Returns the index to continue at, or -1 when nothing
	// applied.
	protected abstract applySubtable(type: number, offset: number, i: number): number

	protected applyAt(lookup: Lookup, i: number): number {
		const subtables = lookup.subtables

		this.buffer.spend(1)

		for (let k = 0; k < subtables.length; k++) {
			if (k > 0 && k % SUBTABLES_PER_OP === 0) this.buffer.spend(1)

			const next = this.applySubtable(lookup.type, subtables[k] ?? 0, i)

			if (next >= 0) return next
		}

		return -1
	}

	protected eligible(i: number): boolean {
		return (
			((this.buffer.mask[i] ?? 0) & this.settings.mask) !== 0 &&
			!this.ignoredByFlag(i, this.lookup.flag, this.lookup.markFilteringSet)
		)
	}

	ignoredByFlag(i: number, flag: number, filterSet: number): boolean {
		const glyphClass = this.buffer.glyphClass[i] ?? 0

		if (glyphClass === GlyphClass.MARK) {
			if (flag & LookupFlag.IGNORE_MARKS) return true

			const glyph = this.buffer.glyph[i] ?? 0

			if (flag & LookupFlag.USE_MARK_FILTERING_SET) return !this.gdef.inMarkSet(filterSet, glyph)

			const type = (flag & LookupFlag.MARK_ATTACHMENT_TYPE) >>> 8

			return type !== 0 && this.gdef.markClass(glyph) !== type
		}

		if (glyphClass === GlyphClass.BASE) return (flag & LookupFlag.IGNORE_BASE_GLYPHS) !== 0
		if (glyphClass === GlyphClass.LIGATURE) return (flag & LookupFlag.IGNORE_LIGATURES) !== 0

		return false
	}

	// Whether matching may step over glyph `k`: skipped by the lookup flag, or a default ignorable.
	protected skippable(k: number): boolean {
		if (this.ignoredByFlag(k, this.lookup.flag, this.lookup.markFilteringSet)) return true

		const cp = this.buffer.cp[k] ?? 0

		if (cp === ZWNJ || !isDefaultIgnorable(cp)) return false

		return this.settings.autoZwj || cp !== ZWJ
	}

	// The next glyph after (dir 1) or before (dir -1) `from` that matching considers, or -1.
	step(from: number, dir: 1 | -1, limitToSyllable: boolean = this.settings.perSyllable): number {
		const buffer = this.buffer
		const syllable = buffer.syllable[from] ?? 0
		let found = -1
		let k = from + dir

		for (; k >= 0 && k < buffer.length; k += dir) {
			if (limitToSyllable && (buffer.syllable[k] ?? 0) !== syllable) break
			if (!this.skippable(k)) {
				found = k
				break
			}
		}

		this.visit((k - from) * dir)

		return found
	}

	// Charges `count` glyphs stepped to or over, an operation per VISITS_PER_OP.
	protected visit(count: number): void {
		const visits = this.visits + count

		if (visits < VISITS_PER_OP) {
			this.visits = visits

			return
		}

		this.visits = visits % VISITS_PER_OP
		this.buffer.spend(Math.floor(visits / VISITS_PER_OP))
	}

	// Matches `count` further input glyphs after `i` (the first is covered by the caller) with `test`, filling
	// `positions` (positions[0] = i). Input glyphs must carry the lookup mask unless `context`.
	protected matchInput(
		i: number,
		count: number,
		test: (glyph: number, index: number) => boolean,
		positions: number[],
		context: boolean
	): boolean {
		positions.length = 0
		positions.push(i)

		let k = i

		for (let n = 1; n < count; n++) {
			k = this.step(k, 1)

			if (k < 0) return false

			const glyph = this.buffer.glyph[k] ?? 0

			if (!test(glyph, n)) return false
			if (!context && ((this.buffer.mask[k] ?? 0) & this.settings.mask) === 0) return false

			positions.push(k)
		}

		return true
	}

	protected matchBacktrack(i: number, count: number, test: (glyph: number, index: number) => boolean): boolean {
		let k = i

		for (let n = 0; n < count; n++) {
			k = this.step(k, -1)

			if (k < 0 || !test(this.buffer.glyph[k] ?? 0, n)) return false
		}

		return true
	}

	protected matchLookahead(last: number, count: number, test: (glyph: number, index: number) => boolean): boolean {
		let k = last

		for (let n = 0; n < count; n++) {
			k = this.step(k, 1)

			if (k < 0 || !test(this.buffer.glyph[k] ?? 0, n)) return false
		}

		return true
	}

	// Runs nested lookups on matched positions (SequenceLookupRecords). Returns the index after the input.
	protected applyNested(positions: number[], records: number, recordCount: number): number {
		const view = this.view
		const lookup = this.lookup
		const settings = this.settings
		const startLength = this.buffer.length
		let end = (positions[positions.length - 1] ?? 0) + 1

		if (this.nesting >= MAX_NESTING) return end

		// Restored on every exit: a run that throws past the shaping limits mid-lookup must not leave the face's
		// applier deeper (or on the nested lookup) for its later runs.
		this.nesting++

		try {
			for (let r = 0; r < recordCount; r++) {
				if (r > 0 && r % SUBTABLES_PER_OP === 0) this.buffer.spend(1)

				const sequenceIndex = view.getUint16(records + r * 4)
				const lookupIndex = view.getUint16(records + r * 4 + 2)
				const at = positions[sequenceIndex]
				const nested = this.table.lookup(lookupIndex)

				if (at === undefined || nested === undefined || nested.type === 0 || at >= this.buffer.length) continue

				const before = this.buffer.length

				this.lookup = nested
				this.applyAt(nested, at)
				this.lookup = lookup
				this.settings = settings

				const delta = this.buffer.length - before

				if (delta !== 0) {
					// Positions after the changed glyph move with it (as HarfBuzz does).
					for (let p = sequenceIndex + 1; p < positions.length; p++) positions[p] = (positions[p] ?? 0) + delta

					if (delta < 0) {
						for (let p = sequenceIndex + 1; p < positions.length; p++) positions[p] = Math.max(positions[p] ?? 0, at + 1)
					}
				}
			}
		} finally {
			this.nesting--
			this.lookup = lookup
			this.settings = settings
		}

		end += this.buffer.length - startLength

		return Math.min(end, this.buffer.length)
	}

	// Formats 1-3 of SequenceContext (GSUB 5 / GPOS 7) and ChainedSequenceContext (GSUB 6 / GPOS 8).
	protected applyContext(offset: number, i: number, chained: boolean): number {
		const view = this.view
		const format = view.getUint16(offset)
		const glyph = this.buffer.glyph[i] ?? 0
		const positions: number[] = []

		if (format === 3) return chained ? this.chainFormat3(offset, i, positions) : this.contextFormat3(offset, i, positions)

		const coverage = offset + view.getUint16(offset + 2)
		const covered = coverageIndex(view, coverage, glyph)

		if (covered < 0) return -1

		if (format === 1) {
			const setCount = view.getUint16(offset + 4)

			if (covered >= setCount) return -1

			const setOffset = view.getUint16(offset + 6 + covered * 2)

			if (setOffset === 0) return -1

			const set = offset + setOffset
			const ruleCount = view.getUint16(set)

			for (let r = 0; r < ruleCount; r++) {
				if (r > 0 && r % SUBTABLES_PER_OP === 0) this.buffer.spend(1)

				const rule = set + view.getUint16(set + 2 + r * 2)
				const next = chained
					? this.chainRule(rule, i, positions, glyphTest, glyphTest, glyphTest)
					: this.contextRule(rule, i, positions, glyphTest)

				if (next >= 0) return next
			}

			return -1
		}

		if (format !== 2) return -1

		if (!chained) {
			const classDef = offset + view.getUint16(offset + 4)
			const setCount = view.getUint16(offset + 6)
			const cls = classOf(view, classDef, glyph)

			if (cls >= setCount) return -1

			const setOffset = view.getUint16(offset + 8 + cls * 2)

			if (setOffset === 0) return -1

			const set = offset + setOffset
			const ruleCount = view.getUint16(set)
			const test = classTest(view, classDef)

			for (let r = 0; r < ruleCount; r++) {
				if (r > 0 && r % SUBTABLES_PER_OP === 0) this.buffer.spend(1)

				const next = this.contextRule(set + view.getUint16(set + 2 + r * 2), i, positions, test)

				if (next >= 0) return next
			}

			return -1
		}

		const backtrackDef = offset + view.getUint16(offset + 4)
		const inputDef = offset + view.getUint16(offset + 6)
		const lookaheadDef = offset + view.getUint16(offset + 8)
		const setCount = view.getUint16(offset + 10)
		const cls = classOf(view, inputDef, glyph)

		if (cls >= setCount) return -1

		const setOffset = view.getUint16(offset + 12 + cls * 2)

		if (setOffset === 0) return -1

		const set = offset + setOffset
		const ruleCount = view.getUint16(set)
		const backtrack = classTest(view, backtrackDef)
		const input = classTest(view, inputDef)
		const lookahead = classTest(view, lookaheadDef)

		for (let r = 0; r < ruleCount; r++) {
			if (r > 0 && r % SUBTABLES_PER_OP === 0) this.buffer.spend(1)

			const next = this.chainRule(set + view.getUint16(set + 2 + r * 2), i, positions, backtrack, input, lookahead)

			if (next >= 0) return next
		}

		return -1
	}

	private contextRule(rule: number, i: number, positions: number[], test: ValueTest): number {
		const view = this.view
		const glyphCount = view.getUint16(rule)
		const recordCount = view.getUint16(rule + 2)

		if (glyphCount === 0 || glyphCount > MAX_CONTEXT) return -1

		const inputAt = rule + 4

		if (!this.matchInput(i, glyphCount, (glyph, n) => test(glyph, view.getUint16(inputAt + (n - 1) * 2)), positions, true)) return -1

		return this.applyNested(positions, inputAt + (glyphCount - 1) * 2, recordCount)
	}

	private chainRule(
		rule: number,
		i: number,
		positions: number[],
		backtrackTest: ValueTest,
		inputTest: ValueTest,
		lookaheadTest: ValueTest
	): number {
		const view = this.view
		const backtrackCount = view.getUint16(rule)
		const backtrackAt = rule + 2
		const inputCountAt = backtrackAt + backtrackCount * 2
		const inputCount = view.getUint16(inputCountAt)
		const inputAt = inputCountAt + 2
		const lookaheadCountAt = inputAt + Math.max(0, inputCount - 1) * 2
		const lookaheadCount = view.getUint16(lookaheadCountAt)
		const lookaheadAt = lookaheadCountAt + 2
		const recordCountAt = lookaheadAt + lookaheadCount * 2
		const recordCount = view.getUint16(recordCountAt)

		if (inputCount === 0 || inputCount + backtrackCount + lookaheadCount > MAX_CONTEXT * 3) return -1

		if (!this.matchInput(i, inputCount, (glyph, n) => inputTest(glyph, view.getUint16(inputAt + (n - 1) * 2)), positions, true))
			return -1
		if (!this.matchBacktrack(i, backtrackCount, (glyph, n) => backtrackTest(glyph, view.getUint16(backtrackAt + n * 2)))) return -1
		if (
			!this.matchLookahead(positions[positions.length - 1] ?? i, lookaheadCount, (glyph, n) =>
				lookaheadTest(glyph, view.getUint16(lookaheadAt + n * 2))
			)
		) {
			return -1
		}

		return this.applyNested(positions, recordCountAt + 2, recordCount)
	}

	private contextFormat3(offset: number, i: number, positions: number[]): number {
		const view = this.view
		const glyphCount = view.getUint16(offset + 2)
		const recordCount = view.getUint16(offset + 4)
		const coverages = offset + 6

		if (glyphCount === 0 || glyphCount > MAX_CONTEXT) return -1
		if (coverageIndex(view, offset + view.getUint16(coverages), this.buffer.glyph[i] ?? 0) < 0) return -1

		const test = (glyph: number, n: number): boolean => coverageIndex(view, offset + view.getUint16(coverages + n * 2), glyph) >= 0

		if (!this.matchInput(i, glyphCount, test, positions, true)) return -1

		return this.applyNested(positions, coverages + glyphCount * 2, recordCount)
	}

	private chainFormat3(offset: number, i: number, positions: number[]): number {
		const view = this.view
		const backtrackCount = view.getUint16(offset + 2)
		const backtrackAt = offset + 4
		const inputCountAt = backtrackAt + backtrackCount * 2
		const inputCount = view.getUint16(inputCountAt)
		const inputAt = inputCountAt + 2
		const lookaheadCountAt = inputAt + inputCount * 2
		const lookaheadCount = view.getUint16(lookaheadCountAt)
		const lookaheadAt = lookaheadCountAt + 2
		const recordCountAt = lookaheadAt + lookaheadCount * 2
		const recordCount = view.getUint16(recordCountAt)

		if (inputCount === 0 || inputCount + backtrackCount + lookaheadCount > MAX_CONTEXT * 3) return -1

		const covers = (at: number) => (glyph: number, n: number) => coverageIndex(view, offset + view.getUint16(at + n * 2), glyph) >= 0

		if (coverageIndex(view, offset + view.getUint16(inputAt), this.buffer.glyph[i] ?? 0) < 0) return -1
		if (!this.matchInput(i, inputCount, covers(inputAt), positions, true)) return -1
		if (!this.matchBacktrack(i, backtrackCount, covers(backtrackAt))) return -1
		if (!this.matchLookahead(positions[positions.length - 1] ?? i, lookaheadCount, covers(lookaheadAt))) return -1

		return this.applyNested(positions, recordCountAt + 2, recordCount)
	}
}

type ValueTest = (glyph: number, value: number) => boolean

function glyphTest(glyph: number, value: number): boolean {
	return glyph === value
}

function classTest(view: DataView, classDef: number): ValueTest {
	return (glyph, value) => classOf(view, classDef, glyph) === value
}

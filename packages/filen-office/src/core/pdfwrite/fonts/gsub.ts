import { LookupApplier, MAX_CONTEXT, SUBTABLES_PER_OP } from "./apply"
import { GlyphBuffer, GlyphFlag, ShapingLimitError } from "./buffer"
import { GlyphClass, classOf, coverageIndex, type LayoutTable, type Lookup } from "./otl"

// GSUB lookup types 1-8 (OpenType 1.9 "GSUB — Glyph Substitution Table"). Type 3 (alternates) takes the
// first alternate, as features that pick one without user choice do; type 7 is resolved by LayoutTable.

export class SubstitutionApplier extends LookupApplier {
	private nextLigId = 1
	private readonly scratch: number[] = []

	protected isReverse(lookup: Lookup): boolean {
		return lookup.type === 8
	}

	// A multiple substitution lookup copies the run into a second buffer as it goes (as HarfBuzz's output
	// buffer), so each sequence costs its own length instead of moving every glyph after it.
	protected override applyPass(lookup: Lookup, digest: Uint32Array | null): boolean {
		if (lookup.type !== 2) return false

		const source = this.buffer
		const out = (this.out ??= new GlyphBuffer())
		const view = this.view
		const n = source.length

		out.length = 0
		out.ensure(n)

		for (let i = 0; i < n; i++) {
			const glyph = source.glyph[i] ?? 0
			const sequence =
				(digest === null || ((digest[glyph >>> 5] ?? 0) & (1 << (glyph & 31))) !== 0) && this.eligible(i)
					? this.sequenceOf(lookup, i)
					: -1

			if (sequence < 0) {
				out.appendFrom(source, i)
				continue
			}

			const count = view.getUint16(sequence)

			// An empty sequence deletes the glyph; its text stays with the cluster.
			if (count === 0) continue
			if (out.length + count > source.maxLength) throw new ShapingLimitError()

			const ligId = source.ligId[i] ?? 0

			for (let k = 0; k < count; k++) {
				const at = out.length
				const next = view.getUint16(sequence + 2 + k * 2)
				const glyphClass = this.gdef.glyphClass(next)

				out.appendFrom(source, i)
				out.glyph[at] = next
				out.flags[at] = (out.flags[at] ?? 0) | GlyphFlag.SUBSTITUTED | GlyphFlag.MULTIPLIED

				if (glyphClass !== GlyphClass.UNKNOWN) out.glyphClass[at] = glyphClass
				// Components of a decomposed glyph keep apart for mark attachment (as HarfBuzz numbers them).
				if (ligId === 0) out.ligComp[at] = Math.min(15, k + 1)
			}
		}

		source.swap(out)

		return true
	}

	private out: GlyphBuffer | null = null

	// The sequence a multiple substitution lookup puts at `i`, or -1; charged as one lookup application (as applyAt).
	private sequenceOf(lookup: Lookup, i: number): number {
		const view = this.view
		const glyph = this.buffer.glyph[i] ?? 0

		const subtables = lookup.subtables

		this.buffer.spend(1)

		for (let k = 0; k < subtables.length; k++) {
			if (k > 0 && k % SUBTABLES_PER_OP === 0) this.buffer.spend(1)

			const offset = subtables[k] ?? 0
			const covered = coverageIndex(view, offset + view.getUint16(offset + 2), glyph)

			if (covered >= 0 && view.getUint16(offset) === 1 && covered < view.getUint16(offset + 4)) {
				return offset + view.getUint16(offset + 6 + covered * 2)
			}
		}

		return -1
	}

	protected applySubtable(type: number, offset: number, i: number): number {
		switch (type) {
			case 1:
				return this.single(offset, i)
			case 2:
				return this.multiple(offset, i)
			case 3:
				return this.alternate(offset, i)
			case 4:
				return this.ligature(offset, i)
			case 5:
				return this.applyContext(offset, i, false)
			case 6:
				return this.applyContext(offset, i, true)
			case 8:
				return this.reverseChain(offset, i)
			default:
				return -1
		}
	}

	private setGlyph(i: number, glyph: number, flags: number = GlyphFlag.SUBSTITUTED): void {
		const buffer = this.buffer

		buffer.glyph[i] = glyph
		buffer.flags[i] = (buffer.flags[i] ?? 0) | flags

		const glyphClass = this.gdef.glyphClass(glyph)

		if (glyphClass !== GlyphClass.UNKNOWN) buffer.glyphClass[i] = glyphClass
	}

	private single(offset: number, i: number): number {
		const view = this.view
		const glyph = this.buffer.glyph[i] ?? 0
		const covered = coverageIndex(view, offset + view.getUint16(offset + 2), glyph)

		if (covered < 0) return -1

		const format = view.getUint16(offset)

		if (format === 1) {
			this.setGlyph(i, (glyph + view.getInt16(offset + 4)) & 0xffff)
		} else if (format === 2) {
			if (covered >= view.getUint16(offset + 4)) return -1

			this.setGlyph(i, view.getUint16(offset + 6 + covered * 2))
		} else {
			return -1
		}

		return i + 1
	}

	private multiple(offset: number, i: number): number {
		const view = this.view
		const covered = coverageIndex(view, offset + view.getUint16(offset + 2), this.buffer.glyph[i] ?? 0)

		if (covered < 0 || view.getUint16(offset) !== 1 || covered >= view.getUint16(offset + 4)) return -1

		const sequence = offset + view.getUint16(offset + 6 + covered * 2)
		const count = view.getUint16(sequence)
		const glyphs = this.scratch

		glyphs.length = 0

		for (let k = 0; k < count; k++) glyphs.push(view.getUint16(sequence + 2 + k * 2))

		// An empty sequence deletes the glyph; its text stays with the cluster.
		if (count === 0) {
			this.buffer.remove(i)

			return i
		}

		const buffer = this.buffer
		const ligId = buffer.ligId[i] ?? 0

		buffer.replace(i, 1, glyphs)

		for (let k = 0; k < count; k++) {
			this.setGlyph(i + k, glyphs[k] ?? 0, GlyphFlag.SUBSTITUTED | GlyphFlag.MULTIPLIED)
			// Components of a decomposed glyph keep apart for mark attachment (as HarfBuzz numbers them).
			if (ligId === 0) buffer.ligComp[i + k] = Math.min(15, k + 1)
		}

		return i + count
	}

	private alternate(offset: number, i: number): number {
		const view = this.view
		const covered = coverageIndex(view, offset + view.getUint16(offset + 2), this.buffer.glyph[i] ?? 0)

		if (covered < 0 || covered >= view.getUint16(offset + 4)) return -1

		const set = offset + view.getUint16(offset + 6 + covered * 2)

		if (view.getUint16(set) === 0) return -1

		this.setGlyph(i, view.getUint16(set + 2))

		return i + 1
	}

	private ligature(offset: number, i: number): number {
		const view = this.view
		const buffer = this.buffer
		const covered = coverageIndex(view, offset + view.getUint16(offset + 2), buffer.glyph[i] ?? 0)

		if (covered < 0 || covered >= view.getUint16(offset + 4)) return -1

		const set = offset + view.getUint16(offset + 6 + covered * 2)
		const count = view.getUint16(set)
		const positions: number[] = []

		for (let l = 0; l < count; l++) {
			if (l > 0 && l % SUBTABLES_PER_OP === 0) buffer.spend(1)

			const ligature = set + view.getUint16(set + 2 + l * 2)
			const components = view.getUint16(ligature + 2)

			// Longer than any context is never matched (as HarfBuzz's match_input).
			if (components === 0 || components > MAX_CONTEXT) continue
			if (!this.matchInput(i, components, (glyph, n) => glyph === view.getUint16(ligature + 4 + (n - 1) * 2), positions, false))
				continue

			this.formLigature(view.getUint16(ligature), positions)

			return i + 1
		}

		return -1
	}

	// Replaces the matched components with the ligature glyph. Marks skipped between and after them stay,
	// tagged with the component they follow, so mark-to-ligature positioning can find it.
	private formLigature(ligatureGlyph: number, positions: readonly number[]): void {
		const buffer = this.buffer
		const count = positions.length
		const first = positions[0] ?? 0
		const last = positions[count - 1] ?? first
		const isMarkLigature = positions.every(p => buffer.glyphClass[p] === GlyphClass.MARK)
		const ligId = isMarkLigature ? 0 : this.nextLigId

		if (!isMarkLigature) {
			this.nextLigId = (this.nextLigId % 255) + 1

			for (let p = 0; p < count; p++) {
				const from = (positions[p] ?? 0) + 1
				const to = p + 1 < count ? (positions[p + 1] ?? 0) : buffer.length
				let k = from

				for (; k < to && buffer.glyphClass[k] === GlyphClass.MARK; k++) {
					buffer.ligId[k] = ligId
					buffer.ligComp[k] = Math.min(15, p + 1)
				}

				// The marks after the last component are not paid for by matching or removing, and a ligature of one
				// component applied again and again at one glyph (by nested lookups) would walk them every time.
				this.visit(k - from)
			}
		}

		buffer.mergeClusters(first, last + 1)
		buffer.flags[first] = (buffer.flags[first] ?? 0) & ~GlyphFlag.MULTIPLIED
		this.setGlyph(first, ligatureGlyph, GlyphFlag.SUBSTITUTED | GlyphFlag.LIGATED)
		buffer.ligId[first] = ligId
		buffer.ligComp[first] = 0

		for (let p = count - 1; p >= 1; p--) buffer.remove(positions[p] ?? 0)
	}

	private reverseChain(offset: number, i: number): number {
		const view = this.view
		const buffer = this.buffer
		const glyph = buffer.glyph[i] ?? 0
		const covered = coverageIndex(view, offset + view.getUint16(offset + 2), glyph)

		if (covered < 0 || view.getUint16(offset) !== 1) return -1

		const backtrackCount = view.getUint16(offset + 4)
		const backtrackAt = offset + 6
		const lookaheadCountAt = backtrackAt + backtrackCount * 2
		const lookaheadCount = view.getUint16(lookaheadCountAt)
		const lookaheadAt = lookaheadCountAt + 2
		const substituteCountAt = lookaheadAt + lookaheadCount * 2
		const covers = (at: number) => (candidate: number, n: number) =>
			coverageIndex(view, offset + view.getUint16(at + n * 2), candidate) >= 0

		// As chainRule, a context longer than any real one is not matched, so one position cannot walk the run.
		if (backtrackCount + lookaheadCount > MAX_CONTEXT * 3) return -1
		if (covered >= view.getUint16(substituteCountAt)) return -1
		if (!this.matchBacktrack(i, backtrackCount, covers(backtrackAt))) return -1
		if (!this.matchLookahead(i, lookaheadCount, covers(lookaheadAt))) return -1

		this.setGlyph(i, view.getUint16(substituteCountAt + 2 + covered * 2))

		return i + 1
	}
}

// Lookups, subtables, ligatures and rules one wouldSubstitute call tries at most, all together.
const WOULD_SUBSTITUTE_TRIES = MAX_CONTEXT * SUBTABLES_PER_OP
// Tries the running wouldSubstitute call has left (it is synchronous, so one counter serves every call).
let triesLeft = 0

// Whether any of `lookups` would substitute the glyph sequence on its own, without context (as HarfBuzz's
// would_substitute): single, multiple and alternate substitutions of one glyph, ligatures of exactly these
// glyphs, and contextual rules whose input is exactly these glyphs. It has no operations budget to charge, so
// past WOULD_SUBSTITUTE_TRIES lookups, subtables, ligatures and rules tried in one call the answer is no.
export function wouldSubstitute(table: LayoutTable, lookups: readonly number[], glyphs: readonly number[]): boolean {
	const view = table.view

	triesLeft = WOULD_SUBSTITUTE_TRIES

	for (const index of lookups) {
		// A lookup counts as a try too, so a feature of thousands of lookups without subtables stops as well.
		if (!tried()) return false

		const lookup = table.lookup(index)

		if (lookup === undefined) continue

		for (const offset of lookup.subtables) {
			if (!tried()) return false
			if (wouldApply(view, lookup.type, offset, glyphs)) return true
		}
	}

	return false
}

// Lookups, subtables, ligatures and rules the last wouldSubstitute call tried, so a caller that runs it over a
// syllable the font sets the length of can charge them to the run.
export function wouldSubstituteTries(): number {
	return WOULD_SUBSTITUTE_TRIES - Math.max(0, triesLeft)
}

// Counts one try of the running wouldSubstitute call; false: none left.
function tried(): boolean {
	return triesLeft-- > 0
}

function wouldApply(view: DataView, type: number, offset: number, glyphs: readonly number[]): boolean {
	const first = glyphs[0] ?? 0
	const format = view.getUint16(offset)

	switch (type) {
		case 1:
		case 2:
		case 3:
			return glyphs.length === 1 && coverageIndex(view, offset + view.getUint16(offset + 2), first) >= 0
		case 4: {
			const covered = coverageIndex(view, offset + view.getUint16(offset + 2), first)

			if (covered < 0 || covered >= view.getUint16(offset + 4)) return false

			const set = offset + view.getUint16(offset + 6 + covered * 2)
			const count = view.getUint16(set)

			for (let l = 0; l < count; l++) {
				if (!tried()) return false

				const ligature = set + view.getUint16(set + 2 + l * 2)

				if (view.getUint16(ligature + 2) !== glyphs.length) continue

				let match = true

				for (let k = 1; k < glyphs.length && match; k++) match = view.getUint16(ligature + 4 + (k - 1) * 2) === glyphs[k]

				if (match) return true
			}

			return false
		}
		case 5:
		case 6:
			return format === 3 ? wouldApplyFormat3(view, offset, glyphs, type === 6) : wouldApplyRules(view, offset, glyphs, type === 6)
		default:
			return false
	}
}

function wouldApplyFormat3(view: DataView, offset: number, glyphs: readonly number[], chained: boolean): boolean {
	let inputCount: number
	let coverages: number

	if (chained) {
		const backtrack = view.getUint16(offset + 2)
		const inputAt = offset + 4 + backtrack * 2

		inputCount = view.getUint16(inputAt)
		coverages = inputAt + 2

		const lookahead = view.getUint16(coverages + inputCount * 2)

		if (backtrack !== 0 || lookahead !== 0) return false
	} else {
		inputCount = view.getUint16(offset + 2)
		coverages = offset + 6
	}

	if (inputCount !== glyphs.length) return false

	for (let k = 0; k < inputCount; k++) {
		if (coverageIndex(view, offset + view.getUint16(coverages + k * 2), glyphs[k] ?? 0) < 0) return false
	}

	return true
}

function wouldApplyRules(view: DataView, offset: number, glyphs: readonly number[], chained: boolean): boolean {
	const format = view.getUint16(offset)
	const first = glyphs[0] ?? 0
	const covered = coverageIndex(view, offset + view.getUint16(offset + 2), first)

	if (covered < 0) return false

	if (format === 1) {
		if (covered >= view.getUint16(offset + 4)) return false

		const setOffset = view.getUint16(offset + 6 + covered * 2)

		if (setOffset === 0) return false

		const set = offset + setOffset

		for (let r = 0, count = view.getUint16(set); r < count; r++) {
			if (!tried()) return false

			let rule = set + view.getUint16(set + 2 + r * 2)

			if (chained) {
				if (view.getUint16(rule) !== 0) continue

				rule += 2
			}

			if (view.getUint16(rule) !== glyphs.length) continue

			const inputAt = rule + (chained ? 2 : 4)
			let match = true

			for (let k = 1; k < glyphs.length && match; k++) match = view.getUint16(inputAt + (k - 1) * 2) === glyphs[k]

			if (match && chained && view.getUint16(inputAt + (glyphs.length - 1) * 2) !== 0) match = false
			if (match) return true
		}

		return false
	}

	if (format !== 2) return false

	const inputDef = offset + view.getUint16(offset + (chained ? 6 : 4))
	const setCountAt = offset + (chained ? 10 : 6)
	const cls = classOf(view, inputDef, first)

	if (cls >= view.getUint16(setCountAt)) return false

	const setOffset = view.getUint16(setCountAt + 2 + cls * 2)

	if (setOffset === 0) return false

	const set = offset + setOffset

	for (let r = 0, count = view.getUint16(set); r < count; r++) {
		if (!tried()) return false

		let rule = set + view.getUint16(set + 2 + r * 2)

		if (chained) {
			if (view.getUint16(rule) !== 0) continue

			rule += 2
		}

		if (view.getUint16(rule) !== glyphs.length) continue

		const inputAt = rule + (chained ? 2 : 4)
		let match = true

		for (let k = 1; k < glyphs.length && match; k++)
			match = view.getUint16(inputAt + (k - 1) * 2) === classOf(view, inputDef, glyphs[k] ?? 0)

		if (match && chained && view.getUint16(inputAt + (glyphs.length - 1) * 2) !== 0) match = false
		if (match) return true
	}

	return false
}

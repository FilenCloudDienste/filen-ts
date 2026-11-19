import { SUBTABLES_PER_OP } from "./apply"
import { GlyphFlag, type GlyphBuffer } from "./buffer"
import { wouldSubstitute, wouldSubstituteTries } from "./gsub"
import type { Plan, Shaper } from "./shape"
import { IndicCategory as C, MatraPosition, indicCategory, matraPosition, type ScriptCode } from "./unicode"

// The Indic shaping model of the OpenType script development specifications ("Creating and supporting
// OpenType fonts for Devanagari", and the Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada,
// Malayalam and Sinhala documents): syllable identification, base consonant, initial reordering (matras,
// reph, pre-base forms), the basic features one at a time per syllable, final reordering, then the
// presentation features. Where the specifications are ambiguous this follows HarfBuzz's reading, which
// the tests compare against: the syllable grammar is a port of src/hb-ot-shaper-indic-machine.rl and the
// reordering steps and per-script settings follow src/hb-ot-shaper-indic.cc (HarfBuzz 14.6.0, "Old MIT"
// licence, see THIRD_PARTY_NOTICES.md).

// Positions, in their reordering order.
const P = {
	START: 0,
	RA_TO_BECOME_REPH: 1,
	PRE_M: 2,
	PRE_C: 3,
	BASE_C: 4,
	AFTER_MAIN: 5,
	ABOVE_C: 6,
	BEFORE_SUB: 7,
	BELOW_C: 8,
	AFTER_SUB: 9,
	BEFORE_POST: 10,
	POST_C: 11,
	AFTER_POST: 12,
	FINAL_C: 13,
	SMVD: 14,
	END: 15
} as const

const Syllable = { CONSONANT: 0, VOWEL: 1, STANDALONE: 2, SYMBOL: 3, BROKEN: 4, OTHER: 5 } as const

const RephPosition = { AFTER_MAIN: 0, BEFORE_SUB: 1, AFTER_SUB: 2, BEFORE_POST: 3, AFTER_POST: 4 } as const
const RephMode = { IMPLICIT: 0, EXPLICIT: 1, LOG_REPHA: 2 } as const

interface Config {
	readonly oldSpecTag: string
	readonly virama: number
	readonly sinhalaBase: boolean
	readonly rephPosition: number
	readonly rephMode: number
	readonly blwfPostOnly: boolean
}

function config(
	oldSpecTag: string,
	virama: number,
	rephPosition: number,
	rephMode: number,
	blwfPostOnly: boolean,
	sinhalaBase = false
): Config {
	return { oldSpecTag, virama, sinhalaBase, rephPosition, rephMode, blwfPostOnly }
}

const CONFIGS: Partial<Record<ScriptCode, Config>> = {
	Deva: config("deva", 0x094d, RephPosition.BEFORE_POST, RephMode.IMPLICIT, false),
	Beng: config("beng", 0x09cd, RephPosition.AFTER_SUB, RephMode.IMPLICIT, false),
	Guru: config("guru", 0x0a4d, RephPosition.BEFORE_SUB, RephMode.IMPLICIT, false),
	Gujr: config("gujr", 0x0acd, RephPosition.BEFORE_POST, RephMode.IMPLICIT, false),
	Orya: config("orya", 0x0b4d, RephPosition.AFTER_MAIN, RephMode.IMPLICIT, false),
	Taml: config("taml", 0x0bcd, RephPosition.AFTER_POST, RephMode.IMPLICIT, false),
	Telu: config("telu", 0x0c4d, RephPosition.AFTER_POST, RephMode.EXPLICIT, true),
	Knda: config("knda", 0x0ccd, RephPosition.AFTER_POST, RephMode.IMPLICIT, true),
	Mlym: config("mlym", 0x0d4d, RephPosition.AFTER_MAIN, RephMode.LOG_REPHA, false),
	Sinh: config("", 0x0dca, RephPosition.AFTER_POST, RephMode.EXPLICIT, false, true)
}

const DEFAULT_CONFIG = config("", 0, RephPosition.BEFORE_POST, RephMode.IMPLICIT, false)

const BASIC = ["nukt", "akhn", "rphf", "rkrf", "pref", "blwf", "abvf", "half", "pstf", "vatu", "cjct"] as const
const PRESENTATION = ["init", "pres", "abvs", "blws", "psts", "haln"] as const
const NON_GLOBAL = new Set(["rphf", "pref", "blwf", "abvf", "half", "pstf", "init"])

// Backward walks over a syllable cost one operation per this many glyphs walked: a MultipleSubst copies the
// syllable to every glyph it emits, so a font can make one syllable as long as the run's length limit.
const WALK_PER_OP = 32

const bit = (category: number): number => 1 << category
const CONSONANTS = bit(C.C) | bit(C.CS) | bit(C.Ra) | bit(C.CM) | bit(C.V) | bit(C.PLACEHOLDER) | bit(C.DOTTEDCIRCLE)
const JOINERS = bit(C.ZWJ) | bit(C.ZWNJ)

// A category test that, as in HarfBuzz, no longer holds once the glyph is a ligature.
function isOneOf(buffer: GlyphBuffer, i: number, flags: number): boolean {
	if ((buffer.flags[i] ?? 0) & GlyphFlag.LIGATED) return false

	return ((1 << (buffer.category[i] ?? 0)) & flags) !== 0
}

const isConsonant = (buffer: GlyphBuffer, i: number): boolean => isOneOf(buffer, i, CONSONANTS)
const isHalant = (buffer: GlyphBuffer, i: number): boolean => isOneOf(buffer, i, bit(C.H))
const isJoiner = (buffer: GlyphBuffer, i: number): boolean => isOneOf(buffer, i, JOINERS)
const ligatedOnly = (buffer: GlyphBuffer, i: number): boolean =>
	((buffer.flags[i] ?? 0) & (GlyphFlag.LIGATED | GlyphFlag.MULTIPLIED)) === GlyphFlag.LIGATED

function inBlock(cp: number, start: number): boolean {
	return cp >= start && cp < start + 0x80
}

// Where a matra goes, by script (the specifications' matra reordering classes).
function matraPositionOf(cp: number, side: number): number {
	const deva = inBlock(cp, 0x0900)
	const beng = inBlock(cp, 0x0980)
	const guru = inBlock(cp, 0x0a00)
	const gujr = inBlock(cp, 0x0a80)
	const orya = inBlock(cp, 0x0b00)
	const taml = inBlock(cp, 0x0b80)
	const telu = inBlock(cp, 0x0c00)
	const knda = inBlock(cp, 0x0c80)
	const mlym = inBlock(cp, 0x0d00)

	switch (side) {
		case P.PRE_C:
			return P.PRE_M
		case P.POST_C:
			if (deva) return P.AFTER_SUB
			if (beng || guru || gujr || orya || taml || mlym) return P.AFTER_POST
			if (telu) return cp <= 0x0c42 ? P.BEFORE_SUB : P.AFTER_SUB
			if (knda) return cp < 0x0cc3 || cp > 0x0cd6 ? P.BEFORE_SUB : P.AFTER_SUB

			return P.AFTER_SUB
		case P.ABOVE_C:
			if (guru) return P.AFTER_POST
			if (orya) return P.AFTER_MAIN
			if (telu || knda) return P.BEFORE_SUB

			return P.AFTER_SUB
		case P.BELOW_C:
			if (guru || gujr || taml || mlym) return P.AFTER_POST
			if (telu || knda) return P.BEFORE_SUB

			return P.AFTER_SUB
		default:
			return side
	}
}

function sideOf(position: number): number {
	switch (position) {
		case MatraPosition.LEFT:
			return P.PRE_C
		case MatraPosition.TOP:
			return P.ABOVE_C
		case MatraPosition.BOTTOM:
			return P.BELOW_C
		case MatraPosition.RIGHT:
		case MatraPosition.SPLIT:
			return P.POST_C
		case MatraPosition.VISUAL_LEFT:
			return P.PRE_M
		case MatraPosition.OVERSTRUCK:
			return P.AFTER_MAIN
		default:
			return P.END
	}
}

function initialPosition(cp: number, category: number): number {
	if ((bit(category) & CONSONANTS) !== 0) return P.BASE_C

	const side = sideOf(matraPosition(cp))

	if (category === C.M) return matraPositionOf(cp, side)
	if (category === C.SM || category === C.A || category === C.Symbol) return P.SMVD
	if (cp === 0x0b01) return P.BEFORE_SUB

	return side
}

// Syllable grammar over one letter per category (the specifications' syllable structure, as HarfBuzz's
// Indic machine): consonant, vowel, standalone, symbol and broken clusters, longest match first.
function letterOf(category: number): string {
	switch (category) {
		case C.C:
			return "C"
		case C.Ra:
			return "R"
		case C.V:
			return "V"
		case C.N:
			return "N"
		case C.H:
			return "H"
		case C.ZWNJ:
			return "Z"
		case C.ZWJ:
			return "J"
		case C.M:
			return "M"
		case C.SM:
			return "S"
		case C.A:
			return "A"
		case C.PLACEHOLDER:
			return "P"
		case C.DOTTEDCIRCLE:
			return "D"
		case C.RS:
			return "r"
		case C.Repha:
			return "E"
		case C.CM:
			return "m"
		case C.Symbol:
			return "Y"
		case C.CS:
			return "s"
		default:
			return "X"
	}
}

const consonant = "[CR]"
const modifier = "(?:(?:Z?r)?(?:NN?)?)"
const reph = "(?:RH|E)"
const cn = `(?:${consonant}J?${modifier}?)`
const symbol = "(?:YN?)"
const matraGroup = "(?:[JZ]*MN?H?)"
const tail = "(?:(?:[JZ]?SS?Z?)?A*)"
const halantGroup = "(?:[JZ]?H(?:JN?)?)"
const finalHalantGroup = `(?:${halantGroup}|HZ)`
const halantOrMatra = `(?:${finalHalantGroup}|${matraGroup}*)`
const complexTail = `(?:(?:${halantGroup}${cn})*m?${halantOrMatra}${tail})`
const SYLLABLES: readonly (readonly [number, RegExp])[] = [
	[Syllable.CONSONANT, new RegExp(`(?:E|s)?${cn}${complexTail}`, "y")],
	[Syllable.VOWEL, new RegExp(`${reph}?V${modifier}?(?:J|${complexTail})`, "y")],
	[Syllable.STANDALONE, new RegExp(`(?:(?:E|s)?P|${reph}?D)${modifier}?${complexTail}`, "y")],
	[Syllable.SYMBOL, new RegExp(`${symbol}${tail}`, "y")],
	[Syllable.BROKEN, new RegExp(`${reph}?${modifier}?${complexTail}`, "y")]
]

// What the font makes of each consonant with a virama (below-base, post-base or base form), per plan.
const consonantPositions = new WeakMap<Plan, Map<number, number>>()

// Syllable types by serial, for the buffer being shaped.
const syllableTypes = new WeakMap<GlyphBuffer, number[]>()

function findSyllables(buffer: GlyphBuffer): number[] {
	let letters = ""

	for (let i = 0; i < buffer.length; i++) letters += letterOf(buffer.category[i] ?? 0)

	const types: number[] = [Syllable.OTHER]
	let serial = 0

	for (let at = 0; at < letters.length;) {
		let best = 0
		let bestType: number = Syllable.OTHER

		for (const [type, pattern] of SYLLABLES) {
			pattern.lastIndex = at

			const match = pattern.exec(letters)
			const length = match === null ? 0 : match[0].length

			if (length > best) {
				best = length
				bestType = type
			}
		}

		if (best === 0) best = 1

		serial = (serial % 0xffff) + 1
		types[serial] = bestType
		buffer.syllable.fill(serial, at, at + best)
		at += best
	}

	return types
}

function syllableEnd(buffer: GlyphBuffer, start: number): number {
	const serial = buffer.syllable[start] ?? 0
	let end = start + 1

	while (end < buffer.length && buffer.syllable[end] === serial) end++

	return end
}

function configOf(plan: Plan): Config {
	return CONFIGS[plan.script] ?? DEFAULT_CONFIG
}

function isOldSpec(plan: Plan, cfg: Config): boolean {
	return cfg.oldSpecTag !== "" && plan.gsubScript === cfg.oldSpecTag
}

// Whether the font's `tag` lookups would substitute `glyphs`. With `run`, the check and the tries it took are
// charged to that run: checks inside a syllable are as many as the font makes the syllable long, and one check
// as many tries as the font's lookups hold.
function would(plan: Plan, tag: string, glyphs: readonly number[], run?: GlyphBuffer): boolean {
	const gsub = plan.face.gsub
	const lookups = plan.gsubFeatures.get(tag)

	if (gsub === undefined || lookups === undefined) return false

	const result = wouldSubstitute(gsub, lookups, glyphs)

	run?.spend(1 + Math.floor(wouldSubstituteTries() / SUBTABLES_PER_OP))

	return result
}

function maskOf(plan: Plan, tag: string): number {
	return plan.gsubFeatures.has(tag) ? (plan.masks.get(tag) ?? 0) : 0
}

function setup(buffer: GlyphBuffer, plan: Plan): void {
	const cfg = configOf(plan)
	const face = plan.face

	for (let i = 0; i < buffer.length; i++) {
		const cp = buffer.cp[i] ?? 0
		let category = indicCategory(cp)

		// Stress signs behave like bindus.
		if (cp === 0x0953 || cp === 0x0954) category = C.SM

		buffer.category[i] = category
		buffer.position[i] = initialPosition(cp, category)
	}

	// Consonants with a below-base or post-base form in this font (either glyph order, as fonts differ). The
	// checks run once per glyph and plan and before any lookup multiplies the run, so they are not charged.
	const virama = cfg.virama === 0 ? 0 : face.glyphOf(cfg.virama)

	if (virama !== 0) {
		let known = consonantPositions.get(plan)

		if (known === undefined) {
			known = new Map()
			consonantPositions.set(plan, known)
		}

		for (let i = 0; i < buffer.length; i++) {
			if (buffer.position[i] !== P.BASE_C) continue

			const glyph = buffer.glyph[i] ?? 0
			let position = known.get(glyph)

			if (position === undefined) {
				const pairs = [
					[virama, glyph],
					[glyph, virama]
				]

				position = pairs.some(pair => would(plan, "blwf", pair) || would(plan, "vatu", pair))
					? P.BELOW_C
					: pairs.some(pair => would(plan, "pstf", pair) || would(plan, "pref", pair))
						? P.POST_C
						: P.BASE_C
				known.set(glyph, position)
			}

			buffer.position[i] = position
		}
	}

	const types = findSyllables(buffer)

	insertDottedCircles(buffer, plan, types)
	syllableTypes.set(buffer, types)
}

// Broken clusters get a dotted circle as their base, after a leading repha (as Uniscribe and HarfBuzz).
function insertDottedCircles(buffer: GlyphBuffer, plan: Plan, types: number[]): void {
	const circle = plan.face.glyphOf(0x25cc)

	if (circle === 0) return

	for (let i = 0; i < buffer.length;) {
		const serial = buffer.syllable[i] ?? 0
		const end = syllableEnd(buffer, i)

		if (types[serial] !== Syllable.BROKEN) {
			i = end
			continue
		}

		let at = i

		while (at < end && buffer.category[at] === C.Repha) at++

		buffer.replace(at, 0, [circle])
		buffer.copyData(at === i ? at + 1 : at - 1, at)
		buffer.glyph[at] = circle
		buffer.cp[at] = 0x25cc
		buffer.cluster[at] = buffer.cluster[i] ?? 0
		buffer.category[at] = C.DOTTEDCIRCLE
		buffer.position[at] = P.END
		buffer.glyphClass[at] = plan.face.classOf(circle, 0x25cc)
		buffer.flags[at] = 0
		buffer.mask[at] = plan.globalMask
		types[serial] = Syllable.STANDALONE
		i = end + 1
	}
}

function initialReordering(buffer: GlyphBuffer, plan: Plan): void {
	const types = syllableTypes.get(buffer)

	if (types === undefined) return

	for (let start = 0; start < buffer.length;) {
		const end = syllableEnd(buffer, start)
		const type = types[buffer.syllable[start] ?? 0]

		if (type === Syllable.CONSONANT || type === Syllable.VOWEL || type === Syllable.STANDALONE || type === Syllable.BROKEN) {
			reorderSyllable(buffer, plan, start, end)
		}

		start = end
	}
}

function reorderSyllable(buffer: GlyphBuffer, plan: Plan, start: number, end: number): void {
	const cfg = configOf(plan)
	const category = buffer.category
	const position = buffer.position
	const oldSpec = isOldSpec(plan, cfg)
	const rphfMask = maskOf(plan, "rphf")

	// Kannada RA + H + ZWJ behaves as RA + ZWJ + H.
	if (
		plan.script === "Knda" &&
		start + 3 <= end &&
		category[start] === C.Ra &&
		category[start + 1] === C.H &&
		category[start + 2] === C.ZWJ
	) {
		buffer.mergeClusters(start + 1, start + 3)
		buffer.move(start + 2, start + 1)
	}

	// 1. The base consonant.
	let base = end
	let hasReph = false
	let limit = start

	if (
		rphfMask !== 0 &&
		start + 3 <= end &&
		((cfg.rephMode === RephMode.IMPLICIT && !isJoiner(buffer, start + 2)) ||
			(cfg.rephMode === RephMode.EXPLICIT && category[start + 2] === C.ZWJ))
	) {
		// At most two checks per syllable, which the text sets, so they are not charged.
		const glyphs = [buffer.glyph[start] ?? 0, buffer.glyph[start + 1] ?? 0]

		if (
			would(plan, "rphf", glyphs) ||
			(cfg.rephMode === RephMode.EXPLICIT && would(plan, "rphf", [...glyphs, buffer.glyph[start + 2] ?? 0]))
		) {
			limit += 2

			while (limit < end && isJoiner(buffer, limit)) limit++

			base = start
			hasReph = true
		}
	} else if (cfg.rephMode === RephMode.LOG_REPHA && category[start] === C.Repha) {
		limit += 1

		while (limit < end && isJoiner(buffer, limit)) limit++

		base = start
		hasReph = true
	}

	if (!cfg.sinhalaBase) {
		let i = end
		let seenBelow = false

		do {
			i--

			if (isConsonant(buffer, i)) {
				if (position[i] !== P.BELOW_C && (position[i] !== P.POST_C || seenBelow)) {
					base = i
					break
				}

				if (position[i] === P.BELOW_C) seenBelow = true

				base = i
			} else if (start < i && category[i] === C.ZWJ && category[i - 1] === C.H) {
				// ZWJ after a halant requests a half form and ends the search.
				break
			}
		} while (i > limit)
	} else {
		if (!hasReph) base = limit

		for (let i = limit; i < end; i++) {
			if (!isConsonant(buffer, i)) continue

			if (limit < i && category[i - 1] === C.ZWJ) break

			base = i
		}

		for (let i = base + 1; i < end; i++) if (isConsonant(buffer, i)) position[i] = P.BELOW_C
	}

	// A lone RA + halant forms no reph: RA is the base.
	if (hasReph && base === start && limit - base <= 2) hasReph = false

	for (let i = start; i < base; i++) position[i] = Math.min(P.PRE_C, position[i] ?? 0)

	if (base < end) position[base] = P.BASE_C

	// A consonant after a matra is final (Sinhala).
	for (let i = base + 1; i < end; i++) {
		if (category[i] !== C.M) continue

		for (let j = i + 1; j < end; j++) {
			if (isConsonant(buffer, j)) {
				position[j] = P.FINAL_C
				break
			}
		}

		break
	}

	if (hasReph) position[start] = P.RA_TO_BECOME_REPH

	// Old-spec fonts expect the first post-base halant after the last consonant.
	if (oldSpec) {
		const noDoubleHalant = plan.script === "Knda"

		for (let i = base + 1; i < end; i++) {
			if (category[i] !== C.H) continue

			let j = end - 1

			for (; j > i; j--) if (isConsonant(buffer, j) || (noDoubleHalant && category[j] === C.H)) break

			if (category[j] !== C.H && j > i) buffer.move(i, j)

			break
		}
	}

	// Joiners, nuktas, register shifters, medials and halants move with the character before them.
	let lastPosition: number = P.START

	for (let i = start; i < end; i++) {
		const cat = category[i] ?? 0

		if ((bit(cat) & (JOINERS | bit(C.N) | bit(C.RS) | bit(C.CM) | bit(C.H))) !== 0) {
			position[i] = lastPosition

			if (cat === C.H && position[i] === P.PRE_M) {
				// The halant does not move with a left matra. A font can multiply left matras into a long
				// syllable, so the walk is charged to the run.
				let j = i

				for (; j > start; j--) {
					if (position[j - 1] !== P.PRE_M) {
						position[i] = position[j - 1] ?? 0
						break
					}
				}

				buffer.spend(Math.floor((i - j) / WALK_PER_OP))
			}
		} else if (position[i] !== P.SMVD) {
			lastPosition = position[i] ?? 0
		}
	}

	// Post-base consonants own what comes before them since the last consonant or matra.
	let last = base

	for (let i = base + 1; i < end; i++) {
		if (isConsonant(buffer, i)) {
			for (let j = last + 1; j < i; j++) if ((position[j] ?? 0) < P.SMVD) position[j] = position[i] ?? 0

			last = i
		} else if (category[i] === C.M) {
			last = i
		}
	}

	// Stable sort by position.
	const order = Array.from({ length: end - start }, (_, k) => k)

	order.sort((a, b) => (position[start + a] ?? 0) - (position[start + b] ?? 0) || a - b)
	buffer.permute(start, order)

	let firstLeftMatra = end
	let lastLeftMatra = end

	base = end

	for (let i = start; i < end; i++) {
		if (position[i] === P.BASE_C) {
			base = i
			break
		}

		if (position[i] === P.PRE_M) {
			if (firstLeftMatra === end) firstLeftMatra = i

			lastLeftMatra = i
		}
	}

	// Several left matras keep their logical order, nuktas staying after their matra.
	if (firstLeftMatra < lastLeftMatra) {
		buffer.reverse(firstLeftMatra, lastLeftMatra + 1)

		let from = firstLeftMatra

		for (let j = from; j <= lastLeftMatra; j++) {
			if (category[j] === C.M) {
				buffer.reverse(from, j + 1)
				from = j + 1
			}
		}
	}

	// What moved across the base merges clusters from the base on; pre-base clusters are final reordering's.
	if (oldSpec || end - start > 127) {
		buffer.mergeClusters(base, end)
	} else {
		for (let i = base; i < end; i++) {
			const from = start + (order[i - start] ?? 0)

			if (from !== i) buffer.mergeClusters(Math.max(base, Math.min(i, from)), Math.max(i, from) + 1)
		}
	}

	// Masks.
	for (let i = start; i < end && position[i] === P.RA_TO_BECOME_REPH; i++) buffer.mask[i] = (buffer.mask[i] ?? 0) | rphfMask

	let preBase = maskOf(plan, "half")

	if (!oldSpec && !cfg.blwfPostOnly) preBase |= maskOf(plan, "blwf")

	for (let i = start; i < base; i++) buffer.mask[i] = (buffer.mask[i] ?? 0) | preBase

	const postBase = maskOf(plan, "blwf") | maskOf(plan, "abvf") | maskOf(plan, "pstf")

	for (let i = base + 1; i < end; i++) buffer.mask[i] = (buffer.mask[i] ?? 0) | postBase

	// Old-spec Devanagari eyelash RA.
	if (oldSpec && plan.script === "Deva") {
		const blwf = maskOf(plan, "blwf")

		for (let i = start; i + 1 < base; i++) {
			if (category[i] === C.Ra && category[i + 1] === C.H && (i + 2 === base || category[i + 2] !== C.ZWJ)) {
				buffer.mask[i] = (buffer.mask[i] ?? 0) | blwf
				buffer.mask[i + 1] = (buffer.mask[i + 1] ?? 0) | blwf
			}
		}
	}

	// Pre-base-reordering RA: a halant + RA the font's pref forms. A font can multiply the glyphs after the base
	// into a long syllable, so each pair tried is charged to the run.
	const prefMask = maskOf(plan, "pref")

	if (prefMask !== 0 && base + 2 < end) {
		for (let i = base + 1; i + 1 < end; i++) {
			if (would(plan, "pref", [buffer.glyph[i] ?? 0, buffer.glyph[i + 1] ?? 0], buffer)) {
				buffer.mask[i] = (buffer.mask[i] ?? 0) | prefMask
				buffer.mask[i + 1] = (buffer.mask[i + 1] ?? 0) | prefMask
				break
			}
		}
	}

	// A ZWNJ disables half forms before it.
	const halfMask = maskOf(plan, "half")

	for (let i = start + 1; i < end; i++) {
		if (!isJoiner(buffer, i) || category[i] !== C.ZWNJ) continue

		let j = i

		do {
			j--
			buffer.mask[j] = (buffer.mask[j] ?? 0) & ~halfMask
		} while (j > start && !isConsonant(buffer, j))

		// A font can multiply ZWNJs into a long syllable, so the walk is charged to the run.
		buffer.spend(Math.floor((i - j) / WALK_PER_OP))
	}
}

function finalReordering(buffer: GlyphBuffer, plan: Plan): void {
	for (let start = 0; start < buffer.length;) {
		const end = syllableEnd(buffer, start)

		finalSyllable(buffer, plan, start, end)
		start = end
	}

	syllableTypes.delete(buffer)
}

function finalSyllable(buffer: GlyphBuffer, plan: Plan, start: number, end: number): void {
	const cfg = configOf(plan)
	const category = buffer.category
	const position = buffer.position
	const virama = cfg.virama === 0 ? 0 : plan.face.glyphOf(cfg.virama)
	const both = GlyphFlag.LIGATED | GlyphFlag.MULTIPLIED

	// A halant that took part in a ligature and was split out again is a halant.
	if (virama !== 0) {
		for (let i = start; i < end; i++) {
			if (buffer.glyph[i] === virama && ((buffer.flags[i] ?? 0) & both) === both) {
				category[i] = C.H
				buffer.flags[i] = (buffer.flags[i] ?? 0) & ~both
			}
		}
	}

	const prefMask = maskOf(plan, "pref")
	let tryPref = prefMask !== 0
	let base = start

	for (; base < end; base++) {
		if ((position[base] ?? 0) < P.BASE_C) continue

		if (tryPref && base + 1 < end) {
			for (let i = base + 1; i < end; i++) {
				if (((buffer.mask[i] ?? 0) & prefMask) === 0) continue

				if (!(((buffer.flags[i] ?? 0) & GlyphFlag.SUBSTITUTED) !== 0 && ligatedOnly(buffer, i))) {
					// A pref candidate that formed nothing: the base is around here.
					base = i

					while (base < end && isHalant(buffer, base)) base++

					if (base < end) position[base] = P.BASE_C

					tryPref = false
				}

				break
			}

			if (base === end) break
		}

		// Malayalam: unformed below forms after the base become the base.
		if (plan.script === "Mlym") {
			for (let i = base + 1; i < end; i++) {
				while (i < end && isJoiner(buffer, i)) i++

				if (i === end || !isHalant(buffer, i)) break

				i++

				while (i < end && isJoiner(buffer, i)) i++

				if (i < end && isConsonant(buffer, i) && position[i] === P.BELOW_C) {
					base = i
					position[base] = P.BASE_C
				}
			}
		}

		if (start < base && (position[base] ?? 0) > P.BASE_C) base--

		break
	}

	if (base === end && start < base && isOneOf(buffer, base - 1, bit(C.ZWJ))) base--

	if (base < end) {
		while (start < base && isOneOf(buffer, base, bit(C.N) | bit(C.H))) base--
	}

	// Pre-base matras move to after the last standalone halant before the base.
	if (start + 1 < end && start < base) {
		let target = base === end ? base - 2 : base - 1

		if (plan.script !== "Mlym" && plan.script !== "Taml") {
			for (;;) {
				while (target > start && !isOneOf(buffer, target, bit(C.M) | bit(C.H))) target--

				if (isHalant(buffer, target) && position[target] !== P.PRE_M) {
					// After a halant + ZWJ the matra keeps searching left.
					if (target + 1 < end && category[target + 1] === C.ZWJ && target > start) {
						target--
						continue
					}
				} else {
					target = start
				}

				break
			}
		}

		if (start < target && position[target] !== P.PRE_M) {
			for (let i = target; i > start; i--) {
				if (position[i - 1] !== P.PRE_M) continue

				const old = i - 1

				if (old < base && base <= target) base--

				buffer.move(old, target)
				buffer.mergeClusters(target, Math.min(end, base + 1))
				target--
			}
		} else {
			for (let i = start; i < base; i++) {
				if (position[i] === P.PRE_M) {
					buffer.mergeClusters(i, Math.min(end, base + 1))
					break
				}
			}
		}
	}

	// The reph moves to its script's position: if it formed, or for a separately encoded repha, if it did not.
	if (start + 1 < end && position[start] === P.RA_TO_BECOME_REPH && (category[start] === C.Repha) !== ligatedOnly(buffer, start)) {
		const target = rephTarget(buffer, cfg, start, end, base)

		buffer.mergeClusters(start, target + 1)
		buffer.move(start, target)

		if (start < base && base <= target) base--
	}

	// Pre-base-reordering consonants the pref feature formed move before the base.
	if (tryPref && base + 1 < end) {
		for (let i = base + 1; i < end; i++) {
			if (((buffer.mask[i] ?? 0) & prefMask) === 0) continue

			if (ligatedOnly(buffer, i)) {
				let target = base

				if (plan.script !== "Mlym" && plan.script !== "Taml") {
					while (target > start && !isOneOf(buffer, target - 1, bit(C.M) | bit(C.H))) target--
				}

				if (target > start && isHalant(buffer, target - 1) && target < end && isJoiner(buffer, target)) target++

				buffer.mergeClusters(target, i + 1)
				buffer.move(i, target)

				if (target <= base && base < i) base++
			}

			break
		}
	}

	// 'init' for a left matra at the start of a word.
	if (position[start] === P.PRE_M) {
		const previous = start > 0 ? (buffer.cp[start - 1] ?? 0) : 0

		if (start === 0 || !WORD_CHARACTER.test(String.fromCodePoint(previous))) {
			buffer.mask[start] = (buffer.mask[start] ?? 0) | maskOf(plan, "init")
		}
	}
}

const WORD_CHARACTER = /[\p{L}\p{M}\p{Cf}\p{Cn}\p{Co}\p{Cs}]/u

function rephTarget(buffer: GlyphBuffer, cfg: Config, start: number, end: number, base: number): number {
	const position = buffer.position
	const afterHalant = (): number => {
		let target = start + 1

		while (target < base && !isHalant(buffer, target)) target++

		if (target < base && isHalant(buffer, target)) {
			if (target + 1 < base && isJoiner(buffer, target + 1)) target++

			return target
		}

		return -1
	}

	if (cfg.rephPosition !== RephPosition.AFTER_POST) {
		const found = afterHalant()

		if (found >= 0) return found

		if (cfg.rephPosition === RephPosition.AFTER_MAIN) {
			let target = base

			while (target + 1 < end && (position[target + 1] ?? 0) <= P.AFTER_MAIN) target++

			if (target < end) return target
		}

		if (cfg.rephPosition === RephPosition.AFTER_SUB) {
			let target = base
			const stop = (p: number): boolean => p === P.POST_C || p === P.AFTER_POST || p === P.SMVD

			while (target + 1 < end && !stop(position[target + 1] ?? 0)) target++

			if (target < end) return target
		}
	}

	const found = afterHalant()

	if (found >= 0) return found

	let target = end - 1

	while (target > start && position[target] === P.SMVD) target--

	// After a matra + halant, the reph goes before that halant so it can interact with the matra.
	if (isHalant(buffer, target)) {
		for (let i = base + 1; i < target; i++) if (buffer.category[i] === C.M) target--
	}

	return target
}

// The Indic shaper; fontSet.ts registers it (a named import, so no bundler drops this module as side-effect-free).
export const INDIC_SHAPER: Shaper = {
	collect(builder) {
		builder.add("locl", { global: true, perSyllable: true })
		builder.add("ccmp", { global: true, perSyllable: true })
		builder.pause(initialReordering)

		for (const tag of BASIC) {
			builder.add(tag, { global: !NON_GLOBAL.has(tag), perSyllable: true, manualZwj: true })
			builder.pause()
		}

		builder.pause(finalReordering)

		for (const tag of PRESENTATION) builder.add(tag, { global: !NON_GLOBAL.has(tag), perSyllable: true, manualZwj: true })
	},
	setup,
	zeroMarksLate: false,
	compose: "base",
	disabled: ["liga"]
}

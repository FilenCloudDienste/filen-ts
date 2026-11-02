import { fromCodePoints } from "../../arrays"
import type { SfntFont } from "../../fonts/sfnt"
import { ZWJ } from "./apply"
import { GlyphBuffer, ShapingLimitError } from "./buffer"
import { PositioningApplier, resolveOrigins } from "./gpos"
import { SubstitutionApplier } from "./gsub"
import { GlyphClass, GlyphDefinitions, LayoutTable } from "./otl"
import {
	JoiningType,
	combiningClass,
	isDefaultIgnorable,
	isMark,
	joiningType,
	mirrorOf,
	openTypeLanguage,
	openTypeScripts,
	scriptCode,
	type ScriptCode
} from "./unicode"

// Text shaping for PDF output, following the OpenType script development specifications
// (learn.microsoft.com/typography/script-development) and, where those leave a choice, HarfBuzz's
// behaviour, which it is tested against: cmap, normalization, mark ordering, GSUB by stage, default
// advances, GPOS, late mark zeroing, default-ignorable removal. A malformed layout table makes the run
// fall back to unshaped cmap glyphs.

export const GLOBAL_MASK = 1

export interface FeatureOptions {
	readonly global?: boolean
	readonly perSyllable?: boolean
	readonly manualZwj?: boolean
}

interface StageLookup {
	readonly index: number
	readonly mask: number
	readonly perSyllable: boolean
	readonly autoZwj: boolean
}

interface Stage {
	readonly lookups: readonly StageLookup[]
	readonly pause: ((buffer: GlyphBuffer, plan: Plan) => void) | undefined
}

export interface Plan {
	readonly script: ScriptCode
	readonly rtl: boolean
	readonly shaper: Shaper
	readonly masks: ReadonlyMap<string, number>
	readonly globalMask: number
	readonly gsub: readonly Stage[]
	readonly gpos: readonly Stage[]
	readonly face: ShapingFace
	// GSUB lookups per feature, and the script tag the GSUB table was read under.
	readonly gsubFeatures: ReadonlyMap<string, readonly number[]>
	readonly gsubScript: string | undefined
}

export interface ShapeInput {
	readonly cps: Uint32Array
	readonly clusters: Uint32Array
	readonly count: number
	// Code points around the run, nearest first, for joining across run boundaries.
	readonly before: readonly number[]
	readonly after: readonly number[]
	readonly script: number
	readonly rtl: boolean
	readonly language: string | undefined
}

export interface Shaper {
	collect(builder: PlanBuilder): void
	// After cmap: masks and shaper data per glyph.
	setup(buffer: GlyphBuffer, plan: Plan, input: ShapeInput): void
	readonly zeroMarksLate: boolean
	// Normalization: "all" composes where the font has the composed glyph; "base" composes only a base with
	// the mark after it (split vowel signs stay apart).
	readonly compose: "all" | "base"
	// Default features the script does not use.
	readonly disabled?: readonly string[]
}

export class PlanBuilder {
	readonly script: ScriptCode
	readonly rtl: boolean
	private readonly stages: { features: { tag: string; options: FeatureOptions }[]; pause: Stage["pause"] }[] = [
		{ features: [], pause: undefined }
	]
	private readonly gposFeatures: { tag: string; options: FeatureOptions }[] = []

	constructor(script: ScriptCode, rtl: boolean) {
		this.script = script
		this.rtl = rtl
	}

	// Adds a GSUB feature to the current stage. A feature added again keeps its first stage.
	add(tag: string, options: FeatureOptions = { global: true }): void {
		if (this.stages.some(stage => stage.features.some(feature => feature.tag === tag))) return

		this.stages[this.stages.length - 1]?.features.push({ tag, options })
	}

	position(tag: string, options: FeatureOptions = { global: true }): void {
		this.gposFeatures.push({ tag, options })
	}

	// Ends the current GSUB stage; `pause` runs after it.
	pause(pause?: Stage["pause"]): void {
		const last = this.stages[this.stages.length - 1]

		if (last !== undefined && pause !== undefined) {
			if (last.pause === undefined) last.pause = pause
			else this.stages.push({ features: [], pause })
		}

		this.stages.push({ features: [], pause: undefined })
	}

	build(face: ShapingFace, shaper: Shaper, language: string | undefined): Plan {
		const masks = new Map<string, number>()
		let nextBit = 1
		let globalMask = GLOBAL_MASK

		const maskOf = (tag: string, options: FeatureOptions): number => {
			let mask = masks.get(tag)

			if (mask === undefined) {
				mask = options.global === false && nextBit < 31 ? 1 << nextBit++ : GLOBAL_MASK
				masks.set(tag, mask)
			}

			if (options.global !== false) globalMask |= mask

			return mask
		}

		const scriptTags = openTypeScripts(this.script)
		const gsubLookups = face.gsub?.featureLookups(scriptTags, language) ?? new Map<string, number[]>()
		const gposLookups = face.gpos?.featureLookups(scriptTags, language) ?? new Map<string, number[]>()
		const stage = (
			features: readonly { tag: string; options: FeatureOptions }[],
			table: Map<string, number[]>,
			pause: Stage["pause"]
		): Stage => {
			const merged = new Map<number, StageLookup>()

			for (const { tag, options } of features) {
				const mask = maskOf(tag, options)

				for (const index of table.get(tag) ?? []) {
					const known = merged.get(index)

					merged.set(index, {
						index,
						mask: (known?.mask ?? 0) | mask,
						perSyllable: (known?.perSyllable ?? true) && options.perSyllable === true,
						autoZwj: (known?.autoZwj ?? true) && options.manualZwj !== true
					})
				}
			}

			return { lookups: [...merged.values()].sort((a, b) => a.index - b.index), pause }
		}

		const gsub = this.stages.map(s => stage(s.features, gsubLookups, s.pause))
		const gpos = [stage(this.gposFeatures, gposLookups, undefined)]

		return {
			script: this.script,
			rtl: this.rtl,
			shaper,
			masks,
			globalMask,
			gsub,
			gpos,
			face,
			gsubFeatures: gsubLookups,
			gsubScript: face.gsub?.scriptOffset(scriptTags)?.tag
		}
	}
}

// Features every script gets (hb-ot-shape.cc: common and horizontal features), around the shaper's own.
function collectPlan(builder: PlanBuilder, shaper: Shaper): void {
	builder.add("rvrn")
	builder.pause()

	if (builder.rtl) {
		builder.add("rtla")
		builder.add("rtlm")
	} else {
		builder.add("ltra")
		builder.add("ltrm")
	}

	shaper.collect(builder)

	const disabled = new Set(shaper.disabled ?? [])

	for (const tag of ["ccmp", "locl", "rlig", "calt", "clig", "liga", "rclt"]) if (!disabled.has(tag)) builder.add(tag)
	for (const tag of ["abvm", "blwm", "mark", "mkmk", "curs", "dist", "kern"]) builder.position(tag)
}

const DEFAULT_SHAPER: Shaper = {
	collect() {},
	setup() {},
	zeroMarksLate: true,
	compose: "all"
}

// Arabic joining (OpenType "Developing OpenType fonts for Arabic script"). The state table is HarfBuzz's
// (src/hb-ot-shaper-arabic.cc, HarfBuzz 14.6.0, "Old MIT" licence, see THIRD_PARTY_NOTICES.md).
const ARABIC_FEATURES = ["isol", "fina", "fin2", "fin3", "medi", "med2", "init"] as const
const NONE = 7
const [ISOL, FINA, FIN2, FIN3, MEDI, MED2, INIT] = [0, 1, 2, 3, 4, 5, 6]

// [previous action, current action, next state] per state and joining class (U, L, R, D, Alaph, Dalath/Rish).
const ARABIC_STATES: readonly (readonly (readonly [number, number, number])[])[] = [
	[
		[NONE, NONE, 0],
		[NONE, ISOL, 2],
		[NONE, ISOL, 1],
		[NONE, ISOL, 2],
		[NONE, ISOL, 1],
		[NONE, ISOL, 6]
	],
	[
		[NONE, NONE, 0],
		[NONE, ISOL, 2],
		[NONE, ISOL, 1],
		[NONE, ISOL, 2],
		[NONE, FIN2, 5],
		[NONE, ISOL, 6]
	],
	[
		[NONE, NONE, 0],
		[NONE, ISOL, 2],
		[INIT, FINA, 1],
		[INIT, FINA, 3],
		[INIT, FINA, 4],
		[INIT, FINA, 6]
	],
	[
		[NONE, NONE, 0],
		[NONE, ISOL, 2],
		[MEDI, FINA, 1],
		[MEDI, FINA, 3],
		[MEDI, FINA, 4],
		[MEDI, FINA, 6]
	],
	[
		[NONE, NONE, 0],
		[NONE, ISOL, 2],
		[MED2, ISOL, 1],
		[MED2, ISOL, 2],
		[MED2, FIN2, 5],
		[MED2, ISOL, 6]
	],
	[
		[NONE, NONE, 0],
		[NONE, ISOL, 2],
		[ISOL, ISOL, 1],
		[ISOL, ISOL, 2],
		[ISOL, FIN2, 5],
		[ISOL, ISOL, 6]
	],
	[
		[NONE, NONE, 0],
		[NONE, ISOL, 2],
		[NONE, ISOL, 1],
		[NONE, ISOL, 2],
		[NONE, FIN3, 5],
		[NONE, ISOL, 6]
	]
]

const SYRIAC_ALAPH = 0x0710
const SYRIAC_DALATH_RISH = new Set([0x0715, 0x0716, 0x072a, 0x072f])
const TRANSPARENT = -1

function joiningClass(cp: number): number {
	if (cp === SYRIAC_ALAPH) return 4
	if (SYRIAC_DALATH_RISH.has(cp)) return 5

	switch (joiningType(cp)) {
		case JoiningType.T:
			return TRANSPARENT
		case JoiningType.L:
			return 1
		case JoiningType.R:
			return 2
		case JoiningType.D:
		case JoiningType.C:
			return 3
		default:
			return 0
	}
}

const ARABIC_SHAPER: Shaper = {
	collect(builder) {
		builder.add("stch")
		builder.pause()
		builder.add("ccmp", { global: true, manualZwj: true })
		builder.add("locl", { global: true, manualZwj: true })
		builder.pause()

		for (const tag of ARABIC_FEATURES) {
			builder.add(tag, { global: false })
			builder.pause()
		}

		builder.add("rlig", { global: true, manualZwj: true })
		builder.add("rclt", { global: true, manualZwj: true })
		builder.add("calt", { global: true, manualZwj: true })
		builder.pause()
		builder.add("mset")
	},
	setup(buffer, plan, input) {
		const actions = new Uint8Array(buffer.length).fill(NONE)
		let previous = -1
		let state = 0

		for (const cp of input.before) {
			const cls = joiningClass(cp)

			if (cls === TRANSPARENT) continue

			state = ARABIC_STATES[state]?.[cls]?.[2] ?? 0
			break
		}

		for (let i = 0; i < buffer.length; i++) {
			const cls = joiningClass(buffer.cp[i] ?? 0)

			if (cls === TRANSPARENT) continue

			const entry = ARABIC_STATES[state]?.[cls] ?? [NONE, NONE, 0]

			if (entry[0] !== NONE && previous >= 0) actions[previous] = entry[0]

			actions[i] = entry[1]
			previous = i
			state = entry[2]
		}

		for (const cp of input.after) {
			const cls = joiningClass(cp)

			if (cls === TRANSPARENT) continue

			const entry = ARABIC_STATES[state]?.[cls] ?? [NONE, NONE, 0]

			if (entry[0] !== NONE && previous >= 0) actions[previous] = entry[0]

			break
		}

		for (let i = 0; i < buffer.length; i++) {
			const action = actions[i] ?? NONE

			if (action !== NONE) buffer.mask[i] = (buffer.mask[i] ?? 0) | (plan.masks.get(ARABIC_FEATURES[action] ?? "") ?? 0)
		}
	},
	zeroMarksLate: true,
	compose: "all"
}

// Thai and Lao: SARA AM decomposes to NIKHAHIT + SARA AA, NIKHAHIT moving before the tone marks it
// follows (OpenType Thai and Lao script specifications; as HarfBuzz).
const THAI_SHAPER: Shaper = {
	collect() {},
	setup(buffer, plan) {
		const face = plan.face

		for (let i = 0; i < buffer.length; i++) {
			const cp = buffer.cp[i] ?? 0

			if (cp !== 0x0e33 && cp !== 0x0eb3) continue

			const nikhahit = cp - 0x0e33 + 0x0e4d
			const saraAa = cp - 0x0e33 + 0x0e32

			buffer.replace(i, 1, [face.glyphOf(nikhahit), face.glyphOf(saraAa)])
			buffer.cp[i] = nikhahit
			buffer.cp[i + 1] = saraAa
			buffer.glyphClass[i] = face.classOf(buffer.glyph[i] ?? 0, nikhahit)
			buffer.glyphClass[i + 1] = face.classOf(buffer.glyph[i + 1] ?? 0, saraAa)

			// Move NIKHAHIT back over preceding above-base tone marks.
			let to = i

			while (to > 0 && isThaiAboveMark(buffer.cp[to - 1] ?? 0)) to--

			if (to < i) {
				buffer.move(i, to)
				buffer.mergeClusters(to, i + 2)
			}

			i++
		}
	},
	zeroMarksLate: true,
	compose: "all"
}

function isThaiAboveMark(cp: number): boolean {
	return (cp >= 0x0e48 && cp <= 0x0e4b) || (cp >= 0x0ec8 && cp <= 0x0ecb)
}

let indicShaper: Shaper | null = null

// Indic scripts get their shaper from indic.ts, registered there to keep this module free of it.
export function registerIndicShaper(shaper: Shaper): void {
	indicShaper = shaper
}

const INDIC_SCRIPTS = new Set<ScriptCode>(["Deva", "Beng", "Guru", "Gujr", "Orya", "Taml", "Telu", "Knda", "Mlym", "Sinh"])
const ARABIC_SCRIPTS = new Set<ScriptCode>(["Arab", "Syrc", "Nkoo", "Mong"])

function shaperFor(script: ScriptCode): Shaper {
	if (ARABIC_SCRIPTS.has(script)) return ARABIC_SHAPER
	if (script === "Thai" || script === "Laoo") return THAI_SHAPER
	if (INDIC_SCRIPTS.has(script) && indicShaper !== null) return indicShaper

	return DEFAULT_SHAPER
}

// A font with its layout tables, shaping runs into a reusable buffer.
export class ShapingFace {
	readonly font: SfntFont
	readonly gsub: LayoutTable | undefined
	readonly gpos: LayoutTable | undefined
	readonly gdef: GlyphDefinitions
	private readonly plans = new Map<string, Plan>()
	private readonly glyphs = new Map<number, number>()
	private substitution: SubstitutionApplier | null = null
	private positioning: PositioningApplier | null = null
	readonly buffer = new GlyphBuffer()
	private originX = new Float64Array(0)
	private originY = new Float64Array(0)
	// Whether layout tables failed to parse or apply; the face then shapes with cmap and hmtx only.
	broken = false

	constructor(font: SfntFont) {
		this.font = font

		const view = new DataView(font.bytes.buffer, font.bytes.byteOffset, font.bytes.byteLength)
		const table = (tag: string, extension: number): LayoutTable | undefined => {
			const range = font.table(tag)

			if (range === undefined) return undefined

			try {
				return new LayoutTable(view, range.offset, extension)
			} catch {
				return undefined
			}
		}

		this.gsub = table("GSUB", 7)
		this.gpos = table("GPOS", 9)

		const gdef = font.table("GDEF")

		this.gdef = new GlyphDefinitions(gdef === undefined ? null : view, gdef?.offset ?? 0, font.numGlyphs)
	}

	glyphOf(cp: number): number {
		let glyph = this.glyphs.get(cp)

		if (glyph === undefined) {
			glyph = this.font.glyphId(cp)
			this.glyphs.set(cp, glyph)
		}

		return glyph
	}

	hasGlyph(cp: number): boolean {
		return this.glyphOf(cp) !== 0
	}

	// GDEF class, or one derived from the character when the font has none.
	classOf(glyph: number, cp: number): number {
		if (this.gdef.hasClasses) return this.gdef.glyphClass(glyph)

		return isMark(cp) ? GlyphClass.MARK : GlyphClass.BASE
	}

	plan(scriptIndex: number, rtl: boolean, language: string | undefined): Plan {
		const script = scriptCode(scriptIndex)
		const key = `${script}|${rtl ? 1 : 0}|${language ?? ""}`
		let plan = this.plans.get(key)

		if (plan === undefined) {
			const shaper = shaperFor(script)
			const builder = new PlanBuilder(script, rtl)

			collectPlan(builder, shaper)
			plan = builder.build(this, shaper, openTypeLanguage(language))
			this.plans.set(key, plan)
		}

		return plan
	}

	// Shapes the run into `buffer` (logical order) and returns origins and the total advance, font units.
	// `limited`: the run went past the shaping limits and is drawn with cmap and hmtx only.
	shape(input: ShapeInput): {
		readonly buffer: GlyphBuffer
		readonly x: Float64Array
		readonly y: Float64Array
		readonly width: number
		readonly limited: boolean
	} {
		const plan = this.plan(input.script, input.rtl, input.language)
		const buffer = this.buffer
		let limited = false

		this.fill(input, plan)

		if (!this.broken) {
			try {
				buffer.limit()
				plan.shaper.setup(buffer, plan, input)
				this.substitute(plan)
				this.advances()
				this.positionGlyphs(plan)
			} catch (error) {
				// Past the limits only this run is unshaped; a table that fails to apply stays off for the face.
				if (error instanceof ShapingLimitError) limited = true
				else this.broken = true

				buffer.unlimit()
				this.fill(input, plan)
				this.advances()
			} finally {
				buffer.unlimit()
			}
		} else {
			this.advances()
		}

		this.removeIgnorables()

		if (this.originX.length < buffer.length) {
			this.originX = new Float64Array(buffer.capacity)
			this.originY = new Float64Array(buffer.capacity)
		}

		const width = resolveOrigins(buffer, input.rtl, this.originX, this.originY)

		return { buffer, x: this.originX, y: this.originY, width, limited }
	}

	private fill(input: ShapeInput, plan: Plan): void {
		const buffer = this.buffer
		const sequence = this.normalize(input, plan)

		buffer.reset(sequence.count)

		for (let i = 0; i < sequence.count; i++) {
			const cp = sequence.cps[i] ?? 0
			const glyph = this.glyphOf(cp)

			buffer.glyph[i] = glyph
			buffer.cp[i] = cp
			buffer.cluster[i] = sequence.clusters[i] ?? 0
			buffer.mask[i] = plan.globalMask
			buffer.glyphClass[i] = this.classOf(glyph, cp)
		}

		// A grapheme (base and its marks) is one cluster.
		for (let i = 1; i < buffer.length; i++) {
			const cp = buffer.cp[i] ?? 0

			if (isMark(cp) || cp === ZWJ) buffer.cluster[i] = buffer.cluster[i - 1] ?? 0
		}
	}

	private sequenceCps = new Uint32Array(0)
	private sequenceClusters = new Uint32Array(0)

	// Mirroring in right-to-left runs, canonical mark order (with HarfBuzz's modified classes), and per
	// grapheme the composed or decomposed form the font covers.
	private normalize(
		input: ShapeInput,
		plan: Plan
	): { readonly cps: Uint32Array; readonly clusters: Uint32Array; readonly count: number } {
		const capacity = input.count * 3 + 4

		if (this.sequenceCps.length < capacity) {
			this.sequenceCps = new Uint32Array(capacity)
			this.sequenceClusters = new Uint32Array(capacity)
		}

		const cps = this.sequenceCps
		const clusters = this.sequenceClusters
		let count = 0

		for (let start = 0; start < input.count;) {
			let end = start + 1

			while (end < input.count && isMark(input.cps[end] ?? 0)) end++

			const first = input.cps[start] ?? 0

			// A lone character the font has needs no normalization (and no mirroring left to right).
			if (end === start + 1 && !input.rtl && this.hasGlyph(first)) {
				if (count < cps.length) {
					cps[count] = first
					clusters[count] = input.clusters[start] ?? 0
					count++
				}

				start = end
				continue
			}

			const grapheme = Array.from(input.cps.subarray(start, end))

			if (input.rtl) {
				for (let k = 0; k < grapheme.length; k++) {
					const mirrored = mirrorOf(grapheme[k] ?? 0)

					if (mirrored !== 0 && this.hasGlyph(mirrored)) grapheme[k] = mirrored
				}
			}

			const chosen = this.chooseForm(grapheme, plan.shaper.compose)
			const cluster = input.clusters[start] ?? 0

			for (const cp of chosen) {
				if (count >= cps.length) break

				cps[count] = cp
				clusters[count] = cluster
				count++
			}

			start = end
		}

		return { cps, clusters, count }
	}

	private chooseForm(grapheme: number[], compose: Shaper["compose"]): number[] {
		const covered = (list: readonly number[]): boolean => list.every(cp => this.hasGlyph(cp) || isDefaultIgnorable(cp))
		const text = fromCodePoints(grapheme)
		const decomposed = codePoints(text.normalize("NFD"))

		sortMarks(decomposed)

		if (compose === "all") {
			const composed = codePoints(text.normalize("NFC"))

			sortMarks(composed)

			if (covered(composed)) return composed
		} else if (decomposed.length > 1 && !isMark(decomposed[0] ?? 0)) {
			const first = decomposed[0] ?? 0
			const second = decomposed[1] ?? 0
			// Bengali YYA is a composition exclusion fonts still expect composed (as HarfBuzz recomposes it).
			const pair = first === 0x09af && second === 0x09bc ? [0x09df] : codePoints(String.fromCodePoint(first, second).normalize("NFC"))
			const composed = pair.length === 1 ? [pair[0] ?? 0, ...decomposed.slice(2)] : decomposed

			if (covered(composed)) return composed
		}

		if (covered(decomposed)) return decomposed

		const original = [...grapheme]

		sortMarks(original)

		return original
	}

	private substitute(plan: Plan): void {
		if (this.gsub === undefined) return

		const buffer = this.buffer

		this.substitution ??= new SubstitutionApplier(buffer, this.gsub, this.gdef)

		for (const stage of plan.gsub) {
			for (const lookup of stage.lookups) this.substitution.applyLookup(lookup.index, lookup)

			stage.pause?.(buffer, plan)
		}
	}

	private advances(): void {
		const buffer = this.buffer

		buffer.clearPositions()

		for (let i = 0; i < buffer.length; i++) buffer.xAdvance[i] = this.font.advance(buffer.glyph[i] ?? 0)
	}

	private positionGlyphs(plan: Plan): void {
		const buffer = this.buffer

		if (this.gpos !== undefined) {
			this.positioning ??= new PositioningApplier(buffer, this.gpos, this.gdef)
			this.positioning.rtl = plan.rtl

			for (const stage of plan.gpos) for (const lookup of stage.lookups) this.positioning.applyLookup(lookup.index, lookup)
		}

		if (plan.shaper.zeroMarksLate) {
			for (let i = 0; i < buffer.length; i++) {
				if (buffer.glyphClass[i] === GlyphClass.MARK && this.gdef.hasClasses) buffer.xAdvance[i] = 0
			}
		}
	}

	// Default ignorables are not drawn; their text stays with the cluster before them.
	private removeIgnorables(): void {
		const buffer = this.buffer
		let any = false

		for (let i = 0; i < buffer.length && !any; i++) any = isDefaultIgnorable(buffer.cp[i] ?? 0)

		if (any) buffer.removeWhere(i => isDefaultIgnorable(buffer.cp[i] ?? 0))
	}
}

function codePoints(text: string): number[] {
	const out: number[] = []

	for (const char of text) out.push(char.codePointAt(0) ?? 0)

	return out
}

// Stable sort of each run of non-zero combining classes (canonical ordering).
function sortMarks(cps: number[]): void {
	for (let i = 0; i < cps.length; i++) {
		if (combiningClass(cps[i] ?? 0) === 0) continue

		let end = i + 1

		while (end < cps.length && combiningClass(cps[end] ?? 0) !== 0) end++

		if (end - i > 1) {
			const sorted = cps.slice(i, end).sort((a, b) => combiningClass(a) - combiningClass(b))

			for (let k = 0; k < sorted.length; k++) cps[i + k] = sorted[k] ?? 0
		}

		i = end
	}
}

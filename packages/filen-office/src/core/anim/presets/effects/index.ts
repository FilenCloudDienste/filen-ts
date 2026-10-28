import type { ColorModel } from "../../../presentation/model"
import type { AnimTarget, TimeNode, TimeNodeType } from "../../model"
import { EMPHASIS_PRESETS } from "./emphasis"
import { ENTRANCE_PRESETS } from "./entrance"
import { EXIT_PRESETS } from "./exit"
import { PATH_PRESETS } from "./paths"
import { extentOf, withStart, type EffectStart } from "./sequence"
import type { EffectClass, EffectPreset } from "./types"

// Our effect presets (entrance 30, emphasis 20, exit 30, motion paths 24), keyed by presetClass and presetID, and
// how an effect is made from one: the effect par (§19.5.29 cTn with presetID, presetClass, presetSubtype, grpId and
// nodeType) around the preset's behaviours.

export type { EffectClass, EffectPreset, PresetBuild, PresetGroup } from "./types"
export {
	automatic,
	extentOf,
	IdAllocator,
	readSequences,
	usedIds,
	withStart,
	writeSequences,
	type EffectSequence,
	type EffectStart,
	type EffectTrigger,
	type SequenceEffect,
	type SequenceRefusal,
	type SlideSequences
} from "./sequence"

export const EFFECT_PRESETS: readonly EffectPreset[] = [...ENTRANCE_PRESETS, ...EMPHASIS_PRESETS, ...EXIT_PRESETS, ...PATH_PRESETS]

const BY_KEY = new Map(EFFECT_PRESETS.map(preset => [`${preset.presetClass}:${String(preset.id)}`, preset]))

export function effectPreset(presetClass: string | undefined, id: number | undefined): EffectPreset | undefined {
	return presetClass === undefined || id === undefined ? undefined : BY_KEY.get(`${presetClass}:${String(id)}`)
}

// What setEffectTiming changes (the op's EffectTiming without its trigger).
export interface EffectTimingChange {
	readonly start?: EffectStart
	readonly durationMs?: number
	readonly delayMs?: number
	readonly repeat?: number | "untilNextClick" | "untilEndOfSlide"
	readonly rewind?: boolean
	readonly autoReverse?: boolean
}

export const DEFAULT_EFFECT_COLOR: ColorModel = { kind: "scheme", slot: "accent2" }

export interface EffectMake {
	readonly preset: EffectPreset
	readonly target: AnimTarget
	readonly start: EffectStart
	readonly subtype?: number
	readonly delayMs?: number
	readonly durationMs?: number
	readonly grpId?: number
	readonly color?: ColorModel
	// Slide width over height.
	readonly aspect?: number
	// Text animated by word or by letter (§19.5.49 iterate), with this much of the effect between elements.
	readonly iterate?: { readonly type: "wd" | "lt"; readonly pct: number }
}

const NODE_TYPES: Readonly<Record<EffectStart, TimeNodeType>> = {
	click: "clickEffect",
	with: "withEffect",
	after: "afterEffect"
}

// The effect par of `make` (ids 0: applying it gives them).
export function presetEffect(make: EffectMake): TimeNode {
	const preset = make.preset
	const subtype = make.subtype ?? preset.subtypes[0] ?? 0
	const children = preset.build({
		target: make.target,
		subtype,
		durationMs: Math.max(1, make.durationMs ?? preset.durationMs),
		color: make.color ?? DEFAULT_EFFECT_COLOR,
		aspect: make.aspect ?? 16 / 9
	})

	return {
		kind: "par",
		ctn: {
			id: 0,
			presetID: preset.id,
			presetClass: preset.presetClass,
			presetSubtype: subtype,
			fill: "hold",
			...(make.grpId === undefined ? {} : { grpId: make.grpId }),
			nodeType: NODE_TYPES[make.start],
			...(make.iterate === undefined
				? {}
				: { iterate: { type: make.iterate.type, interval: { pct: make.iterate.pct }, backwards: false } }),
			stCondLst: [{ delay: Math.max(0, Math.round(make.delayMs ?? 0)) }],
			endCondLst: [],
			children
		}
	}
}

// How long an effect plays once (its own begin delay left out).
export function effectDuration(effect: TimeNode): number {
	return Math.max(0, ...effect.ctn.children.map(extentOf))
}

// The effect played over `durationMs`: every timed behaviour's duration and begin scaled alike (1 ms sets keep theirs).
export function scaledEffect(effect: TimeNode, durationMs: number): TimeNode {
	const current = effectDuration(effect)

	if (current <= 0 || Math.round(durationMs) === current) return effect

	const factor = Math.max(1, durationMs) / current
	const scale = (node: TimeNode): TimeNode => {
		const ctn = node.ctn
		const dur = typeof ctn.dur === "number" && ctn.dur > 1 ? Math.max(1, Math.round(ctn.dur * factor)) : ctn.dur
		const stCondLst = ctn.stCondLst.map(condition =>
			typeof condition.delay === "number" && condition.delay > 0
				? { ...condition, delay: Math.round(condition.delay * factor) }
				: condition
		)

		return {
			...node,
			ctn: { ...ctn, ...(dur === undefined ? {} : { dur }), stCondLst, children: ctn.children.map(scale) }
		} as TimeNode
	}

	return { ...effect, ctn: { ...effect.ctn, children: effect.ctn.children.map(scale) } } as TimeNode
}

const SLIDE_NEXT = { evt: "onNext", delay: 0, tgtEl: { kind: "slide" } } as const

// The effect with `timing` applied (fields absent stay as they are).
export function timedEffect(effect: TimeNode, timing: EffectTimingChange): TimeNode {
	let next = timing.durationMs === undefined ? effect : scaledEffect(effect, timing.durationMs)
	const ctn = { ...next.ctn }

	if (timing.start !== undefined) next = withStart({ ...next, ctn } as TimeNode, timing.start)
	else next = { ...next, ctn } as TimeNode

	const out = next.ctn

	if (timing.delayMs !== undefined) {
		const delay = Math.max(0, Math.round(timing.delayMs))
		const [first, ...rest] = out.stCondLst

		out.stCondLst = [first === undefined ? { delay } : { ...first, delay }, ...rest]
	}

	if (timing.repeat !== undefined) {
		const onNext = (condition: { readonly evt?: string; readonly tgtEl?: AnimTarget }): boolean =>
			condition.evt === "onNext" && condition.tgtEl?.kind === "slide"

		out.endCondLst = out.endCondLst.filter(condition => !onNext(condition))

		if (timing.repeat === "untilNextClick") {
			out.repeatCount = "indefinite"
			out.endCondLst = [...out.endCondLst, SLIDE_NEXT]
		} else if (timing.repeat === "untilEndOfSlide") out.repeatCount = "indefinite"
		else if (Math.round(timing.repeat * 1000) === 1000) delete out.repeatCount
		else out.repeatCount = Math.max(1, Math.round(timing.repeat * 1000))
	}

	if (timing.rewind !== undefined) out.fill = timing.rewind ? "remove" : "hold"

	if (timing.autoReverse !== undefined) {
		if (timing.autoReverse) out.autoRev = true
		else delete out.autoRev
	}

	return next
}

export function presetsOf(presetClass: EffectClass): readonly EffectPreset[] {
	return EFFECT_PRESETS.filter(preset => preset.presetClass === presetClass)
}

import type { AnimTarget, PresetClass, TimeNode, TimingTree } from "../../../anim/model"
import {
	automatic,
	effectDuration,
	effectPreset,
	extentOf,
	presetEffect,
	readSequences,
	timedEffect,
	type EffectPreset,
	type EffectStart,
	type EffectTimingChange
} from "../../../anim/presets/effects/index"
import type { ColorModel, SlideRef } from "../../model"
import type { DeckOp, EffectTiming } from "../ops"
import { oneStep } from "./batch"

// The Animations tab and the animation pane as ops: a slide's effects listed the way the pane shows them (the main
// sequence, then each trigger's), and the ops that add an effect from a preset, replace one (Effect Options, or
// another preset picked for it), remove, reorder and time them. Each command is one op (a batch when it takes
// several), so it undoes in one step.

export {
	EFFECT_PRESETS,
	effectPreset,
	presetsOf,
	type EffectClass,
	type EffectPreset,
	type EffectStart,
	type PresetGroup
} from "../../../anim/presets/effects/index"

export type EffectRepeat = number | "untilNextClick" | "untilEndOfSlide"

// One effect as the pane lists it.
export interface EffectRow {
	// The effect par's ctn id (what the timing ops name).
	readonly id: number
	// 0: the main sequence; n: the nth trigger's interactive sequence.
	readonly sequence: number
	readonly trigger?: number
	// The medium bookmark that starts its sequence (`trigger` is the medium's shape).
	readonly bookmark?: string
	// Within its sequence.
	readonly index: number
	readonly start: EffectStart
	// The click it plays on (1 the first; 0: with the slide, before any click).
	readonly step: number
	readonly presetClass?: PresetClass
	readonly presetID?: number
	readonly presetSubtype?: number
	// Ours, when the effect is one of our presets' (by class and id).
	readonly preset?: EffectPreset
	readonly shape?: number
	// The paragraph a by-paragraph effect animates.
	readonly paragraph?: number
	readonly grpId: number
	readonly delayMs: number
	readonly durationMs: number
	// When it begins within its click (its group's offset plus its delay), for the timeline bars.
	readonly beginMs: number
	readonly repeat: EffectRepeat
	readonly rewind: boolean
	readonly autoReverse: boolean
	readonly iterate?: "wd" | "lt"
}

export type SlideEffects =
	{ readonly kind: "effects"; readonly rows: readonly EffectRow[] } | { readonly kind: "unsupported"; readonly detail: string }

function targetOf(node: TimeNode): AnimTarget | undefined {
	if (node.kind === "behavior") {
		const behavior = node.behavior

		return "common" in behavior ? behavior.common.target : behavior.target
	}

	for (const child of node.ctn.children) {
		const target = targetOf(child)

		if (target !== undefined) return target
	}

	return undefined
}

function repeatOf(effect: TimeNode): EffectRepeat {
	const count = effect.ctn.repeatCount

	if (count === "indefinite")
		return effect.ctn.endCondLst.some(c => c.evt === "onNext" && c.tgtEl?.kind === "slide") ? "untilNextClick" : "untilEndOfSlide"

	return count === undefined ? 1 : count / 1000
}

function delayOf(effect: TimeNode): number {
	const delay = effect.ctn.stCondLst[0]?.delay

	return typeof delay === "number" ? delay : 0
}

export function slideEffects(timing: TimingTree | undefined): SlideEffects {
	const sequences = readSequences(timing)

	if ("kind" in sequences) return { kind: "unsupported", detail: sequences.detail }

	const rows: EffectRow[] = []

	for (const [s, sequence] of [sequences.main, ...sequences.interactive].entries()) {
		let step = 0
		let index = 0

		// Offsets as the click and group pars say (the tree is the truth); a main-sequence click par that starts by
		// itself plays on the click before it (0: with the slide).
		for (const [c, click] of sequence.clicks.entries()) {
			step = s > 0 ? c + 1 : automatic(click.node) ? step : step + 1

			for (const group of click.groups) {
				const offset = group.ctn.stCondLst[0]?.delay
				const groupBegin = typeof offset === "number" ? offset : 0

				for (const effect of group.ctn.children) {
					const entry = sequence.effects[index]
					const target = targetOf(effect)
					const ctn = effect.ctn

					rows.push({
						id: ctn.id,
						sequence: s,
						...(sequence.trigger === undefined ? {} : { trigger: sequence.trigger.shape }),
						...(sequence.trigger?.kind === "bookmark" ? { bookmark: sequence.trigger.bookmark } : {}),
						index,
						start: entry?.start ?? "click",
						step,
						...(ctn.presetClass === undefined ? {} : { presetClass: ctn.presetClass }),
						...(ctn.presetID === undefined ? {} : { presetID: ctn.presetID }),
						...(ctn.presetSubtype === undefined ? {} : { presetSubtype: ctn.presetSubtype }),
						...(p => (p === undefined ? {} : { preset: p }))(effectPreset(ctn.presetClass, ctn.presetID)),
						...(target === undefined || target.kind === "slide" || target.kind === "sound" ? {} : { shape: target.shape }),
						...(target?.kind === "text" && target.unit === "para" ? { paragraph: target.start } : {}),
						grpId: ctn.grpId ?? 0,
						delayMs: delayOf(effect),
						durationMs: effectDuration(effect),
						beginMs: groupBegin + delayOf(effect),
						repeat: repeatOf(effect),
						rewind: ctn.fill === "remove",
						autoReverse: ctn.autoRev === true,
						...(ctn.iterate !== undefined && ctn.iterate.type !== "el" ? { iterate: ctn.iterate.type } : {})
					})
					index++
				}
			}
		}
	}

	return { kind: "effects", rows }
}

// How long each main-sequence click plays (index 0: what plays with the slide, before the first click), for a
// preview that clicks by itself. An indefinite repeat counts once.
export function stepDurations(rows: readonly EffectRow[]): number[] {
	const out: number[] = []

	for (const row of rows) {
		if (row.sequence !== 0) continue

		const once = row.durationMs * (row.autoReverse ? 2 : 1)
		const times = typeof row.repeat === "number" ? row.repeat : 1

		while (out.length <= row.step) out.push(0)

		out[row.step] = Math.max(out[row.step] ?? 0, row.beginMs + once * times)
	}

	return out
}

// --- Ops ---

export interface EffectTargetShape {
	readonly id: number
	// Paragraphs of its text (a by-paragraph effect makes one effect each); 0 or absent: animated as one object.
	readonly paragraphs?: number
}

export interface EffectChoice {
	readonly preset: EffectPreset
	readonly subtype?: number
	readonly color?: ColorModel
	readonly byParagraph?: boolean
	readonly iterate?: { readonly type: "wd" | "lt"; readonly pct: number }
	// Slide width over height.
	readonly aspect: number
}

function nextGrpId(rows: readonly EffectRow[], shape: number): number {
	let next = 0

	for (const row of rows) if (row.shape === shape) next = Math.max(next, row.grpId + 1)

	return next
}

function effectsFor(
	choice: EffectChoice,
	shape: EffectTargetShape,
	grpId: number,
	starts: { readonly first: EffectStart; readonly rest: EffectStart },
	timing: EffectTimingChange | undefined
): TimeNode[] {
	const paragraphs = choice.byParagraph === true ? (shape.paragraphs ?? 0) : 0
	const targets: AnimTarget[] =
		paragraphs > 0
			? Array.from({ length: paragraphs }, (_, p) => ({ kind: "text", shape: shape.id, unit: "para", start: p, end: p }) as const)
			: [{ kind: "shape", shape: shape.id }]
	const { durationMs, ...rest } = timing ?? {}

	return targets.map((target, index) => {
		const start = index === 0 ? starts.first : starts.rest
		const effect = presetEffect({
			preset: choice.preset,
			target,
			start,
			grpId,
			aspect: choice.aspect,
			...(choice.subtype === undefined ? {} : { subtype: choice.subtype }),
			...(choice.color === undefined ? {} : { color: choice.color }),
			...(choice.iterate === undefined ? {} : { iterate: choice.iterate }),
			...(durationMs === undefined ? {} : { durationMs })
		})

		return timing === undefined ? effect : timedEffect(effect, { ...rest, start })
	})
}

// Add Animation: `choice` on each shape, at the end of the main sequence. The first shape's effect starts as `start`
// (on click by default) and the other shapes' with it, as one click; a by-paragraph effect's later paragraphs each
// start as `start` does.
export function addEffectsOp(
	slide: SlideRef,
	rows: readonly EffectRow[],
	shapes: readonly EffectTargetShape[],
	choice: EffectChoice,
	start: EffectStart = "click"
): DeckOp | undefined {
	const ops: DeckOp[] = []

	for (const [s, shape] of shapes.entries()) {
		for (const effect of effectsFor(
			choice,
			shape,
			nextGrpId(rows, shape.id),
			{ first: s === 0 ? start : "with", rest: start },
			undefined
		))
			ops.push({ family: "timing", kind: "addEffect", slide, effect })
	}

	return oneStep(ops)[0]
}

// The effects of the pane that make one effect with `row` (a by-paragraph effect's paragraphs share its shape and
// group), in order.
export function effectGroup(rows: readonly EffectRow[], row: EffectRow): EffectRow[] {
	if (row.paragraph === undefined) return [row]

	return rows.filter(
		other => other.sequence === row.sequence && other.shape === row.shape && other.grpId === row.grpId && other.paragraph !== undefined
	)
}

function timingOf(row: EffectRow): EffectTimingChange {
	return { start: row.start, delayMs: row.delayMs, repeat: row.repeat, rewind: row.rewind, autoReverse: row.autoReverse }
}

// Effect Options, or another preset picked for a selected effect: the effect (with its paragraphs) made again from
// `choice` where it was, with its start, delay, repeat and rewind (and its duration while the preset is the same).
export function replaceEffectOp(
	slide: SlideRef,
	rows: readonly EffectRow[],
	row: EffectRow,
	choice: EffectChoice,
	paragraphs?: number
): DeckOp | undefined {
	const members = effectGroup(rows, row)
	const first = members[0] ?? row

	if (first.shape === undefined) return undefined

	const samePreset = first.presetClass === choice.preset.presetClass && first.presetID === choice.preset.id
	const timing: EffectTimingChange = { ...timingOf(first), ...(samePreset ? { durationMs: first.durationMs } : {}) }
	const effects = effectsFor(
		choice,
		{ id: first.shape, paragraphs: paragraphs ?? (first.paragraph === undefined ? 0 : members.length) },
		first.grpId,
		{ first: first.start, rest: members[1]?.start ?? first.start },
		timing
	)
	const trigger =
		first.trigger === undefined
			? undefined
			: first.bookmark === undefined
				? ({ kind: "shapeClick", shape: first.trigger } as const)
				: ({ kind: "bookmark", shape: first.trigger, bookmark: first.bookmark } as const)
	const ops: DeckOp[] = members.map(member => ({ family: "timing", kind: "removeEffect", slide, node: member.id }))

	for (const [e, effect] of effects.entries()) {
		ops.push({
			family: "timing",
			kind: "addEffect",
			slide,
			effect,
			at: first.index + e,
			...(trigger === undefined ? {} : { trigger })
		})
	}

	return oneStep(ops)[0]
}

export function removeEffectsOp(slide: SlideRef, ids: readonly number[]): DeckOp | undefined {
	return oneStep(ids.map(node => ({ family: "timing", kind: "removeEffect", slide, node }) as const))[0]
}

// Moves effect `id` to `to` within its sequence.
export function moveEffectOp(slide: SlideRef, id: number, to: number): DeckOp {
	return { family: "timing", kind: "moveEffect", slide, node: id, to }
}

export function effectTimingOp(slide: SlideRef, ids: readonly number[], timing: EffectTiming): DeckOp | undefined {
	return oneStep(ids.map(node => ({ family: "timing", kind: "setEffectTiming", slide, node, timing }) as const))[0]
}

// Every effect par of a tree, in document order (for tests and the pane's lookups).
export function effectNodes(timing: TimingTree | undefined): TimeNode[] {
	const sequences = readSequences(timing)

	if ("kind" in sequences) return []

	return [sequences.main, ...sequences.interactive].flatMap(sequence => sequence.effects.map(effect => effect.node))
}

export { extentOf }

import type { ColorModel } from "../../../presentation/model"
import type { AnimTarget, TimeNode } from "../../model"

// An effect preset: our own behaviour tree for one ECMA-376 preset (presetClass and presetID, §19.5.29 CT_TLCommonTimeNodeData,
// the TimeEffectID numbers), with the subtypes it offers. The tree is made from the attribute semantics of §19.5; the
// player follows it, never the number.

export type EffectClass = "entr" | "exit" | "emph" | "path"

// The gallery's sections (paths: lines, arcs, turns, shapes, loops).
export type PresetGroup = "basic" | "subtle" | "moderate" | "exciting" | "lines" | "arcs" | "turns" | "shapes" | "loops"

export interface PresetBuild {
	readonly target: AnimTarget
	readonly subtype: number
	// The default duration, or the one the effect is made with: the trees are written at it.
	readonly durationMs: number
	// The colour of a colour emphasis.
	readonly color: ColorModel
	// The slide's width over its height (motion paths keep their shapes round).
	readonly aspect: number
}

export interface EffectPreset {
	readonly presetClass: EffectClass
	readonly id: number
	// The locale key suffix of its name (previewPptxAnimPreset<Name>).
	readonly name: string
	readonly group: PresetGroup
	// Offered subtypes (ECMA bit patterns for directions: top 1, right 2, bottom 4, left 8, in 16, out 32), the first
	// the default; empty: the effect has none (subtype 0).
	readonly subtypes: readonly number[]
	readonly durationMs: number
	// What the target must have: text (font effects), or a fill or a line to recolour.
	readonly needs?: "text"
	// A colour emphasis (Effect Options offers its colour).
	readonly colored?: true
	build(options: PresetBuild): TimeNode[]
}

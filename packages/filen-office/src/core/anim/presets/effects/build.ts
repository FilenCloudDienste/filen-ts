import type { ColorModel } from "../../../presentation/model"
import type { AnimTarget, Behavior, CommonTimeNode, TimeAnimateValue, TimeNode } from "../../model"

// The pieces our effect presets are made of: behaviours (ECMA-376 Part 1 §19.5.1–19.5.90) with their timing, built
// from the attribute semantics of §19.5 (attrName values, time-animate-value formulas of §19.5.79, filter names of
// §19.5.29, motion path syntax of §19.5.4). Every node is made with id 0; applying an effect gives it its slide's ids.

export interface At {
	// Begin offset within the effect (ms).
	readonly delay?: number
	readonly fill?: CommonTimeNode["fill"]
	readonly accel?: number
	readonly decel?: number
	readonly autoRev?: boolean
	readonly repeatCount?: number
}

function ctn(dur: number, at: At = {}): CommonTimeNode {
	return {
		id: 0,
		dur: Math.max(1, Math.round(dur)),
		...(at.fill === undefined ? {} : { fill: at.fill }),
		...(at.accel === undefined ? {} : { accel: at.accel }),
		...(at.decel === undefined ? {} : { decel: at.decel }),
		...(at.autoRev === undefined ? {} : { autoRev: at.autoRev }),
		...(at.repeatCount === undefined ? {} : { repeatCount: at.repeatCount }),
		stCondLst: at.delay === undefined ? [] : [{ delay: Math.max(0, Math.round(at.delay)) }],
		endCondLst: [],
		children: []
	}
}

function node(behavior: Behavior, dur: number, at?: At): TimeNode {
	return { kind: "behavior", behavior, ctn: ctn(dur, at) }
}

// A value set for `dur` (1 ms: from its begin on, by its fill).
export function set(target: AnimTarget, attribute: string, to: string, at: At & { readonly dur?: number } = {}): TimeNode {
	return node({ type: "set", common: { target, attrNames: [attribute] }, to }, at.dur ?? 1, { fill: "hold", delay: 0, ...at })
}

// Shown at the start of an entrance.
export function show(target: AnimTarget): TimeNode {
	return set(target, "style.visibility", "visible")
}

// Hidden at the end of an exit of `dur`.
export function hide(target: AnimTarget, dur: number): TimeNode {
	return set(target, "style.visibility", "hidden", { delay: Math.max(0, dur - 1) })
}

// A numeric animation through `values` ([time in 1/100,000 of dur, value or formula]); `fmla` (§19.5.79) maps the
// interpolated value ($) through every keyframe, so the effect ends where the formula puts its last value.
export function anim(
	target: AnimTarget,
	attribute: string,
	values: readonly (readonly [number, string | number])[],
	dur: number,
	at: At & { readonly fmla?: string; readonly calcmode?: "lin" | "discrete"; readonly valueType?: "num" | "str" } = {}
): TimeNode {
	const tavLst: TimeAnimateValue[] = values.map(([tm, val]) => (at.fmla === undefined ? { tm, val } : { tm, val, fmla: at.fmla }))

	return node(
		{
			type: "anim",
			common: { target, attrNames: [attribute], additive: "base" },
			calcmode: at.calcmode ?? "lin",
			valueType: at.valueType ?? "num",
			tavLst
		},
		dur,
		{ fill: "hold", ...at }
	)
}

// Moves from `from` to the shape's own place (or from its place to `to`) on one axis.
export function slide(target: AnimTarget, axis: "x" | "y", from: string, to: string, dur: number, at: At = {}): TimeNode {
	return anim(
		target,
		axis === "x" ? "ppt_x" : "ppt_y",
		[
			[0, from],
			[100000, to]
		],
		dur,
		at
	)
}

export function filter(target: AnimTarget, transition: "in" | "out", name: string, dur: number, at: At = {}): TimeNode {
	return node({ type: "animEffect", common: { target, attrNames: [] }, transition, filter: name }, dur, at)
}

// Scale in 1/1000 of a percent.
export function scale(
	target: AnimTarget,
	value: { readonly by: { x: number; y: number } } | { readonly from?: { x: number; y: number }; readonly to?: { x: number; y: number } },
	dur: number,
	at: At = {}
): TimeNode {
	return node({ type: "animScale", common: { target, attrNames: [] }, ...value }, dur, { fill: "hold", ...at })
}

// Rotation by `by` 60,000ths of a degree.
export function rotate(target: AnimTarget, by: number, dur: number, at: At = {}): TimeNode {
	return node({ type: "animRot", common: { target, attrNames: ["r"] }, by }, dur, { fill: "hold", ...at })
}

export function colorTo(target: AnimTarget, attribute: string, to: ColorModel, dur: number, at: At = {}): TimeNode {
	return node({ type: "animClr", common: { target, attrNames: [attribute] }, clrSpc: "rgb", to }, dur, { fill: "hold", ...at })
}

// An HSL offset: hue in 60,000ths of a degree, saturation and lightness in 1/1000 of a percent.
export function colorBy(
	target: AnimTarget,
	attribute: string,
	by: { readonly h: number; readonly s: number; readonly l: number },
	dur: number,
	at: At & { readonly dir?: "cw" | "ccw" } = {}
): TimeNode {
	return node(
		{
			type: "animClr",
			common: { target, attrNames: [attribute] },
			clrSpc: "hsl",
			...(at.dir === undefined ? {} : { dir: at.dir }),
			by
		},
		dur,
		{ fill: "hold", ...at }
	)
}

// A motion path (§19.5.4: fractions of the slide, relative to the shape's place).
export function motion(target: AnimTarget, path: string, dur: number, at: At = {}): TimeNode {
	return node(
		{ type: "animMotion", common: { target, attrNames: ["ppt_x", "ppt_y"] }, origin: "layout", path, pathEditMode: "relative" },
		dur,
		{ fill: "hold", ...at }
	)
}

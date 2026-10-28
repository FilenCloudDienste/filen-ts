import type { AnimTarget, TimeNode } from "../../model"
import { anim, filter, scale, show, slide } from "./build"
import type { EffectPreset, PresetBuild } from "./types"

// Entrance presets (presetClass "entr"): each shows its target at its start (style.visibility), then brings it in.
// Directions are the ECMA subtype bits: top 1, right 2, bottom 4, left 8; in 16, out 32.

export const DIRECTIONS_4 = [4, 8, 2, 1] as const
export const DIRECTIONS_8 = [4, 12, 8, 9, 1, 3, 2, 6] as const

// Off the slide on the side `direction` names, for each axis it moves on.
export function offSlide(direction: number): { readonly x?: string; readonly y?: string } {
	return {
		...((direction & 8) !== 0 ? { x: "0-#ppt_w/2" } : (direction & 2) !== 0 ? { x: "1+#ppt_w/2" } : {}),
		...((direction & 1) !== 0 ? { y: "0-#ppt_h/2" } : (direction & 4) !== 0 ? { y: "1+#ppt_h/2" } : {})
	}
}

// Slides between the place `direction` names and the shape's own (in: from there; out: to there).
export function moves(target: AnimTarget, from: { readonly x?: string; readonly y?: string }, dur: number, out: boolean): TimeNode[] {
	const nodes: TimeNode[] = []

	if (from.x !== undefined) nodes.push(out ? slide(target, "x", "#ppt_x", from.x, dur) : slide(target, "x", from.x, "#ppt_x", dur))
	if (from.y !== undefined) nodes.push(out ? slide(target, "y", "#ppt_y", from.y, dur) : slide(target, "y", from.y, "#ppt_y", dur))

	return nodes
}

// An ECMA filter (§19.5.29) by the subtype: the filter name for each offered subtype.
export function filtered(names: Readonly<Record<number, string>>, transition: "in" | "out") {
	return ({ target, subtype, durationMs }: PresetBuild): TimeNode[] => {
		const name = names[subtype] ?? Object.values(names)[0] ?? "fade"

		return transition === "in" ? [show(target), filter(target, "in", name, durationMs)] : [filter(target, "out", name, durationMs)]
	}
}

const IN_OUT = [16, 32] as const

export const SIDE_FILTER: Readonly<Record<number, string>> = { 1: "down", 2: "left", 4: "up", 8: "right" }

const SLIDE_FROM: Readonly<Record<number, string>> = {
	1: "slide(fromTop)",
	2: "slide(fromRight)",
	4: "slide(fromBottom)",
	8: "slide(fromLeft)"
}

export const STRIPS: Readonly<Record<number, string>> = {
	3: "strips(downLeft)",
	6: "strips(upLeft)",
	9: "strips(downRight)",
	12: "strips(upRight)"
}

export const SPLITS: Readonly<Record<number, string>> = {
	21: "barn(inVertical)",
	26: "barn(inHorizontal)",
	37: "barn(outVertical)",
	42: "barn(outHorizontal)"
}

export const WHEELS: Readonly<Record<number, string>> = { 1: "wheel(1)", 2: "wheel(2)", 3: "wheel(3)", 4: "wheel(4)", 8: "wheel(8)" }

function zoomIn({ target, subtype, durationMs }: PresetBuild): TimeNode[] {
	// 16: from the shape's centre; 528: from the slide's centre; 32: down from larger.
	const start = subtype === 32 ? "#ppt_w*2" : "0"
	const startH = subtype === 32 ? "#ppt_h*2" : "0"
	const nodes = [
		show(target),
		anim(
			target,
			"ppt_w",
			[
				[0, start],
				[100000, "#ppt_w"]
			],
			durationMs
		),
		anim(
			target,
			"ppt_h",
			[
				[0, startH],
				[100000, "#ppt_h"]
			],
			durationMs
		)
	]

	if (subtype === 528) nodes.push(slide(target, "x", "0.5", "#ppt_x", durationMs), slide(target, "y", "0.5", "#ppt_y", durationMs))

	return nodes
}

function stretch({ target, subtype, durationMs }: PresetBuild): TimeNode[] {
	const across = subtype === 10
	const nodes = [show(target)]

	if (across || (subtype & 10) !== 0)
		nodes.push(
			anim(
				target,
				"ppt_w",
				[
					[0, "0"],
					[100000, "#ppt_w"]
				],
				durationMs
			)
		)
	if (across)
		nodes.push(
			anim(
				target,
				"ppt_h",
				[
					[0, "#ppt_h"],
					[100000, "#ppt_h"]
				],
				durationMs
			)
		)
	else if ((subtype & 5) !== 0)
		nodes.push(
			anim(
				target,
				"ppt_h",
				[
					[0, "0"],
					[100000, "#ppt_h"]
				],
				durationMs
			)
		)

	// From one edge: the edge stays where it is.
	if (subtype === 1) nodes.push(slide(target, "y", "#ppt_y-#ppt_h/2", "#ppt_y", durationMs))
	if (subtype === 4) nodes.push(slide(target, "y", "#ppt_y+#ppt_h/2", "#ppt_y", durationMs))
	if (subtype === 8) nodes.push(slide(target, "x", "#ppt_x-#ppt_w/2", "#ppt_x", durationMs))
	if (subtype === 2) nodes.push(slide(target, "x", "#ppt_x+#ppt_w/2", "#ppt_x", durationMs))

	return nodes
}

export const ENTRANCE_PRESETS: readonly EffectPreset[] = [
	{ presetClass: "entr", id: 1, name: "Appear", group: "basic", subtypes: [], durationMs: 1, build: ({ target }) => [show(target)] },
	{
		presetClass: "entr",
		id: 2,
		name: "FlyIn",
		group: "basic",
		subtypes: DIRECTIONS_8,
		durationMs: 500,
		build: ({ target, subtype, durationMs }) => [show(target), ...moves(target, offSlide(subtype), durationMs, false)]
	},
	{
		presetClass: "entr",
		id: 3,
		name: "Blinds",
		group: "basic",
		subtypes: [10, 5],
		durationMs: 500,
		build: filtered({ 10: "blinds(horizontal)", 5: "blinds(vertical)" }, "in")
	},
	{
		presetClass: "entr",
		id: 4,
		name: "Box",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: filtered({ 16: "box(in)", 32: "box(out)" }, "in")
	},
	{
		presetClass: "entr",
		id: 5,
		name: "Checkerboard",
		group: "basic",
		subtypes: [10, 5],
		durationMs: 500,
		build: filtered({ 10: "checkerboard(across)", 5: "checkerboard(down)" }, "in")
	},
	{
		presetClass: "entr",
		id: 6,
		name: "Circle",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: filtered({ 16: "circle(in)", 32: "circle(out)" }, "in")
	},
	{
		presetClass: "entr",
		id: 7,
		name: "CrawlIn",
		group: "basic",
		subtypes: DIRECTIONS_4,
		durationMs: 5000,
		build: ({ target, subtype, durationMs }) => [show(target), ...moves(target, offSlide(subtype), durationMs, false)]
	},
	{
		presetClass: "entr",
		id: 8,
		name: "Diamond",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: filtered({ 16: "diamond(in)", 32: "diamond(out)" }, "in")
	},
	{
		presetClass: "entr",
		id: 9,
		name: "DissolveIn",
		group: "basic",
		subtypes: [],
		durationMs: 500,
		build: filtered({ 0: "dissolve" }, "in")
	},
	{ presetClass: "entr", id: 10, name: "Fade", group: "subtle", subtypes: [], durationMs: 500, build: filtered({ 0: "fade" }, "in") },
	{
		presetClass: "entr",
		id: 12,
		name: "PeekIn",
		group: "basic",
		subtypes: DIRECTIONS_4,
		durationMs: 500,
		build: filtered(SLIDE_FROM, "in")
	},
	{
		presetClass: "entr",
		id: 13,
		name: "Plus",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: filtered({ 16: "plus(in)", 32: "plus(out)" }, "in")
	},
	{
		presetClass: "entr",
		id: 14,
		name: "RandomBars",
		group: "basic",
		subtypes: [10, 5],
		durationMs: 500,
		build: filtered({ 10: "randombar(horizontal)", 5: "randombar(vertical)" }, "in")
	},
	{
		presetClass: "entr",
		id: 15,
		name: "SpiralIn",
		group: "exciting",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			show(target),
			anim(
				target,
				"ppt_w",
				[
					[0, "0"],
					[100000, "#ppt_w"]
				],
				durationMs
			),
			anim(
				target,
				"ppt_h",
				[
					[0, "0"],
					[100000, "#ppt_h"]
				],
				durationMs
			),
			anim(
				target,
				"ppt_x",
				[
					[0, "0"],
					[100000, "1"]
				],
				durationMs,
				{ fmla: "#ppt_x+(1-$)*0.4*cos(4*pi*$)" }
			),
			anim(
				target,
				"ppt_y",
				[
					[0, "0"],
					[100000, "1"]
				],
				durationMs,
				{ fmla: "#ppt_y+(1-$)*0.4*sin(4*pi*$)" }
			)
		]
	},
	{
		presetClass: "entr",
		id: 16,
		name: "Split",
		group: "basic",
		subtypes: [21, 26, 37, 42],
		durationMs: 500,
		build: filtered(SPLITS, "in")
	},
	{ presetClass: "entr", id: 17, name: "Stretch", group: "moderate", subtypes: [10, 1, 2, 4, 8], durationMs: 500, build: stretch },
	{
		presetClass: "entr",
		id: 18,
		name: "Strips",
		group: "basic",
		subtypes: [12, 9, 6, 3],
		durationMs: 500,
		build: filtered(STRIPS, "in")
	},
	{
		presetClass: "entr",
		id: 19,
		name: "Swivel",
		group: "moderate",
		subtypes: [10, 5],
		durationMs: 500,
		build: ({ target, subtype, durationMs }) => [
			show(target),
			anim(
				target,
				subtype === 5 ? "ppt_h" : "ppt_w",
				[
					[0, "0"],
					[100000, subtype === 5 ? "#ppt_h" : "#ppt_w"]
				],
				durationMs,
				{
					fmla: subtype === 5 ? "#ppt_h*sin(2.5*pi*$)" : "#ppt_w*sin(2.5*pi*$)"
				}
			),
			filter(target, "in", "fade", durationMs)
		]
	},
	{ presetClass: "entr", id: 20, name: "Wedge", group: "basic", subtypes: [], durationMs: 500, build: filtered({ 0: "wedge" }, "in") },
	{
		presetClass: "entr",
		id: 21,
		name: "Wheel",
		group: "basic",
		subtypes: [1, 2, 3, 4, 8],
		durationMs: 2000,
		build: filtered(WHEELS, "in")
	},
	{
		presetClass: "entr",
		id: 22,
		name: "Wipe",
		group: "basic",
		subtypes: DIRECTIONS_4,
		durationMs: 500,
		build: ({ target, subtype, durationMs }) => [
			show(target),
			filter(target, "in", `wipe(${SIDE_FILTER[subtype] ?? "up"})`, durationMs)
		]
	},
	{ presetClass: "entr", id: 23, name: "Zoom", group: "moderate", subtypes: [16, 528, 32], durationMs: 500, build: zoomIn },
	{
		presetClass: "entr",
		id: 26,
		name: "Bounce",
		group: "exciting",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [
			show(target),
			anim(
				target,
				"ppt_x",
				[
					[0, "#ppt_x-0.25"],
					[100000, "#ppt_x"]
				],
				durationMs
			),
			anim(
				target,
				"ppt_y",
				[
					[0, "0"],
					[100000, "1"]
				],
				durationMs,
				{ fmla: "#ppt_y-abs(sin(3*pi*$))*(1-$)*0.25" }
			)
		]
	},
	{
		presetClass: "entr",
		id: 30,
		name: "Float",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			show(target),
			slide(target, "y", "#ppt_y+0.1", "#ppt_y", durationMs, { decel: 100000 }),
			filter(target, "in", "fade", durationMs)
		]
	},
	{
		presetClass: "entr",
		id: 37,
		name: "RiseUp",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			show(target),
			slide(target, "y", "1+#ppt_h/2", "#ppt_y-0.03", durationMs * 0.9, { decel: 100000 }),
			slide(target, "y", "#ppt_y-0.03", "#ppt_y", durationMs * 0.1, { delay: durationMs * 0.9, accel: 100000 }),
			filter(target, "in", "fade", durationMs)
		]
	},
	{
		presetClass: "entr",
		id: 42,
		name: "Ascend",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			show(target),
			slide(target, "y", "#ppt_y+0.1", "#ppt_y", durationMs, { decel: 100000 }),
			filter(target, "in", "fade", durationMs)
		]
	},
	{
		presetClass: "entr",
		id: 47,
		name: "Descend",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			show(target),
			slide(target, "y", "#ppt_y-0.1", "#ppt_y", durationMs, { decel: 100000 }),
			filter(target, "in", "fade", durationMs)
		]
	},
	{
		presetClass: "entr",
		id: 50,
		name: "Compress",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			show(target),
			anim(
				target,
				"ppt_w",
				[
					[0, "#ppt_w*1.5"],
					[100000, "#ppt_w"]
				],
				durationMs,
				{ decel: 100000 }
			),
			filter(target, "in", "fade", durationMs)
		]
	},
	{
		presetClass: "entr",
		id: 53,
		name: "FadedZoom",
		group: "subtle",
		subtypes: [16, 528],
		durationMs: 500,
		build: options => [...zoomIn(options), filter(options.target, "in", "fade", options.durationMs)]
	},
	{
		presetClass: "entr",
		id: 55,
		name: "Expand",
		group: "subtle",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			show(target),
			scale(target, { from: { x: 70000, y: 70000 }, to: { x: 100000, y: 100000 } }, durationMs, { decel: 100000 }),
			filter(target, "in", "fade", durationMs)
		]
	}
]

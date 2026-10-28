import type { TimeNode } from "../../model"
import { anim, filter, hide, scale, slide } from "./build"
import { DIRECTIONS_4, DIRECTIONS_8, moves, offSlide, SIDE_FILTER, SPLITS, STRIPS, WHEELS } from "./entrance"
import type { EffectPreset, PresetBuild } from "./types"

// Exit presets (presetClass "exit"): each takes its target out, then hides it at its end (style.visibility).

const IN_OUT = [16, 32] as const

// The wipe that takes a shape away towards `side` (the reverse of the entrance's).
const WIPE_OUT: Readonly<Record<number, string>> = { 1: "up", 2: "right", 4: "down", 8: "left" }

const SLIDE_TO: Readonly<Record<number, string>> = {
	1: "slide(fromBottom)",
	2: "slide(fromLeft)",
	4: "slide(fromTop)",
	8: "slide(fromRight)"
}

function out(names: Readonly<Record<number, string>>) {
	return ({ target, subtype, durationMs }: PresetBuild): TimeNode[] => [
		filter(target, "out", names[subtype] ?? Object.values(names)[0] ?? "fade", durationMs),
		hide(target, durationMs)
	]
}

function zoomOut({ target, subtype, durationMs }: PresetBuild): TimeNode[] {
	const end = subtype === 32 ? "#ppt_w*2" : "0"
	const endH = subtype === 32 ? "#ppt_h*2" : "0"
	const nodes = [
		anim(
			target,
			"ppt_w",
			[
				[0, "#ppt_w"],
				[100000, end]
			],
			durationMs
		),
		anim(
			target,
			"ppt_h",
			[
				[0, "#ppt_h"],
				[100000, endH]
			],
			durationMs
		)
	]

	if (subtype === 36) nodes.push(slide(target, "x", "#ppt_x", "0.5", durationMs), slide(target, "y", "#ppt_y", "0.5", durationMs))

	return [...nodes, hide(target, durationMs)]
}

function collapse({ target, subtype, durationMs }: PresetBuild): TimeNode[] {
	const nodes: TimeNode[] = []

	if (subtype === 10 || (subtype & 10) !== 0)
		nodes.push(
			anim(
				target,
				"ppt_w",
				[
					[0, "#ppt_w"],
					[100000, "0"]
				],
				durationMs
			)
		)
	if (subtype !== 10 && (subtype & 5) !== 0)
		nodes.push(
			anim(
				target,
				"ppt_h",
				[
					[0, "#ppt_h"],
					[100000, "0"]
				],
				durationMs
			)
		)
	if (subtype === 1) nodes.push(slide(target, "y", "#ppt_y", "#ppt_y-#ppt_h/2", durationMs))
	if (subtype === 4) nodes.push(slide(target, "y", "#ppt_y", "#ppt_y+#ppt_h/2", durationMs))
	if (subtype === 8) nodes.push(slide(target, "x", "#ppt_x", "#ppt_x-#ppt_w/2", durationMs))
	if (subtype === 2) nodes.push(slide(target, "x", "#ppt_x", "#ppt_x+#ppt_w/2", durationMs))

	return [...nodes, hide(target, durationMs)]
}

export const EXIT_PRESETS: readonly EffectPreset[] = [
	{
		presetClass: "exit",
		id: 1,
		name: "Disappear",
		group: "basic",
		subtypes: [],
		durationMs: 1,
		build: ({ target }) => [hide(target, 1)]
	},
	{
		presetClass: "exit",
		id: 2,
		name: "FlyOut",
		group: "basic",
		subtypes: DIRECTIONS_8,
		durationMs: 500,
		build: ({ target, subtype, durationMs }) => [...moves(target, offSlide(subtype), durationMs, true), hide(target, durationMs)]
	},
	{
		presetClass: "exit",
		id: 3,
		name: "Blinds",
		group: "basic",
		subtypes: [10, 5],
		durationMs: 500,
		build: out({ 10: "blinds(horizontal)", 5: "blinds(vertical)" })
	},
	{
		presetClass: "exit",
		id: 4,
		name: "Box",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: out({ 16: "box(in)", 32: "box(out)" })
	},
	{
		presetClass: "exit",
		id: 5,
		name: "Checkerboard",
		group: "basic",
		subtypes: [10, 5],
		durationMs: 500,
		build: out({ 10: "checkerboard(across)", 5: "checkerboard(down)" })
	},
	{
		presetClass: "exit",
		id: 6,
		name: "Circle",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: out({ 16: "circle(in)", 32: "circle(out)" })
	},
	{
		presetClass: "exit",
		id: 7,
		name: "CrawlOut",
		group: "basic",
		subtypes: DIRECTIONS_4,
		durationMs: 5000,
		build: ({ target, subtype, durationMs }) => [...moves(target, offSlide(subtype), durationMs, true), hide(target, durationMs)]
	},
	{
		presetClass: "exit",
		id: 8,
		name: "Diamond",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: out({ 16: "diamond(in)", 32: "diamond(out)" })
	},
	{ presetClass: "exit", id: 9, name: "DissolveOut", group: "basic", subtypes: [], durationMs: 500, build: out({ 0: "dissolve" }) },
	{ presetClass: "exit", id: 10, name: "Fade", group: "subtle", subtypes: [], durationMs: 500, build: out({ 0: "fade" }) },
	{ presetClass: "exit", id: 12, name: "PeekOut", group: "basic", subtypes: DIRECTIONS_4, durationMs: 500, build: out(SLIDE_TO) },
	{
		presetClass: "exit",
		id: 13,
		name: "Plus",
		group: "basic",
		subtypes: IN_OUT,
		durationMs: 500,
		build: out({ 16: "plus(in)", 32: "plus(out)" })
	},
	{
		presetClass: "exit",
		id: 14,
		name: "RandomBars",
		group: "basic",
		subtypes: [10, 5],
		durationMs: 500,
		build: out({ 10: "randombar(horizontal)", 5: "randombar(vertical)" })
	},
	{
		presetClass: "exit",
		id: 15,
		name: "SpiralOut",
		group: "exciting",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			anim(
				target,
				"ppt_w",
				[
					[0, "#ppt_w"],
					[100000, "0"]
				],
				durationMs
			),
			anim(
				target,
				"ppt_h",
				[
					[0, "#ppt_h"],
					[100000, "0"]
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
				{ fmla: "#ppt_x+$*0.4*cos(4*pi*$)" }
			),
			anim(
				target,
				"ppt_y",
				[
					[0, "0"],
					[100000, "1"]
				],
				durationMs,
				{ fmla: "#ppt_y+$*0.4*sin(4*pi*$)" }
			),
			hide(target, durationMs)
		]
	},
	{ presetClass: "exit", id: 16, name: "Split", group: "basic", subtypes: [21, 26, 37, 42], durationMs: 500, build: out(SPLITS) },
	{ presetClass: "exit", id: 17, name: "Collapse", group: "moderate", subtypes: [10, 1, 2, 4, 8], durationMs: 500, build: collapse },
	{ presetClass: "exit", id: 18, name: "Strips", group: "basic", subtypes: [12, 9, 6, 3], durationMs: 500, build: out(STRIPS) },
	{
		presetClass: "exit",
		id: 19,
		name: "Swivel",
		group: "moderate",
		subtypes: [10, 5],
		durationMs: 500,
		build: ({ target, subtype, durationMs }) => [
			anim(
				target,
				subtype === 5 ? "ppt_h" : "ppt_w",
				[
					[0, "0"],
					[100000, "1"]
				],
				durationMs,
				{
					fmla: subtype === 5 ? "#ppt_h*cos(2.5*pi*$)" : "#ppt_w*cos(2.5*pi*$)"
				}
			),
			filter(target, "out", "fade", durationMs),
			hide(target, durationMs)
		]
	},
	{ presetClass: "exit", id: 20, name: "Wedge", group: "basic", subtypes: [], durationMs: 500, build: out({ 0: "wedge" }) },
	{ presetClass: "exit", id: 21, name: "Wheel", group: "basic", subtypes: [1, 2, 3, 4, 8], durationMs: 2000, build: out(WHEELS) },
	{
		presetClass: "exit",
		id: 22,
		name: "Wipe",
		group: "basic",
		subtypes: DIRECTIONS_4,
		durationMs: 500,
		build: ({ target, subtype, durationMs }) => [
			filter(target, "out", `wipe(${WIPE_OUT[subtype] ?? SIDE_FILTER[subtype] ?? "down"})`, durationMs),
			hide(target, durationMs)
		]
	},
	{ presetClass: "exit", id: 23, name: "Zoom", group: "moderate", subtypes: [16, 36, 32], durationMs: 500, build: zoomOut },
	{
		presetClass: "exit",
		id: 26,
		name: "Bounce",
		group: "exciting",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [
			anim(
				target,
				"ppt_x",
				[
					[0, "#ppt_x"],
					[100000, "#ppt_x+0.25"]
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
				{ fmla: "#ppt_y-abs(sin(3*pi*$))*$*0.25" }
			),
			hide(target, durationMs)
		]
	},
	{
		presetClass: "exit",
		id: 30,
		name: "Float",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			slide(target, "y", "#ppt_y", "#ppt_y-0.1", durationMs, { accel: 100000 }),
			filter(target, "out", "fade", durationMs),
			hide(target, durationMs)
		]
	},
	{
		presetClass: "exit",
		id: 37,
		name: "SinkDown",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			slide(target, "y", "#ppt_y", "#ppt_y-0.03", durationMs * 0.1, { decel: 100000 }),
			slide(target, "y", "#ppt_y-0.03", "1+#ppt_h/2", durationMs * 0.9, { delay: durationMs * 0.1, accel: 100000 }),
			filter(target, "out", "fade", durationMs),
			hide(target, durationMs)
		]
	},
	{
		presetClass: "exit",
		id: 42,
		name: "Descend",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			slide(target, "y", "#ppt_y", "#ppt_y+0.1", durationMs, { accel: 100000 }),
			filter(target, "out", "fade", durationMs),
			hide(target, durationMs)
		]
	},
	{
		presetClass: "exit",
		id: 47,
		name: "Ascend",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			slide(target, "y", "#ppt_y", "#ppt_y-0.1", durationMs, { accel: 100000 }),
			filter(target, "out", "fade", durationMs),
			hide(target, durationMs)
		]
	},
	{
		presetClass: "exit",
		id: 50,
		name: "Stretchy",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			anim(
				target,
				"ppt_w",
				[
					[0, "#ppt_w"],
					[100000, "#ppt_w*1.5"]
				],
				durationMs,
				{ accel: 100000 }
			),
			filter(target, "out", "fade", durationMs),
			hide(target, durationMs)
		]
	},
	{
		presetClass: "exit",
		id: 53,
		name: "FadedZoom",
		group: "subtle",
		subtypes: [16, 36],
		durationMs: 500,
		build: options => {
			const nodes = zoomOut(options)

			return [...nodes.slice(0, -1), filter(options.target, "out", "fade", options.durationMs), ...nodes.slice(-1)]
		}
	},
	{
		presetClass: "exit",
		id: 55,
		name: "Contract",
		group: "subtle",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			scale(target, { from: { x: 100000, y: 100000 }, to: { x: 70000, y: 70000 } }, durationMs, { accel: 100000 }),
			filter(target, "out", "fade", durationMs),
			hide(target, durationMs)
		]
	}
]

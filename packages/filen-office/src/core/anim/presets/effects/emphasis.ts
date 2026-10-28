import { anim, colorBy, colorTo, rotate, scale, set } from "./build"
import type { EffectPreset } from "./types"

// Emphasis presets (presetClass "emph"): each changes how its target looks while it stays on the slide. Hue in
// 60,000ths of a degree; saturation and lightness offsets in 1/1000 of a percent; scales in 1/1000 of a percent.

export const EMPHASIS_PRESETS: readonly EffectPreset[] = [
	{
		presetClass: "emph",
		id: 1,
		name: "FillColor",
		group: "basic",
		subtypes: [],
		durationMs: 2000,
		colored: true,
		build: ({ target, durationMs, color }) => [
			colorTo(target, "fill.color", color, durationMs),
			set(target, "fill.type", "solid"),
			set(target, "fill.on", "true")
		]
	},
	{
		presetClass: "emph",
		id: 3,
		name: "FontColor",
		group: "basic",
		subtypes: [],
		durationMs: 2000,
		needs: "text",
		colored: true,
		build: ({ target, durationMs, color }) => [colorTo(target, "style.color", color, durationMs)]
	},
	{
		presetClass: "emph",
		id: 28,
		name: "GrowWithColor",
		group: "moderate",
		subtypes: [],
		durationMs: 1000,
		colored: true,
		build: ({ target, durationMs, color }) => [
			scale(target, { by: { x: 110000, y: 110000 } }, durationMs),
			colorTo(target, "fill.color", color, durationMs),
			set(target, "fill.on", "true")
		]
	},
	{
		presetClass: "emph",
		id: 5,
		name: "FontStyle",
		group: "basic",
		subtypes: [],
		durationMs: 1000,
		needs: "text",
		build: ({ target, durationMs }) => [
			set(target, "style.fontStyle", "italic", { dur: durationMs }),
			set(target, "style.fontWeight", "bold", { dur: durationMs })
		]
	},
	{
		presetClass: "emph",
		id: 6,
		name: "GrowShrink",
		group: "basic",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [scale(target, { by: { x: 150000, y: 150000 } }, durationMs, { decel: 50000 })]
	},
	{
		presetClass: "emph",
		id: 7,
		name: "LineColor",
		group: "basic",
		subtypes: [],
		durationMs: 2000,
		colored: true,
		build: ({ target, durationMs, color }) => [colorTo(target, "stroke.color", color, durationMs), set(target, "stroke.on", "true")]
	},
	{
		presetClass: "emph",
		id: 8,
		name: "Spin",
		group: "basic",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [rotate(target, 21600000, durationMs)]
	},
	{
		presetClass: "emph",
		id: 9,
		name: "Transparency",
		group: "basic",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [set(target, "style.opacity", "0.5", { dur: durationMs })]
	},
	{
		presetClass: "emph",
		id: 10,
		name: "BoldFlash",
		group: "subtle",
		subtypes: [],
		durationMs: 1000,
		needs: "text",
		build: ({ target, durationMs }) => [set(target, "style.fontWeight", "bold", { dur: durationMs, fill: "remove" })]
	},
	{
		presetClass: "emph",
		id: 15,
		name: "BoldReveal",
		group: "subtle",
		subtypes: [],
		durationMs: 1000,
		needs: "text",
		build: ({ target, durationMs }) => [set(target, "style.fontWeight", "bold", { dur: durationMs })]
	},
	{
		presetClass: "emph",
		id: 18,
		name: "Underline",
		group: "subtle",
		subtypes: [],
		durationMs: 1000,
		needs: "text",
		build: ({ target, durationMs }) => [set(target, "style.textDecorationUnderline", "true", { dur: durationMs })]
	},
	{
		presetClass: "emph",
		id: 19,
		name: "ColorBlend",
		group: "moderate",
		subtypes: [],
		durationMs: 2000,
		colored: true,
		build: ({ target, durationMs, color }) => [
			colorTo(target, "fill.color", color, durationMs),
			colorTo(target, "stroke.color", color, durationMs),
			set(target, "fill.on", "true")
		]
	},
	{
		presetClass: "emph",
		id: 21,
		name: "ComplementaryColor",
		group: "moderate",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [colorBy(target, "fill.color", { h: 10800000, s: 0, l: 0 }, durationMs, { dir: "cw" })]
	},
	{
		presetClass: "emph",
		id: 24,
		name: "Darken",
		group: "moderate",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [colorBy(target, "fill.color", { h: 0, s: 0, l: -30000 }, durationMs)]
	},
	{
		presetClass: "emph",
		id: 25,
		name: "Desaturate",
		group: "moderate",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [colorBy(target, "fill.color", { h: 0, s: -100000, l: 0 }, durationMs)]
	},
	{
		presetClass: "emph",
		id: 26,
		name: "Pulse",
		group: "subtle",
		subtypes: [],
		durationMs: 500,
		build: ({ target, durationMs }) => [
			scale(target, { by: { x: 105000, y: 105000 } }, durationMs / 2, { autoRev: true, fill: "hold" }),
			anim(
				target,
				"style.opacity",
				[
					[0, "1"],
					[50000, "0.6"],
					[100000, "1"]
				],
				durationMs
			)
		]
	},
	{
		presetClass: "emph",
		id: 27,
		name: "Flicker",
		group: "subtle",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			anim(
				target,
				"style.opacity",
				[
					[0, "1"],
					[25000, "0.2"],
					[50000, "1"],
					[75000, "0.2"],
					[100000, "1"]
				],
				durationMs,
				{
					calcmode: "discrete"
				}
			)
		]
	},
	{
		presetClass: "emph",
		id: 30,
		name: "Lighten",
		group: "moderate",
		subtypes: [],
		durationMs: 2000,
		build: ({ target, durationMs }) => [colorBy(target, "fill.color", { h: 0, s: 0, l: 30000 }, durationMs)]
	},
	{
		presetClass: "emph",
		id: 32,
		name: "Teeter",
		group: "subtle",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			rotate(target, 240000, durationMs / 4),
			rotate(target, -480000, durationMs / 2, { delay: durationMs / 4 }),
			rotate(target, 240000, durationMs / 4, { delay: (durationMs * 3) / 4 })
		]
	},
	{
		presetClass: "emph",
		id: 35,
		name: "Blink",
		group: "exciting",
		subtypes: [],
		durationMs: 1000,
		build: ({ target, durationMs }) => [
			anim(
				target,
				"style.visibility",
				[
					[0, "hidden"],
					[50000, "visible"]
				],
				durationMs,
				{ calcmode: "discrete", valueType: "str" }
			)
		]
	}
]

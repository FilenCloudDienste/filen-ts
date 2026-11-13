import { describe, expect, it } from "vitest"
import { transformPoint } from "@/features/preview/imageEdit/lib/recipe"
import {
	fitWidth,
	minification,
	needsGpuPass,
	outputToTexture,
	overlayBox,
	overlayVisible,
	videoGrade
} from "@/features/preview/videoEdit/gl/pipeline.logic"
import { displayToCoded } from "@/features/preview/videoEdit/lib/plan"
import type { VideoEditRecipe, VideoRotation } from "@/features/preview/videoEdit/types"

function recipe(overrides: Partial<VideoEditRecipe> = {}): VideoEditRecipe {
	return {
		keep: [{ start: 0, end: 10 }],
		crop: null,
		rotate: 0,
		flipH: false,
		flipV: false,
		output: { resolution: "original", quality: "high" },
		audio: { mute: false, gainDb: 0, keepTracks: "first" },
		speed: 1,
		adjust: { exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, warmth: 0, tint: 0, saturation: 0, vibrance: 0 },
		filter: null,
		text: [],
		precise: false,
		removeLocation: false,
		...overrides
	}
}

const HD = { width: 1920, height: 1080 }

function expectPoint(actual: [number, number], expected: [number, number]): void {
	expect(actual[0]).toBeCloseTo(expected[0], 9)
	expect(actual[1]).toBeCloseTo(expected[1], 9)
}

describe("fitWidth", () => {
	it("fits a preview inside the width without enlarging", () => {
		expect(fitWidth(HD, 480)).toEqual({ width: 480, height: 270 })
		expect(fitWidth({ width: 300, height: 200 }, 480)).toEqual({ width: 300, height: 200 })
		expect(fitWidth({ width: 300, height: 1 }, 10)).toEqual({ width: 10, height: 1 })
	})
})

describe("outputToTexture", () => {
	it("is the normalised identity for an untouched recipe", () => {
		const m = outputToTexture(HD, 0, recipe(), { width: 960, height: 540 })

		expectPoint(transformPoint(m, 0, 0), [0, 0])
		expectPoint(transformPoint(m, 960, 540), [1, 1])
		expectPoint(transformPoint(m, 480, 270), [0.5, 0.5])
	})

	it("crops in display space", () => {
		const m = outputToTexture(HD, 0, recipe({ crop: { x: 192, y: 108, width: 960, height: 540 } }), { width: 960, height: 540 })

		expectPoint(transformPoint(m, 0, 0), [0.1, 0.1])
		expectPoint(transformPoint(m, 960, 540), [0.6, 0.6])
	})

	it("turns clockwise: the output's top-left shows the picture's bottom-left, its top-right the top-left", () => {
		const m = outputToTexture(HD, 0, recipe({ rotate: 90 }), { width: 1080, height: 1920 })

		expectPoint(transformPoint(m, 0, 0), [0, 1])
		expectPoint(transformPoint(m, 1080, 0), [0, 0])
		expectPoint(transformPoint(m, 1080, 1920), [1, 0])
	})

	it("turns 180 and 270", () => {
		expectPoint(transformPoint(outputToTexture(HD, 0, recipe({ rotate: 180 }), HD), 0, 0), [1, 1])
		// 270 clockwise = 90 anticlockwise: the output's top-left shows the picture's top-right.
		expectPoint(transformPoint(outputToTexture(HD, 0, recipe({ rotate: 270 }), { width: 1080, height: 1920 }), 0, 0), [1, 0])
	})

	it("flips in the turned frame", () => {
		expectPoint(transformPoint(outputToTexture(HD, 0, recipe({ flipH: true }), HD), 0, 0), [1, 0])
		expectPoint(transformPoint(outputToTexture(HD, 0, recipe({ flipV: true }), HD), 0, 0), [0, 1])
		// Turned, then mirrored left to right: the top-left shows what the turned frame had top-right.
		expectPoint(
			transformPoint(outputToTexture(HD, 0, recipe({ rotate: 90, flipH: true }), { width: 1080, height: 1920 }), 0, 0),
			[0, 0]
		)
	})

	it("undoes the source's rotation metadata: display space is the turned picture", () => {
		// A phone video: decoded 1920×1080, shown turned 90° clockwise as 1080×1920.
		const display = { width: 1080, height: 1920 }
		const m = outputToTexture(display, 90, recipe(), display)

		// The display's top-left is the decoded picture's bottom-left.
		expectPoint(transformPoint(m, 0, 0), [0, 1])
		expectPoint(transformPoint(m, 1080, 0), [0, 0])

		// A crop of the display's top half is the decoded picture's left half.
		const top = outputToTexture(display, 90, recipe({ crop: { x: 0, y: 0, width: 1080, height: 960 } }), { width: 1080, height: 960 })

		expectPoint(transformPoint(top, 0, 0), [0, 1])
		expectPoint(transformPoint(top, 1080, 960), [0.5, 0])
	})

	it("draws the same picture from the export's coded-orientation recipe as from the preview's display one", () => {
		// Decoded 1920×1080; shown turned by the source's rotation.
		const natural = { width: 1920, height: 1080 }

		for (const source of [0, 90, 180, 270] as VideoRotation[]) {
			for (const user of [0, 90, 180, 270] as VideoRotation[]) {
				const sideways = source % 180 !== 0
				const display = sideways ? { width: 1080, height: 1920 } : natural
				const crop = { x: 100, y: 60, width: 400, height: 300 }
				const out = user % 180 === 0 ? { width: 400, height: 300 } : { width: 300, height: 400 }
				const flips = { flipH: true, flipV: false }
				const preview = outputToTexture(display, source, recipe({ crop, rotate: user, ...flips }), out)
				const exported = outputToTexture(
					natural,
					0,
					recipe({
						crop: displayToCoded(crop, source, natural.width, natural.height),
						rotate: ((source + user) % 360) as VideoRotation,
						...flips
					}),
					out
				)

				for (const [x, y] of [
					[0, 0],
					[out.width, 0],
					[17, 233],
					[out.width, out.height]
				] as const) {
					expectPoint(transformPoint(exported, x, y), transformPoint(preview, x, y))
				}
			}
		}
	})

	it("scales to the output", () => {
		const m = outputToTexture(HD, 0, recipe(), { width: 192, height: 108 })

		expectPoint(transformPoint(m, 96, 54), [0.5, 0.5])
		expect(minification(HD, m)).toBeCloseTo(10, 9)
		expect(minification(HD, outputToTexture(HD, 0, recipe(), HD))).toBeCloseTo(1, 9)
	})
})

describe("videoGrade", () => {
	it("adds the filter preset's offsets, vignette included, without touching the sliders", () => {
		const r = recipe({ filter: "noir", adjust: { ...recipe().adjust, contrast: 10 } })
		const grade = videoGrade(r)

		expect(grade.saturation).toBe(-100)
		expect(grade.contrast).toBe(55)
		expect(grade.vignette).toBe(30)
		expect(r.adjust.contrast).toBe(10)
	})

	it("has no vignette or sharpening without a filter", () => {
		const grade = videoGrade(recipe({ adjust: { ...recipe().adjust, exposure: 20 } }))

		expect(grade.exposure).toBe(20)
		expect(grade.vignette).toBe(0)
	})
})

describe("needsGpuPass", () => {
	it("is false for an untouched recipe, a trim, a crop, a speed change or audio edits", () => {
		expect(needsGpuPass(recipe())).toBe(false)
		expect(needsGpuPass(recipe({ keep: [{ start: 1, end: 2 }], crop: { x: 0, y: 0, width: 640, height: 480 }, speed: 2 }))).toBe(false)
		expect(needsGpuPass(recipe({ audio: { mute: true, gainDb: 3, keepTracks: [1, 2] } }))).toBe(false)
	})

	it("is false for a rotation alone (metadata), true for colour, text, flips and a tone map", () => {
		expect(needsGpuPass(recipe({ filter: "mono" }))).toBe(true)
		expect(
			needsGpuPass(
				recipe({
					text: [{ id: "a", text: "hi", startSec: 0, endSec: 1, x: 0.5, y: 0.5, size: 0.1, color: "#fff", background: false }]
				})
			)
		).toBe(true)
		expect(needsGpuPass(recipe({ flipV: true }))).toBe(true)
		expect(needsGpuPass(recipe({ rotate: 270 }))).toBe(false)
		expect(needsGpuPass(recipe(), { hdr: "toSdr" })).toBe(true)
		expect(needsGpuPass(recipe(), { hdr: "keep" })).toBe(false)
	})

	it("needs a resize only when the plan scales the output", () => {
		const r = recipe({ output: { resolution: 1080, quality: "high" } })

		expect(needsGpuPass(r)).toBe(false)
		expect(needsGpuPass(r, { scaled: true })).toBe(true)
	})
})

describe("overlays", () => {
	it("shows from the start up to the end", () => {
		expect(overlayVisible({ startSec: 1, endSec: 2 }, 0.99)).toBe(false)
		expect(overlayVisible({ startSec: 1, endSec: 2 }, 1)).toBe(true)
		expect(overlayVisible({ startSec: 1, endSec: 2 }, 2)).toBe(false)
	})

	it("centres the raster on the box's point", () => {
		expect(overlayBox({ x: 0.5, y: 0.25 }, { width: 200, height: 50 }, HD)).toEqual({ left: 860, top: 245, right: 1060, bottom: 295 })
	})
})

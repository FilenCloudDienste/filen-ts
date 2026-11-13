import { describe, expect, it } from "vitest"
import {
	aspectCrop,
	clampGain,
	clampSpeed,
	clampTexts,
	cropFromNormalised,
	cropToNormalised,
	edgeBounds,
	identityVideoRecipe,
	isIdentityVideoRecipe,
	keepIndexAt,
	keptDuration,
	MIN_KEEP_SECONDS,
	moveKeepEdge,
	newTextOverlay,
	normaliseKeep,
	outputDuration,
	outputToSource,
	playableTime,
	previewVolume,
	rectFromView,
	rectToView,
	removedRanges,
	removeSection,
	restoreSection,
	setTrim,
	sourceToOutput,
	toggleTrack,
	turnRecipe,
	flipRecipe
} from "@/features/preview/videoEdit/lib/recipe"
import type { VideoRotation } from "@/features/preview/videoEdit/types"

describe("identity", () => {
	it("keeps the whole source and is clean", () => {
		const recipe = identityVideoRecipe(10)

		expect(recipe.keep).toEqual([{ start: 0, end: 10 }])
		expect(isIdentityVideoRecipe(recipe, 10)).toBe(true)
	})

	it("is dirty for any change that alters the output", () => {
		const base = identityVideoRecipe(10)

		expect(isIdentityVideoRecipe({ ...base, keep: [{ start: 1, end: 10 }] }, 10)).toBe(false)
		expect(isIdentityVideoRecipe({ ...base, speed: 2 }, 10)).toBe(false)
		expect(isIdentityVideoRecipe({ ...base, rotate: 90 }, 10)).toBe(false)
		expect(isIdentityVideoRecipe({ ...base, adjust: { ...base.adjust, contrast: 5 } }, 10)).toBe(false)
		expect(isIdentityVideoRecipe({ ...base, audio: { ...base.audio, keepTracks: [1, 2] } }, 10)).toBe(false)
		expect(isIdentityVideoRecipe({ ...base, removeLocation: true }, 10)).toBe(false)
		expect(isIdentityVideoRecipe({ ...base, output: { resolution: 720, quality: "high" } }, 10)).toBe(false)
	})

	it("is clean when only the precision or quality changed", () => {
		const base = identityVideoRecipe(10)

		expect(isIdentityVideoRecipe({ ...base, precise: true, output: { resolution: "original", quality: "low" } }, 10)).toBe(true)
	})
})

describe("keep ranges", () => {
	it("normalises: clamps, sorts, merges overlapping and touching, drops slivers", () => {
		expect(
			normaliseKeep(
				[
					{ start: 8, end: 12 },
					{ start: -1, end: 2 },
					{ start: 2, end: 3 },
					{ start: 5, end: 5.05 }
				],
				10
			)
		).toEqual([
			{ start: 0, end: 3 },
			{ start: 8, end: 10 }
		])
	})

	it("removes a section and never leaves nothing", () => {
		const keep = [{ start: 0, end: 10 }]

		expect(removeSection(keep, { start: 3, end: 5 }, 10)).toEqual([
			{ start: 0, end: 3 },
			{ start: 5, end: 10 }
		])
		expect(removeSection(keep, { start: 5, end: 3 }, 10)).toEqual([
			{ start: 0, end: 3 },
			{ start: 5, end: 10 }
		])
		expect(removeSection(keep, { start: 0, end: 10 }, 10)).toBeNull()
	})

	it("restores a removed section", () => {
		const cut = removeSection([{ start: 0, end: 10 }], { start: 3, end: 5 }, 10) ?? []

		expect(removedRanges(cut, 10)).toEqual([{ start: 3, end: 5 }])
		expect(restoreSection(cut, { start: 3, end: 5 }, 10)).toEqual([{ start: 0, end: 10 }])
	})

	it("lists the removed ranges including the trimmed ends", () => {
		expect(
			removedRanges(
				[
					{ start: 1, end: 3 },
					{ start: 5, end: 8 }
				],
				10
			)
		).toEqual([
			{ start: 0, end: 1 },
			{ start: 3, end: 5 },
			{ start: 8, end: 10 }
		])
	})

	it("trims the first start and the last end, dropping ranges passed", () => {
		const keep = [
			{ start: 0, end: 3 },
			{ start: 5, end: 10 }
		]

		expect(setTrim(keep, "start", 4, 10)).toEqual([{ start: 5, end: 10 }])
		expect(setTrim(keep, "start", 1, 10)).toEqual([
			{ start: 1, end: 3 },
			{ start: 5, end: 10 }
		])
		expect(setTrim(keep, "end", 2, 10)).toEqual([{ start: 0, end: 2 }])
		// Never past the other end.
		expect(setTrim([{ start: 0, end: 10 }], "start", 20, 10)).toEqual([{ start: 10 - MIN_KEEP_SECONDS, end: 10 }])
	})

	it("moves an inner edge within its neighbours and merges on meeting one", () => {
		const keep = [
			{ start: 0, end: 3 },
			{ start: 5, end: 10 }
		]

		expect(edgeBounds(keep, 1, "start", 10)).toEqual({ start: 3, end: 10 - MIN_KEEP_SECONDS })
		expect(moveKeepEdge(keep, 1, "start", 4, 10)).toEqual([
			{ start: 0, end: 3 },
			{ start: 4, end: 10 }
		])
		expect(moveKeepEdge(keep, 1, "start", 1, 10)).toEqual([{ start: 0, end: 10 }])
		expect(moveKeepEdge(keep, 0, "end", 9, 10)).toEqual([{ start: 0, end: 10 }])
	})

	it("maps source and output times through cuts and speed", () => {
		const keep = [
			{ start: 0, end: 2 },
			{ start: 4, end: 8 }
		]

		expect(keptDuration(keep)).toBe(6)
		expect(outputDuration(keep, 2)).toBe(3)
		expect(sourceToOutput(keep, 1, 5)).toBe(3)
		expect(sourceToOutput(keep, 1, 3)).toBe(2)
		expect(sourceToOutput(keep, 2, 5)).toBe(1.5)
		expect(outputToSource(keep, 1, 3)).toBe(5)
		expect(outputToSource(keep, 2, 1.5)).toBe(5)
		expect(outputToSource(keep, 1, 100)).toBe(8)
		expect(keepIndexAt(keep, 3)).toBe(-1)
		expect(keepIndexAt(keep, 4)).toBe(1)
	})

	it("skips removed ranges and loops while playing", () => {
		const keep = [
			{ start: 1, end: 2 },
			{ start: 4, end: 8 }
		]

		expect(playableTime(keep, 1.5, null)).toEqual({ time: 1.5, jumped: false })
		expect(playableTime(keep, 2.01, null)).toEqual({ time: 4, jumped: true })
		expect(playableTime(keep, 0, null)).toEqual({ time: 1, jumped: true })
		expect(playableTime(keep, 8, null)).toEqual({ time: 1, jumped: true })
		expect(playableTime(keep, 7, { start: 5, end: 6 })).toEqual({ time: 5, jumped: true })
		// A loop starting in a removed section starts at the next kept moment.
		expect(playableTime(keep, 6, { start: 3, end: 5 })).toEqual({ time: 4, jumped: true })
	})
})

describe("geometry", () => {
	const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }

	it("turns a crop with the picture and back", () => {
		expect(rectToView(rect, 90, false, false)).toEqual({ x: 0.4, y: 0.1, width: 0.4, height: 0.3 })

		for (const rotate of [0, 90, 180, 270] as VideoRotation[]) {
			for (const flipH of [false, true]) {
				for (const flipV of [false, true]) {
					const back = rectFromView(rectToView(rect, rotate, flipH, flipV), rotate, flipH, flipV)

					expect(back.x).toBeCloseTo(rect.x)
					expect(back.y).toBeCloseTo(rect.y)
					expect(back.width).toBeCloseTo(rect.width)
					expect(back.height).toBeCloseTo(rect.height)
				}
			}
		}
	})

	it("snaps a crop to even pixels inside the frame, null for the whole frame", () => {
		expect(cropFromNormalised({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, { width: 1001, height: 501 })).toEqual({
			x: 100,
			y: 50,
			width: 500,
			height: 250
		})
		expect(cropFromNormalised({ x: 0, y: 0, width: 1, height: 1 }, { width: 1920, height: 1080 })).toBeNull()
		expect(cropToNormalised(null, { width: 10, height: 10 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })

		const crop = cropFromNormalised({ x: 0.33, y: 0.21, width: 0.41, height: 0.37 }, { width: 1919, height: 1077 })

		expect(crop).not.toBeNull()

		for (const value of Object.values(crop ?? {})) {
			expect(value % 2).toBe(0)
		}
	})

	it("crops a preset ratio as the output shows it", () => {
		expect(aspectCrop("square", { width: 1920, height: 1080 }, 0)).toEqual({ x: 420, y: 0, width: 1080, height: 1080 })
		// 16:9 in the turned frame is 9:16 of the display frame.
		expect(aspectCrop("16:9", { width: 1920, height: 1080 }, 90)).toEqual({ x: 656, y: 0, width: 608, height: 1080 })
		expect(aspectCrop("original", { width: 1920, height: 1080 }, 0)).toBeNull()
		expect(aspectCrop("free", { width: 1920, height: 1080 }, 0)).toBeNull()
	})

	it("turns and mirrors what is shown", () => {
		const base = identityVideoRecipe(10)
		const flipped = flipRecipe(base, "horizontal")

		expect(turnRecipe(base, "right").rotate).toBe(90)
		expect(turnRecipe(base, "left").rotate).toBe(270)
		expect(turnRecipe(flipped, "right")).toMatchObject({ rotate: 90, flipH: false, flipV: true })
	})
})

describe("speed, sound and text", () => {
	it("clamps speed and gain", () => {
		expect(clampSpeed(10)).toBe(4)
		expect(clampSpeed(0.1)).toBe(0.25)
		expect(clampSpeed(Number.NaN)).toBe(1)
		expect(clampGain(-100)).toBe(-20)
		expect(clampGain(3.14)).toBe(3.1)
		expect(previewVolume(0)).toBe(1)
		expect(previewVolume(-20)).toBeCloseTo(0.1)
		expect(previewVolume(6)).toBe(1)
	})

	it("switches audio tracks but never to none", () => {
		expect(toggleTrack("first", 2, [1, 2])).toEqual([1, 2])
		expect(toggleTrack([1, 2], 2, [1, 2])).toBe("first")
		expect(toggleTrack("first", 1, [1, 2])).toBe("first")
		expect(toggleTrack([1, 2], 1, [1, 2])).toEqual([2])
	})

	it("keeps text boxes on the output timeline", () => {
		const base = identityVideoRecipe(10)
		const text = newTextOverlay("a", "Hi", 9, 10)

		expect(text).toMatchObject({ startSec: 9, endSec: 10 })

		const sped = clampTexts({ ...base, speed: 2, text: [text, newTextOverlay("b", "Yo", 1, 10)] })

		expect(sped.text.map(item => item.id)).toEqual(["b"])
		expect(sped.text[0]).toMatchObject({ startSec: 1, endSec: 4 })
	})
})

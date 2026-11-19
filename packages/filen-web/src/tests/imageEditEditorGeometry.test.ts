import { describe, expect, it } from "vitest"
import {
	cropFromFrame,
	cropOnFrame,
	dragCrop,
	flip,
	rotateLeft,
	strokeHit,
	type CropHandle
} from "@/features/preview/imageEdit/components/editorGeometry"
import { MIN_CROP, type Crop } from "@/features/preview/imageEdit/lib/recipe"
import type { Geometry, MarkupItem } from "@/features/preview/imageEdit/types"

// The crop tab's pure math where imageEditor.test.tsx does not reach: every crop handle with and without a ratio,
// the room fit, the frame mapping of off-centre crops while straightened, and the turn/flip round trips.

const EPSILON = 1e-9
const START: Crop = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }
const HANDLES: readonly CropHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"]

// `minSide`: a ratio crop's following side may be shorter than MIN_CROP (the leading side is clamped to it, the other
// follows at the ratio); the commit's clampCrop then lifts it.
function expectInside(crop: Crop, minSide = MIN_CROP): void {
	expect(crop.x).toBeGreaterThanOrEqual(-EPSILON)
	expect(crop.y).toBeGreaterThanOrEqual(-EPSILON)
	expect(crop.x + crop.width).toBeLessThanOrEqual(1 + EPSILON)
	expect(crop.y + crop.height).toBeLessThanOrEqual(1 + EPSILON)
	expect(Math.max(crop.width, crop.height)).toBeGreaterThanOrEqual(MIN_CROP - EPSILON)
	expect(crop.width).toBeGreaterThanOrEqual(minSide - EPSILON)
	expect(crop.height).toBeGreaterThanOrEqual(minSide - EPSILON)
}

function expectCrop(actual: Crop, expected: Crop): void {
	expect(actual.x).toBeCloseTo(expected.x, 9)
	expect(actual.y).toBeCloseTo(expected.y, 9)
	expect(actual.width).toBeCloseTo(expected.width, 9)
	expect(actual.height).toBeCloseTo(expected.height, 9)
}

// The edges a handle does not drag stay where they were.
function expectAnchored(crop: Crop, handle: CropHandle): void {
	if (handle.includes("w")) {
		expect(crop.x + crop.width).toBeCloseTo(START.x + START.width, 9)
	} else if (handle.includes("e")) {
		expect(crop.x).toBeCloseTo(START.x, 9)
	}

	if (handle.includes("n")) {
		expect(crop.y + crop.height).toBeCloseTo(START.y + START.height, 9)
	} else if (handle.includes("s")) {
		expect(crop.y).toBeCloseTo(START.y, 9)
	}
}

describe("dragCrop", () => {
	// Small drags, large outward drags that would leave the frame, and inward drags past the opposite edge.
	const DRAGS: readonly (readonly [number, number])[] = [
		[0.05, 0.02],
		[-0.05, -0.02],
		[0.9, 0.9],
		[-0.9, -0.9],
		[0.9, -0.9],
		[-0.9, 0.9],
		[0.02, -0.6]
	]

	for (const handle of HANDLES) {
		it(`free: ${handle} stays inside, at least MIN_CROP, anchored`, () => {
			for (const [dx, dy] of DRAGS) {
				const crop = dragCrop(START, handle, dx, dy, null)

				expectInside(crop)
				expectAnchored(crop, handle)

				// Sides the handle does not touch keep their extent.
				if (!handle.includes("w") && !handle.includes("e")) {
					expect(crop.x).toBeCloseTo(START.x, 9)
					expect(crop.width).toBeCloseTo(START.width, 9)
				}

				if (!handle.includes("n") && !handle.includes("s")) {
					expect(crop.y).toBeCloseTo(START.y, 9)
					expect(crop.height).toBeCloseTo(START.height, 9)
				}
			}
		})

		for (const ratio of [16 / 9, 9 / 16, 1]) {
			it(`ratio ${ratio.toFixed(3)}: ${handle} holds the ratio, stays inside, anchored`, () => {
				for (const [dx, dy] of DRAGS) {
					const crop = dragCrop(START, handle, dx, dy, ratio)

					expectInside(crop, MIN_CROP * Math.min(ratio, 1 / ratio))
					expect(crop.width / crop.height).toBeCloseTo(ratio, 9)
					expectAnchored(crop, handle)

					// An edge handle keeps the crop centred across the other axis.
					if (handle === "n" || handle === "s") {
						expect(crop.x + crop.width / 2).toBeCloseTo(START.x + START.width / 2, 9)
					}

					if (handle === "e" || handle === "w") {
						expect(crop.y + crop.height / 2).toBeCloseTo(START.y + START.height / 2, 9)
					}
				}
			})
		}
	}

	it("16:9 from the north-west, led vertically, shrinks to the room the anchored corner leaves", () => {
		// Height leads to 0.7, which at 16:9 would need 1.24 of width; the south-east anchor leaves 0.7.
		const crop = dragCrop(START, "nw", 0, -0.3, 16 / 9)

		expectCrop(crop, { x: 0, y: 0.7 - 0.7 / (16 / 9), width: 0.7, height: 0.7 / (16 / 9) })
	})

	it("a wide ratio from the north edge fits the room either side of the centre", () => {
		// Height leads to 0.7, which at 4:1 would need 2.8 of width; the centre leaves 2 * 0.5 either side.
		const crop = dragCrop(START, "n", 0, -0.3, 4)

		expectCrop(crop, { x: 0, y: 0.7 - 0.25, width: 1, height: 0.25 })
	})

	it("the dominant axis leads on a corner", () => {
		// Width leads at 0.5 (height following would give 0.35), then height leads at 0.5.
		expectCrop(dragCrop(START, "se", 0.1, -0.05, 1), { x: 0.3, y: 0.3, width: 0.5, height: 0.5 })
		expectCrop(dragCrop(START, "se", -0.05, 0.1, 1), { x: 0.3, y: 0.3, width: 0.5, height: 0.5 })
	})

	it("move keeps the size and stops at the frame", () => {
		expectCrop(dragCrop(START, "move", 0.9, -0.9, null), { x: 0.6, y: 0, width: 0.4, height: 0.4 })
	})
})

describe("cropOnFrame / cropFromFrame", () => {
	const CROPS: readonly Crop[] = [
		{ x: 0.05, y: 0.1, width: 0.3, height: 0.2 },
		{ x: 0.6, y: 0.55, width: 0.35, height: 0.4 },
		{ x: 0.1, y: 0.6, width: 0.5, height: 0.25 }
	]
	const FRAMES = [
		{ width: 4000, height: 3000 },
		{ width: 1080, height: 1920 },
		{ width: 500, height: 500 }
	]

	it("round-trips off-centre crops at angles of both signs on non-square frames", () => {
		for (const frame of FRAMES) {
			for (const angle of [-37, -12.5, 0, 3, 45]) {
				for (const crop of CROPS) {
					expectCrop(cropFromFrame(cropOnFrame(crop, angle, frame), angle, frame), crop)
					expectCrop(cropOnFrame(cropFromFrame(crop, angle, frame), angle, frame), crop)
				}
			}
		}
	})

	it("turns the crop's centre clockwise on screen about the frame's centre", () => {
		const frame = { width: 400, height: 200 }
		// Centre 100 px right of the frame's centre, on its horizontal axis.
		const crop: Crop = { x: 0.7, y: 0.4, width: 0.1, height: 0.2 }
		const shown = cropOnFrame(crop, 90, frame)

		// Clockwise with y down: right of centre turns to below it, 100 px = 0.5 of the frame's height.
		expectCrop(shown, { x: 0.45, y: 0.9, width: 0.1, height: 0.2 })

		const tilted = cropOnFrame(crop, 30, frame)

		expect(tilted.x + tilted.width / 2).toBeCloseTo(0.5 + (100 * Math.cos(Math.PI / 6)) / 400, 9)
		expect(tilted.y + tilted.height / 2).toBeCloseTo(0.5 + (100 * Math.sin(Math.PI / 6)) / 200, 9)
	})

	it("keeps the size and the identity at angle 0", () => {
		const crop = CROPS[1] ?? START

		expect(cropOnFrame(crop, 0, FRAMES[0] ?? { width: 1, height: 1 })).toBe(crop)
		expect(cropFromFrame(crop, 0, FRAMES[0] ?? { width: 1, height: 1 })).toBe(crop)
	})
})

const GEOMETRY: Geometry = {
	quarterTurns: 1,
	flipH: true,
	flipV: false,
	angle: 12,
	crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.5 },
	aspect: "4:3"
}

describe("rotateLeft", () => {
	it("four times is the identity", () => {
		let geometry = GEOMETRY

		for (let turn = 0; turn < 4; turn++) {
			geometry = rotateLeft(geometry)
		}

		expect(geometry.quarterTurns).toBe(GEOMETRY.quarterTurns)
		expect(geometry.flipH).toBe(GEOMETRY.flipH)
		expect(geometry.flipV).toBe(GEOMETRY.flipV)
		expect(geometry.angle).toBe(GEOMETRY.angle)
		expect(geometry.aspect).toBe(GEOMETRY.aspect)
		expectCrop(geometry.crop, GEOMETRY.crop)
	})

	it("swaps 4:3 with 3:4, the flips with each other, and turns the crop", () => {
		const once = rotateLeft(GEOMETRY)

		expect(once.aspect).toBe("3:4")
		expect(rotateLeft(once).aspect).toBe("4:3")
		expect(once.flipH).toBe(false)
		expect(once.flipV).toBe(true)
		// The crop's left edge becomes its bottom edge.
		expectCrop(once.crop, { x: 0.2, y: 0.6, width: 0.5, height: 0.3 })
	})
})

describe("flip", () => {
	for (const axis of ["horizontal", "vertical"] as const) {
		it(`${axis} twice is the identity`, () => {
			const twice = flip(flip(GEOMETRY, axis), axis)

			expect(twice.flipH).toBe(GEOMETRY.flipH)
			expect(twice.flipV).toBe(GEOMETRY.flipV)
			expect(twice.angle).toBe(GEOMETRY.angle)
			expectCrop(twice.crop, GEOMETRY.crop)
		})
	}

	it("negates the angle once and mirrors the crop", () => {
		const horizontal = flip(GEOMETRY, "horizontal")
		const vertical = flip(GEOMETRY, "vertical")

		expect(horizontal.angle).toBe(-12)
		expect(vertical.angle).toBe(-12)
		expect(horizontal.flipH).toBe(false)
		expect(vertical.flipV).toBe(true)
		expectCrop(horizontal.crop, { x: 0.6, y: 0.2, width: 0.3, height: 0.5 })
		expectCrop(vertical.crop, { x: 0.1, y: 0.3, width: 0.3, height: 0.5 })
	})
})

describe("strokeHit", () => {
	const lower: MarkupItem = { kind: "pen", id: "lower", color: "#000000", width: 4, points: [0, 50, 100, 50] }
	const arrow: MarkupItem = { kind: "arrow", id: "arrow", color: "#000000", width: 2, from: [50, 0], to: [50, 100] }
	const text: MarkupItem = { kind: "text", id: "text", color: "#000000", size: 20, at: [45, 45], text: "hi" }

	it("returns the topmost item under the point", () => {
		expect(strokeHit([lower, arrow], 50, 50, 1)?.id).toBe("arrow")
		expect(strokeHit([arrow, lower], 50, 50, 1)?.id).toBe("lower")
	})

	it("skips text", () => {
		expect(strokeHit([lower, text], 50, 50, 1)?.id).toBe("lower")
		expect(strokeHit([text], 46, 46, 10)).toBeNull()
	})

	it("hits within half the width plus the tolerance only", () => {
		expect(strokeHit([lower], 30, 53, 1)?.id).toBe("lower")
		expect(strokeHit([lower], 30, 53.5, 1)).toBeNull()
		expect(strokeHit([arrow], 52.9, 120, 2)).toBeNull()
		expect(strokeHit([arrow], 52.9, 100, 2)?.id).toBe("arrow")
	})

	it("hits a single-point pen stroke as a dot", () => {
		const dot: MarkupItem = { kind: "pen", id: "dot", color: "#000000", width: 4, points: [10, 10] }

		expect(strokeHit([dot], 11, 11, 0)?.id).toBe("dot")
		expect(strokeHit([dot], 13, 13, 0)).toBeNull()
	})
})

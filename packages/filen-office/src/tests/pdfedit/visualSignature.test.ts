import { describe, expect, it } from "vitest"
import {
	fitBox,
	normalizeStrokes,
	PDF_SIGNATURE_MAX_POINTS,
	PDF_SIGNATURE_UNITS,
	signatureAspect,
	smoothStroke,
	strokesInBox
} from "../../core/pdfedit/visualSignature"

describe("visual signature strokes", () => {
	it("smooths a stroke and keeps its end points", () => {
		const smoothed = smoothStroke([0, 0, 10, 10, 20, 0])

		expect(smoothed.slice(0, 2)).toEqual([0, 0])
		expect(smoothed.slice(-2)).toEqual([20, 0])
		expect(smoothed.length).toBeGreaterThan(6)
		expect(Math.max(...smoothed.filter((_, index) => index % 2 === 1))).toBeLessThan(10)
		expect(smoothStroke([1, 2, 3, 4])).toEqual([1, 2, 3, 4])
	})

	it("normalises to integer units cropped to the ink", () => {
		const normalized = normalizeStrokes([
			[100, 100, 300, 150],
			[200, 200]
		])

		expect(normalized).not.toBeNull()
		expect(normalized?.width).toBe(PDF_SIGNATURE_UNITS)
		expect(normalized?.height).toBeLessThan(PDF_SIGNATURE_UNITS)
		expect(normalized?.strokes.flat().every(value => Number.isInteger(value) && value >= 0)).toBe(true)
		expect(normalized?.strokes.length).toBe(2)
		expect(normalizeStrokes([[], [Number.NaN, 1]])).toBeNull()
	})

	it("thins very long strokes and merges repeated points", () => {
		const long = Array.from({ length: PDF_SIGNATURE_MAX_POINTS * 3 * 2 }, (_, index) => (index % 2 === 0 ? index : index % 7))
		const thinned = normalizeStrokes([long])
		const repeated = normalizeStrokes([[0, 0, 0, 0, 0, 0, 10, 10]])

		expect((thinned?.strokes[0]?.length ?? 0) / 2).toBeLessThanOrEqual(PDF_SIGNATURE_MAX_POINTS + 1)
		expect(repeated?.strokes[0]?.length).toBe(4)
	})

	it("fits into a box keeping the aspect, centred", () => {
		expect(fitBox(2, [0, 0, 100, 100])).toEqual([0, 25, 100, 75])
		expect(fitBox(0.5, [0, 0, 100, 100])).toEqual([25, 0, 75, 100])

		const strokes = { kind: "strokes" as const, width: 200, height: 100, strokes: [[0, 0, 200, 100]] }

		expect(signatureAspect(strokes)).toBe(2)
		expect(strokesInBox(strokes, [10, 10, 110, 110])).toEqual([[10, 35, 110, 85]])
	})
})

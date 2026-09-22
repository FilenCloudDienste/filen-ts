import { describe, it, expect } from "vitest"
import { clampedRatio } from "@filen/shared"

describe("clampedRatio", () => {
	it("returns 0 for a zero denominator", () => {
		expect(clampedRatio(5, 0)).toBe(0)
	})

	it("returns 0 for a negative denominator", () => {
		expect(clampedRatio(5, -10)).toBe(0)
	})

	it("returns 0 for a NaN denominator", () => {
		expect(clampedRatio(5, Number.NaN)).toBe(0)
	})

	it("clamps a numerator greater than the denominator to scale", () => {
		expect(clampedRatio(150, 100)).toBe(1)
		expect(clampedRatio(150, 100, 100)).toBe(100)
	})

	it("computes the ratio at scale 1 (default)", () => {
		expect(clampedRatio(50, 200)).toBe(0.25)
	})

	it("computes the ratio at scale 100", () => {
		expect(clampedRatio(50, 200, 100)).toBe(25)
	})
})

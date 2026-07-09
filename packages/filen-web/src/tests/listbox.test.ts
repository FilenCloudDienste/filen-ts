import { describe, expect, it } from "vitest"
import { clampListboxIndex, listboxRange } from "@/features/drive/lib/listbox"

describe("clampListboxIndex", () => {
	it("passes through an index already in range", () => {
		expect(clampListboxIndex(3, 10)).toBe(3)
	})

	it("clamps a negative index up to 0", () => {
		expect(clampListboxIndex(-5, 10)).toBe(0)
	})

	it("clamps an index past the end down to length - 1", () => {
		expect(clampListboxIndex(99, 10)).toBe(9)
	})

	it("returns 0 for a zero-length list", () => {
		expect(clampListboxIndex(4, 0)).toBe(0)
	})

	it("returns 0 for a single-item list regardless of the requested index", () => {
		expect(clampListboxIndex(7, 1)).toBe(0)
		expect(clampListboxIndex(-7, 1)).toBe(0)
	})
})

describe("listboxRange", () => {
	it("returns a single-element range when anchor equals active", () => {
		expect(listboxRange(3, 3)).toEqual([3])
	})

	it("returns an ascending inclusive range when the anchor precedes the active index", () => {
		expect(listboxRange(2, 5)).toEqual([2, 3, 4, 5])
	})

	it("returns the same ascending range when the anchor follows the active index", () => {
		expect(listboxRange(5, 2)).toEqual([2, 3, 4, 5])
	})

	it("handles adjacent indices", () => {
		expect(listboxRange(4, 5)).toEqual([4, 5])
	})
})

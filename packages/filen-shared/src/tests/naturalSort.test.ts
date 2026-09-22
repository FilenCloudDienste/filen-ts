import { describe, it, expect } from "vitest"
import { getUuidNumber, getLowerName, getNumericParts, comparePartsNumeric, clearNaturalSortCaches } from "@filen/shared"

describe("getNumericParts", () => {
	it("splits a name into alternating string/number runs", () => {
		expect(getNumericParts("img10.png")).toEqual(["img", 10, ".png"])
	})

	it("parses a leading digit run", () => {
		expect(getNumericParts("10img")).toEqual([10, "img"])
	})

	it("parses an absurdly long digit run the same way parseInt would", () => {
		expect(getNumericParts("1".repeat(30))).toEqual([parseInt("1".repeat(30), 10)])
	})

	it("returns an empty array for an empty string", () => {
		expect(getNumericParts("")).toEqual([])
	})

	it("memoizes: repeated calls for the same string return the SAME array reference", () => {
		const first = getNumericParts("cache-me-10")
		const second = getNumericParts("cache-me-10")

		expect(first).toBe(second)
	})
})

describe("comparePartsNumeric", () => {
	it("orders digit runs numerically, not lexically", () => {
		expect(comparePartsNumeric(getNumericParts("img9"), getNumericParts("img10"))).toBeLessThan(0)
	})

	it("orders string runs lexically", () => {
		expect(comparePartsNumeric(getNumericParts("apple"), getNumericParts("banana"))).toBeLessThan(0)
	})

	it("sorts a number part before a string part at the same position", () => {
		expect(comparePartsNumeric(["10"], [10]) === 0).toBe(false)
		expect(comparePartsNumeric([10], ["a"])).toBeLessThan(0)
		expect(comparePartsNumeric(["a"], [10])).toBeGreaterThan(0)
	})

	it("breaks ties by length when all shared parts are equal", () => {
		expect(comparePartsNumeric(["a"], ["a", "b"])).toBeLessThan(0)
		expect(comparePartsNumeric(["a", "b"], ["a"])).toBeGreaterThan(0)
	})

	it("short-circuits to 0 for the same cached parts array (reference equality)", () => {
		const parts = getNumericParts("same-name")

		expect(comparePartsNumeric(parts, parts)).toBe(0)
	})

	it("returns 0 for equal, distinct arrays", () => {
		expect(comparePartsNumeric(["a", 1], ["a", 1])).toBe(0)
	})
})

describe("getLowerName", () => {
	it("lowercases and memoizes", () => {
		expect(getLowerName("ABC")).toBe("abc")
		expect(getLowerName("ABC")).toBe("abc")
	})
})

describe("getUuidNumber", () => {
	it("extracts the numeric digits of a uuid", () => {
		expect(getUuidNumber("a1b2c3")).toBe(123)
	})

	it("memoizes per uuid", () => {
		expect(getUuidNumber("no-digits-here")).toBe(0)
		expect(getUuidNumber("no-digits-here")).toBe(0)
	})
})

describe("clearNaturalSortCaches", () => {
	it("evicts the numeric-parts cache so a later call returns a fresh array", () => {
		const before = getNumericParts("evict-me-1")

		clearNaturalSortCaches()

		const after = getNumericParts("evict-me-1")

		expect(after).not.toBe(before)
		expect(after).toEqual(before)
	})
})

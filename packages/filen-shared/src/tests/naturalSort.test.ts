import { describe, it, expect } from "vitest"
import { getUuidNumber, getNameParts, comparePartsNumeric, clearNaturalSortCaches } from "@filen/shared"

describe("getNameParts", () => {
	it("splits a name into alternating string/number runs", () => {
		expect(getNameParts("img10.png")).toEqual(["img", 10, ".png"])
	})

	it("parses a leading digit run", () => {
		expect(getNameParts("10img")).toEqual([10, "img"])
	})

	it("parses an absurdly long digit run the same way parseInt would", () => {
		expect(getNameParts("1".repeat(30))).toEqual([parseInt("1".repeat(30), 10)])
	})

	it("lowercases before parsing", () => {
		expect(getNameParts("IMG10.PNG")).toEqual(["img", 10, ".png"])
	})

	it("returns an empty array for an empty string", () => {
		expect(getNameParts("")).toEqual([])
	})

	it("memoizes: repeated calls for the same key return the SAME array reference", () => {
		const first = getNameParts("cache-me-10")
		const second = getNameParts("cache-me-10")

		expect(first).toBe(second)
	})
})

describe("comparePartsNumeric", () => {
	it("orders digit runs numerically, not lexically", () => {
		expect(comparePartsNumeric(getNameParts("img9"), getNameParts("img10"))).toBeLessThan(0)
	})

	it("orders string runs lexically", () => {
		expect(comparePartsNumeric(getNameParts("apple"), getNameParts("banana"))).toBeLessThan(0)
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
		const parts = getNameParts("same-name")

		expect(comparePartsNumeric(parts, parts)).toBe(0)
	})

	it("returns 0 for keys that differ only by case", () => {
		expect(comparePartsNumeric(getNameParts("Case10"), getNameParts("cASE10"))).toBe(0)
	})

	it("returns 0 for equal, distinct arrays", () => {
		expect(comparePartsNumeric(["a", 1], ["a", 1])).toBe(0)
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
	it("evicts the name-parts cache so a later call returns a fresh array", () => {
		const before = getNameParts("evict-me-1")

		clearNaturalSortCaches()

		const after = getNameParts("evict-me-1")

		expect(after).not.toBe(before)
		expect(after).toEqual(before)
	})
})

import { describe, expect, it } from "vitest"
import { COUNTRIES, countryOptions, isValidCountry } from "@/features/settings/lib/countries"

describe("COUNTRIES", () => {
	it("is sorted alphabetically with no duplicates", () => {
		const sorted = [...COUNTRIES].sort((a, b) => a.localeCompare(b))

		expect(COUNTRIES).toEqual(sorted)
		expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length)
	})

	it("has the full 250-entry list mobile ships, sovereigns and territories alike", () => {
		expect(COUNTRIES).toHaveLength(250)
		expect(COUNTRIES).toEqual(expect.arrayContaining(["Hong Kong", "Puerto Rico", "Greenland", "Germany", "United States", "Japan"]))
	})
})

describe("isValidCountry", () => {
	it("accepts the empty string (unset)", () => {
		expect(isValidCountry("")).toBe(true)
	})

	it("accepts an exact list member", () => {
		expect(isValidCountry("Germany")).toBe(true)
	})

	it("rejects free text not on the list", () => {
		expect(isValidCountry("Not A Country")).toBe(false)
		expect(isValidCountry("germany")).toBe(false)
	})
})

describe("countryOptions", () => {
	it("returns the same list for an unset value", () => {
		expect(countryOptions("")).toBe(COUNTRIES)
	})

	it("returns the same list for an exact member", () => {
		expect(countryOptions("Germany")).toBe(COUNTRIES)
	})

	it("inserts an off-list value exactly once and keeps the result sorted", () => {
		const options = countryOptions("DE")

		expect(options).toHaveLength(COUNTRIES.length + 1)
		expect(options.filter(country => country === "DE")).toHaveLength(1)
		expect(options).toEqual([...options].sort((a, b) => a.localeCompare(b)))
	})

	it("never mutates COUNTRIES", () => {
		countryOptions("DE")

		expect(COUNTRIES).toHaveLength(250)
	})
})

import { describe, expect, it, vi } from "vitest"
import { COUNTRIES, countryOptions, isValidCountry } from "@filen/shared"

// Pinned to "en" so the committed order doesn't depend on the locale of the machine running the tests.
const compareEn = new Intl.Collator("en").compare

describe("COUNTRIES", () => {
	it("is committed in en collation order with no duplicates", () => {
		expect(COUNTRIES).toEqual([...COUNTRIES].sort(compareEn))
		expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length)
	})

	// The barrel loads on every mobile launch and background wake, and on Hermes each localeCompare
	// call builds a native collator.
	it("sorts nothing when the package loads", async () => {
		vi.resetModules()

		const localeCompare = vi.spyOn(String.prototype, "localeCompare")
		const collator = vi.spyOn(Intl, "Collator")

		await import("@filen/shared")

		expect(localeCompare).not.toHaveBeenCalled()
		expect(collator).not.toHaveBeenCalled()
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
		expect(options).toEqual([...options].sort(compareEn))
	})

	it("places an off-list value before the first entry or after the last", () => {
		expect(countryOptions("Aa")[0]).toBe("Aa")
		expect(countryOptions("Zz").at(-1)).toBe("Zz")
	})

	it("never mutates COUNTRIES", () => {
		countryOptions("DE")

		expect(COUNTRIES).toHaveLength(250)
	})
})

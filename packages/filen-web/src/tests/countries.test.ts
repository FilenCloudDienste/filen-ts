import { describe, expect, it } from "vitest"
import { COUNTRIES, isValidCountry } from "@/features/settings/lib/countries"

describe("COUNTRIES", () => {
	it("is sorted alphabetically with no duplicates", () => {
		const sorted = [...COUNTRIES].sort((a, b) => a.localeCompare(b))

		expect(COUNTRIES).toEqual(sorted)
		expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length)
	})

	it("has roughly the ~190-entry closed list mobile ships", () => {
		expect(COUNTRIES.length).toBeGreaterThan(180)
		expect(COUNTRIES.length).toBeLessThan(210)
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

import { describe, expect, it } from "vitest"
import { ratePasswordStrength } from "@filen/utils"
import { isPasswordStrongEnough } from "@/lib/validate"

// Fixtures run through the REAL @filen/utils rater (not hand-built rating objects) so the gate is
// tested against the same tier boundaries the forms see: length >= 10 plus 2 of 3 character classes
// rates normal, all 3 classes rates strong (>= 16 best), everything below rates weak.
describe("isPasswordStrongEnough (minimum-strength submit gate)", () => {
	it("rejects a null rating (no password typed)", () => {
		expect(isPasswordStrongEnough(null)).toBe(false)
	})

	it("rejects a weak rating (too short)", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("abc"))).toBe(false)
	})

	it("rejects a weak rating at the length boundary (9 chars, all character classes)", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("Abcdefg!@"))).toBe(false)
	})

	it("rejects a weak rating with enough length but only one character class", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("abcdefghijkl"))).toBe(false)
	})

	it("accepts the lowest passing tier (normal: 10+ chars, two character classes)", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("AbcAbcAbcAbc"))).toBe(true)
	})

	it("accepts a strong rating (10+ chars, all character classes)", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("Abcdefg!@#"))).toBe(true)
	})

	it("accepts a best rating (16+ chars, all character classes)", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("Abcdefghijk!@#$%"))).toBe(true)
	})
})

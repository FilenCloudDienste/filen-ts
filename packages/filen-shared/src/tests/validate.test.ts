import { describe, it, expect } from "vitest"
import { isValidEmail, isPasswordStrongEnough, ratePasswordStrength } from "@filen/shared"

describe("isValidEmail", () => {
	it("accepts a standard email address", () => {
		expect(isValidEmail("user@example.com")).toBe(true)
	})

	it("accepts an email with subdomains and plus addressing", () => {
		expect(isValidEmail("user.name+tag@mail.sub.example.co.uk")).toBe(true)
	})

	it("trims surrounding whitespace before validating", () => {
		expect(isValidEmail("  user@example.com  ")).toBe(true)
	})

	it("rejects a string without an @ sign", () => {
		expect(isValidEmail("userexample.com")).toBe(false)
	})

	it("rejects a string without a domain dot", () => {
		expect(isValidEmail("user@example")).toBe(false)
	})

	it("rejects an empty string", () => {
		expect(isValidEmail("")).toBe(false)
	})

	it("rejects an address containing internal whitespace", () => {
		expect(isValidEmail("user name@example.com")).toBe(false)
	})

	it("rejects a missing local part", () => {
		expect(isValidEmail("@example.com")).toBe(false)
	})
})

// Fixtures run through the REAL ratePasswordStrength (not hand-built rating objects) so the gate is
// tested against the same tier boundaries the forms see: length >= 10 plus 2 of 3 character classes
// rates normal, all 3 classes rates strong (>= 16 best), everything below rates weak.
describe("isPasswordStrongEnough", () => {
	it("rejects a null strength (empty password)", () => {
		expect(isPasswordStrongEnough(null)).toBe(false)
	})

	it("rejects a weak password", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("abc"))).toBe(false)
	})

	it("rejects a weak rating at the length boundary (9 chars, all character classes)", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("Abcdefg!@"))).toBe(false)
	})

	it("rejects a weak rating with enough length but only one character class", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("abcdefghijkl"))).toBe(false)
	})

	it("accepts a normal-strength password", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("AbcAbcAbcAbc"))).toBe(true)
	})

	it("accepts a strong password", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("Abcdefg!@#"))).toBe(true)
	})

	it("accepts the best-tier password", () => {
		expect(isPasswordStrongEnough(ratePasswordStrength("Abcdefghijk!@#$%"))).toBe(true)
	})
})

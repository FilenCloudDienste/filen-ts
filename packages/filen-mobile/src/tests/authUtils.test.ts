import { describe, it, expect } from "vitest"

import { isValidEmail } from "@/features/auth/utils"

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

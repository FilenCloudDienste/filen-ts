import { describe, it, expect } from "vitest"
import { THEME_SETTINGS, DEFAULT_THEME_SETTING, isThemeSetting } from "@filen/shared"

describe("isThemeSetting", () => {
	it("accepts every value in THEME_SETTINGS", () => {
		for (const value of THEME_SETTINGS) {
			expect(isThemeSetting(value)).toBe(true)
		}
	})

	it("rejects null, undefined, and an unrecognised string", () => {
		expect(isThemeSetting(null)).toBe(false)
		expect(isThemeSetting(undefined)).toBe(false)
		expect(isThemeSetting("sepia")).toBe(false)
		expect(isThemeSetting("")).toBe(false)
	})
})

describe("DEFAULT_THEME_SETTING", () => {
	it("is 'system' and is itself a valid ThemeSetting", () => {
		expect(DEFAULT_THEME_SETTING).toBe("system")
		expect(isThemeSetting(DEFAULT_THEME_SETTING)).toBe(true)
	})
})

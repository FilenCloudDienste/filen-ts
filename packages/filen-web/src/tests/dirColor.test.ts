import { describe, expect, it } from "vitest"
import { DIR_COLOR_HEX, dirColorHex, isCustomDirColor, normalizeCustomHex } from "@/features/drive/lib/dirColor"

describe("dirColorHex", () => {
	it("maps every named color to its DIR_COLOR_HEX value", () => {
		expect(dirColorHex("default")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("blue")).toBe(DIR_COLOR_HEX.blue)
		expect(dirColorHex("green")).toBe(DIR_COLOR_HEX.green)
		expect(dirColorHex("purple")).toBe(DIR_COLOR_HEX.purple)
		expect(dirColorHex("red")).toBe(DIR_COLOR_HEX.red)
		expect(dirColorHex("gray")).toBe(DIR_COLOR_HEX.gray)
	})

	it("passes a valid freeform #rrggbb hex through untouched (the SDK's custom-color arm)", () => {
		expect(dirColorHex("#1a2b3c")).toBe("#1a2b3c")
		expect(dirColorHex("#ABCDEF")).toBe("#ABCDEF")
	})

	it("falls back to the default tint for anything it can't recognize", () => {
		expect(dirColorHex("")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("rebeccapurple")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("#abc")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("#12345g")).toBe(DIR_COLOR_HEX.default)
	})
})

describe("normalizeCustomHex", () => {
	it("accepts a leading-# hex and lowercases it", () => {
		expect(normalizeCustomHex("#1A2B3C")).toBe("#1a2b3c")
	})

	it("accepts a bare hex with no leading #", () => {
		expect(normalizeCustomHex("1a2b3c")).toBe("#1a2b3c")
	})

	it("trims surrounding whitespace", () => {
		expect(normalizeCustomHex("  #1a2b3c  ")).toBe("#1a2b3c")
	})

	it("returns null for an incomplete or malformed hex", () => {
		expect(normalizeCustomHex("#abc")).toBeNull()
		expect(normalizeCustomHex("12345g")).toBeNull()
		expect(normalizeCustomHex("")).toBeNull()
	})

	// Round-trips into dirColorHex — a value this function accepts must always be exactly what the
	// row/tile paints with, never falling back to the default tint.
	it("round-trips through dirColorHex unchanged", () => {
		const normalized = normalizeCustomHex("#1A2B3C")

		if (normalized === null) {
			throw new Error("expected normalizeCustomHex to accept a valid hex")
		}

		expect(dirColorHex(normalized)).toBe(normalized)
	})
})

describe("isCustomDirColor", () => {
	it("is false for every named color", () => {
		expect(isCustomDirColor("default")).toBe(false)
		expect(isCustomDirColor("blue")).toBe(false)
		expect(isCustomDirColor("green")).toBe(false)
		expect(isCustomDirColor("purple")).toBe(false)
		expect(isCustomDirColor("red")).toBe(false)
		expect(isCustomDirColor("gray")).toBe(false)
	})

	it("is true for a freeform hex", () => {
		expect(isCustomDirColor("#1a2b3c")).toBe(true)
	})
})

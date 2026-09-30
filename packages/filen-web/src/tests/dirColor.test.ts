import { describe, expect, it } from "vitest"
import { dirColorHex } from "@filen/shared"
import { isCustomDirColor, normalizeCustomHex } from "@/features/drive/lib/dirColor"

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

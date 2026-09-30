import { describe, expect, it } from "vitest"
import { DIR_COLOR_HEX, dirColorHex, directoryFolderTint, isNamedDirColor } from "@filen/shared"

describe("isNamedDirColor", () => {
	it("is true only for the six named colors", () => {
		for (const name of ["default", "blue", "green", "purple", "red", "gray"]) {
			expect(isNamedDirColor(name)).toBe(true)
		}

		expect(isNamedDirColor("#1a2b3c")).toBe(false)
		expect(isNamedDirColor("DEFAULT")).toBe(false)
		expect(isNamedDirColor("toString")).toBe(false)
	})
})

describe("dirColorHex", () => {
	it("maps every named color to its DIR_COLOR_HEX value", () => {
		expect(dirColorHex("default")).toBe("#85BCFF")
		expect(dirColorHex("blue")).toBe("#037AFF")
		expect(dirColorHex("green")).toBe("#33C759")
		expect(dirColorHex("purple")).toBe("#AF52DE")
		expect(dirColorHex("red")).toBe("#FF3B30")
		expect(dirColorHex("gray")).toBe("#8F8E93")
	})

	it("passes a valid custom #rrggbb through with its case kept", () => {
		expect(dirColorHex("#1a2b3c")).toBe("#1a2b3c")
		expect(dirColorHex("#ABCDEF")).toBe("#ABCDEF")
	})

	it("falls back to the default for anything missing or unrecognized", () => {
		expect(dirColorHex(null)).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex(undefined)).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("rebeccapurple")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("DEFAULT")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("AABBCC")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("#abc")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("#12345g")).toBe(DIR_COLOR_HEX.default)
		expect(dirColorHex("#ZZZZZZ")).toBe(DIR_COLOR_HEX.default)
	})
})

describe("directoryFolderTint", () => {
	it("uses the fixed default pair for an uncolored directory", () => {
		const pair = { path1: "#5398DF", path2: "#85BCFF" }

		expect(directoryFolderTint("default")).toEqual(pair)
		expect(directoryFolderTint(null)).toEqual(pair)
		expect(directoryFolderTint(undefined)).toEqual(pair)
		expect(directoryFolderTint("")).toEqual(pair)
	})

	// Literals, not a recomputation: only a fixed expected value proves the arithmetic
	it("derives a darker tab shade from the body color", () => {
		expect(directoryFolderTint("red")).toEqual({ path1: "#c42d25", path2: "#FF3B30" })
		expect(directoryFolderTint("blue")).toEqual({ path1: "#025ec4", path2: "#037AFF" })
		expect(directoryFolderTint("#ffffff")).toEqual({ path1: "#c4c4c4", path2: "#ffffff" })
	})

	it("zero-pads single-digit channels", () => {
		expect(directoryFolderTint("#101010")).toEqual({ path1: "#0c0c0c", path2: "#101010" })
		expect(directoryFolderTint("#000000")).toEqual({ path1: "#000000", path2: "#000000" })
	})

	it("shades the default body for an unrecognized color rather than using the default pair", () => {
		expect(directoryFolderTint("orange")).toEqual({ path1: "#6691c4", path2: "#85BCFF" })
	})
})

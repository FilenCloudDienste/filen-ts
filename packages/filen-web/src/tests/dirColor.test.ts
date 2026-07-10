import { describe, expect, it } from "vitest"
import { DIR_COLOR_HEX, dirColorHex } from "@/features/drive/lib/dirColor"

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

import { describe, expect, it } from "vitest"
import { fontMatches, listedFont, parseFontSize, typedFont } from "@/features/preview/components/docxFormatControls.logic"

// The Font group's editable boxes: a size typed in points as w:sz half-points within Word's 1 to 1638 pt, and a font
// name typed as a listed font or as itself.

describe("parseFontSize", () => {
	it("takes any size in half-point steps, with either decimal separator", () => {
		expect(parseFontSize("13")).toBe(26)
		expect(parseFontSize("10.5")).toBe(21)
		expect(parseFontSize("10,5")).toBe(21)
		expect(parseFontSize(" 200 ")).toBe(400)
		expect(parseFontSize(".5")).toBeNull()
		expect(parseFontSize("1")).toBe(2)
		expect(parseFontSize("1638")).toBe(3276)
	})

	it("rounds to the nearest half point", () => {
		expect(parseFontSize("10.3")).toBe(21)
		expect(parseFontSize("10.2")).toBe(20)
	})

	it("refuses text that is no size and sizes outside 1 to 1638 pt, without clamping", () => {
		for (const text of ["", " ", "abc", "12pt", "-3", "1e3", "Infinity", "NaN", "1.2.3", "0", "0.5", "1638.5", "5000"]) {
			expect(parseFontSize(text), text).toBeNull()
		}
	})
})

describe("typed font names", () => {
	const items = [
		{ value: "+body", label: "Calibri (Body)" },
		{ value: "Arial", label: "Arial" },
		{ value: "Calibri Light", label: "Calibri Light" }
	]

	it("applies a listed font by its label in any case, else the name as typed", () => {
		expect(typedFont("calibri (body)", items)).toBe("+body")
		expect(typedFont(" arial ", items)).toBe("Arial")
		expect(typedFont("Comic Sans MS", items)).toBe("Comic Sans MS")
		expect(typedFont("  ", items)).toBeNull()
		expect(listedFont("Calibri", items)).toBeUndefined()
	})

	it("matches a label by the start of any of its words", () => {
		expect(fontMatches("Calibri Light", "cal")).toBe(true)
		expect(fontMatches("Calibri Light", "light")).toBe(true)
		expect(fontMatches("Calibri Light", "ibri")).toBe(false)
		expect(fontMatches("Arial", "")).toBe(true)
	})
})

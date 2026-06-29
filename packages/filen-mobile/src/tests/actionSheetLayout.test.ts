import { describe, it, expect } from "vitest"
import { actionSheetNeedsTopInset } from "@/providers/actionSheetLayout"

describe("actionSheetNeedsTopInset", () => {
	// Typical portrait phone (dp): ~800 tall, 24 status bar, 34 home indicator.
	const PHONE = { windowHeight: 800, insetTop: 24, insetBottom: 34 }

	it("returns false for a short sheet that fits on screen (few options)", () => {
		// e.g. the sort-direction sheet: Ascending / Descending / Cancel + a title.
		expect(actionSheetNeedsTopInset({ buttonCount: 3, hasTitle: true, ...PHONE })).toBe(false)
	})

	it("returns true for a tall sheet whose options fill the screen", () => {
		expect(actionSheetNeedsTopInset({ buttonCount: 20, hasTitle: true, ...PHONE })).toBe(true)
	})

	it("counts the title block height — it can tip a borderline sheet into needing the inset", () => {
		// Boundary without the title sits just above 13 rows on this phone; the title pushes 13 over.
		const borderline = 13

		expect(actionSheetNeedsTopInset({ buttonCount: borderline, hasTitle: false, ...PHONE })).toBe(false)
		expect(actionSheetNeedsTopInset({ buttonCount: borderline, hasTitle: true, ...PHONE })).toBe(true)
	})

	it("needs the inset sooner in a short (landscape) window", () => {
		expect(actionSheetNeedsTopInset({ buttonCount: 6, hasTitle: false, windowHeight: 360, insetTop: 24, insetBottom: 34 })).toBe(true)
		expect(actionSheetNeedsTopInset({ buttonCount: 6, hasTitle: false, windowHeight: 800, insetTop: 24, insetBottom: 34 })).toBe(false)
	})

	it("a device with no top inset never needs top padding", () => {
		// insetTop 0 → there is no status-bar region to clear; even a full sheet shouldn't add a gap.
		expect(actionSheetNeedsTopInset({ buttonCount: 3, hasTitle: true, windowHeight: 800, insetTop: 0, insetBottom: 0 })).toBe(false)
	})
})

import { describe, expect, it } from "vitest"
import { fallbackFor, NO_HINTS } from "../core/fonts/substitutes"

describe("fallbacks for fonts without a substitute", () => {
	it.each([
		"Corbel",
		"Candara",
		"Century Gothic",
		"Franklin Gothic Book",
		"Gill Sans MT",
		"Trebuchet MS",
		"Tw Cen MT",
		"Verdana",
		"Arial Narrow"
	])("draws the unhinted sans family %s in the bundled sans", name => {
		expect(fallbackFor(name, NO_HINTS, true)).toEqual({ family: "arimo", generic: "sans-serif" })
	})

	it.each(["Garamond", "Book Antiqua", "Constantia", "Rockwell", "Some Unknown Face"])(
		"keeps %s, unhinted, in the bundled serif",
		name => {
			expect(fallbackFor(name, NO_HINTS, true)).toEqual({ family: "tinos", generic: "serif" })
		}
	)

	it("lets the font table's hints decide over the name", () => {
		expect(fallbackFor("Corbel", { ...NO_HINTS, fontClass: "roman" }, true).generic).toBe("serif")
	})
})

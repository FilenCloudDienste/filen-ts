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

	it("keeps a variable-pitch script font named Monotype out of the monospaced fallback", () => {
		const hints = { ...NO_HINTS, fontClass: "script" as const, pitch: "variable" as const, charset: 0 }

		expect(fallbackFor("Monotype Corsiva", hints, true)).toEqual({ family: "arimo", generic: "sans-serif" })
		expect(fallbackFor("Monotype Corsiva", NO_HINTS, true).generic).not.toBe("monospace")
	})

	it.each(["Roboto Mono", "Andale Mono", "DejaVu Sans Mono", "Courier", "Courier 10 Pitch", "Monospace 821", "Monospaced"])(
		"draws the unhinted monospaced family %s in the bundled monospace",
		name => {
			expect(fallbackFor(name, NO_HINTS, true)).toEqual({ family: "cousine", generic: "monospace" })
		}
	)

	it("lets explicit pitch and class decide over a monospaced-looking name", () => {
		expect(fallbackFor("Roboto Mono", { ...NO_HINTS, pitch: "variable" }, true).generic).toBe("sans-serif")
		expect(fallbackFor("Courier Script", { ...NO_HINTS, fontClass: "script" }, true).generic).toBe("sans-serif")
		expect(fallbackFor("Anything", { ...NO_HINTS, pitch: "fixed" }, true).generic).toBe("monospace")
		expect(fallbackFor("Anything", { ...NO_HINTS, fontClass: "modern" }, true).generic).toBe("monospace")
	})

	it("reads monospacing from PANOSE when pitch and class are absent", () => {
		const panose = (proportion: number): Uint8Array => Uint8Array.of(2, 11, 6, proportion, 0, 0, 0, 0, 0, 0)

		expect(fallbackFor("Plain", { ...NO_HINTS, panose: panose(9) }, true).generic).toBe("monospace")
		expect(fallbackFor("Plain Mono", { ...NO_HINTS, panose: panose(3) }, true).generic).toBe("sans-serif")
	})
})

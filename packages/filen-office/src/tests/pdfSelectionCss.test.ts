import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// A var() declaration always parses, so pdf.js's plain fallback pair cannot work through --fo-pdf-selection: an
// AccentColor fallback outside @supports leaves the selection transparent over the transparent glyphs in an engine
// without it.
const css = readFileSync(join(import.meta.dirname, "..", "css", "pdf.css"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "")
const supportsAt = css.indexOf("@supports (color: color-mix(in srgb, AccentColor, transparent 50%))")

describe("PDF text selection colour", () => {
	it("defaults to a plain colour and uses AccentColor only under @supports", () => {
		expect(supportsAt).toBeGreaterThan(-1)

		for (const selector of ["::-moz-selection", "::selection"]) {
			const plain = new RegExp(`${selector}\\s*\\{[^}]*background: var\\(--fo-pdf-selection, rgb\\(0 0 255 / 0\\.25\\)\\);`, "u")

			expect(css.slice(0, supportsAt)).toMatch(plain)
		}

		expect(css.slice(0, supportsAt)).not.toContain("AccentColor")
		expect(css.slice(supportsAt).match(/var\(--fo-pdf-selection, color-mix\(in srgb, AccentColor, transparent 50%\)\)/gu)).toHaveLength(
			2
		)
	})
})

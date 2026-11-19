import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// A var() value always parses, so an unconditional AccentColor value for --fo-pdf-selection is invalid at computed
// time in an engine without it and leaves PDF text selection transparent.
const css = readFileSync(join(import.meta.dirname, "..", "features", "preview", "components", "pdfTheme.css"), "utf8").replace(
	/\/\*[\s\S]*?\*\//gu,
	""
)
const supportsAt = css.indexOf("@supports (color: color-mix(in srgb, AccentColor, transparent 50%))")

describe("PDF theme selection colour", () => {
	it("defaults to a plain colour and sets the AccentColor mix only under @supports", () => {
		expect(supportsAt).toBeGreaterThan(-1)
		expect(css.slice(0, supportsAt)).toContain("--fo-pdf-selection: rgb(0 0 255 / 0.25);")
		expect(css.slice(0, supportsAt)).not.toContain("AccentColor")
		expect(css.slice(supportsAt)).toContain("--fo-pdf-selection: color-mix(in srgb, AccentColor, transparent 50%);")
	})
})

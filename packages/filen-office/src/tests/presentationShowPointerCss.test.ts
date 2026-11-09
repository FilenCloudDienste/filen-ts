import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The show stage's cursor rules: show/pointer.ts sets data-fo-pointer="hidden" while the mouse is idle.
const css = readFileSync(join(import.meta.dirname, "..", "css", "presentation.css"), "utf8")

describe("show pointer auto-hide styles", () => {
	it("hides the cursor only on the idle attribute, never for the whole stage", () => {
		// A bare .fo-show-stage cursor rule (or one under :hover, which a fixed full-viewport stage always is) would
		// keep the arrow showing, or hidden, for the whole show.
		expect(css).not.toMatch(/\.fo-show-stage(?::hover)?\s*\{[^}]*cursor/u)
		expect(css).toMatch(/\.fo-show-stage\[data-fo-pointer="hidden"\] \*\s*\{\s*cursor: none;/u)
	})
})

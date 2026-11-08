// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Emphasis, RunEffect } from "../core/docx/layout/effects"
import { paintPage } from "../react/docx/paint/page"
import { fixtureTextPage } from "./fixtures/presentation/textPage"

// A document run's character effect and emphasis mark (DocxTextStyle.effect, .emphasis) on its painted spans.

describe("page painter: character effects and emphasis marks", () => {
	it("draws an outlined, shadowed run with dots over it, and plain runs as before", () => {
		const text = fixtureTextPage(["Plain", "Marked"], { decorated: [1] })
		const tables = { styles: text.styles, decorations: text.decorations, links: text.links }
		const before = paintPage(text.page, { document, tables }).root.innerHTML
		const [plain, marked] = text.styles

		if (plain === undefined || marked === undefined) throw new Error("fixture styles")

		const { paint: _p, outline: _o, effects: _e, alpha: _a, ...run } = marked
		const styles = [plain, { ...run, effect: RunEffect.OUTLINE_SHADOW, emphasis: Emphasis.DOT }]
		const painted = paintPage(text.page, { document, tables: { ...tables, styles } })
		const [first, second] = painted.texts.map(item => item.element.getAttribute("style") ?? "")

		// The DOM under test keeps the standard properties (the -webkit- stroke and fill come from runEffectCss).
		expect(second).toContain("text-shadow: 0.06em 0.06em 0 #808080")
		expect(second).toContain("text-emphasis: filled dot")
		expect(second).toContain("text-emphasis-position: over right")
		expect(first).not.toMatch(/text-shadow|text-emphasis/)
		// Without the fields nothing changes.
		expect(paintPage(text.page, { document, tables }).root.innerHTML).toBe(before)
	})
})

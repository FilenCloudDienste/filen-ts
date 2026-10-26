// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { drawingTextCss, paintPage } from "../react/docx/paint/page"
import { fixtureTextPage } from "./fixtures/presentation/textPage"

// The DrawingML text fields of DocxTextStyle (a presentation TextPage's paint, outline, effects and alpha) as the
// DOM page painter draws them, and documents (styles without those fields) drawn exactly as before.

function styleOf(element: Element): string {
	return element.getAttribute("style") ?? ""
}

describe("page painter: DrawingML text paint", () => {
	it("draws a gradient-filled, outlined, glowing title as CSS on its spans", () => {
		const text = fixtureTextPage(["Plain line", "Gradient title"], { decorated: [1] })
		const painted = paintPage(text.page, {
			document,
			tables: { styles: text.styles, decorations: text.decorations, links: text.links },
			paints: { paints: text.paints, strokes: text.strokes, textEffects: text.textEffects }
		})
		const [plain, title] = painted.texts.map(painted => styleOf(painted.element))
		const decorated = drawingTextCss(text.styles[1], { paints: text.paints, strokes: text.strokes, textEffects: text.textEffects })

		// What the decorated style adds: the gradient clipped to the glyphs (DrawingML 90° = top to bottom = CSS
		// 180deg), the outline in its paint, a two-step glow; alpha does not apply to a paint fill.
		expect(decorated).toBe(
			"background-image:linear-gradient(180deg,rgba(68,114,196,1) 0%,rgba(237,125,49,1) 100%);" +
				"-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;" +
				"-webkit-text-stroke:1px rgba(31,41,55,1);" +
				"text-shadow:0 0 4px rgba(255,192,0,0.6),0 0 2px rgba(255,192,0,0.6);"
		)
		// The span carries it (the DOM under test keeps the standard properties of it).
		expect(title).toContain("linear-gradient(180deg")
		expect(title).toContain("text-shadow")
		expect(plain).not.toMatch(/gradient|text-shadow/)
		expect(drawingTextCss(text.styles[0], { paints: text.paints, strokes: text.strokes, textEffects: text.textEffects })).toBe("")
	})

	it("draws a document's spans exactly as without the paint tables", () => {
		const text = fixtureTextPage(["One", "Two"], { decorated: [1] })
		const tables = { styles: text.styles, decorations: text.decorations, links: text.links }
		const without = paintPage(text.page, { document, tables })
		const plainStyles = { ...tables, styles: text.styles.map(({ paint: _p, outline: _o, effects: _e, alpha: _a, ...style }) => style) }
		const plain = paintPage(text.page, {
			document,
			tables: plainStyles,
			paints: { paints: text.paints, strokes: text.strokes, textEffects: text.textEffects }
		})

		expect(plain.root.innerHTML).toBe(without.root.innerHTML)
	})

	it("draws translucent and fill-less text through the fill colour only", () => {
		const text = fixtureTextPage(["Half"])
		const tables = { paints: text.paints, strokes: text.strokes, textEffects: text.textEffects }
		const base = text.styles[0]

		if (base === undefined) throw new Error("fixture style")

		expect(drawingTextCss({ ...base, alpha: 0.5 }, tables)).toBe("color:rgba(31,41,55,0.5);")
		expect(drawingTextCss({ ...base, alpha: 0, outline: 0 }, tables)).toBe(
			"-webkit-text-stroke:1px rgba(31,41,55,1);-webkit-text-fill-color:transparent;"
		)
	})
})

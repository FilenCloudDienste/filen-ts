// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import type { SlideRender } from "../core/presentation/output"
import { paintDrawing } from "../react/docx/paint/drawing"
import { paintPage } from "../react/docx/paint/page"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

// The slide fixtures painted by the docx painters the presentation canvas reuses, through a stand-in for the slide
// compositor: the background drawing, then per layer its drawing and, in a box placed by the layer's matrix, its
// text page.

function composite(render: SlideRender, width: number, height: number): HTMLElement {
	const slide = document.createElement("div")

	slide.style.cssText = `position:relative;width:${String(width)}px;height:${String(height)}px;background:#fff`
	slide.append(paintDrawing(render.background, { document, idPrefix: `s${String(render.index)}b`, imageUrl: () => undefined }))

	render.layers.forEach((layer, index) => {
		const box = document.createElement("div")
		const [a, b, c, d, e, f] = layer.matrix

		box.dataset["shape"] = String(layer.shape.id)
		box.style.cssText = `position:absolute;left:0;top:0;transform:matrix(${[a, b, c, d, e, f].map(String).join(",")})`
		box.append(
			paintDrawing(layer.drawing, { document, idPrefix: `s${String(render.index)}l${String(index)}`, imageUrl: () => undefined })
		)

		if (layer.text !== undefined) {
			const { styles, decorations, links } = layer.text

			box.append(paintPage(layer.text.page, { document, tables: { styles, decorations, links } }).root)
		}

		if (layer.alt !== undefined) box.setAttribute("aria-label", layer.alt)

		slide.append(box)
	})

	return slide
}

describe("presentation fixtures through the docx painters", () => {
	it("paints a slide's background, shapes and text", () => {
		const deck = fixtureDeck()
		const render = fixtureSlideRender(deck, 0)
		const slide = composite(render, deck.size.cx / 9525, deck.size.cy / 9525)
		const boxes = [...slide.querySelectorAll<HTMLElement>("[data-shape]")]

		expect(boxes.map(box => box.dataset["shape"])).toEqual(["2", "3", "4", "5"])
		expect(slide.querySelectorAll("svg")).toHaveLength(5)
		expect(slide.querySelectorAll("svg path").length).toBeGreaterThanOrEqual(5)
		expect(boxes[0]?.textContent).toContain("Slide 1")
		expect(boxes[1]?.textContent).toContain("First point")
		expect(boxes[1]?.textContent).toContain("Second point")
		expect(boxes[2]?.getAttribute("aria-label")).toBe("A chart of the quarter")
		expect(boxes[2]?.style.transform).toBe(`matrix(1,0,0,1,${String(6_096_000 / 9525)},${String(1_825_625 / 9525)})`)
	})

	it("paints the text of every slide of the deck", () => {
		const deck = fixtureDeck(3)

		deck.slides.forEach((_ref, index) => {
			const slide = composite(fixtureSlideRender(deck, index), 1280, 720)

			expect(slide.textContent).toContain(`Slide ${String(index + 1)}`)
		})
	})
})

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { paintPage } from "../react/docx/paint/page"
import { uprightPage } from "./fixtures/presentation/uprightPage"

describe("page painter: upright clusters of sideways text", () => {
	it("turns an upright span back about its cell's centre, and leaves a plain span unturned", () => {
		const text = uprightPage()
		const painted = paintPage(text.page, {
			document,
			tables: {
				styles: text.styles,
				decorations: text.decorations,
				links: text.links
			}
		})
		const [upright, plain] = painted.texts.map(item => item.element.getAttribute("style") ?? "")

		// Half the 9 px advance across, half the 24 px line box (ascent 18 + descent 6) down.
		expect(upright).toContain("transform: rotate(-90deg)")
		expect(upright).toContain("transform-origin: 4.5px 12px")
		expect(plain).not.toContain("rotate")
	})
})

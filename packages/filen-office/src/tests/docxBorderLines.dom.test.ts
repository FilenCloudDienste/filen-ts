// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { borderLines } from "../core/docx/layout/borderLines"
import { DecorationKind } from "../core/text/index"
import type { DocxPageData, DocxTextStyle } from "../dom/docx/protocol"
import type { DecorationValue } from "../core/docx/layout/index"
import { paintPage } from "../react/docx/paint/page"

// Multi-line borders (ST_Border triple, thinThick*, thickThin*; ECMA-376 Part 1 §17.18.2) are drawn as their own
// lines across the width the layout reserves, top to bottom (left to right): not as CSS double's two equal lines.

const STYLE: DocxTextStyle = {
	font: "400 16px serif",
	smallCapsFont: "400 11.2px serif",
	color: "000000",
	kerning: true,
	letterSpacing: 0,
	scaleX: 1,
	shift: 0,
	ascent: 12,
	descent: 4,
	revision: 0
}

function border(style: string, width = 4): DecorationValue {
	return { kind: "border", style, width, space: 0, color: "112233", shadow: false }
}

// One line of text with a run border (decoration 0) and the given page graphics (x, y, width, height, decoration key).
function page(graphics: readonly (readonly [number, number, number, number, number])[]): DocxPageData {
	return {
		index: 0,
		number: 1,
		numberText: "1",
		section: 0,
		width: 816,
		height: 1056,
		lineCount: 1,
		fragmentCount: 1,
		decorationCount: 1,
		lineFloats: Float32Array.from([96, 20, 112, 96, 24]),
		lineInts: Int32Array.from([0, 1, 0, 3, 1 | 256, 0, 0]),
		fragmentFloats: Float32Array.from([96, 24, 0, 0]),
		fragmentInts: Int32Array.from([0, 3, 0, 0, 0]),
		decorationFloats: Float32Array.from([96, 96, 24, 20]),
		decorationInts: Int32Array.from([DecorationKind.BORDER, 1, 0]),
		graphicCount: graphics.length,
		graphicFloats: Float32Array.from(graphics.flatMap(([x, y, w, h]) => [x, y, w, h])),
		graphicInts: Int32Array.from(graphics.flatMap(([, , , , key]) => [2, key, 1])),
		objectCount: 0,
		objectFloats: new Float32Array(0),
		objectInts: new Int32Array(0),
		objectKinds: new Uint8Array(0),
		sourceCount: 1,
		sourceInts: Int32Array.from([0, 0, 0, 0]),
		sourceTexts: ["abc"],
		linkCount: 0,
		linkInts: new Int32Array(0)
	}
}

function boxes(root: HTMLElement): string[] {
	return [...root.querySelectorAll<HTMLElement>(".fo-docx-box")].map(element => element.getAttribute("style") ?? "")
}

describe("multi-line borders", () => {
	it("gives each style its lines and gaps, summing to the reserved width", () => {
		for (const style of [
			"triple",
			"thinThickSmallGap",
			"thickThinSmallGap",
			"thinThickMediumGap",
			"thickThinMediumGap",
			"thinThickLargeGap",
			"thickThinLargeGap"
		]) {
			const lines = borderLines(style) ?? []

			expect(lines.length % 2).toBe(1)
			expect(lines.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 10)
		}

		expect(borderLines("triple")).toEqual([0.2, 0.2, 0.2, 0.2, 0.2])
		// Thin first from the top or left edge; thick-thin the mirror of it.
		expect(borderLines("thinThickSmallGap")).toEqual([0.25, 0.125, 0.625])
		expect(borderLines("thickThinSmallGap")).toEqual([0.625, 0.125, 0.25])
		for (const style of ["single", "double", "dotted", "dashed", "none"]) expect(borderLines(style)).toBeUndefined()
	})

	it("paints a triple page border as three lines and a thin-thick one as a thin and a thick line", () => {
		const decorations = [border("single"), border("triple"), border("thinThickSmallGap"), border("double")]
		const painted = paintPage(
			page([
				[96, 50, 600, 10, 2],
				[50, 96, 8, 800, 3],
				[96, 1000, 600, 6, 4]
			]),
			{ document, tables: { styles: [STYLE], decorations, links: [] } }
		)
		const [triple, thinThick, double] = boxes(painted.root)

		expect(triple).toContain("linear-gradient(to bottom")
		expect(triple?.replace(/\s/g, "")).toContain(
			"#112233 0% 20%,transparent 20% 40%,#112233 40% 60%,transparent 60% 80%,#112233 80% 100%".replace(/\s/g, "")
		)
		expect(thinThick).toContain("linear-gradient(to right")
		expect(thinThick?.replace(/\s/g, "")).toContain("#1122330%25%,transparent25%37.5%,#11223337.5%100%")
		// Plain double stays a CSS double border.
		expect(double).toMatch(/border-top(-style)?:[^;]*double/)
	})

	it("paints a multi-line run border on all four sides without a CSS double border", () => {
		const painted = paintPage(page([]), {
			document,
			tables: { styles: [STYLE], decorations: [border("thickThinMediumGap")], links: [] }
		})
		const run = boxes(painted.root).find(style => style.includes("gradient")) ?? ""

		expect(run).not.toMatch(/double/)
		expect(run.match(/linear-gradient/g)).toHaveLength(4)
		expect(run.replace(/\s/g, "")).toContain("#1122330%50%,transparent50%75%,#11223375%100%")
	})
})

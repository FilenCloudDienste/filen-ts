// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { turnMatrix, turnTransform } from "../core/docx/layout/turns"
import type { DocxPageData, DocxTextStyle } from "../dom/docx/protocol"
import { paintPage, patchPage } from "../react/docx/paint/page"

// The page painter turns a sideways cell's lines, graphics and objects onto its box by one CSS transform each, and
// leaves pages without turns untouched.

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

// Two lines: "side" laid out in the frame of the box (96, 100, 40, 200), turned `angle`, and "flat" upright; a fill
// and an object in the turn.
function page(angle: number | undefined, top = 100): DocxPageData {
	const turned =
		angle === undefined
			? {}
			: {
					turnCount: 1,
					turnFloats: Float32Array.from([96, 100, 40, 200]),
					turnInts: Int32Array.from([angle, 0, 1, 0, 1, 0, 1]),
					objectTurns: Int32Array.from([0])
				}

	return {
		index: 0,
		number: 1,
		numberText: "1",
		section: 0,
		width: 816,
		height: 1056,
		lineCount: 2,
		fragmentCount: 2,
		decorationCount: 0,
		lineFloats: Float32Array.from([top, 20, top + 16, 96, 30, 400, 20, 416, 96, 30]),
		lineInts: Int32Array.from([0, 1, 0, 4, 1 | 256, 0, 0, 1, 1, 0, 4, 1 | 256, 1, 0]),
		fragmentFloats: Float32Array.from([96, 30, 0, 0, 96, 30, 0, 0]),
		fragmentInts: Int32Array.from([0, 4, 0, 0, 0, 0, 4, 0, 0, 0]),
		decorationFloats: new Float32Array(0),
		decorationInts: new Int32Array(0),
		graphicCount: 1,
		graphicFloats: Float32Array.from([96, 100, 200, 40]),
		graphicInts: Int32Array.from([1, 1, 0]),
		objectCount: 1,
		objectFloats: Float32Array.from([130, 100, 20, 20]),
		objectInts: Int32Array.from([7, 1, 0]),
		objectKinds: Uint8Array.from([0]),
		sourceCount: 2,
		sourceInts: Int32Array.from([0, 0, 0, 0, 0, 0, 1, 0]),
		sourceTexts: ["side", "flat"],
		linkCount: 0,
		linkInts: new Int32Array(0),
		...turned
	}
}

const tables = { styles: [STYLE], decorations: [{ kind: "color" as const, color: "EEEEEE" }], links: [] }

describe("sideways text on the page", () => {
	it("turns the turned line's group, fill and object, and nothing else", () => {
		const painted = paintPage(page(270), { document, tables })
		const [side, flat] = painted.lines
		const matrix = turnMatrix(270, 96, 100, 40, 200)

		expect(side?.text.style.transform).toBe(turnTransform(matrix, 0, 100))
		expect(side?.text.style.transformOrigin).toBe("0 0")
		expect(flat?.text.style.transform).toBe("")
		expect(painted.root.querySelector<HTMLElement>(".fo-docx-box")?.style.transform).toBe(turnTransform(matrix, 96, 100))
		expect(painted.objects[0]?.element.style.transform).toBe(turnTransform(matrix, 130, 100))
	})

	it("puts a frame point where the turn draws it", () => {
		// Bottom to top in the box (96, 100, 40, 200): the frame's corner is the box's bottom left corner.
		const css = turnTransform(turnMatrix(270, 96, 100, 40, 200), 0, 100)
		const [a, b, c, d, e, f] = (/matrix\(([^)]*)\)/.exec(css)?.[1] ?? "").split(",").map(Number)
		// The group's own point (96, 0), its left edge at x 0 and its top at the line's top (100).
		const x = (a ?? 0) * 96 + (c ?? 0) * 0 + (e ?? 0)
		const y = (b ?? 0) * 96 + (d ?? 0) * 0 + (f ?? 0) + 100

		expect([x, y]).toEqual([96, 300])
	})

	it("turns lines back upright, and moved, when the page is painted again", () => {
		const painted = paintPage(page(90), { document, tables })
		const moved = patchPage(painted, page(90, 110), { document, tables }).painted
		const matrix = turnMatrix(90, 96, 100, 40, 200)

		expect(moved.lines[0]?.text.style.transform).toBe(turnTransform(matrix, 0, 110))

		const upright = patchPage(moved, page(undefined, 110), { document, tables }).painted

		expect(upright.lines[0]?.text.style.transform).toBe("")
		expect(upright.root.querySelector<HTMLElement>(".fo-docx-box")?.style.transform).toBe("")
	})
})

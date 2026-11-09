import { describe, expect, it } from "vitest"
import { highlightedReferences, textNumber } from "@filen/office/core/sheet"
import type { GridCanvas, GridPaintScene } from "@filen/office/react/sheet"
import { referenceColors, REFERENCE_COLORS } from "@/features/spreadsheet/formulaBar/referenceColors"
import { referenceLayer } from "@/features/spreadsheet/formulaBar/referenceLayer"
import { sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"

describe("the locale entries are typed in", () => {
	it("comes from the browser's formatting locale, ; between arguments where , is the point", () => {
		const numFmt = expect.any(Object) as unknown

		expect(sheetLocaleOf("en-US")).toEqual({ decimal: ".", group: ",", argument: ",", dateOrder: "mdy", currencies: ["$"], numFmt })
		expect(sheetLocaleOf("en-GB")).toEqual({ decimal: ".", group: ",", argument: ",", dateOrder: "dmy", currencies: ["£"], numFmt })
		expect(sheetLocaleOf("de-DE")).toEqual({ decimal: ",", group: ".", argument: ";", dateOrder: "dmy", currencies: ["€"], numFmt })
		expect(sheetLocaleOf("ja-JP").dateOrder).toBe("ymd")
		expect(sheetLocaleOf("not a tag")).toEqual({ decimal: ".", group: ",", argument: ",", dateOrder: "mdy", numFmt })
	})

	it("reads text with the region's currency symbol as a number", () => {
		const read = (language: string, text: string) => textNumber(text, sheetLocaleOf(language))

		expect(read("de-DE", "€5")).toBe(5)
		expect(read("de-DE", "5 €")).toBe(5)
		expect(read("de-DE", "1.000,50 €")).toBe(1000.5)
		expect(read("en-GB", "£5")).toBe(5)
		expect(read("ja-JP", "¥5")).toBe(5)
		expect(read("ja-JP", "￥5")).toBe(5)
		expect(read("en-US", "$1,000.50")).toBe(1000.5)
		expect(read("de-DE", "£5")).toBeUndefined()
	})
})

// A canvas that records the rectangles it fills and the colour each stroke takes.
function recordingCanvas(): { canvas: GridCanvas; fills: string[]; strokes: string[] } {
	const fills: string[] = []
	const strokes: string[] = []
	const state = { fillStyle: "", strokeStyle: "", lineWidth: 1 }
	const canvas: Pick<GridCanvas, "fillStyle" | "strokeStyle" | "lineWidth" | "fillRect" | "rect" | "beginPath" | "stroke"> = {
		get fillStyle() {
			return state.fillStyle
		},
		set fillStyle(value: string | object) {
			state.fillStyle = typeof value === "string" ? value : ""
		},
		get strokeStyle() {
			return state.strokeStyle
		},
		set strokeStyle(value: string | object) {
			state.strokeStyle = typeof value === "string" ? value : ""
		},
		get lineWidth() {
			return state.lineWidth
		},
		set lineWidth(value: number) {
			state.lineWidth = value
		},
		fillRect: (x, y, width, height) => {
			fills.push(`${state.fillStyle} ${String(x)},${String(y)},${String(width)},${String(height)}`)
		},
		rect: () => undefined,
		beginPath: () => undefined,
		stroke: () => {
			strokes.push(state.strokeStyle)
		}
	}

	return { canvas: canvas as GridCanvas, fills, strokes }
}

describe("the formula's references outlined on the grid", () => {
	it("outlines each reference to the sheet shown in its colour, and leaves the others", () => {
		const colors = referenceColors(false)
		const references = highlightedReferences("=A1+Data!B2:C3+Other!A1+A1", REFERENCE_COLORS)
		const layer = referenceLayer({ references, ownSheet: "Data", shownSheet: "data", colors })
		const { canvas, fills, strokes } = recordingCanvas()
		const scene: Pick<GridPaintScene, "rangeRects"> = {
			rangeRects: range => [
				{
					x: range.startCol * 10,
					y: range.startRow * 10,
					width: (range.endCol - range.startCol + 1) * 10,
					height: (range.endRow - range.startRow + 1) * 10
				}
			]
		}

		layer.paint(canvas, scene as GridPaintScene)

		// A1 (twice, one colour) and Data!B2:C3 are on the sheet shown; Other!A1 is not.
		expect(strokes).toEqual([colors[0], colors[1], colors[0]])
		expect(fills.map(fill => fill.split(" ").at(-1))).toEqual(["0,0,10,10", "10,10,20,20", "0,0,10,10"])
		expect(layer.stage).toBe("chrome")
	})

	it("has colours for the light and the dark grid", () => {
		expect(referenceColors(false)).toHaveLength(REFERENCE_COLORS)
		expect(referenceColors(true)).toHaveLength(REFERENCE_COLORS)
		expect(referenceColors(true)[0]).not.toBe(referenceColors(false)[0])
	})
})

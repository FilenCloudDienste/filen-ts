import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { compoundBands, compoundRadii } from "../core/drawingml/compoundLine"
import { DrawingList } from "../core/drawingml/displayList"
import { shapeEffects } from "../core/drawingml/fill"
import { D, drawingReader } from "../core/drawingml/reader"
import { parseXml } from "../core/xml/index"
import { NS } from "./fixtures/presentation/renderDeck"

describe("compoundBands", () => {
	it("splits each compound type into lines that start at the outer edge and end at the inner one", () => {
		for (const compound of ["sng", "dbl", "thickThin", "thinThick", "tri"] as const) {
			const bands = compoundBands(compound)

			expect(bands[0]?.[0]).toBe(0)
			expect(bands[bands.length - 1]?.[1]).toBe(1)

			for (let k = 1; k < bands.length; k++) expect(bands[k]?.[0]).toBeGreaterThan(bands[k - 1]?.[1] ?? 1)
		}

		const widths = compoundBands("tri").map(([from, to]) => to - from)

		expect(widths.length).toBe(3)
		expect(widths[0]).toBeCloseTo(1 / 6, 9)
		expect(widths[1]).toBeCloseTo(1 / 3, 9)
		expect(widths[2]).toBeCloseTo(1 / 6, 9)
	})

	it("places centred and inset bands on each side of the path", () => {
		const double = compoundRadii("dbl", 6, false)

		expect(double.pen).toBe(6)
		expect(double.symmetric).toBe(true)

		for (const side of [double.outer, double.inner]) {
			expect(side.length).toBe(1)
			expect(side[0]?.[0]).toBeCloseTo(3, 9)
			expect(side[0]?.[1]).toBeCloseTo(1, 9)
		}

		expect(compoundRadii("thickThin", 8, false)).toEqual({
			pen: 8,
			outer: [[4, 0]],
			inner: [[4, 2]],
			symmetric: false
		})
		expect(compoundRadii("sng", 5, true)).toEqual({ pen: 10, outer: [], inner: [[5, 0]], symmetric: false })
	})
})

describe("outer shadow scale", () => {
	it("reports an outer shadow scaled by sx or sy as approximated", () => {
		const read = (attributes: string): readonly string[] => {
			const document = parseXml(
				new TextEncoder().encode(
					`<p:sp ${NS}><p:spPr><a:effectLst><a:outerShdw blurRad="0" dist="9525" dir="0" ${attributes}><a:srgbClr val="000000"/></a:outerShdw></a:effectLst></p:spPr></p:sp>`
				)
			)
			const reader = drawingReader(document)
			const context = {
				list: new DrawingList(),
				theme: drawingTheme(undefined, () => undefined),
				images: () => undefined,
				effects: true
			}

			return shapeEffects(context, reader, reader.child(document.documentElement(), D.P, "spPr"), undefined).approximated
		}

		expect(read("")).toEqual([])
		expect(read('sx="100000" sy="100000"')).toEqual([])
		expect(read('sx="90000"')).toEqual(["outerShdw"])
		expect(read('sy="-23000"')).toEqual(["outerShdw"])
	})
})

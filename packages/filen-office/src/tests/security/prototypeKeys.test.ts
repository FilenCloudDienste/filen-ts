import { describe, expect, it } from "vitest"
import { readPlotArea } from "../../core/drawingml/chart/model"
import { drawingTheme } from "../../core/drawingml/color"
import { DrawingList } from "../../core/drawingml/displayList"
import { shapeLine } from "../../core/drawingml/fill"
import { imageFormat } from "../../core/drawingml/picture"
import { D, drawingReader } from "../../core/drawingml/reader"
import { parseXml } from "../../core/xml/index"
import { NS } from "../fixtures/presentation/renderDeck"

// Lookup tables indexed by document strings resolve own keys only, never Object.prototype members.

const C_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'
const PROTOTYPE_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty"]

describe("prototype keys in DrawingML lookup tables", () => {
	it("reads an image content type or extension named after a prototype member as unknown", () => {
		for (const key of PROTOTYPE_KEYS) {
			expect(imageFormat("media/image1.bin", key)).toBe("unknown")
			expect(imageFormat("media/image1.bin", key.toUpperCase())).toBe("unknown")
			expect(imageFormat(`media/image1.${key}`, undefined)).toBe("unknown")
			expect(imageFormat(`media/image1.${key}`, "application/octet-stream")).toBe("unknown")
		}

		expect(imageFormat("media/image1.constructor", "image/png")).toBe("png")
		expect(imageFormat("media/image1.png", "constructor")).toBe("png")
	})

	it("ignores plot area children named after a prototype member", () => {
		const document = parseXml(
			new TextEncoder().encode(
				`<c:chartSpace ${C_NS}><c:chart><c:plotArea><c:constructor/><c:toString/><c:valueOf/></c:plotArea></c:chart></c:chartSpace>`
			)
		)
		const reader = drawingReader(document)
		const area = readPlotArea(reader, reader.child(reader.child(document.documentElement(), D.C, "chart"), D.C, "plotArea"))

		expect(area.plots).toEqual([])
	})

	it("falls back to the medium arrowhead size for a size named after a prototype member", () => {
		for (const key of PROTOTYPE_KEYS) {
			const document = parseXml(
				new TextEncoder().encode(
					`<p:sp ${NS}><p:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:headEnd type="triangle" w="${key}" len="${key}"/></a:ln></p:spPr></p:sp>`
				)
			)
			const reader = drawingReader(document)
			const context = {
				list: new DrawingList(),
				theme: drawingTheme(undefined, () => undefined),
				images: () => undefined,
				effects: true
			}
			const line = shapeLine(
				context,
				reader,
				reader.child(reader.child(document.documentElement(), D.P, "spPr"), D.A, "ln"),
				undefined
			)

			expect(line?.head).toEqual({ type: "triangle", width: 3, length: 3 })
		}
	})
})

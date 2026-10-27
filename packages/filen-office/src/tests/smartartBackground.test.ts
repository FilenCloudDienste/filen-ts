import { describe, expect, it } from "vitest"
import type { DrawingData } from "../core/drawingml/data"
import { ItemFloat, ItemInt, ItemKind } from "../core/drawingml/displayList"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { NS, SLIDE, THEME, THEME_PART, deckOf, renderServices, xfrm } from "./fixtures/presentation/renderDeck"

// A diagram's background and outline (ECMA-376 §21.4.3.1 bg, §21.4.3.10 whole) are the data model's, not the
// drawing cache's: they draw over the whole frame, under its shapes, cached or laid out.

const EMU = 9525
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }
const DGM =
	'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function paths(data: DrawingData): number[][] {
	const out: number[][] = []

	for (let item = 0; item < data.itemCount; item++) {
		if (data.itemInts[item * 10 + ItemInt.KIND] !== ItemKind.PATH) continue

		const f = item * 10

		out.push([ItemFloat.E, ItemFloat.F, ItemFloat.WIDTH, ItemFloat.HEIGHT].map(k => Math.round(data.itemFloats[f + k] ?? 0)))
	}

	return out
}

async function render(data: string, rels: Record<string, string> = {}): Promise<DrawingData | undefined> {
	const drawing =
		`<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>` +
		`<dsp:sp modelId="{1}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="${String(20 * EMU)}" y="${String(10 * EMU)}"/>` +
		`<a:ext cx="${String(50 * EMU)}" cy="${String(30 * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></dsp:spPr></dsp:sp>` +
		"</dsp:spTree></dsp:drawing>"
	const fixture = renderServices({
		parts: { [THEME_PART]: THEME, "/ppt/diagrams/data1.xml": data, "/ppt/diagrams/drawing1.xml": drawing },
		rels: { "/ppt/diagrams/data1.xml": rels }
	})
	const deck = deckOf(
		[],
		[],
		[
			{
				id: 4,
				name: "Diagram",
				hidden: false,
				kind: "frame",
				xfrm: xfrm(0, 0, 200 * EMU, 100 * EMU),
				frame: {
					kind: "smartart",
					data: "/ppt/diagrams/data1.xml",
					layout: "",
					style: "",
					colors: "",
					drawing: "/ppt/diagrams/drawing1.xml"
				}
			}
		]
	)

	return (await renderSlide(deck, SLIDE, fixture.services, SLICING)).layers[0]?.drawing
}

describe("SmartArt background", () => {
	it("fills and outlines the whole frame under the diagram's shapes", async () => {
		const data =
			`<dgm:dataModel ${DGM}><dgm:ptLst><dgm:pt modelId="0" type="doc"/></dgm:ptLst><dgm:cxnLst/>` +
			'<dgm:bg><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></dgm:bg><dgm:whole><a:ln w="12700"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln></dgm:whole></dgm:dataModel>'
		const drawn = await render(data)

		expect(paths(drawn as DrawingData)).toEqual([
			[0, 0, 200, 100],
			[20, 10, 50, 30]
		])
	})

	it("takes a background picture through the data part's relationships", async () => {
		const data =
			`<dgm:dataModel ${DGM} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dgm:ptLst><dgm:pt modelId="0" type="doc"/></dgm:ptLst><dgm:cxnLst/>` +
			'<dgm:bg><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></dgm:bg></dgm:dataModel>'
		const drawn = (await render(data, { rId1: "/ppt/media/photo.png" })) as DrawingData

		expect(paths(drawn)[0]).toEqual([0, 0, 200, 100])
		expect(drawn.images.map(image => image.partName)).toEqual(["/ppt/media/photo.png"])
	})

	it("draws nothing more without a background or outline", async () => {
		const data = `<dgm:dataModel ${DGM}><dgm:ptLst><dgm:pt modelId="0" type="doc"/></dgm:ptLst><dgm:cxnLst/><dgm:bg/><dgm:whole/></dgm:dataModel>`

		expect(paths((await render(data)) as DrawingData)).toEqual([[20, 10, 50, 30]])
	})
})

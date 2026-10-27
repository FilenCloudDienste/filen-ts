import { describe, expect, it } from "vitest"
import { RenderReport } from "../core/presentation/render/effects"
import { renderSlide } from "../core/presentation/render/slide"
import type { ShapeNode } from "../core/presentation/model"
import type { XmlDocument } from "../core/xml/index"
import {
	SLIDE,
	SLIDE_PART,
	THEME,
	THEME_PART,
	deckOf,
	elementById,
	part,
	renderServices,
	src,
	xfrm
} from "./fixtures/presentation/renderDeck"

// An embedded OLE object is drawn as the picture its p:oleObj holds (ECMA-376 Part 1 §19.3.2.4), with that picture's
// border, crop and effects, as PowerPoint shows it; an object without one shows its preview alone.

const SLICING = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }
const BOX = '<a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/>'

function frameMarkup(inner: string): string {
	return (
		`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm>${BOX}</p:xfrm>` +
		`<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj r:id="rId2" progId="Excel.Sheet.8"><p:embed/>${inner}</p:oleObj></a:graphicData></a:graphic></p:graphicFrame>`
	)
}

const PICTURE =
	'<p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:srcRect l="10000" r="10000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
	`<p:spPr><a:xfrm>${BOX}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr></p:pic>`

async function render(inner: string) {
	const fixture = renderServices({
		parts: { [THEME_PART]: THEME, [SLIDE_PART]: part(frameMarkup(inner)) },
		rels: { [SLIDE_PART]: { rId1: "/ppt/media/image1.png" } },
		types: { "/ppt/media/image1.png": "image/png" }
	})
	const shape: ShapeNode = {
		id: 10,
		name: "Object",
		hidden: false,
		kind: "frame",
		xfrm: xfrm(0, 0, 914400, 914400, { rot: 1800000 }),
		frame: { kind: "ole", progId: "Excel.Sheet.8", preview: "/ppt/media/image1.png" },
		src: src(fixture, SLIDE_PART, elementById(fixture.documents.get(SLIDE_PART) as XmlDocument, 10))
	}
	const report = new RenderReport()
	const rendered = await renderSlide(deckOf([], [], [shape]), SLIDE, fixture.services, SLICING, report)

	return { rendered, report }
}

describe("embedded OLE object frames", () => {
	it("draws the object's picture with its border and crop, rotated as the frame", async () => {
		const { rendered, report } = await render(PICTURE)
		const layer = rendered.layers[0]

		expect(rendered.layers.map(entry => entry.role)).toEqual(["ole"])
		expect(layer?.drawing.images.length).toBe(1)
		expect(layer?.drawing.strokes.length).toBe(1)
		expect(layer?.matrix[1]).toBeCloseTo(0.5)
		expect(report.toJSON().unsupported["olePreviewMissing"]).toBeUndefined()
	})

	it("draws the preview alone for an object without a picture", async () => {
		const { rendered } = await render("")

		expect(rendered.layers[0]?.drawing.images.length).toBe(1)
		expect(rendered.layers[0]?.drawing.strokes.length).toBe(0)
	})
})

import { describe, expect, it } from "vitest"
import { renderSlideFor } from "../dom/presentation/engine/view"
import { installTestRealm, openDeck, deckPdf } from "./presentationExportFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// A slide that relates an XML part the reader does not need to draw it (an SVG picture as Illustrator writes it, with
// an internal DTD subset; a broken table style part) still renders; at worst that picture shows its fallback.

const ILLUSTRATOR_SVG =
	'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
	'\t<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">\n\t<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">\n]>\n' +
	'<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:x="&ns_extend;" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function deck(svg: string): Uint8Array {
	const blip =
		'<a:blip r:embed="rIdPng"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rIdSvg"/></a:ext></a:extLst></a:blip>'

	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Text", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Hello"))) +
					`<p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(1_000_000, 1_000_000, 1_000_000, 1_000_000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
				rels: [
					["rIdPng", "image", "../media/image1.png"],
					["rIdSvg", "image", "../media/image2.svg"]
				]
			}
		],
		parts: {
			"ppt/media/image1.png": { data: PNG, type: "image/png" },
			"ppt/media/image2.svg": { data: svg, type: "image/svg+xml" }
		}
	})
}

describe("slides relating XML parts they do not draw from", () => {
	it("renders a slide whose SVG picture carries an internal DTD subset", async () => {
		installTestRealm()

		const context = await openDeck(deck(ILLUSTRATOR_SVG))
		const ref = context.session.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		const render = await renderSlideFor(context, ref)

		expect(render.layers.length).toBeGreaterThan(0)
	})

	it("exports that deck to PDF", { timeout: 60_000 }, async () => {
		installTestRealm()

		const context = await openDeck(deck(ILLUSTRATOR_SVG))

		await expect(deckPdf(context)).resolves.toBeDefined()
	})

	it("renders the same deck with a plain SVG", async () => {
		installTestRealm()

		const context = await openDeck(deck(ILLUSTRATOR_SVG.replace(/<!DOCTYPE[\s\S]*?\]>/u, "").replace("&ns_extend;", "x")))
		const ref = context.session.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		expect((await renderSlideFor(context, ref)).layers.length).toBeGreaterThan(0)
	})

	it("renders a slide when the deck's table style part is not well-formed", async () => {
		installTestRealm()

		const bytes = buildPptx({
			slides: [{ shapes: sp(2, "Text", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Hello"))) }],
			presentationRels: [["rIdTs", "tableStyles", "tableStyles.xml"]],
			parts: {
				"ppt/tableStyles.xml": {
					data: '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/><a:tblStyleLst/>',
					type: "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"
				}
			}
		})
		const context = await openDeck(bytes)
		const ref = context.session.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		expect((await renderSlideFor(context, ref)).layers.length).toBeGreaterThan(0)
	})
})

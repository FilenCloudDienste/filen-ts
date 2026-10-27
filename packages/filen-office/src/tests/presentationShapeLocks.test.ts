import { describe, expect, it } from "vitest"
import type { SlideRef } from "../core/presentation/model"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { DEFAULT_STYLES_AUTOMATIC, openOdpFixture, page, slideOf } from "./odpFixtures"
import { buildPptx, xfrm } from "./pptxFixtures"

// The file's own shape locks (ECMA-376 Part 1 §20.1.2.2; ODF style:protect) and line shapes, read into the model and
// carried on the layer box the editor starts from.

const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }
const RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'

function never(): never {
	throw new Error("unexpected undefined")
}

const shapes =
	'<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1" noCrop="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
	`<p:blipFill/><p:spPr>${xfrm(0, 0, 2000, 1000)}${RECT}</p:spPr></p:pic>` +
	'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Locked"/><p:cNvSpPr><a:spLocks noMove="1" noResize="1" noRot="1" noSelect="0"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>' +
	`<p:spPr>${xfrm(3000, 0, 1000, 1000)}${RECT}</p:spPr></p:sp>` +
	`<p:sp><p:nvSpPr><p:cNvPr id="4" name="Free"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(5000, 0, 1000, 1000)}${RECT}</p:spPr></p:sp>` +
	'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="5" name="Connector"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>' +
	`<p:spPr>${xfrm(0, 2000, 1000, 0)}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>` +
	'<p:sp><p:nvSpPr><p:cNvPr id="6" name="Old line"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
	`<p:spPr>${xfrm(0, 3000, 1000, 500)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom></p:spPr></p:sp>`

describe("the file's own shape locks", () => {
	it("reads a picture's noChangeAspect and a shape's noMove, noResize and noRot onto the model and the layer box", async () => {
		const opened = (await openRenderDeck(buildPptx({ slides: [{ shapes }] }))) ?? never()
		const ref: SlideRef = opened.deck.slides[0] ?? never()
		const services = { ...opened.services, layoutText: () => ({ page: fixtureTextPage(["x"], { width: 10 }), height: 10 }) }
		const render = await renderSlide(opened.deck, ref, services, SLICING)
		const node = opened.deck.nodes.get(ref) ?? never()
		const boxOf = (id: number) => render.layers.find(layer => layer.box?.id === id)?.box

		expect(node.shapes.map(shape => shape.locks)).toEqual([
			{ noChangeAspect: true },
			{ noMove: true, noResize: true, noRot: true },
			undefined,
			undefined,
			undefined
		])
		expect(boxOf(2)?.locks).toEqual({ noChangeAspect: true })
		expect(boxOf(3)?.locks).toEqual({ noMove: true, noResize: true, noRot: true })
		expect(boxOf(4)?.locks).toBeUndefined()
	})

	it("a connector and a line preset carry line on their box, a rectangle does not", async () => {
		const opened = (await openRenderDeck(buildPptx({ slides: [{ shapes }] }))) ?? never()
		const ref: SlideRef = opened.deck.slides[0] ?? never()
		const services = { ...opened.services, layoutText: () => ({ page: fixtureTextPage(["x"], { width: 10 }), height: 10 }) }
		const render = await renderSlide(opened.deck, ref, services, SLICING)
		const lineOf = (id: number) => render.layers.find(layer => layer.box?.id === id)?.box?.line

		expect([lineOf(4), lineOf(5), lineOf(6)]).toEqual([undefined, true, true])
	})

	it("an ODP frame whose style protects position and size reads as locked against moving, turning and resizing", async () => {
		const opened = await openOdpFixture({
			automatic:
				'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties style:protect="position size"/></style:style>' +
				'<style:style style:name="gr2" style:family="graphic"><style:graphic-properties style:protect="none"/></style:style>',
			stylesAutomatic: DEFAULT_STYLES_AUTOMATIC,
			body: page(
				'<draw:rect draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="2cm"/>' +
					'<draw:rect draw:style-name="gr2" svg:x="4cm" svg:y="1cm" svg:width="2cm" svg:height="2cm"/>'
			)
		})
		const slide = await slideOf(opened, 0)

		expect(slide.shapes.map(shape => shape.locks)).toEqual([{ noMove: true, noRot: true, noResize: true }, undefined])
	})
})

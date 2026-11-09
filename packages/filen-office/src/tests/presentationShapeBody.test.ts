import { describe, expect, it } from "vitest"
import { slideRef, type SlideRef } from "../core/presentation/model"
import type { SlideRender } from "../core/presentation/output"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { createShapeSelection, slideShapes } from "../react/presentation/edit/selection"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { buildPptx, xfrm } from "./pptxFixtures"

// What text body each top-level shape holds reaches the editor on its render box, so the canvas opens text only where
// there is a body (an sp's, a table's cells) and never asks the worker for one a picture, group or connector lacks.

const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

function never(): never {
	throw new Error("unexpected undefined")
}

const sp = (id: number, nv: string, nvPr = ""): string =>
	`<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="S${String(id)}"/>${nv}<p:nvPr>${nvPr}</p:nvPr></p:nvSpPr>` +
	`<p:spPr>${xfrm(0, 0, 4000, 3000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
	"<p:txBody><a:bodyPr/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>"

describe("the text body on a render box", () => {
	it("names a placeholder's, a text box's, a shape's and a table's body, and none for a connector or a group", async () => {
		const shapes =
			sp(2, "<p:cNvSpPr/>", '<p:ph type="title"/>') +
			sp(3, '<p:cNvSpPr txBox="1"/>') +
			sp(4, "<p:cNvSpPr/>") +
			'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="5" name="C5"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>' +
			`<p:spPr>${xfrm(0, 0, 4000, 3000)}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>` +
			'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="G6"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
			'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000" cy="3000"/><a:chOff x="0" y="0"/><a:chExt cx="4000" cy="3000"/></a:xfrm></p:grpSpPr>' +
			sp(7, "<p:cNvSpPr/>") +
			"</p:grpSp>" +
			'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="T8"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
			'<p:xfrm><a:off x="0" y="0"/><a:ext cx="4000" cy="3000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
			'<a:tbl><a:tblGrid><a:gridCol w="4000"/></a:tblGrid><a:tr h="3000"><a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>' +
			"</a:graphicData></a:graphic></p:graphicFrame>"
		const opened = (await openRenderDeck(buildPptx({ slides: [{ shapes }] }))) ?? never()
		const slide: SlideRef = opened.deck.slides[0] ?? never()
		const services = { ...opened.services, layoutText: () => ({ page: fixtureTextPage(["x"], { width: 10 }), height: 10 }) }
		const render: SlideRender = await renderSlide(opened.deck, slide, services, SLICING)
		const bodies = new Map(slideShapes(render).map(shape => [shape.id, shape.body]))

		expect(bodies.get(2)).toBe("placeholder")
		expect(bodies.get(3)).toBe("textBox")
		expect(bodies.get(4)).toBe("shape")
		expect(bodies.has(5)).toBe(true)
		expect(bodies.get(5)).toBeUndefined()
		expect(bodies.has(6)).toBe(true)
		expect(bodies.get(6)).toBeUndefined()
		expect(bodies.get(8)).toBe("table")
	})
})

describe("withdrawing a request to select what a command makes", () => {
	it("puts the selection back when the request is still waiting, and does nothing once it was resolved or replaced", () => {
		const ref = slideRef(256)
		const store = createShapeSelection()

		store.show(ref)
		store.set([3, 4])

		const withdraw = store.selectNew(ref, [3, 4])

		withdraw()
		expect(store.getSnapshot()).toEqual({ slide: ref, ids: [3, 4] })

		const stale = store.selectNew(ref, [3, 4])

		store.set([7])
		stale()
		expect(store.getSnapshot()).toEqual({ slide: ref, ids: [7] })
	})
})

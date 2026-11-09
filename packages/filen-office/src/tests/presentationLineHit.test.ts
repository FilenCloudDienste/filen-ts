import { describe, expect, it } from "vitest"
import { slideRef, type SlideRef, type Xfrm } from "../core/presentation/model"
import type { SlideLayer, SlideRender } from "../core/presentation/output"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { onLine, shapeAt, slideShapes } from "../react/presentation/edit/selection"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { buildPptx, xfrm } from "./pptxFixtures"

// A line or connector is hit near its stroke, not across its box (PowerPoint lets a click beside a diagonal line
// reach the shapes beneath it).

const ref = slideRef(256)
const DEG = 60000
const box = (x: number, y: number, cx: number, cy: number, rot = 0, flipH = false, flipV = false): Xfrm => ({
	x,
	y,
	cx,
	cy,
	rot,
	flipH,
	flipV
})
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

function never(): never {
	throw new Error("unexpected undefined")
}

function layer(id: number, at: Xfrm, line?: { readonly path?: readonly number[] }): SlideLayer {
	return {
		shape: { slide: ref, id },
		role: "shape",
		drawing: { width: 1, height: 1 },
		matrix: [1, 0, 0, 1, 0, 0],
		box: { id, xfrm: at, ...(line === undefined ? {} : { line: true, ...(line.path === undefined ? {} : { path: line.path }) }) }
	} as unknown as SlideLayer
}

function renderOf(layers: readonly SlideLayer[]): SlideRender {
	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

describe("presentation line hit testing", () => {
	it("a diagonal line on top takes clicks near its stroke only; the rest reach the shape beneath", () => {
		const shapes = slideShapes(renderOf([layer(3, box(0, 0, 4000, 3000)), layer(4, box(0, 0, 4000, 3000), {})]))

		// On the stroke, and within the slack of it.
		expect(shapeAt(shapes, { x: 2000, y: 1500 }, 50)?.id).toBe(4)
		expect(shapeAt(shapes, { x: 2030, y: 1470 }, 50)?.id).toBe(4)
		// Inside the line's box, away from the stroke: the rectangle beneath.
		expect(shapeAt(shapes, { x: 3500, y: 500 }, 50)?.id).toBe(3)
		expect(shapeAt(shapes, { x: 500, y: 2500 }, 50)?.id).toBe(3)
	})

	it("a flipped or turned line is hit along the stroke as it shows", () => {
		// flipH: from the top-right corner to the bottom-left.
		const flipped = box(0, 0, 4000, 3000, 0, true)

		expect(onLine(flipped, undefined, 4000, 0, 10)).toBe(true)
		expect(onLine(flipped, undefined, 1000, 2250, 10)).toBe(true)
		expect(onLine(flipped, undefined, 1000, 750, 10)).toBe(false)

		// A horizontal line turned a quarter stands upright about its centre.
		const turned = box(0, 1000, 2000, 0, 90 * DEG)

		expect(onLine(turned, undefined, 1000, 300, 10)).toBe(true)
		expect(onLine(turned, undefined, 300, 1000, 10)).toBe(false)
	})

	it("an elbow connector is hit along its legs, not across its box", () => {
		// bentConnector3 at its default 50%: right along the top, down the middle, right along the bottom.
		const path = [0, 0, 2000, 0, 2000, 3000, 4000, 3000]
		const at = box(0, 0, 4000, 3000)

		expect(onLine(at, path, 1000, 0, 10)).toBe(true)
		expect(onLine(at, path, 2000, 1500, 10)).toBe(true)
		expect(onLine(at, path, 3000, 3000, 10)).toBe(true)
		// On the box's diagonal, where a straight segment would run.
		expect(onLine(at, path, 1000, 750, 10)).toBe(false)
		// A NaN pair splits subpaths: no stroke across the gap.
		expect(onLine(at, [0, 0, 1000, 0, Number.NaN, Number.NaN, 3000, 0, 4000, 0], 2000, 0, 10)).toBe(false)
	})

	it("the render carries an elbow's and a curve's stroke on its box, a straight connector's none", async () => {
		const connector = (id: number, prst: string, adj = ""): string =>
			`<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${String(id)}" name="C${String(id)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
			`<p:spPr>${xfrm(0, 0, 4000, 3000)}<a:prstGeom prst="${prst}"><a:avLst>${adj}</a:avLst></a:prstGeom></p:spPr></p:cxnSp>`
		const shapes =
			connector(2, "straightConnector1") +
			connector(3, "bentConnector3", '<a:gd name="adj1" fmla="val 25000"/>') +
			connector(4, "curvedConnector3")
		const opened = (await openRenderDeck(buildPptx({ slides: [{ shapes }] }))) ?? never()
		const slide: SlideRef = opened.deck.slides[0] ?? never()
		const services = { ...opened.services, layoutText: () => ({ page: fixtureTextPage(["x"], { width: 10 }), height: 10 }) }
		const render = await renderSlide(opened.deck, slide, services, SLICING)
		const boxOf = (id: number) => render.layers.find(candidate => candidate.box?.id === id)?.box ?? never()

		expect(boxOf(2).line).toBe(true)
		expect(boxOf(2).path).toBeUndefined()

		const elbow = boxOf(3)

		expect(elbow.line).toBe(true)
		expect([...(elbow.path ?? [])].map(value => Math.round(value))).toEqual([0, 0, 1000, 0, 1000, 3000, 4000, 3000])

		const curve = boxOf(4).path ?? never()

		// The curve passes through the box's centre (its midpoint) and ends at the bottom-right corner.
		expect(onLine(elbow.xfrm, curve, 2000, 1500, 20)).toBe(true)
		expect(onLine(elbow.xfrm, curve, 4000, 3000, 20)).toBe(true)
		expect(onLine(elbow.xfrm, curve, 3500, 500, 20)).toBe(false)

		// Through slideShapes, a click on the elbow's empty corner misses it.
		const hit = slideShapes(render)

		expect(shapeAt(hit, { x: 3000, y: 1000 }, 20)?.id).toBeUndefined()
		expect(shapeAt(hit, { x: 1000, y: 1500 }, 20)?.id).toBe(3)
	})
})

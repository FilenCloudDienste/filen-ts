import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/displayList"
import type { ShapeNode } from "../core/presentation/model"
import { RenderReport } from "../core/presentation/render/effects"
import { renderSlide } from "../core/presentation/render/slide"
import type { XmlDocument } from "../core/xml/index"
import type { Slicing } from "../core/slicing"
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

const EMU = 9525

const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

const GROUP_XFRM = xfrm(0, 0, 100 * EMU, 50 * EMU, { chX: 0, chY: 0, chCx: 100 * EMU, chCy: 50 * EMU })

function child(id: number, extra: Partial<ShapeNode> = {}): ShapeNode {
	return {
		id,
		name: `c${String(id)}`,
		hidden: false,
		kind: "sp",
		xfrm: xfrm(0, 0, 100 * EMU, 50 * EMU),
		props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "336699" } } },
		...extra
	}
}

describe("group effects", () => {
	it("draws a group's own effects, its outer shadow included, around the whole group", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } })
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 2,
					name: "Group",
					hidden: false,
					kind: "grpSp",
					xfrm: GROUP_XFRM,
					props: {
						effects: {
							effects: [
								{ kind: "outerShdw", color: { kind: "srgb", rgb: "000000" }, blurRad: 9525, dist: 9525, dir: 0 },
								{ kind: "glow", color: { kind: "srgb", rgb: "FF0000" }, rad: 19050 }
							]
						}
					},
					children: [child(3)]
				}
			]
		)
		const report = new RenderReport()
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING, report)

		expect(render.layers).toHaveLength(1)
		expect(render.layers[0]?.effects).toEqual([
			{ kind: "outerShadow", color: rgba("000000"), blur: 1, dx: 1, dy: 0, sx: 1, sy: 1 },
			{ kind: "glow", color: rgba("FF0000"), radius: 2 }
		])
		expect(report.toJSON().approximated).toEqual({})
	})

	it("carries a source group's grpSpPr effect list into the drawing", async () => {
		const group =
			'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>' +
			'<a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/><a:chOff x="0" y="0"/><a:chExt cx="952500" cy="476250"/></a:xfrm>' +
			'<a:effectLst><a:softEdge rad="28575"/></a:effectLst></p:grpSpPr>' +
			'<p:sp><p:nvSpPr><p:cNvPr id="3" name="c3"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm>' +
			'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="336699"/></a:solidFill></p:spPr></p:sp></p:grpSp>'
		const fixture = renderServices({ parts: { [THEME_PART]: THEME, [SLIDE_PART]: part(group) } })
		const document = fixture.documents.get(SLIDE_PART) as XmlDocument
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 2,
					name: "Group",
					hidden: false,
					kind: "grpSp",
					xfrm: GROUP_XFRM,
					src: src(fixture, SLIDE_PART, elementById(document, 2)),
					children: [child(3, { src: src(fixture, SLIDE_PART, elementById(document, 3)) })]
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(render.layers[0]?.effects).toEqual([{ kind: "softEdge", radius: 3 }])
	})

	it("reports a grouped shape's effects beyond its first outer shadow instead of dropping them silently", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } })
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 2,
					name: "Group",
					hidden: false,
					kind: "grpSp",
					xfrm: GROUP_XFRM,
					children: [
						child(3, {
							props: {
								fill: { kind: "solid", color: { kind: "srgb", rgb: "336699" } },
								effects: {
									effects: [
										{ kind: "outerShdw", color: { kind: "srgb", rgb: "000000" }, blurRad: 0, dist: 9525, dir: 0 },
										{ kind: "glow", color: { kind: "srgb", rgb: "FF0000" }, rad: 19050 },
										{ kind: "softEdge", rad: 9525 }
									]
								}
							}
						}),
						child(4)
					]
				}
			]
		)
		const report = new RenderReport()
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING, report)

		expect(render.layers[0]?.effects).toBeUndefined()
		expect(report.toJSON().approximated).toEqual({ "group:childEffects": 2 })
	})
})

import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import { canFlip } from "../core/presentation/edit/commands/shape"
import type { SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { renderSlideFor } from "../dom/presentation/engine/view"
import { slideShapes } from "../react/presentation/edit/selection"
import { buildPptx, body, para, sp, xfrm } from "./pptxFixtures"
import { driveSession } from "./odpWriteDrive"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { tableFrame } from "./presentationObjectsFixtures"

// A group holding a table (or another graphic frame) cannot be flipped either: the flip would mirror the table, which
// has no flip PowerPoint draws (ECMA-376 §19.3.1.21). The Rotate menu does not offer it, and the command refuses it.

const GROUP = 9

function groupDeck(): Uint8Array {
	const box = '<a:off x="0" y="0"/><a:ext cx="4000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/>'

	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Group"))) +
					`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${String(GROUP)}" name="Group 9"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>${box}</a:xfrm></p:grpSpPr>` +
					tableFrame(3, [
						["A1", "B1"],
						["A2", "B2"]
					]) +
					sp(4, "Box", undefined, `${xfrm(3000000, 0, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
					"</p:grpSp>"
			}
		]
	})
}

describe("flipping a group that holds a table", () => {
	it("is not offered, and is refused as the command, the group kept as it was", async () => {
		const h = await editHarness(groupDeck(), { emit: emitPptx } as never)
		const slide = h.session.deck.slides[0] as SlideRef
		const render = await renderSlideFor(h.context, slide)
		const group = slideShapes(render).find(shape => shape.id === GROUP)

		expect(group).toBeDefined()
		expect(canFlip(group as NonNullable<typeof group>)).toBe(false)

		const before = shapeById((await h.slide(0)).shapes, GROUP)?.xfrm as Xfrm
		const result = await h.command({ family: "shape", kind: "setXfrm", target: { slide, id: GROUP }, xfrm: { ...before, flipH: true } })

		expect(result).toMatchObject({ ok: false, refusal: "unsupported" })
		expect(shapeById((await h.slide(0)).shapes, GROUP)?.xfrm?.flipH).toBe(false)
		expect(
			await h.command({ family: "shape", kind: "setXfrms", slide, xfrms: [{ id: GROUP, xfrm: { ...before, flipV: true } }] })
		).toMatchObject({ ok: false, refusal: "unsupported" })
	})
})

describe("flipping a group that holds a chart", () => {
	for (const nested of [false, true])
		it(`is not offered, and is refused as the command${nested ? ", the chart a group deeper" : ""}`, async () => {
			const d = await driveSession(
				buildPptx({
					slides: [
						{
							shapes:
								sp(
									2,
									"Box 2",
									undefined,
									`${xfrm(0, 3000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
								) +
								sp(
									3,
									"Box 3",
									undefined,
									`${xfrm(2000000, 3000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
								)
						}
					]
				}),
				"pptx"
			)
			const slide = d.session.deck.slides[0] as SlideRef
			const cells = sampleChartCells({ categories: ["A", "B"], series: ["North"] })

			expect((await d.command(insertChartOp(d.session.deck, slide, 0, "column", cells))).ok).toBe(true)

			const chart = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.frame?.kind === "chart")?.id ?? 0

			expect((await d.command({ family: "shape", kind: "group", slide, shapes: [chart, 2], id: 50 })).ok).toBe(true)
			if (nested) expect((await d.command({ family: "shape", kind: "group", slide, shapes: [50, 3], id: 60 })).ok).toBe(true)

			const id = nested ? 60 : 50
			const group = slideShapes(await renderSlideFor(d.context, slide)).find(shape => shape.id === id)

			expect(group).toBeDefined()
			expect(canFlip(group as NonNullable<typeof group>)).toBe(false)

			const before = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.id === id)?.xfrm as Xfrm

			expect(
				await d.command({ family: "shape", kind: "setXfrm", target: { slide, id }, xfrm: { ...before, flipH: true } })
			).toMatchObject({ ok: false, refusal: "unsupported" })
		})
})

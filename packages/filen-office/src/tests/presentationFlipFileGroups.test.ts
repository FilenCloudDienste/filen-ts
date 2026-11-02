import { describe, expect, it } from "vitest"
import { canFlip } from "../core/presentation/edit/commands/shape"
import type { SlideRef } from "../core/presentation/model"
import { renderSlideFor } from "../dom/presentation/engine/view"
import { slideShapes } from "../react/presentation/edit/selection"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { driveSession } from "./odpWriteDrive"

// A group read from the file that holds a chart is not offered Flip either, however the group is drawn: here its text
// child is drawn on a layer of its own and the chart on none of the group's, so only the child's layer carries what the
// group holds.

const CHART =
	'<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' +
	'<c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:val></c:ser>' +
	'<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>' +
	'<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>'
const BOX = '<a:off x="0" y="0"/><a:ext cx="4000000" cy="3000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="3000000"/>'

function group(id: number, members: string): string {
	return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${String(id)}" name="Group ${String(id)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>${BOX}</a:xfrm></p:grpSpPr>${members}</p:grpSp>`
}

const chartFrame =
	'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="14" name="Chart 13"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="3000000"/></p:xfrm>' +
	'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId20"/></a:graphicData></a:graphic></p:graphicFrame>'
const label = sp(
	18,
	"Rectangle 17",
	undefined,
	`${xfrm(1000000, 1000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
	body(para("2/3"))
)

function deck(shapes: string): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes,
				rels: [["rId20", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart", "../charts/chart1.xml"]]
			}
		],
		parts: { "ppt/charts/chart1.xml": { data: CHART, type: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml" } }
	})
}

describe("flipping a group read from the file that holds a chart", () => {
	for (const [name, shapes, id] of [
		["the chart in the group", group(101, chartFrame + label), 101],
		["the chart a group deeper", group(100, group(101, chartFrame + label) + sp(21, "Box", undefined, xfrm(0, 0, 500000, 500000))), 100]
	] as const)
		it(`is not offered: ${name}`, async () => {
			const d = await driveSession(deck(shapes), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef
			const shape = slideShapes(await renderSlideFor(d.context, slide)).find(each => each.id === id)

			expect(shape).toBeDefined()
			expect(canFlip(shape as NonNullable<typeof shape>)).toBe(false)
		})
})

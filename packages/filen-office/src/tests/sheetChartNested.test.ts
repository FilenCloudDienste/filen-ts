import { describe, expect, it } from "vitest"
import { DrawingList, ItemFloat } from "../core/drawingml/displayList"
import { drawingReader } from "../core/drawingml/reader"
import { bytesSource } from "../core/opc/index"
import { RenderStyleTable } from "../core/sheet/session"
import { nestedChartFrames } from "../core/xlsx/charts/render"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { openXlsx } from "../core/xlsx/read/index"
import { NodeKind, parseXml } from "../core/xml/index"
import { buildFixture, cells } from "./sheetSessionFixtures"
import { CHART_FRAME, wsDr } from "./sheetDrawingsFixtures"
import { KEPT, SOLD, barChart, chartFixture, openCharts } from "./sheetChartFixtures"

// A chart inside a group of a sheet's drawing: read before the shape walk and drawn into the group's list where the
// walker meets its frame, placed by the group's transform; the list keeps its own size.

const GROUP =
	"<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>" +
	"<xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>" +
	'<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="9" name="Group 8"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>' +
	'<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="2743200"/><a:chOff x="0" y="0"/><a:chExt cx="4572000" cy="2743200"/></a:xfrm></xdr:grpSpPr>' +
	CHART_FRAME.slice(CHART_FRAME.indexOf("<xdr:graphicFrame"), CHART_FRAME.indexOf("<xdr:clientData/>")).replace(
		'<a:ext cx="0" cy="0"/>',
		'<a:ext cx="4572000" cy="2743200"/>'
	) +
	"</xdr:grpSp><xdr:clientData/></xdr:twoCellAnchor>"

describe("charts in a group", () => {
	it("draws the chart of a frame inside a group, placed by the group's transform", async () => {
		const bytes = buildFixture({
			...chartFixture(barChart([SOLD, KEPT], { title: "Grouped" })),
			parts: {
				...chartFixture(barChart([SOLD, KEPT], { title: "Grouped" })).parts,
				"xl/drawings/drawing1.xml": { text: wsDr(GROUP), type: "application/vnd.openxmlformats-officedocument.drawing+xml" }
			}
		})
		const opened = await openXlsx(bytesSource(bytes))

		if (!opened.ok) throw new Error(opened.reason)

		const document = new XlsxDocument(opened.workbook, new RenderStyleTable(), { kind: "xlsx" })
		const drawing = parseXml(await opened.workbook.parts.read("xl/drawings/drawing1.xml"))
		const found = await nestedChartFrames(document, "xl/drawings/drawing1.xml", drawing)

		if (found === null) throw new Error("no chart in the group")

		const frame = found
		const node =
			Array.from({ length: drawing.count }, (_, index) => index).find(
				index => drawing.kind(index) === NodeKind.Element && drawing.localName(index) === "graphicFrame"
			) ?? -1
		const list = new DrawingList()

		list.width = 800
		list.height = 600

		const drew = frame(drawingReader(drawing), node, list, [1, 0, 0, 1, 100, 50], 4_572_000, 2_743_200)

		expect(drew).toBe(true)
		expect(list.itemCount).toBeGreaterThan(10)
		// Every item is moved by the group's translation; the list keeps the group's size.
		expect(list.itemFloat(0, ItemFloat.E)).toBe(100)
		expect(list.itemFloat(0, ItemFloat.F)).toBe(50)
		expect([list.width, list.height]).toEqual([800, 600])
		// A node that is no chart frame draws nothing.
		expect(frame(drawingReader(drawing), drawing.documentElement(), list, [1, 0, 0, 1, 0, 0], 1, 1)).toBe(false)
	})
})

describe("a group holding a chart in the sheet view", () => {
	it("draws the group with its chart and says it follows the cells", async () => {
		const fixture = chartFixture(barChart([SOLD, KEPT], { title: "Grouped" }))
		const { session, sheets } = await openCharts({
			...fixture,
			parts: {
				...fixture.parts,
				"xl/drawings/drawing1.xml": { text: wsDr(GROUP), type: "application/vnd.openxmlformats-officedocument.drawing+xml" }
			}
		})
		const sheet = sheets[0] ?? 0
		const group = (await session.layout(sheet)).extensions?.drawings?.objects[0]

		if (group === undefined) throw new Error("no group")

		const rendered = await session.query("drawing.render", { sheet, key: group.key, stamp: group.stamp })

		expect(group.kind).toBe("group")
		expect(rendered?.kind).toBe("drawing")
		expect(rendered?.kind === "drawing" && typeof rendered.live).toBe("string")
		expect(JSON.stringify(rendered?.kind === "drawing" ? rendered.drawing.texts : [])).toContain("Grouped")
		session.close()
	})

	it("answers the same while its charts show what they did, and draws again once their cells change", async () => {
		const fixture = chartFixture(barChart([SOLD, KEPT], { title: "Grouped" }))
		const { session, sheets } = await openCharts({
			...fixture,
			parts: {
				...fixture.parts,
				"xl/drawings/drawing1.xml": { text: wsDr(GROUP), type: "application/vnd.openxmlformats-officedocument.drawing+xml" }
			}
		})
		const sheet = sheets[0] ?? 0
		const group = (await session.layout(sheet)).extensions?.drawings?.objects[0]

		if (group === undefined) throw new Error("no group")

		const ask = (since: string | undefined) =>
			session.query("drawing.render", { sheet, key: group.key, stamp: group.stamp, ...(since === undefined ? {} : { since }) })
		const first = await ask(undefined)
		const since = first?.kind === "drawing" ? first.live : undefined

		expect(since).toBeTypeOf("string")
		// An edit no chart reads changes nothing it shows.
		await session.command({ type: "cells.set", sheet: sheets[1] ?? 0, cells: cells([[0, 0, "1"]]) })
		expect(await ask(since)).toEqual({ kind: "same", stamp: since })

		await session.command({ type: "cells.set", sheet, cells: cells([[2, 1, "50"]]) })

		const again = await ask(since)

		expect(again?.kind).toBe("drawing")
		expect(again?.kind === "drawing" && again.live).not.toBe(since)
		session.close()
	})

	it("draws an unnamed series of a grouped chart in the session's chart text, and again once that text changes", async () => {
		const fixture = chartFixture(barChart([SOLD, KEPT]).replace(/<c:tx>.*?<\/c:tx>/gu, ""))
		const { session, sheets } = await openCharts({
			...fixture,
			parts: {
				...fixture.parts,
				"xl/drawings/drawing1.xml": { text: wsDr(GROUP), type: "application/vnd.openxmlformats-officedocument.drawing+xml" }
			}
		})
		const sheet = sheets[0] ?? 0
		const group = (await session.layout(sheet)).extensions?.drawings?.objects[0]

		if (group === undefined) throw new Error("no group")

		const ask = (since: string | undefined) =>
			session.query("drawing.render", { sheet, key: group.key, stamp: group.stamp, ...(since === undefined ? {} : { since }) })
		const textOf = (render: Awaited<ReturnType<typeof ask>>): string =>
			render?.kind === "drawing" ? JSON.stringify(render.drawing.texts) : ""
		const first = await ask(undefined)
		const since = first?.kind === "drawing" ? first.live : undefined

		expect(textOf(first)).toContain("Series2")
		session.configure({ chartText: { series: "Datenreihe{n}", chartTitle: "Diagrammtitel", axisTitle: "Achsentitel" } })

		const german = await ask(since)

		expect(german?.kind).toBe("drawing")
		expect(textOf(german)).toContain("Datenreihe2")
		expect(textOf(german)).not.toContain("Series")
		session.close()
	})
})

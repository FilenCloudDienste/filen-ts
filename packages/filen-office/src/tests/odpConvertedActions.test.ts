import { describe, expect, it } from "vitest"
import { bytesSource, memorySink, ZipArchive } from "@filen/office/core/opc"
import { convertPresentation } from "../core/convert/presentation/index"
import { openPptx } from "../core/pptx/package"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// A shape converted to ODP keeps its outline, fill and text whatever its click action: "last slide viewed" is ODF's
// last-visited-page, and an action ODF has no form for (a custom show) is left off alone and reported.

function clicked(id: number, name: string, action: string): string {
	return sp(
		id,
		name,
		undefined,
		`${xfrm(100_000, id * 1_000_000, 3_000_000, 800_000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
		body(para(`${name} text`))
	).replace(
		`<p:cNvPr id="${String(id)}" name="${name}"/>`,
		`<p:cNvPr id="${String(id)}" name="${name}"><a:hlinkClick r:id="" action="${action}"/></p:cNvPr>`
	)
}

async function toOdp(bytes: Uint8Array) {
	const open = await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(open.reason)

	await open.parts.parseAll()

	const sink = memorySink()
	const archive = await ZipArchive.open(bytesSource(bytes))
	const converted = await convertPresentation(
		open.deck,
		{ format: "pptx", parts: open.parts, source: { archive, package: open.parts.opc } },
		"odp",
		sink,
		{}
	)

	if ("kind" in converted) throw new Error(converted.reason)

	const out = await ZipArchive.open(bytesSource(sink.bytes()))
	const entry = out.get("content.xml")

	if (entry === undefined) throw new Error("no content.xml")

	return { losses: converted.losses, content: new TextDecoder().decode(await out.read(entry)) }
}

describe("a pptx shape with a click action, converted to ODP", () => {
	it("last slide viewed: kept, its listener last-visited-page", async () => {
		const out = await toOdp(
			buildPptx({ slides: [{ shapes: clicked(3, "Back", "ppaction://hlinkshowjump?jump=lastslideviewed") }, { shapes: "" }] })
		)

		expect(out.content).toContain("Back text")
		expect(out.content).toMatch(/<presentation:event-listener [^>]*presentation:action="last-visited-page"/u)
		expect(out.losses.filter(loss => loss.kind === "shape" || loss.kind === "action")).toEqual([])
	})

	it("a custom show: kept without its action, the action reported", async () => {
		const out = await toOdp(buildPptx({ slides: [{ shapes: clicked(3, "Show", "ppaction://customshow?id=0") }] }))

		expect(out.content).toContain("Show text")
		expect(out.content).not.toContain("presentation:event-listener")
		expect(out.losses).toContainEqual(expect.objectContaining({ kind: "action", count: 1 }))
		expect(out.losses.filter(loss => loss.kind === "shape")).toEqual([])
	})
})

// A table whose cell has a fill a table cell cannot hold in ODF (fo:background-color has no alpha; a gradient, pattern
// or picture none at all): the table and its text kept, that fill written as its nearest opaque colour and reported.
function table(fills: readonly string[]): string {
	const cells = fills.map(
		(fill, at) =>
			`<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cell ${String(at)}</a:t></a:r></a:p></a:txBody><a:tcPr>${fill}</a:tcPr></a:tc>`
	)

	return (
		'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
		'<p:xfrm><a:off x="100000" y="100000"/><a:ext cx="4000000" cy="400000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
		`<a:tbl><a:tblPr/><a:tblGrid>${fills.map(() => '<a:gridCol w="1000000"/>').join("")}</a:tblGrid><a:tr h="400000">${cells.join("")}</a:tr></a:tbl>` +
		"</a:graphicData></a:graphic></p:graphicFrame>"
	)
}

describe("a pptx table converted to ODP", () => {
	it("with a semi-transparent, a gradient and a pattern cell fill: kept whole, the fills approximated and reported", async () => {
		const out = await toOdp(
			buildPptx({
				slides: [
					{
						shapes: table([
							'<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>',
							'<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="00FF00"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst></a:gradFill>',
							'<a:pattFill prst="dkDnDiag"><a:fgClr><a:srgbClr val="112233"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>'
						])
					}
				]
			})
		)

		for (const at of [0, 1, 2]) expect(out.content).toContain(`Cell ${String(at)}`)
		expect(out.content).toContain('fo:background-color="#ff0000"')
		expect(out.content).toContain('fo:background-color="#00ff00"')
		expect(out.content).toContain('fo:background-color="#112233"')
		expect(out.losses.filter(loss => loss.kind === "shape")).toEqual([])
		expect(out.losses).toContainEqual(expect.objectContaining({ kind: "fill" }))
	})
})

// Actions ODF has no listener for are never dropped silently: a refused click (a macro) or a hover on a shape is
// counted as an action loss, a refused text link is written as its raw link (inert, as the ODP writer keeps one), and a
// text link ODF can't hold (the last slide viewed) is counted.
describe("a pptx action ODF can't hold, converted to ODP", () => {
	it("a shape's refused click and its hover: the shape kept, each counted", async () => {
		const hover = sp(
			4,
			"Hover",
			undefined,
			`${xfrm(100_000, 3_000_000, 3_000_000, 800_000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
			body(para("Hover text"))
		).replace(
			'<p:cNvPr id="4" name="Hover"/>',
			'<p:cNvPr id="4" name="Hover"><a:hlinkHover r:id="" action="ppaction://hlinkshowjump?jump=nextslide"/></p:cNvPr>'
		)
		const out = await toOdp(buildPptx({ slides: [{ shapes: clicked(3, "Macro", "ppaction://macro?name=Run") + hover }] }))

		expect(out.content).toContain("Macro text")
		expect(out.content).toContain("Hover text")
		expect(out.losses).toContainEqual(expect.objectContaining({ kind: "action", count: 2 }))
	})

	it("a refused text link written as its raw link, a last-slide-viewed text link counted", async () => {
		const run = (text: string, action: string) =>
			`<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="" action="${action}"/></a:rPr><a:t>${text}</a:t></a:r>`
		const shape = sp(
			3,
			"Links",
			undefined,
			`${xfrm(100_000, 1_000_000, 3_000_000, 800_000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
			body(
				`<a:p>${run("Macro link", "ppaction://macro?name=Run")}${run(" back", "ppaction://hlinkshowjump?jump=lastslideviewed")}</a:p>`
			)
		)
		const out = await toOdp(buildPptx({ slides: [{ shapes: shape }, { shapes: "" }] }))

		expect(out.content).toMatch(/<text:a [^>]*xlink:href="ppaction:\/\/macro\?name=Run"[^>]*>Macro link<\/text:a>/u)
		expect(out.content).toContain(" back")
		expect(out.losses).toContainEqual(expect.objectContaining({ kind: "action", count: 1 }))
		expect(out.losses.filter(loss => loss.kind === "shape")).toEqual([])
	})
})

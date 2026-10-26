import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptx, type PptxParts } from "../core/pptx/package"
import type { Deck, ShapeNode, SlideNode } from "../core/presentation/model"
import { body, buildPptx, para, sp, xfrm, type FixtureOptions } from "./pptxFixtures"

// The PresentationML reader into the shared model: every level stores what its source wrote, nothing resolved.

async function open(options: FixtureOptions): Promise<{ deck: Deck; parts: PptxParts; slides: SlideNode[] }> {
	const result = await openPptx(bytesSource(buildPptx(options)))

	if (result.kind !== "opened") throw new Error(`${result.reason}: ${result.detail ?? ""}`)

	await result.parts.parseAll()

	return {
		deck: result.deck,
		parts: result.parts,
		slides: result.deck.slides.map(ref => result.deck.nodes.get(ref) ?? fail(`slide ${String(ref)}`))
	}
}

async function shapesOf(shapes: string, extra: Partial<FixtureOptions> = {}): Promise<ShapeNode[]> {
	const [first, ...rest] = extra.slides ?? []
	const { slides } = await open({ ...extra, slides: [{ ...first, shapes }, ...rest] })

	return slides[0]?.shapes ?? []
}

function fail(what: string): never {
	throw new Error(`missing ${what}`)
}

const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const A14 = "http://schemas.microsoft.com/office/drawing/2010/main"

describe("pptx shapes", () => {
	it("reads names, alt text, hidden, decorative and the placeholder with its defaults", async () => {
		const decorative =
			'<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>'
		const shapes = await shapesOf(
			`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Pic" descr="A chart" title="Q3" hidden="1">${decorative}</p:cNvPr><p:cNvSpPr/><p:nvPr><p:ph/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
				sp(3, "Vertical", 'type="body" orient="vert" sz="half" idx="7" hasCustomPrompt="1"')
		)

		expect(shapes[0]).toMatchObject({
			id: 2,
			name: "Pic",
			alt: { descr: "A chart", title: "Q3", decorative: true },
			hidden: true,
			kind: "sp",
			ph: { type: "obj", idx: 0 }
		})
		expect(shapes[0]?.xfrm).toBeUndefined()
		expect(shapes[1]?.ph).toEqual({ type: "body", idx: 7, idxWritten: true, orient: "vert", sz: "half", hasCustomPrompt: true })
	})

	it("reads xfrm in EMU with rotation, flips and group child space", async () => {
		const shapes = await shapesOf(
			'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
				'<p:grpSpPr><a:xfrm rot="5400000" flipH="1"><a:off x="10" y="20"/><a:ext cx="300" cy="400"/><a:chOff x="1" y="2"/><a:chExt cx="30" cy="40"/></a:xfrm></p:grpSpPr>' +
				sp(5, "Child", undefined, '<a:xfrm flipV="1"><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm>') +
				"</p:grpSp>" +
				sp(6, "Strict units", undefined, '<a:xfrm><a:off x="1in" y="2.54cm"/><a:ext cx="72pt" cy="0"/></a:xfrm>')
		)

		expect(shapes[0]).toMatchObject({
			kind: "grpSp",
			xfrm: { x: 10, y: 20, cx: 300, cy: 400, rot: 5_400_000, flipH: true, flipV: false, chX: 1, chY: 2, chCx: 30, chCy: 40 }
		})
		expect(shapes[0]?.children?.[0]).toMatchObject({ id: 5, xfrm: { x: 1, y: 2, cx: 3, cy: 4, flipV: true } })
		expect(shapes[1]?.xfrm).toMatchObject({ x: 914_400, y: 914_400, cx: 914_400, cy: 0 })
	})

	it("reassigns repeated cNvPr ids and keeps the written one", async () => {
		const shapes = await shapesOf(sp(5, "A", undefined) + sp(5, "B", undefined) + sp(1, "C", undefined))

		expect(shapes.map(shape => [shape.id, shape.sourceId])).toEqual([
			[5, undefined],
			[6, 5],
			[7, 1]
		])
	})

	it("reads tables, charts, SmartArt, OLE and unknown frames", async () => {
		const frame = (id: number, graphic: string, uri: string): string =>
			`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="F${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
			`<p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm><a:graphic><a:graphicData uri="${uri}">${graphic}</a:graphicData></a:graphic></p:graphicFrame>`
		const table =
			'<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>' +
			'<a:tblGrid><a:gridCol w="100"/><a:gridCol w="200"/></a:tblGrid><a:tr h="50">' +
			'<a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Merged</a:t></a:r></a:p></a:txBody>' +
			'<a:tcPr marL="10" anchor="ctr"><a:lnL w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnL><a:lnR><a:noFill/></a:lnR><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:tcPr></a:tc>' +
			'<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>'
		const shapes = await shapesOf(
			frame(2, table, "http://schemas.openxmlformats.org/drawingml/2006/table") +
				frame(
					3,
					'<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId10"/>',
					"http://schemas.openxmlformats.org/drawingml/2006/chart"
				) +
				frame(
					4,
					'<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId11" r:lo="rId12" r:qs="rId13" r:cs="rId14"/>',
					"http://schemas.openxmlformats.org/drawingml/2006/diagram"
				) +
				frame(
					5,
					'<p:oleObj progId="Excel.Sheet.12" r:id="rId15"><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId16"/></p:blipFill><p:spPr/></p:pic></p:oleObj>',
					"http://schemas.openxmlformats.org/presentationml/2006/ole"
				) +
				frame(6, "<x:unknown xmlns:x='urn:x'/>", "urn:unknown"),
			{
				slides: [
					{
						shapes: "",
						rels: [
							["rId10", "chart", "../charts/chart1.xml"],
							["rId11", "diagramData", "../diagrams/data1.xml"],
							["rId12", "diagramLayout", "../diagrams/layout1.xml"],
							["rId13", "diagramQuickStyle", "../diagrams/quickStyle1.xml"],
							["rId14", "diagramColors", "../diagrams/colors1.xml"],
							["rId15", "package", "../embeddings/sheet.xlsx"],
							["rId16", "image", "../media/image9.emf"]
						]
					}
				]
			}
		)
		const [tableShape, chart, smartart, ole, unknown] = shapes

		expect(tableShape?.frame?.kind).toBe("table")

		const model = tableShape?.frame?.kind === "table" ? tableShape.frame.table : fail("table")

		expect(model.grid).toEqual([100, 200])
		expect(model.styleId).toBe("{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}")
		expect(model.flags).toEqual({ firstRow: true, lastRow: false, firstCol: false, lastCol: false, bandRow: true, bandCol: false })
		expect(model.rows[0]?.h).toBe(50)
		expect(model.rows[0]?.cells[0]).toMatchObject({
			gridSpan: 2,
			props: {
				marL: 10,
				anchor: "ctr",
				fill: { kind: "solid", color: { kind: "scheme", slot: "accent1" } },
				borders: { l: { w: 12700, fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } }, r: "none" }
			}
		})
		expect(model.rows[0]?.cells[0]?.text.paragraphs[0]?.runs[0]).toMatchObject({ text: "Merged" })
		expect(model.rows[0]?.cells[1]?.hMerge).toBe(true)
		expect(chart?.frame).toEqual({ kind: "chart", part: "/ppt/charts/chart1.xml" })
		expect(smartart?.frame).toEqual({
			kind: "smartart",
			data: "/ppt/diagrams/data1.xml",
			layout: "/ppt/diagrams/layout1.xml",
			style: "/ppt/diagrams/quickStyle1.xml",
			colors: "/ppt/diagrams/colors1.xml"
		})
		expect(ole?.frame).toEqual({
			kind: "ole",
			progId: "Excel.Sheet.12",
			part: "/ppt/embeddings/sheet.xlsx",
			preview: "/ppt/media/image9.emf"
		})
		expect(unknown?.frame?.kind).toBe("unknown")
		expect(unknown?.lock).toBe("unknownFrame")
	})

	it("reads embedded and linked media with the poster, never resolving a link", async () => {
		const pic = (id: number, nvPr: string, embed: string): string =>
			`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Media ${id}"/><p:cNvPicPr/><p:nvPr>${nvPr}</p:nvPr></p:nvPicPr>` +
			`<p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr>${xfrm(0, 0, 10, 10)}</p:spPr></p:pic>`
		const p14 = `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="${P14}" r:embed="rId21"/></p:ext></p:extLst>`
		const shapes = await shapesOf(
			pic(2, `<a:videoFile r:link="rId20"/>${p14}`, "rId22") +
				pic(3, '<a:videoFile r:link="rId23"/>', "rId22") +
				pic(4, '<a:wavAudioFile r:embed="rId24"/>', "rId22"),
			{
				slides: [
					{
						shapes: "",
						rels: [
							["rId20", "video", "../media/media1.mp4"],
							["rId21", "http://schemas.microsoft.com/office/2007/relationships/media", "../media/media1.mp4"],
							["rId22", "image", "../media/poster.png"],
							["rId23", "video", "https://example.com/clip", "External"],
							["rId24", "audio", "../media/sound.wav"]
						]
					}
				],
				parts: {
					"ppt/media/media1.mp4": { data: new Uint8Array(32), type: "video/mp4" },
					"ppt/media/sound.wav": { data: new Uint8Array(16), type: "audio/wav" }
				}
			}
		)

		expect(shapes[0]?.media).toEqual({
			kind: "video",
			part: "/ppt/media/media1.mp4",
			contentType: "video/mp4",
			size: 32,
			poster: "/ppt/media/poster.png"
		})
		expect(shapes[1]?.media).toEqual({
			kind: "video",
			external: "https://example.com/clip",
			contentType: "video/unknown",
			poster: "/ppt/media/poster.png"
		})
		expect(shapes[2]?.media).toMatchObject({ kind: "audio", part: "/ppt/media/sound.wav", contentType: "audio/wav", size: 16 })
	})

	it("reads the understood mc:Choice and locks its shapes, keeping unknown ones opaque", async () => {
		const shapes = await shapesOf(
			`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="${P14}" Requires="p14">` +
				'<p:contentPart p14:bwMode="auto" r:id="rId3"><p14:nvContentPartPr><p14:cNvPr id="9" name="Ink 8"/><p14:cNvContentPartPr/><p14:nvPr/></p14:nvContentPartPr>' +
				'<p14:xfrm><a:off x="5" y="6"/><a:ext cx="7" cy="8"/></p14:xfrm></p:contentPart></mc:Choice>' +
				`<mc:Fallback>${sp(9, "Ink fallback", undefined)}</mc:Fallback></mc:AlternateContent>` +
				'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:zz="urn:future"><mc:Choice Requires="zz"><zz:shape/></mc:Choice></mc:AlternateContent>'
		)

		expect(shapes[0]).toMatchObject({ kind: "ink", id: 9, name: "Ink 8", xfrm: { x: 5, y: 6, cx: 7, cy: 8 }, lock: "alternateContent" })
		expect(shapes[1]).toMatchObject({ kind: "opaque", lock: "alternateContent" })
		expect(shapes[1]?.src).toBeDefined()
	})

	it("classifies click and hover actions on shapes and runs", async () => {
		const shapes = await shapesOf(
			'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Link"><a:hlinkClick r:id="rId30"/><a:hlinkHover r:id="" action="ppaction://program"/></p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
				'<p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:hlinkClick r:id="rId31" action="ppaction://hlinksldjump"/></a:rPr><a:t>Next</a:t></a:r></a:p></p:txBody></p:sp>',
			{
				slides: [
					{
						shapes: "",
						rels: [
							["rId30", "hyperlink", "https://filen.io/", "External"],
							["rId31", "slide", "slide2.xml"]
						]
					},
					{ shapes: "" }
				]
			}
		)
		const run = shapes[0]?.text?.paragraphs[0]?.runs[0]

		expect(shapes[0]?.actions).toEqual({
			click: { kind: "url", href: "https://filen.io/" },
			hover: { kind: "refused", what: "program", raw: "ppaction://program" }
		})
		expect(run?.kind === "r" ? run.rPr.hlinkClick : undefined).toMatchObject({ kind: "slide" })
	})
})

describe("pptx text", () => {
	it("reads runs, breaks, fields and the end-of-paragraph properties as written", async () => {
		const shapes = await shapesOf(
			sp(
				2,
				"Text",
				undefined,
				"",
				'<a:bodyPr/><a:p><a:r><a:rPr lang="en-GB" sz="2400" b="1" i="0" u="sng" strike="dblStrike" baseline="30000" cap="small" spc="-50" kern="1200" noProof="1"/><a:t>One</a:t></a:r>' +
					'<a:br><a:rPr sz="1000"/></a:br><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr/><a:t>‹#›</a:t></a:fld><a:endParaRPr sz="1800"/></a:p>'
			)
		)
		const paragraph = shapes[0]?.text?.paragraphs[0]

		expect(paragraph?.runs).toEqual([
			{
				kind: "r",
				text: "One",
				rPr: {
					lang: "en-GB",
					sz: 2400,
					b: true,
					i: false,
					u: "sng",
					strike: "dblStrike",
					baseline: 30000,
					cap: "small",
					spc: -50,
					kern: 1200,
					noProof: true
				}
			},
			{ kind: "br", rPr: { sz: 1000 } },
			{ kind: "fld", type: "slidenum", id: "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}", text: "‹#›", rPr: {} }
		])
		expect(paragraph?.endRPr).toEqual({ sz: 1800 })
		expect(paragraph?.src).toMatchObject({ format: "pptx", part: "/ppt/slides/slide1.xml", epoch: 0 })
	})

	it("reads run fills, outline, fonts, highlight and underline styles", async () => {
		const rPr =
			'<a:rPr><a:ln w="9525"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill><a:prstDash val="dash"/><a:round/></a:ln>' +
			'<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"><a:alpha val="50000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
			'<a:highlight><a:srgbClr val="FFFF00"/></a:highlight><a:uLnTx/><a:uFill><a:solidFill><a:prstClr val="red"/></a:solidFill></a:uFill>' +
			'<a:latin typeface="+mj-lt" pitchFamily="34" charset="0"/><a:ea typeface="MS Gothic"/><a:sym typeface="Wingdings" panose="05000000000000000000"/></a:rPr>'
		const shapes = await shapesOf(sp(2, "Text", undefined, "", `<a:bodyPr/><a:p><a:r>${rPr}<a:t>x</a:t></a:r></a:p>`))
		const run = shapes[0]?.text?.paragraphs[0]?.runs[0]

		expect(run?.kind === "r" ? run.rPr : undefined).toEqual({
			ln: {
				w: 9525,
				fill: { kind: "solid", color: { kind: "scheme", slot: "tx1", mods: [{ name: "lumMod", value: 75000 }] } },
				dash: "dash",
				join: "round"
			},
			fill: {
				kind: "gradient",
				stops: [
					{ pos: 0, color: { kind: "srgb", rgb: "FF0000" } },
					{ pos: 100000, color: { kind: "srgb", rgb: "0000FF", mods: [{ name: "alpha", value: 50000 }] } }
				],
				linear: { angle: 5_400_000, scaled: false }
			},
			highlight: { kind: "srgb", rgb: "FFFF00" },
			uLn: "text",
			uFill: { kind: "solid", color: { kind: "preset", name: "red" } },
			latin: { typeface: "+mj-lt", pitchFamily: 34, charset: 0 },
			ea: { typeface: "MS Gothic" },
			sym: { typeface: "Wingdings", panose: "05000000000000000000" }
		})
	})

	it("reads paragraph properties: bullets, spacing (Strict percentages too), tabs and defaults", async () => {
		const pPr =
			'<a:pPr lvl="2" algn="just" marL="342900" indent="-342900" defTabSz="914400" rtl="0" eaLnBrk="1" fontAlgn="base">' +
			'<a:lnSpc><a:spcPct val="90%"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef><a:spcAft><a:spcPct val="20000"/></a:spcAft>' +
			'<a:buClr><a:schemeClr val="accent2"/></a:buClr><a:buSzPct val="75000"/><a:buFont typeface="Arial"/><a:buAutoNum type="romanUcPeriod" startAt="3"/>' +
			'<a:tabLst><a:tab pos="457200" algn="dec"/><a:tab pos="914400"/></a:tabLst><a:defRPr sz="1400"/></a:pPr>'
		const shapes = await shapesOf(
			sp(
				2,
				"Text",
				undefined,
				"",
				`<a:bodyPr/><a:p>${pPr}<a:r><a:t>x</a:t></a:r></a:p><a:p><a:pPr><a:buClrTx/><a:buSzTx/><a:buFontTx/><a:buNone/></a:pPr></a:p>`
			)
		)
		const [first, second] = shapes[0]?.text?.paragraphs ?? []

		expect(first?.pPr).toEqual({
			lvl: 2,
			algn: "just",
			fontAlgn: "base",
			marL: 342900,
			indent: -342900,
			defTabSz: 914400,
			rtl: false,
			eaLnBrk: true,
			lnSpc: { pct: 90000 },
			spcBef: { pts: 600 },
			spcAft: { pct: 20000 },
			buClr: { kind: "scheme", slot: "accent2" },
			buSz: { pct: 75000 },
			buFont: { typeface: "Arial" },
			bullet: { kind: "autoNum", scheme: "romanUcPeriod", startAt: 3 },
			tabs: [
				{ pos: 457200, algn: "dec" },
				{ pos: 914400, algn: "l" }
			],
			defRPr: { sz: 1400 }
		})
		expect(second?.pPr).toEqual({ buClr: "text", buSz: "text", buFont: "text", bullet: { kind: "none" } })
	})

	it("reads only the bodyPr attributes written, an inset not written as NaN", async () => {
		const shapes = await shapesOf(
			sp(
				2,
				"A",
				undefined,
				"",
				body(
					"",
					'<a:bodyPr lIns="91440" anchor="ctr" vert="eaVert" wrap="none" rot="-5400000" numCol="2" spcCol="95250"><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr>'
				)
			) +
				sp(3, "B", undefined, "", body("", "<a:bodyPr><a:spAutoFit/></a:bodyPr>")) +
				sp(4, "C", undefined, "", body("", "<a:bodyPr/>"))
		)

		expect(shapes[0]?.text?.bodyPr).toEqual({
			insets: { left: 9.6, top: Number.NaN, right: Number.NaN, bottom: Number.NaN },
			anchor: "ctr",
			vertical: "eaVert",
			wrap: false,
			rotation: -90,
			columns: 2,
			columnSpacing: 10,
			autofit: "normal",
			fontScale: 0.625,
			lineSpacingReduction: 0.2
		})
		expect(shapes[1]?.text?.bodyPr).toEqual({ autofit: "shape" })
		expect(shapes[2]?.text?.bodyPr).toEqual({})
	})

	it("keeps math as an opaque run with its fallback's text", async () => {
		const math =
			`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="${A14}" Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"/></a14:m></mc:Choice>` +
			'<mc:Fallback><a:r><a:rPr><a:blipFill><a:blip r:embed="rId9"/></a:blipFill></a:rPr><a:t>x²</a:t></a:r></mc:Fallback></mc:AlternateContent>'
		const shapes = await shapesOf(sp(2, "Math", undefined, "", `<a:bodyPr/><a:p>${math}</a:p>`))

		expect(shapes[0]?.text?.paragraphs[0]?.runs[0]).toMatchObject({ kind: "opaque", text: "x²", src: { format: "pptx" } })
	})
})

describe("pptx slide levels", () => {
	it("reads masters, layouts and slides with their links, colour maps, styles and backgrounds", async () => {
		const { deck, slides } = await open({
			slides: [
				{
					shapes: '<p:cSld name="Intro"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree/></p:cSld>',
					attributes: ' showMasterSp="0"',
					after: '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>'
				},
				{ shapes: "", layout: 2 }
			]
		})
		const master = deck.nodes.get(deck.masters[0] ?? fail("master")) ?? fail("master node")
		const [layout1, layout2] = deck.layouts.map(ref => deck.nodes.get(ref) ?? fail("layout"))

		expect(master).toMatchObject({
			kind: "master",
			name: "Office Theme",
			theme: { part: "/ppt/theme/theme1.xml", revision: 0 },
			showMasterShapes: true
		})
		expect(master.clrMap?.bg1).toBe("lt1")
		expect(master.background).toMatchObject({ kind: "ref", idx: 1002, color: { kind: "scheme", slot: "bg1" } })
		expect(master.txStyles?.title.levels[0]).toMatchObject({ algn: "ctr", defRPr: { sz: 4400, latin: { typeface: "+mj-lt" } } })
		expect(master.txStyles?.body.levels[1]).toMatchObject({ marL: 685800, defRPr: { sz: 2400 } })
		expect(layout1).toMatchObject({
			kind: "layout",
			name: "Title and Content",
			layoutType: "obj",
			parent: master.ref,
			clrMapOvr: "master"
		})
		expect(layout2?.layoutType).toBe("blank")
		expect(slides[0]).toMatchObject({ kind: "slide", name: "Intro", parent: layout1?.ref, showMasterShapes: false, hidden: false })
		expect(slides[0]?.clrMapOvr).toMatchObject({ bg1: "dk1", tx1: "lt1" })
		expect(slides[0]?.background).toMatchObject({ kind: "fill", fill: { kind: "solid", color: { kind: "srgb", rgb: "112233" } } })
		expect(slides[1]?.parent).toBe(layout2?.ref)
	})

	it("reads notes slides under the notes master with its notes style", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: "", notes: para("Speak slowly") }] })
		const notes = deck.nodes.get(slides[0]?.notes ?? fail("notes ref")) ?? fail("notes")
		const master = deck.nodes.get(deck.notesMaster ?? fail("notes master")) ?? fail("notes master node")

		expect(notes).toMatchObject({ kind: "notes", parent: master.ref })
		expect(notes.shapes[1]?.text?.paragraphs[0]?.runs[0]).toMatchObject({ text: "Speak slowly" })
		expect(master.txStyles?.body.levels[0]).toEqual({ defRPr: { sz: 1200 } })
		expect(master.theme?.part).toBe("/ppt/theme/theme1.xml")
	})

	it("reads header and footer flags, all on by default", async () => {
		const { deck } = await open({ slides: [], masterAfter: '<p:hf hdr="0" dt="0"/><p:txStyles/>' })
		const master = deck.nodes.get(deck.masters[0] ?? fail("master"))

		expect(master?.hf).toEqual({ sldNum: true, hdr: false, ftr: true, dt: false })
	})
})

describe("pptx presentation part", () => {
	it("reads sections, custom shows, show settings, embedded fonts and authors", async () => {
		const sections =
			`<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="${P14}">` +
			'<p14:section name="Intro" id="{11111111-1111-1111-1111-111111111111}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="999"/></p14:sldIdLst></p14:section>' +
			'<p14:section name="Rest" id="{22222222-2222-2222-2222-222222222222}"><p14:sldIdLst><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>'
		const fonts =
			'<p:embeddedFontLst><p:embeddedFont><p:font typeface="Lato" pitchFamily="34" charset="0"/><p:regular r:id="rId60"/><p:bold r:id="rId61"/></p:embeddedFont></p:embeddedFontLst>'
		const shows =
			'<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId102"/></p:sldLst></p:custShow></p:custShowLst>'
		const { deck } = await open({
			slides: [{ shapes: "" }, { shapes: "" }],
			presentationAttributes: ' firstSlideNum="5"',
			presentation: `${fonts}${shows}<p:defaultTextStyle><a:defPPr><a:defRPr lang="de-DE"/></a:defPPr></p:defaultTextStyle>${sections}`,
			presentationRels: [
				["rId60", "font", "fonts/font1.fntdata"],
				["rId61", "font", "fonts/font2.fntdata"],
				["rId70", "presProps", "presProps.xml"],
				["rId71", "commentAuthors", "commentAuthors.xml"],
				["rId72", "http://schemas.microsoft.com/office/2018/10/relationships/authors", "authors.xml"]
			],
			parts: {
				"ppt/presProps.xml": {
					data: '<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:showPr loop="1" showNarration="1" useTimings="0"><p:kiosk restart="60000"/><p:sldRg st="2" end="3"/><p:penClr><a:prstClr val="red"/></p:penClr></p:showPr></p:presentationPr>'
				},
				"ppt/commentAuthors.xml": {
					data: '<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="1" name="Ann" initials="A" lastIdx="2" clrIdx="0"/></p:cmAuthorLst>'
				},
				"ppt/authors.xml": {
					data: '<p188:authorLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"><p188:author id="{AAA}" name="Bo" initials="B" userId="bo@x" providerId="AD"/></p188:authorLst>'
				}
			}
		})
		const [first, second] = deck.slides

		expect(deck.firstSlideNumber).toBe(5)
		expect(deck.sections).toEqual([
			{ name: "Intro", id: "{11111111-1111-1111-1111-111111111111}", slides: [first] },
			{ name: "Rest", id: "{22222222-2222-2222-2222-222222222222}", slides: [second] }
		])
		expect(deck.customShows).toEqual([{ name: "Short", id: 0, slides: [second] }])
		expect(deck.show).toEqual({
			kind: "kiosk",
			loop: true,
			showNarration: true,
			showAnimation: true,
			useTimings: false,
			range: { kind: "range", start: 2, end: 3 },
			penColor: { kind: "preset", name: "red" },
			restartMs: 60000
		})
		expect(deck.embeddedFonts).toEqual([
			{ typeface: "Lato", regular: "/ppt/fonts/font1.fntdata", bold: "/ppt/fonts/font2.fntdata", charset: 0, pitchFamily: 34 }
		])
		expect(deck.defaultTextStyle.def).toEqual({ defRPr: { lang: "de-DE" } })
		expect(deck.authors).toEqual([
			{ id: "1", name: "Ann", initials: "A", legacyId: 1 },
			{ id: "{AAA}", name: "Bo", initials: "B", userId: "bo@x", providerId: "AD" }
		])
	})
})

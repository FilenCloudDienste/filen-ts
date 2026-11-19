import { describe, expect, it } from "vitest"
import { DocxDrawings } from "../core/docx/drawing"
import { Item } from "../core/docx/index"
import { ItemInt, ItemKind, rgba, rgbaHex } from "../core/drawingml/displayList"
import { modelOf } from "./docxSynthetic"

const THEME = `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>
	<a:clrScheme name="c"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FEFEFE"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
		<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
		<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
	<a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
	<a:fmtScheme name="m"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
	<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`

const CHART = `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
	<c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
		<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Sales</c:v></c:tx>
			<c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat>
			<c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
		<c:axId val="1"/><c:axId val="2"/></c:barChart>
		<c:catAx><c:axId val="1"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>
	</c:plotArea></c:chart></c:chartSpace>`

function inline(graphicUri: string, graphic: string, cx: number = 952500, cy: number = 476250): string {
	return `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="d"/><a:graphic><a:graphicData uri="${graphicUri}">${graphic}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

const PICTURE = "http://schemas.openxmlformats.org/drawingml/2006/picture"
const SHAPE = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
const CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"

function pic(embed: string): string {
	return `<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${embed}/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic>`
}

describe("docx drawing bridge", () => {
	it("draws an unnamed chart series in the texts the host opened the document with", async () => {
		const unnamed = CHART.replace("<c:tx><c:v>Sales</c:v></c:tx>", "").replace(
			"</c:plotArea>",
			'</c:plotArea><c:legend><c:legendPos val="r"/></c:legend>'
		)
		const model = await modelOf({
			body: `<w:p>${inline(CHART_URI, '<c:chart r:id="rId12"/>', 3048000, 1905000)}</w:p>`,
			relationships: [{ id: "rId12", type: "chart", target: "charts/chart1.xml" }],
			parts: [
				{
					name: "word/charts/chart1.xml",
					contentType: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
					data: unnamed
				}
			]
		})
		const shown = async (bridge: DocxDrawings): Promise<string> => {
			const info = model.drawings[0]
			const result = info === undefined ? undefined : await bridge.drawing(info)

			if (result?.kind !== "drawing") throw new Error("the chart converts")

			return JSON.stringify(result.list.texts)
		}

		expect(await shown(await DocxDrawings.open(model))).toContain("Series1")

		const german = await shown(
			await DocxDrawings.open(model, {
				chartText: { series: "Datenreihe{n}", chartTitle: "Diagrammtitel", axisTitle: "Achsentitel" }
			})
		)

		expect(german).toContain("Datenreihe1")
		expect(german).not.toContain("Series1")
	})

	it("converts pictures, shapes with text boxes, charts, VML and equations of a document", async () => {
		const model = await modelOf({
			body:
				`<w:p>${inline(PICTURE, pic('r:embed="rId10"'))}${inline(PICTURE, pic('r:link="rId11"'))}</w:p>` +
				`<w:p>${inline(
					SHAPE,
					`<wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"/></wps:spPr>
						<wps:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"/></wps:style>
						<wps:txbx><w:txbxContent><w:p><w:r><w:t>Inside</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>`
				)}</w:p>` +
				`<w:p>${inline(CHART_URI, '<c:chart r:id="rId12"/>', 3048000, 1905000)}</w:p>` +
				'<w:p><w:r><w:pict><v:rect style="width:100pt;height:50pt" fillcolor="#00ff00"/></w:pict></w:r></w:p>' +
				"<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>",
			relationships: [
				{ id: "rId10", type: "image", target: "media/image1.png" },
				{ id: "rId11", type: "image", target: "https://example.invalid/a.png", external: true },
				{ id: "rId12", type: "chart", target: "charts/chart1.xml" },
				{ id: "rId13", type: "theme", target: "theme/theme1.xml" }
			],
			parts: [
				{ name: "word/media/image1.png", data: new Uint8Array([137, 80, 78, 71]) },
				{ name: "word/theme/theme1.xml", contentType: "application/vnd.openxmlformats-officedocument.theme+xml", data: THEME },
				{
					name: "word/charts/chart1.xml",
					contentType: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
					data: CHART
				}
			]
		})
		const bridge = await DocxDrawings.open(model)

		expect(model.drawings).toHaveLength(4)

		const [internal, external, shape, chart] = await Promise.all(model.drawings.map(info => bridge.drawing(info)))

		if (internal?.kind !== "drawing" || external?.kind !== "drawing" || shape?.kind !== "drawing" || chart?.kind !== "drawing") {
			throw new Error("every drawing converts")
		}

		expect(internal.list.images[0]?.partName).toBe("word/media/image1.png")
		expect(internal.list.images[0]?.format).toBe("png")
		expect(external.list.images[0]?.handling).toBe("placeholder")

		// The style's fill reference resolves to accent2 through the theme part, the text box to its story.
		const path = shape.list.itemInt(0, ItemInt.FILL)

		expect(shape.list.paints[path]).toEqual({ kind: "solid", color: rgba("ED7D31") })

		const story = model.stories.find(candidate => candidate.kind === "textbox")

		expect(shape.textboxes).toEqual([story?.index])

		const text = shape.list.texts[0]

		expect(text?.kind === "story" ? text.story : -2).toBe(story?.index)
		expect(chart.list.itemCount).toBeGreaterThan(0)

		const vmlInfo = model.vml[0]

		if (vmlInfo === undefined) throw new Error("the w:pict is read")

		const vml = bridge.vml(vmlInfo)

		expect(vml.kind).toBe("drawing")

		if (vml.kind === "drawing") {
			const fill = vml.list.paints[vml.list.itemInt(0, ItemInt.FILL)]

			expect(vml.list.kind(0)).toBe(ItemKind.PATH)
			expect(fill?.kind === "solid" ? rgbaHex(fill.color) : "").toBe("00FF00")
		}

		const body = model.body
		const part = body === undefined ? undefined : model.partOf(body)
		let mathItem = -1

		for (let item = 0; part !== undefined && item < part.count; item++) if (part.kinds[item] === Item.Math) mathItem = item

		const tree = part === undefined ? undefined : bridge.math(part.index, part.nodes[mathItem] ?? -1)

		expect(tree?.tag).toBe("math")
	})

	it("draws placeholders for missing parts", async () => {
		const model = await modelOf({
			body: `<w:p>${inline(CHART_URI, '<c:chart r:id="rId12"/>')}</w:p>`,
			relationships: [{ id: "rId12", type: "chart", target: "charts/missing.xml" }]
		})
		const bridge = await DocxDrawings.open(model)
		const info = model.drawings[0]

		if (info === undefined) throw new Error("the drawing is read")

		const result = await bridge.drawing(info)

		expect(result).toEqual({ kind: "placeholder", reason: "missing" })
	})

	it("turns unexpected failures into placeholders", async () => {
		const model = await modelOf({
			body: `<w:p>${inline(SHAPE, '<wps:wsp><wps:cNvSpPr/><wps:spPr><a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></wps:spPr><wps:bodyPr/></wps:wsp>')}</w:p><w:p><w:r><w:pict><v:rect style="width:10pt;height:10pt" fillcolor="accent1"/></w:pict></w:r></w:p>`
		})
		const failing = new DocxDrawings(model, {
			scheme: () => {
				throw new RangeError("boom")
			},
			majorFont: { latin: "", eastAsia: "", complex: "" },
			minorFont: { latin: "", eastAsia: "", complex: "" },
			formats: undefined
		})
		const info = model.drawings[0]

		if (info === undefined) throw new Error("the drawing is read")

		expect(await failing.drawing(info)).toEqual({ kind: "placeholder", reason: "failed" })
	})
})

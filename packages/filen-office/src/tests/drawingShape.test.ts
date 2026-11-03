import { describe, expect, it } from "vitest"
import { drawingTheme, type DrawingTheme } from "../core/drawingml/color"
import { DrawingList, ItemFlag, ItemFloat, ItemInt, ItemKind, rgba, rgbaAlpha, rgbaHex, type Paint } from "../core/drawingml/displayList"
import { convertGraphic, type ShapeContext } from "../core/drawingml/shape"
import { convertSmartArt } from "../core/drawingml/smartart"
import { parseXml, type XmlDocument } from "../core/xml/index"

const NS = [
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
	'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
	'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"',
	'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
	'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
	'xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"'
].join(" ")

const EMU = 9525

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>
	<a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
		<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme>
	<a:fontScheme name="f"><a:majorFont><a:latin typeface="Major Face"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
		<a:minorFont><a:latin typeface="Minor Face"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
	<a:fmtScheme name="m">
		<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:noFill/></a:fillStyleLst>
		<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="dash"/></a:ln></a:lnStyleLst>
		<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="38100" dist="25400" dir="5400000"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>
		<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
	</a:fmtScheme></a:themeElements></a:theme>`

function xml(source: string): XmlDocument {
	return parseXml(new TextEncoder().encode(source))
}

function theme(): DrawingTheme {
	const colors: Record<string, string> = {
		accent1: "4472C4",
		accent2: "ED7D31",
		tx1: "000000",
		bg1: "FFFFFF",
		dk1: "000000",
		lt1: "FFFFFF"
	}

	return drawingTheme(xml(THEME), name => colors[name])
}

function context(effects: boolean = false): ShapeContext {
	return {
		list: new DrawingList(),
		theme: theme(),
		images: id =>
			id === "rId5"
				? { partName: "/word/media/image1.png", contentType: "image/png" }
				: id === "rId6"
					? { partName: "/word/media/image2.svg", contentType: "image/svg+xml" }
					: undefined,
		effects,
		story: node => 1000 + node
	}
}

function graphic(
	inner: string,
	width: number = 100 * EMU,
	height: number = 50 * EMU,
	ctx: ShapeContext = context()
): ReturnType<typeof convertGraphic> {
	const document = xml(`<a:graphicData ${NS} uri="x">${inner}</a:graphicData>`)

	return convertGraphic(ctx, document, document.documentElement(), width, height)
}

function items(list: DrawingList, kind: number): number[] {
	const out: number[] = []

	for (let item = 0; item < list.itemCount; item++) if (list.kind(item) === kind) out.push(item)

	return out
}

function paintOf(list: DrawingList, item: number): Paint | undefined {
	return list.paints[list.itemInt(item, ItemInt.FILL)]
}

function wsp(spPr: string, extra: string = ""): string {
	return `<wps:wsp><wps:cNvSpPr/><wps:spPr>${spPr}</wps:spPr>${extra}<wps:bodyPr/></wps:wsp>`
}

const XFRM = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm>'

describe("DrawingML shapes", () => {
	it("fills and strokes a preset shape with transforms and alpha", () => {
		const { list } = graphic(
			wsp(
				`<a:xfrm rot="5400000" flipH="1"><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
				<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>
				<a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>`
			)
		)
		const paths = items(list, ItemKind.PATH)

		expect(paths).toHaveLength(1)

		const item = paths[0] ?? 0
		const paint = paintOf(list, item)

		expect(paint).toEqual({ kind: "solid", color: rgba("FF0000", 0.5) })
		expect(rgbaAlpha(paint?.kind === "solid" ? paint.color : 0)).toBeCloseTo(0.5, 2)
		expect(list.strokes[list.itemInt(item, ItemInt.STROKE)]?.width).toBeCloseTo(12700 / EMU, 6)
		// Rotated 90 degrees and mirrored: a = cos * -1 = 0, b = sin * -1 = -1.
		expect(list.itemFloat(item, ItemFloat.A)).toBeCloseTo(0, 6)
		expect(list.itemFloat(item, ItemFloat.B)).toBeCloseTo(-1, 6)
		expect(list.itemInt(item, ItemInt.FLAGS) & ItemFlag.EVEN_ODD).toBe(ItemFlag.EVEN_ODD)

		// Rotated about its centre, the 100x50 box spans 25..75 horizontally.
		const box = list.bounds()

		expect(box[0]).toBeCloseTo(25 - 12700 / EMU / 2, 3)
		expect(box[2]).toBeCloseTo(75 + 12700 / EMU / 2, 3)
	})

	it("adds arrowheads to open paths only", () => {
		const { list } = graphic(
			wsp(
				`${XFRM}<a:prstGeom prst="line"/><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:headEnd type="arrow"/><a:tailEnd type="oval" w="lg" len="lg"/></a:ln>`
			)
		)
		const decorations = items(list, ItemKind.PATH).filter(item => (list.itemInt(item, ItemInt.FLAGS) & ItemFlag.DECORATION) !== 0)

		expect(decorations).toHaveLength(2)
		// The open arrow is stroked, the oval filled.
		expect(list.itemInt(decorations[0] ?? 0, ItemInt.FILL)).toBe(-1)
		expect(list.itemInt(decorations[1] ?? 0, ItemInt.FILL)).toBeGreaterThanOrEqual(0)

		const closed = graphic(
			wsp(
				`${XFRM}<a:prstGeom prst="rect"/><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>`
			)
		)

		expect(items(closed.list, ItemKind.PATH)).toHaveLength(1)
	})

	it("resolves fill, line and effect references through the theme", () => {
		const style = `<wps:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="2"><a:schemeClr val="accent2"/></a:fillRef>
			<a:effectRef idx="2"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></wps:style>`
		const plain = graphic(wsp(`${XFRM}<a:prstGeom prst="ellipse"/>`, style))
		const item = items(plain.list, ItemKind.PATH)[0] ?? 0
		const paint = paintOf(plain.list, item)
		const stroke = plain.list.strokes[plain.list.itemInt(item, ItemInt.STROKE)]

		// fillStyleLst[1] tints phClr = accent2 toward white.
		expect(paint?.kind).toBe("solid")
		expect(paint?.kind === "solid" ? rgbaHex(paint.color) : "").not.toBe("ED7D31")
		expect(stroke?.width).toBeCloseTo(12700 / EMU, 6)
		expect(stroke?.dash).toBe("dash")
		expect(plain.list.paints[stroke?.paint ?? -1]).toEqual({ kind: "solid", color: rgba("4472C4") })
		// Shadows only when effects are on.
		expect(plain.list.itemInt(item, ItemInt.SHADOW)).toBe(-1)

		const shaded = graphic(wsp(`${XFRM}<a:prstGeom prst="ellipse"/>`, style), 100 * EMU, 50 * EMU, context(true))
		const shadow = shaded.list.shadows[shaded.list.itemInt(items(shaded.list, ItemKind.PATH)[0] ?? 0, ItemInt.SHADOW)]

		expect(shadow?.dy).toBeCloseTo(25400 / EMU, 3)
		expect(rgbaAlpha(shadow?.color ?? 0)).toBeCloseTo(0.4, 2)
	})

	it("reads gradient, pattern and picture fills", () => {
		const gradient = graphic(
			wsp(
				`${XFRM}<a:gradFill><a:gsLst><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst><a:lin ang="2700000" scaled="1"/></a:gradFill>`
			)
		)
		const linear = paintOf(gradient.list, 0)

		expect(linear?.kind).toBe("linear")

		if (linear?.kind === "linear") {
			expect(linear.angle).toBe(45)
			expect(linear.scaled).toBe(true)
			expect([...linear.stops.offsets]).toEqual([0, 1])
			expect(rgbaHex(linear.stops.colors[0] ?? 0)).toBe("FF0000")
		}

		const radial = graphic(
			wsp(
				`${XFRM}<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`
			)
		)

		expect(paintOf(radial.list, 0)).toMatchObject({
			kind: "path",
			shape: "circle",
			focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 }
		})

		const pattern = graphic(
			wsp(
				`${XFRM}<a:pattFill prst="dkUpDiag"><a:fgClr><a:srgbClr val="112233"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>`
			)
		)

		expect(paintOf(pattern.list, 0)).toEqual({
			kind: "pattern",
			pattern: "dkUpDiag",
			foreground: rgba("112233"),
			background: rgba("FFFFFF")
		})

		const tiled = graphic(
			wsp(
				`${XFRM}<a:blipFill><a:blip r:embed="rId5"/><a:tile tx="9525" ty="0" sx="50000" sy="50000" flip="xy" algn="ctr"/></a:blipFill>`
			)
		)
		const tile = paintOf(tiled.list, 0)

		expect(tile).toMatchObject({ kind: "image", tile: { tx: 1, sx: 0.5, flip: "xy", align: "ctr" } })
		expect(tiled.list.images[0]?.partName).toBe("/word/media/image1.png")
	})

	it("places group children through the child coordinate system", () => {
		const { list } = graphic(
			`<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/><a:chOff x="0" y="0"/><a:chExt cx="3810000" cy="1905000"/></a:xfrm></wpg:grpSpPr>
				${wsp('<a:xfrm><a:off x="1905000" y="0"/><a:ext cx="1905000" cy="1905000"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>')}
				<wpg:grpSp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></wpg:grpSpPr>
					${wsp('<a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"/><a:grpFill/>')}
				</wpg:grpSp>
			</wpg:wgp>`,
			200 * EMU,
			100 * EMU
		)
		const paths = items(list, ItemKind.PATH)

		expect(paths).toHaveLength(2)

		// The group's 400x200 child space maps onto the 200x100 frame: the child lands at x 100, 100 px wide.
		const first = list.itemBounds.subarray(0, 4)

		expect([...first].map(value => Math.round(value))).toEqual([100, 0, 200, 100])
		// The nested group's fill reaches the child through a:grpFill.
		expect(paintOf(list, paths[1] ?? 0)).toEqual({ kind: "solid", color: rgba("0000FF") })
	})

	it("skips hidden shapes", () => {
		const { list } = graphic(
			`<wps:wsp><wps:cNvPr id="1" name="x" hidden="1"/><wps:spPr>${XFRM}<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></wps:spPr><wps:bodyPr/></wps:wsp>`
		)

		expect(list.itemCount).toBe(0)
	})

	it("emits text box stories and DrawingML text bodies as placeholders", () => {
		const document = xml(
			`<a:graphicData ${NS} uri="x">${wsp(
				`${XFRM}<a:prstGeom prst="rect"/>`,
				"<wps:txbx><w:txbxContent><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:txbxContent></wps:txbx>"
			).replace("<wps:bodyPr/>", '<wps:bodyPr lIns="0" anchor="ctr" vert="vert270"/>')}</a:graphicData>`
		)
		const result = convertGraphic(context(), document, document.documentElement(), 100 * EMU, 50 * EMU)
		const texts = items(result.list, ItemKind.TEXT)

		expect(texts).toHaveLength(1)
		expect(result.textboxes).toHaveLength(1)

		const text = result.list.texts[result.list.itemInt(texts[0] ?? 0, ItemInt.REF)]

		expect(text?.kind).toBe("story")

		if (text?.kind === "story") {
			expect(text.story).toBe(1000 + (result.textboxes[0] ?? 0))
			expect(text.body.insets.left).toBe(0)
			expect(text.body.anchor).toBe("ctr")
			expect(text.body.vertical).toBe("vert270")
		}
	})

	it("draws a picture with crop, flips and a clipping geometry", () => {
		const { list } = graphic(
			`<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>
				<pic:blipFill><a:blip r:embed="rId5"><a:alphaModFix amt="60000"/><a:grayscl/><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId6"/></a:ext></a:extLst></a:blip><a:srcRect l="10000" b="-5000"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
				<pic:spPr><a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="ellipse"/><a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></pic:spPr></pic:pic>`
		)
		const images = items(list, ItemKind.IMAGE)

		expect(images).toHaveLength(1)

		const item = images[0] ?? 0
		const image = list.images[list.itemInt(item, ItemInt.REF)]

		expect(image?.partName).toBe("/word/media/image1.png")
		expect(image?.svgPartName).toBe("/word/media/image2.svg")
		expect(image?.handling).toBe("native")
		expect(image?.crop).toEqual({ left: 0.1, top: 0, right: 0, bottom: -0.05 })
		expect(image?.alpha).toBeCloseTo(0.6, 6)
		expect(image?.grayscale).toBe(true)
		// The ellipse clips the image; flipV mirrors it.
		expect(list.itemInt(item, ItemInt.COMMAND_COUNT)).toBeGreaterThan(0)
		expect(list.itemFloat(item, ItemFloat.D)).toBeCloseTo(-1, 6)
		// The outline follows the picture.
		expect(items(list, ItemKind.PATH)).toHaveLength(1)
	})

	it("draws external pictures as placeholders", () => {
		const { list } = graphic(`<pic:pic><pic:blipFill><a:blip r:link="rId9"/></pic:blipFill><pic:spPr>${XFRM}</pic:spPr></pic:pic>`)

		expect(list.images[0]?.handling).toBe("placeholder")
		expect(list.images[0]?.partName).toBeUndefined()
	})

	it("survives malformed values", () => {
		const { list } = graphic(
			wsp(
				'<a:xfrm rot="abc"><a:off x="1in" y="x"/><a:ext cx="-5" cy="2.5cm"/></a:xfrm><a:prstGeom prst="nope"/><a:solidFill><a:srgbClr val="ZZZ"/></a:solidFill>'
			)
		)

		expect(list.itemCount).toBe(0)
	})
})

describe("hostile DrawingML", () => {
	it("cuts group nesting past the depth limit instead of overflowing the stack", () => {
		const depth = 20000
		const open =
			'<wpg:grpSp><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></wpg:grpSpPr>'
		const result = graphic(
			`<wpg:wgp><wpg:grpSpPr/>${open.repeat(depth)}${wsp(`${XFRM}<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`)}${"</wpg:grpSp>".repeat(depth)}</wpg:wgp>`
		)

		expect(result.unsupported).toBe(1)
		expect(result.list.itemCount).toBe(0)
	})

	it("clamps coordinates beyond ST_Coordinate and the float range", () => {
		const { list } = graphic(
			`<wpg:wgp><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/><a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/></a:xfrm></wpg:grpSpPr>
				${wsp('<a:xfrm><a:off x="0" y="0"/><a:ext cx="1e40" cy="1e40"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>')}</wpg:wgp>`
		)

		for (let k = 0; k < list.coordCount; k++) expect(Number.isFinite(list.coords[k])).toBe(true)
		for (const value of list.bounds()) expect(Number.isFinite(value)).toBe(true)
	})

	it("resolves theme picture fills against the theme's relationships", () => {
		const themed = THEME.replace(
			"<a:fillStyleLst>",
			'<a:fillStyleLst><a:blipFill xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip r:embed="rId1"/><a:stretch/></a:blipFill>'
		)
		const ctx: ShapeContext = {
			...context(),
			theme: drawingTheme(
				xml(themed),
				() => "000000",
				id => (id === "rId1" ? { partName: "word/media/theme.png", contentType: "image/png" } : undefined)
			)
		}
		const { list } = graphic(
			wsp(
				`${XFRM}<a:prstGeom prst="rect"/>`,
				'<wps:style><a:lnRef idx="0"/><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"/><a:fontRef idx="minor"/></wps:style>'
			),
			100 * EMU,
			50 * EMU,
			ctx
		)

		expect(list.images[0]?.partName).toBe("word/media/theme.png")
	})

	it("reads unknown underline values as none", () => {
		const document = xml(
			`<dsp:drawing ${NS}><dsp:spTree><dsp:sp><dsp:spPr>${XFRM}<a:prstGeom prst="rect"/></dsp:spPr><dsp:txBody><a:bodyPr/><a:p><a:r><a:rPr u="url(x)"/><a:t>a</a:t></a:r><a:r><a:rPr u="wavyDbl"/><a:t>b</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>`
		)
		const text = convertSmartArt(context(), document, 100 * EMU, 50 * EMU)?.list.texts[0]
		const runs = text?.kind === "body" ? text.paragraphs[0]?.runs : undefined

		expect(runs?.map(run => run.underline)).toEqual(["none", "wavyDbl"])
	})
})

describe("SmartArt", () => {
	it("draws the cached dsp:drawing with its text", () => {
		const document = xml(
			`<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>
				<dsp:sp modelId="{1}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>
					<dsp:spPr><a:xfrm><a:off x="95250" y="95250"/><a:ext cx="476250" cy="285750"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></dsp:spPr>
					<dsp:style><a:lnRef idx="2"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="1"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef><a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>
					<dsp:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1800" b="1"/><a:t>Step one</a:t></a:r></a:p></dsp:txBody>
					<dsp:txXfrm><a:off x="104775" y="104775"/><a:ext cx="457200" cy="266700"/></dsp:txXfrm></dsp:sp>
			</dsp:spTree></dsp:drawing>`
		)
		const result = convertSmartArt(context(), document, 100 * EMU, 50 * EMU)

		expect(result).toBeDefined()

		const list = result?.list ?? new DrawingList()
		const paths = items(list, ItemKind.PATH)
		const texts = items(list, ItemKind.TEXT)

		expect(paths).toHaveLength(1)
		expect(paintOf(list, paths[0] ?? 0)).toEqual({ kind: "solid", color: rgba("4472C4") })
		expect(texts).toHaveLength(1)

		const text = list.texts[list.itemInt(texts[0] ?? 0, ItemInt.REF)]

		expect(text?.kind).toBe("body")

		if (text?.kind === "body") {
			const run = text.paragraphs[0]?.runs[0]

			expect(run?.text).toBe("Step one")
			expect(run?.size).toBe(18)
			expect(run?.bold).toBe(true)
			// The font reference: minor theme font, lt1 colour.
			expect(run?.font).toBe("Minor Face")
			expect(rgbaHex(run?.color ?? 0)).toBe("FFFFFF")
			expect(text.paragraphs[0]?.align).toBe("ctr")
			expect(text.body.anchor).toBe("ctr")
		}

		// The text sits in its own txXfrm box: 11 px in, 48 px wide.
		expect(list.itemFloat(texts[0] ?? 0, ItemFloat.E)).toBeCloseTo(11, 3)
		expect(list.itemFloat(texts[0] ?? 0, ItemFloat.WIDTH)).toBeCloseTo(48, 3)
	})

	it("turns a text box by the shape's turn plus its own (txXfrm rot is relative)", () => {
		// The Gear layout's cache: a shape turned 345 degrees whose text turns back by 345, so it reads upright.
		const shape = (rot: string, textRot: string) =>
			xml(
				`<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>
				<dsp:sp modelId="{1}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>
					<dsp:spPr><a:xfrm${rot}><a:off x="95250" y="95250"/><a:ext cx="476250" cy="285750"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr>
					<dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Three</a:t></a:r></a:p></dsp:txBody>
					<dsp:txXfrm${textRot}><a:off x="104775" y="104775"/><a:ext cx="457200" cy="266700"/></dsp:txXfrm></dsp:sp>
			</dsp:spTree></dsp:drawing>`
			)
		const turn = (rot: string, textRot: string) => {
			const list = convertSmartArt(context(), shape(rot, textRot), 100 * EMU, 50 * EMU)?.list ?? new DrawingList()
			const text = items(list, ItemKind.TEXT)[0] ?? 0

			return (Math.atan2(list.itemFloat(text, ItemFloat.B), list.itemFloat(text, ItemFloat.A)) * 180) / Math.PI
		}

		expect(turn(' rot="20700000"', ' rot="-20700000"')).toBeCloseTo(0, 3)
		// Upright text on a shape turned half way round (an up-arrow callout pointing down).
		expect(turn(' rot="10800000"', ' rot="-10800000"')).toBeCloseTo(0, 3)
		// No txXfrm turn: the text turns with the shape.
		expect(turn(' rot="5400000"', "")).toBeCloseTo(90, 3)
	})

	it("rejects parts that are not drawings", () => {
		const document = xml(`<dsp:other ${NS}/>`)

		expect(convertSmartArt(context(), document, 1, 1)).toBeUndefined()
	})
})

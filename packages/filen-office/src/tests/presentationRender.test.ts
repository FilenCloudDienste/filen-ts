import { describe, expect, it } from "vitest"
import { DrawingList, ItemFloat, ItemInt, ItemKind, rgba, rgbaHex, type Paint } from "../core/drawingml/displayList"
import type { DrawingData } from "../core/drawingml/data"
import { drawingTheme } from "../core/drawingml/color"
import { shapeEffects, styleRef } from "../core/drawingml/fill"
import { D, drawingGroupOf, drawingReader } from "../core/drawingml/reader"
import { convertShapeTree } from "../core/drawingml/shape"
import { slideRef, type ShapeNode, type SourceRef } from "../core/presentation/model"
import { RenderReport } from "../core/presentation/render/effects"
import { renderSlide } from "../core/presentation/render/slide"
import { parseXml, type XmlDocument } from "../core/xml/index"
import type { Slicing } from "../core/slicing"
import {
	LAYOUT_PART,
	MASTER_PART,
	NS,
	SLIDE,
	SLIDE_PART,
	THEME,
	THEME_PART,
	body,
	deckOf,
	elementById,
	part,
	renderServices,
	src,
	xfrm,
	type FixtureParts
} from "./fixtures/presentation/renderDeck"

const EMU = 9525

const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

function xml(markup: string): XmlDocument {
	return parseXml(new TextEncoder().encode(markup))
}

function itemsOf(data: DrawingData, kind: number): number[] {
	const out: number[] = []

	for (let item = 0; item < data.itemCount; item++) if (data.itemInts[item * 10 + ItemInt.KIND] === kind) out.push(item)

	return out
}

function fillOf(data: DrawingData, item: number): Paint | undefined {
	return data.paints[data.itemInts[item * 10 + ItemInt.FILL] ?? -1]
}

function solid(paint: Paint | undefined): string | undefined {
	return paint?.kind === "solid" ? rgbaHex(paint.color) : undefined
}

function sp(id: number, inner: string, nvPr: string = "<p:nvPr/>", spPr: string = ""): string {
	return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="Shape ${String(id)}"/><p:cNvSpPr/>${nvPr}</p:nvSpPr><p:spPr>${spPr}</p:spPr>${inner}</p:sp>`
}

function withTheme(input: FixtureParts): FixtureParts {
	return { ...input, parts: { [THEME_PART]: THEME, ...input.parts } }
}

describe("DrawingML groups for PresentationML", () => {
	it("reads the PresentationML namespaces (Transitional and Strict) and the PowerPoint extensions as their own groups", () => {
		expect(drawingGroupOf("http://schemas.openxmlformats.org/presentationml/2006/main")).toBe(D.P)
		expect(drawingGroupOf("http://purl.oclc.org/ooxml/presentationml/main")).toBe(D.P)
		expect(drawingGroupOf("http://schemas.microsoft.com/office/powerpoint/2010/main")).toBe(D.P14)
		expect(drawingGroupOf("http://schemas.microsoft.com/office/powerpoint/2012/main")).toBe(D.P15)
		expect(drawingGroupOf("http://schemas.microsoft.com/office/powerpoint/2015/09/main")).toBe(D.P159)
	})

	it("converts a p:spTree's shapes, skipping hidden ones, and hands a:txBody to the host as a story", () => {
		const document = xml(
			`<p:spTree ${NS}>${sp(2, '<p:txBody><a:bodyPr lIns="0"/><a:p><a:r><a:t>Hi</a:t></a:r></a:p></p:txBody>', "<p:nvPr/>", '<a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>')}` +
				'<p:sp><p:nvSpPr><p:cNvPr id="3" name="h" hidden="1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr></p:sp></p:spTree>'
		)
		const list = new DrawingList()
		const seen: number[] = []

		convertShapeTree(
			{
				list,
				theme: drawingTheme(undefined, () => undefined),
				images: () => undefined,
				effects: false,
				body: node => {
					seen.push(node)

					return 77
				}
			},
			document,
			document.documentElement(),
			100 * EMU,
			100 * EMU
		)

		const kinds = Array.from({ length: list.itemCount }, (_, item) => list.kind(item))

		expect(kinds).toEqual([ItemKind.PATH, ItemKind.TEXT])
		expect(seen).toHaveLength(1)
		expect(list.texts).toEqual([expect.objectContaining({ kind: "story", story: 77 })])
		expect(list.texts.some(text => text.kind === "body")).toBe(false)
		expect(list.texts[0]?.kind === "story" ? list.texts[0].body.insets.left : -1).toBe(0)
	})

	it("draws a top-level p:graphicFrame through the host's frame hook in its own box", () => {
		const document = xml(
			`<p:spTree ${NS}><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="c"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${String(10 * EMU)}" y="0"/><a:ext cx="${String(20 * EMU)}" cy="${String(30 * EMU)}"/></p:xfrm><a:graphic/></p:graphicFrame></p:spTree>`
		)
		const boxes: number[][] = []
		const conversion = convertShapeTree(
			{
				list: new DrawingList(),
				theme: drawingTheme(undefined, () => undefined),
				images: () => undefined,
				effects: false,
				frame: (_reader, _node, _list, matrix, width, height) => {
					boxes.push([matrix[4] ?? 0, width / EMU, height / EMU])

					return true
				}
			},
			document,
			document.documentElement(),
			100 * EMU,
			100 * EMU
		)

		expect(conversion.unsupported).toBe(0)
		expect(boxes).toEqual([[10, 20, 30]])
	})

	it("reads glow, soft edge, inner and preset shadows, reflection and blur in px, and a style's effect reference", () => {
		const document = xml(
			`<p:sp ${NS}><p:spPr><a:effectLst><a:blur rad="19050"/><a:glow rad="95250"><a:srgbClr val="FFC000"><a:alpha val="40000"/></a:srgbClr></a:glow>` +
				'<a:innerShdw blurRad="9525" dist="19050" dir="0"><a:srgbClr val="000000"/></a:innerShdw><a:prstShdw prst="shdw13" dist="9525" dir="5400000"><a:srgbClr val="808080"/></a:prstShdw>' +
				'<a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dir="5400000" sy="-100000" algn="bl"/><a:softEdge rad="28575"/></a:effectLst></p:spPr></p:sp>'
		)
		const reader = drawingReader(document)
		const context = { list: new DrawingList(), theme: drawingTheme(undefined, () => undefined), images: () => undefined, effects: true }
		const read = shapeEffects(context, reader, reader.child(document.documentElement(), D.P, "spPr"), undefined)

		expect(read.effects.map(effect => effect.kind)).toEqual(["blur", "glow", "innerShadow", "outerShadow", "reflection", "softEdge"])
		expect(read.effects[0]).toEqual({ kind: "blur", radius: 2 })
		expect(read.effects[1]).toEqual({ kind: "glow", color: rgba("FFC000", 0.4), radius: 10 })
		expect(read.effects[2]).toMatchObject({ kind: "innerShadow", blur: 1, dx: 2 })
		expect(read.effects[3]).toMatchObject({ kind: "outerShadow", blur: 0, sx: 1, sy: 1 })
		expect(read.effects[3]?.kind === "outerShadow" ? read.effects[3].dy : 0).toBeCloseTo(1, 6)
		expect(read.effects[4]).toEqual({
			kind: "reflection",
			blur: 6350 / EMU,
			startAlpha: 0.5,
			endAlpha: 0.003,
			endPos: 0.55,
			distance: 0,
			direction: 90
		})
		expect(read.effects[5]).toEqual({ kind: "softEdge", radius: 3 })
		expect(read.approximated).toEqual(["prstShdw"])

		const theme = drawingTheme(xml(THEME), name => (name === "accent1" ? "4472C4" : undefined))
		const style = xml(`<p:style ${NS}><a:effectRef idx="3"><a:schemeClr val="accent1"/></a:effectRef></p:style>`)
		const styleReader = drawingReader(style)
		const ref = styleRef({ ...context, theme }, styleReader, styleReader.child(style.documentElement(), D.A, "effectRef"), "effect")
		const fromTheme = shapeEffects({ ...context, theme }, styleReader, -1, ref)

		expect(fromTheme.effects).toEqual([{ kind: "glow", color: rgba("4472C4"), radius: 63500 / EMU }])
	})
})

describe("renderSlide", () => {
	const TITLE_BOX = '<a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm>'

	function titleDeck(slideSpPr: string = ""): { deck: ReturnType<typeof deckOf>; fixture: ReturnType<typeof renderServices> } {
		const fixture = renderServices(
			withTheme({
				parts: {
					[MASTER_PART]: part(
						sp(
							2,
							"<p:txBody><a:bodyPr/><a:p/></p:txBody>",
							'<p:nvPr><p:ph type="title"/></p:nvPr>',
							`${TITLE_BOX}<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>`
						),
						"sldMaster"
					),
					[LAYOUT_PART]: part(
						sp(2, '<p:txBody><a:bodyPr anchor="b"/><a:p/></p:txBody>', '<p:nvPr><p:ph type="title"/></p:nvPr>'),
						"sldLayout"
					),
					[SLIDE_PART]: part(
						sp(
							2,
							"<p:txBody><a:bodyPr/><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody>",
							'<p:nvPr><p:ph type="title"/></p:nvPr>',
							slideSpPr
						)
					)
				}
			})
		)
		const at = (partName: string): SourceRef => src(fixture, partName, elementById(fixture.documents.get(partName) as XmlDocument, 2))
		const title = (partName: string, extra: Partial<ShapeNode> = {}): ShapeNode => ({
			id: 2,
			name: "Title 1",
			hidden: false,
			kind: "sp",
			ph: { type: "title", idx: 0 },
			src: at(partName),
			...extra
		})
		const deck = deckOf(
			[title(MASTER_PART, { xfrm: xfrm(838200, 365125, 10515600, 1325563) })],
			// The model carries each level's bodyPr as the reader reads it; the renderer resolves from the model alone.
			[title(LAYOUT_PART, { text: { bodyPr: { anchor: "b" }, paragraphs: [] } })],
			[title(SLIDE_PART, { text: body("Hello") })]
		)

		return { deck, fixture }
	}

	it("renders an inherited title placeholder with no local xfrm at its master's box, with the master's fill and the layout's anchor", async () => {
		const { deck, fixture } = titleDeck()
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(render.layers).toHaveLength(1)

		const layer = render.layers[0]

		expect(layer?.role).toBe("placeholder")
		expect(layer?.matrix).toEqual([1, 0, 0, 1, 838200 / EMU, 365125 / EMU])
		expect(layer?.drawing.width).toBeCloseTo(10515600 / EMU, 6)
		expect(layer?.drawing.height).toBeCloseTo(1325563 / EMU, 6)

		const paths = itemsOf(layer?.drawing as DrawingData, ItemKind.PATH)

		expect(solid(fillOf(layer?.drawing as DrawingData, paths[0] ?? -1))).toBe("ED7D31")
		expect(fixture.requests[0]?.bodyPr.anchor).toBe("b")
		// The text box: the shape box less the default insets (0.1in, 0.05in).
		expect(fixture.requests[0]?.width).toBeCloseTo(10515600 / EMU - 19.2, 4)
		expect(fixture.requests[0]?.height).toBeCloseTo(1325563 / EMU - 9.6, 4)
		expect(layer?.textMatrix).toEqual([1, 0, 0, 1, 838200 / EMU + 9.6, 365125 / EMU + 4.8])
		expect(layer?.text).toBeDefined()
	})

	it("keeps presentation text out of the drawing: no DrawingML body items, one text page per body", async () => {
		const { deck, fixture } = titleDeck()
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		for (const layer of render.layers) expect(layer.drawing.texts.some(text => text.kind === "body")).toBe(false)

		expect(render.background.texts).toHaveLength(0)
		expect(fixture.requests.map(request => request.shape.id)).toEqual([2])
		expect(fixture.requests[0]?.chain.map(level => level.node.kind)).toEqual(["layout", "master"])
	})

	it("renders a typed fill edit without a save, over the source fill", async () => {
		const { deck, fixture } = titleDeck('<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>')
		const slide = deck.nodes.get(SLIDE)
		const title = slide?.shapes[0]

		if (slide === undefined || title === undefined) throw new Error("fixture")

		const before = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(solid(fillOf(before.layers[0]?.drawing as DrawingData, 0))).toBe("00FF00")

		title.props = { fill: { kind: "solid", color: { kind: "scheme", slot: "accent1", mods: [{ name: "lumMod", value: 50000 }] } } }
		slide.revision++

		const after = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(solid(fillOf(after.layers[0]?.drawing as DrawingData, 0))).toBe("203864")
	})

	it("resolves relationship ids of copied groups to the part they came from (a layout picture placeholder whose rId collides with the slide's)", async () => {
		const pic = (blip: string): string =>
			sp(
				5,
				"",
				'<p:nvPr><p:ph type="pic" idx="1"/></p:nvPr>',
				`<a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>${blip}`
			)
		const fixture = renderServices(
			withTheme({
				parts: {
					[MASTER_PART]: part("", "sldMaster"),
					[LAYOUT_PART]: part(
						pic('<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>'),
						"sldLayout"
					),
					[SLIDE_PART]: part(
						sp(5, "", '<p:nvPr><p:ph type="pic" idx="1"/></p:nvPr>') +
							'<p:pic><p:nvPicPr><p:cNvPr id="6" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm></p:spPr></p:pic>'
					)
				},
				rels: { [LAYOUT_PART]: { rId2: "/ppt/media/layout.png" }, [SLIDE_PART]: { rId2: "/ppt/media/slide.png" } }
			})
		)
		const at = (partName: string, id: number): SourceRef =>
			src(fixture, partName, elementById(fixture.documents.get(partName) as XmlDocument, id))
		const deck = deckOf(
			[],
			[
				{
					id: 5,
					name: "Picture Placeholder",
					hidden: false,
					kind: "sp",
					ph: { type: "pic", idx: 1 },
					xfrm: xfrm(0, 0, 952500, 952500),
					src: at(LAYOUT_PART, 5)
				}
			],
			[
				{ id: 5, name: "Picture Placeholder", hidden: false, kind: "sp", ph: { type: "pic", idx: 1 }, src: at(SLIDE_PART, 5) },
				{ id: 6, name: "Picture", hidden: false, kind: "pic", xfrm: xfrm(0, 0, 9525, 9525), src: at(SLIDE_PART, 6) }
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const placeholder = render.layers[0]?.drawing
		const paint = fillOf(placeholder as DrawingData, 0)

		expect(paint?.kind).toBe("image")
		expect(paint?.kind === "image" ? placeholder?.images[paint.image]?.partName : undefined).toBe("/ppt/media/layout.png")
		expect(render.layers[1]?.drawing.images.map(image => image.partName)).toEqual(["/ppt/media/slide.png"])
	})

	it("carries a master shape's hyperlink action (resolved against the master) onto its layer", async () => {
		const fixture = renderServices(
			withTheme({
				parts: {
					[MASTER_PART]: part(sp(7, "", "<p:nvPr/>", TITLE_BOX), "sldMaster"),
					[LAYOUT_PART]: part("", "sldLayout"),
					[SLIDE_PART]: part("")
				}
			})
		)
		const deck = deckOf(
			[
				{
					id: 7,
					name: "Logo",
					hidden: false,
					kind: "sp",
					xfrm: xfrm(838200, 365125, 10515600, 1325563),
					actions: { click: { kind: "url", href: "https://example.org/master" } },
					src: src(fixture, MASTER_PART, elementById(fixture.documents.get(MASTER_PART) as XmlDocument, 7))
				}
			],
			[],
			[]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(render.layers.map(layer => layer.role)).toEqual(["master"])
		expect(render.layers[0]?.actions?.click).toEqual({ kind: "url", href: "https://example.org/master" })
		expect(render.layers[0]?.shape).toEqual({ slide: SLIDE, id: 7 })
	})

	it("never paints layout or master placeholders, and honours showMasterSp on the slide and the layout", async () => {
		const box = xfrm(0, 0, 952500, 952500)
		const shape = (id: number, ph: boolean): ShapeNode => ({
			id,
			name: `s${String(id)}`,
			hidden: false,
			kind: "sp",
			xfrm: box,
			props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "112233" } } },
			...(ph ? { ph: { type: "body", idx: 1 } } : {})
		})
		const fixture = renderServices(withTheme({ parts: {} }))
		const roles = async (slide: boolean, layout: boolean): Promise<string[]> => {
			const deck = deckOf([shape(10, false), shape(11, true)], [shape(20, false), shape(21, true)], [shape(30, false)], {
				slide: { showMasterShapes: slide },
				layout: { showMasterShapes: layout }
			})

			return (await renderSlide(deck, SLIDE, fixture.services, SLICING)).layers.map(
				layer => `${layer.role}:${String(layer.shape.id)}`
			)
		}

		expect(await roles(true, true)).toEqual(["master:10", "layout:20", "shape:30"])
		expect(await roles(true, false)).toEqual(["layout:20", "shape:30"])
		expect(await roles(false, true)).toEqual(["shape:30"])
	})

	it("renders the cached SmartArt drawing as the cache (every shape at its dsp box)", async () => {
		const boxes = [
			[0, 0, 100, 50],
			[120, 0, 100, 50],
			[240, 30, 80, 40]
		]
		const drawing =
			`<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>` +
			boxes
				.map(
					([x, y, w, h], k) =>
						`<dsp:sp modelId="{${String(k)}}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="${String((x ?? 0) * EMU)}" y="${String((y ?? 0) * EMU)}"/><a:ext cx="${String((w ?? 0) * EMU)}" cy="${String((h ?? 0) * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></dsp:spPr></dsp:sp>`
				)
				.join("") +
			"</dsp:spTree></dsp:drawing>"
		const fixture = renderServices(withTheme({ parts: { "/ppt/diagrams/drawing1.xml": drawing } }))
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 4,
					name: "Diagram",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(95250, 95250, 320 * EMU, 70 * EMU),
					frame: {
						kind: "smartart",
						data: "/ppt/diagrams/data1.xml",
						layout: "",
						style: "",
						colors: "",
						drawing: "/ppt/diagrams/drawing1.xml"
					}
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const layer = render.layers[0]

		expect(layer?.role).toBe("smartart")

		const data = layer?.drawing as DrawingData
		const drawn = itemsOf(data, ItemKind.PATH).map(item => {
			const f = item * 10

			return [
				data.itemFloats[f + ItemFloat.E],
				data.itemFloats[f + ItemFloat.F],
				data.itemFloats[f + ItemFloat.WIDTH],
				data.itemFloats[f + ItemFloat.HEIGHT]
			]
		})

		expect(drawn).toHaveLength(boxes.length)
		drawn.forEach((box, k) => {
			const want = boxes[k] ?? []
			const iou = intersectionOverUnion(box.map(Number), want)

			expect(iou).toBeGreaterThanOrEqual(0.99)
		})
	})

	it("draws the Fallback picture of a14:m math, never the equation's text", async () => {
		const math =
			`<mc:AlternateContent><mc:Choice Requires="a14">${sp(8, '<p:txBody><a:bodyPr/><a:p><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"/></a14:m></a:p></p:txBody>', "<p:nvPr/>", '<a:xfrm><a:off x="0" y="0"/><a:ext cx="95250" cy="95250"/></a:xfrm>')}</mc:Choice>` +
			`<mc:Fallback>${sp(8, "", "<p:nvPr/>", '<a:xfrm><a:off x="9525" y="9525"/><a:ext cx="95250" cy="95250"/></a:xfrm><a:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>')}</mc:Fallback></mc:AlternateContent>`
		const fixture = renderServices(
			withTheme({ parts: { [SLIDE_PART]: part(math) }, rels: { [SLIDE_PART]: { rId9: "/ppt/media/math.png" } } })
		)
		const document = fixture.documents.get(SLIDE_PART) as XmlDocument
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 0,
					name: "",
					hidden: false,
					kind: "opaque",
					lock: "alternateContent",
					src: src(fixture, SLIDE_PART, elementById(document, 8))
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const data = render.layers[0]?.drawing as DrawingData
		const paint = fillOf(data, itemsOf(data, ItemKind.PATH)[0] ?? -1)

		expect(paint?.kind === "image" ? data.images[paint.image]?.partName : undefined).toBe("/ppt/media/math.png")
		expect(data.texts).toHaveLength(0)
		expect(render.layers[0]?.lock).toBe("alternateContent")
	})

	it("renders an svgBlip picture with its SVG part and keeps the PNG fallback", async () => {
		const picture =
			'<p:pic><p:nvPicPr><p:cNvPr id="9" name="Graphic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId2"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
			'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="95250" cy="95250"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
		const fixture = renderServices(
			withTheme({
				parts: { [SLIDE_PART]: part(picture) },
				rels: { [SLIDE_PART]: { rId1: "/ppt/media/image1.png", rId2: "/ppt/media/image2.svg" } }
			})
		)
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 9,
					name: "Graphic",
					hidden: false,
					kind: "pic",
					xfrm: xfrm(0, 0, 95250, 95250),
					src: src(fixture, SLIDE_PART, elementById(fixture.documents.get(SLIDE_PART) as XmlDocument, 9))
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(render.layers[0]?.role).toBe("picture")
		expect(render.layers[0]?.drawing.images[0]).toMatchObject({
			partName: "/ppt/media/image1.png",
			svgPartName: "/ppt/media/image2.svg",
			format: "png"
		})
	})

	it("renders an ODP custom shape from the model alone, through the same path", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 3,
					name: "Triangle",
					hidden: false,
					kind: "sp",
					xfrm: xfrm(0, 0, 100 * EMU, 100 * EMU, { flipH: true, rot: 90 * 60000 }),
					src: { format: "odp", part: "/content.xml", fragment: 0, node: 12, epoch: 0 },
					props: {
						geometry: {
							kind: "custom",
							guides: [],
							paths: [
								{
									w: 100,
									h: 100,
									fill: "norm",
									stroke: true,
									extrusionOk: false,
									commands: new Uint8Array([0, 1, 1, 5]),
									coords: new Float64Array([0, 0, 100, 0, 0, 100])
								}
							]
						},
						fill: { kind: "solid", color: { kind: "scheme", slot: "accent6" } },
						ln: { w: 12700, fill: { kind: "solid", color: { kind: "srgb", rgb: "000000" } } }
					}
				}
			]
		)

		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const layer = render.layers[0]
		const data = layer?.drawing as DrawingData
		const path = itemsOf(data, ItemKind.PATH)[0] ?? -1

		expect(solid(fillOf(data, path))).toBe("70AD47")
		expect(data.strokes[data.itemInts[path * 10 + ItemInt.STROKE] ?? -1]?.width).toBeCloseTo(12700 / EMU, 6)
		// Rotation sits in the layer matrix (about the box centre), the flip in the drawing.
		expect(layer?.matrix.map(value => Math.round(value * 1000) / 1000)).toEqual([0, 1, -1, 0, 100, 0])
		expect(data.itemFloats[path * 10 + ItemFloat.A]).toBe(-1)
	})

	it("turns the text box of eaVert and mongolianVert text as it turns vert", async () => {
		for (const vertical of ["eaVert", "mongolianVert"] as const) {
			const fixture = renderServices(withTheme({ parts: {} }))
			const deck = deckOf(
				[],
				[],
				[
					{
						id: 2,
						name: "v",
						hidden: false,
						kind: "sp",
						xfrm: xfrm(0, 0, 200 * EMU, 100 * EMU),
						text: { ...body("Down"), bodyPr: { vertical, insets: { left: 0, top: 0, right: 0, bottom: 0 } } }
					}
				]
			)
			const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

			expect(fixture.requests[0]?.width).toBe(100)
			expect(fixture.requests[0]?.height).toBe(200)
			expect(render.layers[0]?.textMatrix).toEqual([0, 1, -1, 0, 200, 0])
		}
	})

	it("turns the text box for vertical text and lays it out in the swapped box", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 2,
					name: "v",
					hidden: false,
					kind: "sp",
					xfrm: xfrm(0, 0, 200 * EMU, 100 * EMU),
					text: { ...body("Down"), bodyPr: { vertical: "vert", insets: { left: 0, top: 0, right: 0, bottom: 0 } } }
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(fixture.requests[0]?.width).toBe(100)
		expect(fixture.requests[0]?.height).toBe(200)
		expect(render.layers[0]?.textMatrix).toEqual([0, 1, -1, 0, 200, 0])
	})

	it("uses the background of the nearest level, theme background references included", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))
		const deck = deckOf([], [], [], { master: { background: { kind: "ref", idx: 1003, color: { kind: "scheme", slot: "accent1" } } } })
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(solid(fillOf(render.background, 0))).toBe("123456")
		expect(render.background.width).toBeCloseTo(12_192_000 / EMU, 6)

		deck.nodes.set(SLIDE, {
			...(deck.nodes.get(SLIDE) as NonNullable<ReturnType<typeof deck.nodes.get>>),
			background: { kind: "fill", fill: { kind: "solid", color: { kind: "scheme", slot: "bg2" } } },
			revision: 1
		})

		expect(solid(fillOf((await renderSlide(deck, SLIDE, fixture.services, SLICING)).background, 0))).toBe("E7E6E6")
	})

	it("reports effects it does not draw as written", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 2,
					name: "e",
					hidden: false,
					kind: "sp",
					xfrm: xfrm(0, 0, 9525, 9525),
					props: {
						effects: {
							effects: [
								{ kind: "prstShdw", preset: "shdw1", color: { kind: "srgb", rgb: "000000" }, dist: 9525, dir: 0 },
								{ kind: "glow", color: { kind: "srgb", rgb: "FF0000" }, rad: 9525 }
							]
						}
					}
				}
			]
		)
		const report = new RenderReport()
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING, report)

		expect(render.layers[0]?.effects).toEqual([
			{ kind: "outerShadow", color: rgba("000000"), blur: 0, dx: 1, dy: 0, sx: 1, sy: 1 },
			{ kind: "glow", color: rgba("FF0000"), radius: 1 }
		])
		expect(report.toJSON().approximated).toEqual({ prstShdw: 1 })
	})

	it("starts over when an edit lands during one of its pauses, and renders the edited state", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))
		const shape = (id: number): ShapeNode => ({
			id,
			name: "s",
			hidden: false,
			kind: "sp",
			xfrm: xfrm(0, 0, 9525, 9525),
			props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "111111" } } }
		})
		const deck = deckOf([], [], [shape(2), shape(3)])
		const slide = deck.nodes.get(SLIDE)
		let pauses = 0
		const slicing: Slicing = {
			sliceMs: 0,
			now: () => pauses,
			pause: () => {
				pauses++

				if (pauses === 1 && slide !== undefined) {
					const first = slide.shapes[0]

					if (first !== undefined) first.props = { fill: { kind: "solid", color: { kind: "srgb", rgb: "222222" } } }

					slide.revision++
				}

				return Promise.resolve()
			}
		}
		const render = await renderSlide(deck, SLIDE, fixture.services, slicing)

		expect(render.revision).toBe(1)
		expect(solid(fillOf(render.layers[0]?.drawing as DrawingData, 0))).toBe("222222")
	})

	it("refuses a slide it has not been given parsed", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))

		await expect(renderSlide(deckOf([], [], []), slideRef(99), fixture.services, SLICING)).rejects.toMatchObject({ reason: "notFound" })
	})
})

function intersectionOverUnion(a: readonly number[], b: readonly number[]): number {
	const [ax = 0, ay = 0, aw = 0, ah = 0] = a
	const [bx = 0, by = 0, bw = 0, bh = 0] = b
	const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
	const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
	const inter = ix * iy

	return inter / (aw * ah + bw * bh - inter)
}

describe("tables", () => {
	const STYLES = `<a:tblStyleLst ${NS} def="{S}"><a:tblStyle styleId="{S}" styleName="Test">
		<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"/><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:insideH><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></a:insideH></a:tcBdr><a:fill><a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>
		<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:srgbClr val="AAAAAA"/></a:solidFill></a:fill></a:tcStyle></a:band1H>
		<a:firstRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:bottom><a:ln w="38100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></a:bottom></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>
	</a:tblStyle></a:tblStyleLst>`

	it("draws grid, style regions, merged cells and rows grown to their text, with one text page per cell", async () => {
		const fixture = renderServices(withTheme({ parts: { "/ppt/tableStyles.xml": STYLES } }), { textHeight: 60 })
		const cell = (text: string, extra: object = {}): { text: ReturnType<typeof body> } => ({ text: body(text), ...extra })
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 5,
					name: "Table",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(95250, 95250, 300 * EMU, 60 * EMU),
					frame: {
						kind: "table",
						table: {
							grid: [100 * EMU, 100 * EMU, 100 * EMU],
							rows: [
								{ h: 20 * EMU, cells: [cell("Region", { gridSpan: 2 }), cell("", { hMerge: true }), cell("Total")] },
								{
									h: 20 * EMU,
									cells: [
										cell("North"),
										cell(""),
										cell("42", {
											props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } }, anchor: "ctr" }
										})
									]
								},
								{ h: 20 * EMU, cells: [cell(""), cell(""), cell("")] }
							],
							styleId: "{S}",
							flags: { firstRow: true, lastRow: false, firstCol: false, lastCol: false, bandRow: true, bandCol: false }
						}
					}
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const table = render.layers[0]?.drawing as DrawingData
		const fills = itemsOf(table, ItemKind.PATH)
			.map(item => ({
				item,
				fill: solid(fillOf(table, item)),
				box: [
					table.itemFloats[item * 10 + ItemFloat.X],
					table.itemFloats[item * 10 + ItemFloat.Y],
					table.itemFloats[item * 10 + ItemFloat.WIDTH],
					table.itemFloats[item * 10 + ItemFloat.HEIGHT]
				]
			}))
			.filter(entry => entry.fill !== undefined)

		// Rows with text grow to 60 px of text plus the 0.05in margins; the empty last row keeps its 20 px.
		const grown = 60 + 9.6

		expect(fills.map(entry => entry.fill)).toEqual(["4472C4", "4472C4", "AAAAAA", "AAAAAA", "00FF00", "DDDDDD", "DDDDDD", "DDDDDD"])
		expect(fills[0]?.box).toEqual([0, 0, 200, expect.closeTo(grown, 4)])
		expect(fills[7]?.box[3]).toBeCloseTo(20, 4)

		const strokes = itemsOf(table, ItemKind.PATH).filter(item => (table.itemInts[item * 10 + ItemInt.STROKE] ?? -1) >= 0)

		expect(strokes.length).toBeGreaterThan(0)
		expect(table.strokes.some(stroke => stroke.width === 4)).toBe(true)

		const texts = render.layers.slice(1)

		expect(texts.map(layer => layer.role)).toEqual(["table", "table", "table", "table"])
		expect(fixture.requests.find(request => request.cell?.row === 0)?.cell?.style).toEqual({
			bold: true,
			color: "FFFFFF",
			font: "minor"
		})
		expect(fixture.requests.find(request => request.cell?.row === 1 && request.cell.column === 0)?.cell?.style).toEqual({
			color: "000000",
			font: "minor"
		})
		// The anchored cell's text page sits in its cell box, below the top margin.
		expect(texts[3]?.textMatrix?.[4]).toBeCloseTo(95250 / EMU + 200 + 9.6, 4)
	})

	it("draws a group's children through its child space, with each child's text and a nested table as layers of their own", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))
		const child = (id: number, x: number, text?: string): ShapeNode => ({
			id,
			name: `c${String(id)}`,
			hidden: false,
			kind: "sp",
			xfrm: xfrm(x, 0, 100 * EMU, 50 * EMU),
			props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "336699" } } },
			...(text === undefined ? {} : { text: body(text) })
		})
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 2,
					name: "Group",
					hidden: false,
					kind: "grpSp",
					// Half scale: the child space is twice the group's box.
					xfrm: xfrm(10 * EMU, 20 * EMU, 200 * EMU, 50 * EMU, { chX: 0, chY: 0, chCx: 400 * EMU, chCy: 100 * EMU }),
					children: [
						child(3, 0, "One"),
						child(4, 200 * EMU, "Two"),
						{
							id: 5,
							name: "Table",
							hidden: false,
							kind: "frame",
							xfrm: xfrm(0, 50 * EMU, 400 * EMU, 50 * EMU),
							frame: {
								kind: "table",
								table: {
									grid: [400 * EMU],
									rows: [{ h: 50 * EMU, cells: [{ text: body("Cell") }] }],
									flags: {
										firstRow: false,
										lastRow: false,
										firstCol: false,
										lastCol: false,
										bandRow: false,
										bandCol: false
									}
								}
							}
						}
					]
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(render.layers.map(layer => `${layer.role}:${String(layer.shape.id)}`)).toEqual(["group:2", "group:4", "table:5", "table:5"])

		// Each child's drawing with its text, in spTree order.
		const offsets = render.layers
			.slice(0, 2)
			.map(layer => itemsOf(layer.drawing, ItemKind.PATH).map(item => layer.drawing.itemFloats[item * 10 + ItemFloat.E]))
		const second = render.layers[1]?.drawing as DrawingData

		expect(offsets).toEqual([[0], [100]])
		expect(second.itemFloats[(itemsOf(second, ItemKind.PATH)[0] ?? 0) * 10 + ItemFloat.WIDTH]).toBeCloseTo(50, 6)
		expect(render.layers[0]?.text).toBeDefined()
		expect(render.layers[1]?.textMatrix?.[4]).toBeCloseTo(10 + 100 + 9.6, 4)
		expect(render.layers[2]?.matrix).toEqual([0.5, 0, 0, 0.5, 10, 45])
		expect(render.layers[3]?.text).toBeDefined()
	})

	it("paints a group child's text in that child's z position, under a later sibling that overlaps it", async () => {
		const fixture = renderServices(withTheme({ parts: {} }))
		const child = (id: number, rgb: string, text?: string): ShapeNode => ({
			id,
			name: `c${String(id)}`,
			hidden: false,
			kind: "sp",
			xfrm: xfrm(0, 0, 100 * EMU, 50 * EMU),
			props: { fill: { kind: "solid", color: { kind: "srgb", rgb } } },
			...(text === undefined ? {} : { text: body(text) })
		})
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 2,
					name: "Group",
					hidden: false,
					kind: "grpSp",
					xfrm: xfrm(0, 0, 100 * EMU, 50 * EMU, { chX: 0, chY: 0, chCx: 100 * EMU, chCy: 50 * EMU }),
					children: [child(3, "AA0000", "Under"), child(4, "00AA00")]
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const fills = render.layers.map(layer => itemsOf(layer.drawing, ItemKind.PATH).map(item => solid(fillOf(layer.drawing, item))))

		// The first child's drawing and text, then the second child over both.
		expect(fills).toEqual([["AA0000"], ["00AA00"]])
		expect(render.layers[0]?.text).toBeDefined()
		expect(render.layers[1]?.text).toBeUndefined()
		expect(render.layers.map(layer => layer.shape.id)).toEqual([2, 2])
	})

	it("refuses a table over the cell budget rather than drawing part of it", async () => {
		const fixture = renderServices(withTheme({ parts: {} }), { text: false })
		const report = new RenderReport()
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 5,
					name: "T",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(0, 0, 9525, 9525),
					frame: {
						kind: "table",
						table: {
							grid: Array.from({ length: 1001 }, () => 9525),
							rows: [],
							flags: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: false, bandCol: false }
						}
					}
				}
			]
		)

		await renderSlide(deck, SLIDE, fixture.services, SLICING, report)

		expect(report.toJSON().unsupported).toEqual({ "table:tooLarge": 1 })
	})
})

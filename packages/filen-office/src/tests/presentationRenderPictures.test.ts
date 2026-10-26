import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList, ItemKind } from "../core/drawingml/displayList"
import { readFillElement } from "../core/drawingml/fill"
import { drawingReader } from "../core/drawingml/reader"
import { bytesSource } from "../core/opc/index"
import { openPptx } from "../core/pptx/package"
import { legacyOlePreviews } from "../core/pptx/read/legacyOle"
import { RenderReport } from "../core/presentation/render/effects"
import { renderSlide } from "../core/presentation/render/slide"
import { parseXml, type XmlDocument } from "../core/xml/index"
import {
	NS,
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
import { inThreadPresentationWorker, presentationWorkerPool } from "../dom/presentation/host"
import type { PresentationEvent } from "../dom/presentation/protocol"
import { ByteWriter, brush, dib24, emf, rectangle, wmf } from "./metafileFixtures"
import { buildPptx } from "./pptxFixtures"

const EMU = 9525
const SLICING = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

describe("SmartArt with an empty drawing cache", () => {
	const EMPTY = `<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/></dsp:spTree></dsp:drawing>`
	const deck = () =>
		deckOf(
			[],
			[],
			[
				{
					id: 4,
					name: "Diagram",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(0, 0, 100 * EMU, 50 * EMU),
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

	it("draws nothing and says the cache is empty", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME, "/ppt/diagrams/drawing1.xml": EMPTY } })
		const report = new RenderReport()
		const render = await renderSlide(deck(), SLIDE, fixture.services, SLICING, report)

		expect(render.layers[0]?.drawing.itemCount).toBe(0)
		expect(report.toJSON().unsupported["smartartCacheEmpty"]).toBe(1)
	})

	it("asks the SmartArt engine for a layout instead of the empty cache", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME, "/ppt/diagrams/drawing1.xml": EMPTY } })
		let asked = 0
		const services = {
			...fixture.services,
			smartart: {
				relayout: () => {
					asked++

					return Promise.resolve(undefined)
				}
			}
		}

		await renderSlide(deck(), SLIDE, services, SLICING)

		expect(asked).toBe(1)
	})
})

describe("metafile pictures", () => {
	// One blue rectangle over the whole inch.
	const picture = rectangle(brush(emf(), 1, 0xff0000), 0, 0, 1000, 1000).build()
	const markup =
		'<p:pic><p:nvPicPr><p:cNvPr id="9" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
		'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
	const setup = (withBytes: boolean) => {
		const fixture = renderServices({
			parts: { [THEME_PART]: THEME, [SLIDE_PART]: part(markup) },
			rels: { [SLIDE_PART]: { rId1: "/ppt/media/image1.emf" } },
			types: { "/ppt/media/image1.emf": "image/x-emf", "/ppt/media/ole1.emf": "image/x-emf" }
		})
		const read: string[] = []
		const services = withBytes
			? {
					...fixture.services,
					bytes: (name: string) => {
						read.push(name)

						return Promise.resolve(name.endsWith(".emf") ? picture : undefined)
					}
				}
			: fixture.services
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 9,
					name: "Logo",
					hidden: false,
					kind: "pic",
					xfrm: xfrm(0, 0, 914400, 914400),
					src: src(fixture, SLIDE_PART, elementById(fixture.documents.get(SLIDE_PART) as XmlDocument, 9))
				},
				{
					id: 10,
					name: "Object",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(914400, 0, 914400, 914400),
					frame: { kind: "ole", progId: "Equation.3", preview: "/ppt/media/ole1.emf" }
				}
			]
		)

		return { services, deck, read }
	}
	const kinds = (data: { itemCount: number; itemInts: Int32Array }) =>
		Array.from({ length: data.itemCount }, (_, item) => data.itemInts[item * 10] ?? -1)

	it("draws an EMF picture and an EMF OLE preview as what they hold", async () => {
		const { services, deck, read } = setup(true)
		const report = new RenderReport()
		const render = await renderSlide(deck, SLIDE, services, SLICING, report)

		for (const layer of render.layers) {
			expect(kinds(layer.drawing)).not.toContain(ItemKind.IMAGE)
			expect(kinds(layer.drawing)).toContain(ItemKind.PATH)
		}

		expect(render.layers).toHaveLength(2)
		expect(report.toJSON().unsupported["metafile"]).toBeUndefined()

		// Converted once per host: a second render reads nothing.
		const before = read.length

		await renderSlide(deck, SLIDE, services, SLICING)

		expect(read.length).toBe(before)
	})

	it("sends each render its own copy of a metafile's embedded bitmaps", async () => {
		const { info, bits } = dib24(2, 2, 0x00ff00)
		const blit = new ByteWriter()
			.u32(0x00cc0020)
			.i16(2)
			.i16(2)
			.i16(0)
			.i16(0)
			.i16(360)
			.i16(720)
			.i16(0)
			.i16(0)
			.raw(new ByteWriter().raw(info).raw(bits).done())
			.done()
		const bitmap = wmf().record(0x12d, [0]).recordBytes(0xb41, blit).build([0, 0, 1440, 720])
		const { services, deck } = setup(true)
		const withBitmap = { ...services, bytes: () => Promise.resolve(bitmap) }
		const embedded = (render: Awaited<ReturnType<typeof renderSlide>>) =>
			render.layers.flatMap(layer => layer.drawing.images.flatMap(image => (image.bytes === undefined ? [] : [image.bytes])))
		const first = embedded(await renderSlide(deck, SLIDE, withBitmap, SLICING))

		expect(first.length).toBeGreaterThan(0)

		// The page takes the first render's buffers.
		structuredClone(first, { transfer: first.map(bytes => bytes.buffer as ArrayBuffer) })

		const second = embedded(await renderSlide(deck, SLIDE, withBitmap, SLICING))

		expect(second.length).toBe(first.length)
		expect(second.every(bytes => bytes.byteLength > 0)).toBe(true)
	})

	it("names a metafile's embedded bitmap the same in every render, so the page shares one URL for its copies", async () => {
		const { info, bits } = dib24(2, 2, 0x00ff00)
		const blit = new ByteWriter()
			.u32(0x00cc0020)
			.i16(2)
			.i16(2)
			.i16(0)
			.i16(0)
			.i16(360)
			.i16(720)
			.i16(0)
			.i16(0)
			.raw(new ByteWriter().raw(info).raw(bits).done())
			.done()
		const bitmap = wmf().record(0x12d, [0]).recordBytes(0xb41, blit).build([0, 0, 1440, 720])
		const { services, deck } = setup(true)
		const withBitmap = { ...services, bytes: () => Promise.resolve(bitmap) }
		const names = (render: Awaited<ReturnType<typeof renderSlide>>) =>
			render.layers.flatMap(layer => layer.drawing.images.flatMap(image => (image.bytes === undefined ? [] : [image.bytesKey])))
		const first = names(await renderSlide(deck, SLIDE, withBitmap, SLICING))
		const second = names(await renderSlide(deck, SLIDE, withBitmap, SLICING))

		expect(first.length).toBeGreaterThan(0)
		expect(first.every(name => typeof name === "string" && name.length > 0)).toBe(true)
		expect(second).toEqual(first)
	})

	it("keeps the placeholder and counts it without a byte reader", async () => {
		const { services, deck } = setup(false)
		const report = new RenderReport()
		const render = await renderSlide(deck, SLIDE, services, SLICING, report)

		expect(kinds(render.layers[0]?.drawing as never)).toContain(ItemKind.IMAGE)
		expect(report.toJSON().unsupported["metafile:noReader"]).toBe(2)
	})
})

// A PNG header of `width` × `height` pixels at `dpi` (pHYs), enough for its size to be read.
function pngHead(width: number, height: number, dpi: number): Uint8Array {
	const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	const u32 = (value: number) => out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
	const chunk = (type: string, data: number[]) => {
		u32(data.length)
		out.push(...Array.from(type, c => c.charCodeAt(0)), ...data)
		u32(0)
	}
	const be = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
	const perMetre = Math.round(dpi / 0.0254)

	chunk("IHDR", [...be(width), ...be(height), 8, 2, 0, 0, 0])
	chunk("pHYs", [...be(perMetre), ...be(perMetre), 1])
	chunk("IEND", [])

	return new Uint8Array(out)
}

describe("picture tiles and recolouring", () => {
	const tiled = (algn: string) =>
		'<p:sp><p:nvSpPr><p:cNvPr id="9" name="Tiled"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
		`<a:blipFill><a:blip r:embed="rId1"/><a:tile tx="95250" ty="0" sx="50000" sy="25000" flip="none" algn="${algn}"/></a:blipFill></p:spPr></p:sp>`
	const render = async (algn: string) => {
		const fixture = renderServices({
			parts: { [THEME_PART]: THEME, [SLIDE_PART]: part(tiled(algn)) },
			rels: { [SLIDE_PART]: { rId1: "/ppt/media/image1.png" } }
		})
		// 100 × 80 pixels at 192 dpi: 50 × 40 px on the slide.
		const services = { ...fixture.services, bytes: () => Promise.resolve(pngHead(100, 80, 192)) }
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 9,
					name: "Tiled",
					hidden: false,
					kind: "sp",
					xfrm: xfrm(0, 0, 1905000, 952500),
					src: src(fixture, SLIDE_PART, elementById(fixture.documents.get(SLIDE_PART) as XmlDocument, 9))
				}
			]
		)
		const data = (await renderSlide(deck, SLIDE, services, SLICING)).layers[0]?.drawing
		const fill = data?.paints[data.itemInts[4] ?? -1]

		const tile = fill?.kind === "image" ? fill.tile : undefined
		const round = (value: number | undefined) => Math.round((value ?? NaN) * 100) / 100

		return { width: round(tile?.width), height: round(tile?.height), matrix: tile?.matrix?.map(round) }
	}

	it("places a tile at the picture's own size, scaled, aligned and offset in the box", async () => {
		// The box is 200 × 100 px; the tile 25 × 10 px.
		expect(await render("tl")).toEqual({ width: 25, height: 10, matrix: [1, 0, 0, 1, 10, 0] })
		expect(await render("br")).toEqual({ width: 25, height: 10, matrix: [1, 0, 0, 1, 185, 90] })
		expect(await render("ctr")).toEqual({ width: 25, height: 10, matrix: [1, 0, 0, 1, 97.5, 45] })
	})

	it("recolours a theme picture fill's duotone in the style reference's colour", () => {
		const document = parseXml(
			new TextEncoder().encode(
				'<a:blipFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip r:embed="rId1"><a:duotone><a:schemeClr val="phClr"/><a:srgbClr val="FFFFFF"/></a:duotone></a:blip><a:stretch/></a:blipFill>'
			)
		)
		const reader = drawingReader(document)
		const list = new DrawingList()
		const context = {
			list,
			theme: drawingTheme(undefined, () => undefined),
			images: () => ({ partName: "/ppt/media/image1.png", contentType: "image/png" }),
			effects: false
		}
		const paint = list.paints[readFillElement(context, reader, document.documentElement(), 0x1f4e79ff) ?? -1]

		expect(paint?.kind === "image" ? list.images[paint.image]?.duotone : undefined).toEqual([0x1f4e79ff, 0xffffffff])
	})
})

describe("legacy OLE previews", () => {
	it("finds a 2007-style OLE object's preview in the slide's VML drawing by its spid", () => {
		const vml = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
			<o:shapelayout/><v:shapetype id="_x0000_t75"/>
			<v:shape id="Content 3" o:spid="_x0000_s17410" type="#_x0000_t75"><v:imagedata o:relid="rId1" o:title=""/></v:shape>
			<v:shape id="_x0000_s17412" type="#_x0000_t75"><v:imagedata o:relid="rId2"/></v:shape>
			<v:shape id="_x0000_s17413"/>
		</xml>`
		const previews = legacyOlePreviews(parseXml(new TextEncoder().encode(vml)))

		expect([...previews]).toEqual([
			["_x0000_s17410", "rId1"],
			["_x0000_s17412", "rId2"]
		])
	})

	it("gives a 2007-style OLE frame its VML preview when the reader opens the slide", async () => {
		const vml =
			'<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:shape id="x" o:spid="_x0000_s1026"><v:imagedata o:relid="rId1"/></v:shape></xml>'
		const frame =
			'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></p:xfrm>' +
			'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj spid="_x0000_s1026" name="Document" r:id="rId7" progId="Word.Document.8"><p:embed/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>'
		const bytes = buildPptx({
			slides: [
				{
					shapes: frame,
					rels: [
						["rId7", "oleObject", "../embeddings/doc1.doc"],
						["rId8", "vmlDrawing", "../drawings/vmlDrawing1.vml"]
					]
				}
			],
			parts: {
				"ppt/drawings/vmlDrawing1.vml": { data: vml, type: "application/vnd.openxmlformats-officedocument.vmlDrawing" },
				"ppt/drawings/_rels/vmlDrawing1.vml.rels": {
					data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.emf"/></Relationships>'
				}
			}
		})
		const opened = await openPptx(bytesSource(bytes))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		await opened.parts.parseAll()

		const shape = opened.deck.nodes.get(opened.deck.slides[0] ?? (-1 as never))?.shapes[0]

		expect(shape?.frame).toMatchObject({ kind: "ole", progId: "Word.Document.8", preview: "/ppt/media/image1.emf" })
	})
})

describe("SmartArt text", () => {
	it("lays out a cached drawing's text in its text box through the text adapter, styled by the shape's font reference", async () => {
		const drawing =
			`<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>` +
			'<dsp:sp modelId="{1}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr>' +
			'<dsp:style><a:lnRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>' +
			'<dsp:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB" sz="1400"/><a:t>Answering basic questions about me and my condition</a:t></a:r></a:p></dsp:txBody>' +
			'<dsp:txXfrm><a:off x="95250" y="0"/><a:ext cx="952500" cy="952500"/></dsp:txXfrm></dsp:sp>' +
			"</dsp:spTree></dsp:drawing>"
		const fixture = renderServices({ parts: { [THEME_PART]: THEME, "/ppt/diagrams/drawing1.xml": drawing } })
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 4,
					name: "Diagram",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(0, 0, 1905000, 952500),
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
		const request = fixture.requests[0]

		// The text box is the txXfrm (100 px), not the shape (200 px): the text wraps there.
		expect(request?.width).toBeCloseTo(100)
		expect(request?.shape.style?.font).toEqual({ idx: "minor", color: { kind: "scheme", slot: "lt1" } })
		expect(request?.body.paragraphs[0]?.runs[0]).toMatchObject({ text: "Answering basic questions about me and my condition" })
		expect(render.layers.map(layer => layer.role)).toEqual(["smartart"])
		expect(render.layers[0]?.text).toBeDefined()
		// The drawing carries no text of its own.
		expect(render.layers[0]?.drawing.texts.every(text => text.kind !== "body")).toBe(true)
	})
})

describe("metafile pictures through the worker protocol", () => {
	it("renders a slide with a metafile picture again after its first render was transferred to the page", async () => {
		const { info, bits } = dib24(2, 2, 0x00ff00)
		const blit = new ByteWriter()
			.u32(0x00cc0020)
			.i16(2)
			.i16(2)
			.i16(0)
			.i16(0)
			.i16(360)
			.i16(720)
			.i16(0)
			.i16(0)
			.raw(new ByteWriter().raw(info).raw(bits).done())
			.done()
		const bitmap = wmf().record(0x12d, [0]).recordBytes(0xb41, blit).build([0, 0, 1440, 720])
		const picture =
			'<p:pic><p:nvPicPr><p:cNvPr id="9" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
			'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
		const deck = buildPptx({
			slides: [{ shapes: picture, rels: [["rId9", "image", "../media/image1.wmf"]] }],
			parts: { "ppt/media/image1.wmf": { data: bitmap, type: "image/x-wmf" } }
		})
		const pool = presentationWorkerPool(() => inThreadPresentationWorker())
		let opened: (event: PresentationEvent) => void = () => undefined
		const event = new Promise<PresentationEvent>(resolve => (opened = resolve))
		const client = pool.open({ kind: "bytes", bytes: deck }, { format: "pptx", fileName: "a.pptx" }, heard => {
			if (heard.type === "opened" || heard.type === "error") opened(heard)
		})

		try {
			const info = await event
			const ref = info.type === "opened" ? info.info.slides[0]?.ref : undefined

			if (ref === undefined) throw new Error("not opened")

			for (let round = 0; round < 3; round++) {
				const [render] = await client.render([ref])
				const embedded = render?.layers.flatMap(layer => layer.drawing.images.filter(image => image.bytes !== undefined)) ?? []

				expect(embedded.length).toBeGreaterThan(0)
				expect(embedded.every(image => (image.bytes?.byteLength ?? 0) > 0)).toBe(true)
			}
		} finally {
			client.close()
			pool.dispose()
		}
	})
})

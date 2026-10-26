import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { rgba } from "../core/drawingml/displayList"
import { openPptx } from "../core/pptx/package"
import { resolveParagraph, resolveShape } from "../core/presentation/inherit"
import type { Deck, ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import type { SlideRender } from "../core/presentation/output"
import type { RenderServices, TextLayoutRequest } from "../core/presentation/render/services"
import { renderSlide } from "../core/presentation/render/slide"
import { resolveBody, shapeBodyContext, type TextFonts } from "../core/presentation/text/resolve"
import type { Slicing } from "../core/slicing"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { THEME, body, buildPptx, para, sp, xfrm, type FixtureOptions } from "./pptxFixtures"

// One inheritance resolver: the renderer's bodyPr, the text adapter's list-style chain and resolveShape are the same
// code, so what the model tests measure is what paints.

const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }
const FONTS: TextFonts = { color: () => undefined, typeface: () => undefined }

function never(): never {
	throw new Error("unexpected undefined")
}

async function open(options: FixtureOptions): Promise<{ deck: Deck; slides: SlideNode[] }> {
	const result = await openPptx(bytesSource(buildPptx(options)))

	if (result.kind !== "opened") throw new Error(result.reason)

	await result.parts.parseAll()

	return { deck: result.deck, slides: result.deck.slides.map(ref => result.deck.nodes.get(ref) ?? never()) }
}

async function rendered(options: FixtureOptions): Promise<{ deck: Deck; render: SlideRender; requests: TextLayoutRequest[] }> {
	const opened = (await openRenderDeck(buildPptx(options))) ?? never()
	const requests: TextLayoutRequest[] = []
	const services: RenderServices = {
		...opened.services,
		layoutText: request => {
			requests.push(request)

			return { page: fixtureTextPage(["x"], { width: request.width }), height: 24 }
		}
	}
	const ref: SlideRef = opened.deck.slides[0] ?? never()

	return { deck: opened.deck, render: await renderSlide(opened.deck, ref, services, SLICING), requests }
}

function shape(slide: SlideNode | undefined, name: string): ShapeNode {
	return slide?.shapes.find(candidate => candidate.name === name) ?? never()
}

const OBJECT_DEFAULTS =
	"<a:objectDefaults>" +
	'<a:spDef><a:spPr/><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle><a:defPPr algn="ctr"/><a:lvl1pPr algn="r"/></a:lstStyle></a:spDef>' +
	'<a:txDef><a:spPr/><a:bodyPr wrap="none" anchor="b"/><a:lstStyle/></a:txDef>' +
	"</a:objectDefaults>"

const THEMED: Pick<FixtureOptions, "parts"> = {
	parts: { "ppt/theme/theme1.xml": { data: THEME.replace("</a:themeElements>", `</a:themeElements>${OBJECT_DEFAULTS}`) } }
}

function textBox(id: number, name: string): string {
	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
		`<p:spPr>${xfrm(0, 0, 100, 100)}</p:spPr><p:txBody>${body(para("t"))}</p:txBody></p:sp>`
	)
}

describe("one inheritance resolver", () => {
	it("keeps a stored shape's unwritten bodyPr and pPr at the defaults, whatever the theme's objectDefaults say", async () => {
		// PowerPoint's own files show it: oxsdk__typical (PowerPoint 12) has spDef wrap="none", writes wrap="none" on
		// the shapes that do not wrap and leaves it out on boxes sized for wrapped text. objectDefaults format a shape
		// when it is inserted (ECMA-376 §20.1.4.1.27–28), not one read from a file.
		const options: FixtureOptions = {
			...THEMED,
			slides: [{ shapes: sp(2, "Shape", undefined, xfrm(0, 0, 100, 100), body(para("s"))) + textBox(3, "Box") }]
		}
		const { deck, slides } = await open(options)
		const slide = slides[0] ?? never()
		const plain = resolveShape(deck, slide.ref, shape(slide, "Shape"))

		expect(plain.bodyPr).toMatchObject({ anchor: "t", wrap: true })
		expect(resolveShape(deck, slide.ref, shape(slide, "Box")).bodyPr).toMatchObject({ anchor: "t", wrap: true })
		expect(resolveParagraph(plain, shape(slide, "Shape").text?.paragraphs[0] ?? never()).pPr.algn).toBeUndefined()

		// The renderer lays the text out with the same bodyPr.
		const { requests } = await rendered(options)

		expect(requests.map(request => [request.shape.name, request.bodyPr.anchor, request.bodyPr.wrap])).toEqual([
			["Shape", "t", true],
			["Box", "t", true]
		])
	})

	it("matches a written idx by idx alone, an implied one within its class", async () => {
		const layouts = [
			{
				name: "Footers",
				shapes:
					sp(2, "Title 1", 'type="title"', xfrm(1, 1, 1, 1)) +
					sp(3, "Footer 11", 'type="ftr" idx="11"', xfrm(500, 600, 70, 80)) +
					sp(4, "Number 12", 'type="sldNum" idx="12"', xfrm(900, 600, 70, 80))
			}
		]
		const { deck, slides } = await open({
			layouts,
			slides: [{ shapes: sp(2, "Number", 'type="sldNum" idx="11"') + sp(3, "Implied", 'type="body"') }]
		})
		const slide = slides[0] ?? never()
		const number = resolveShape(deck, slide.ref, shape(slide, "Number"))

		expect(number.match).toBe("idx")
		expect(number.levels[1]?.shape.name).toBe("Footer 11")
		expect(number.xfrm).toMatchObject({ x: 500, y: 600 })
		// No idx written: idx 0 is the layout's title, of another class, so it is not taken.
		expect(resolveShape(deck, slide.ref, shape(slide, "Implied")).levels[1]?.shape.name).not.toBe("Title 1")
	})

	it("ignores defPPr in every list style of the chain", async () => {
		const { deck, slides } = await open({
			slides: [
				{
					shapes: sp(
						2,
						"Title",
						'type="title"',
						"",
						body(para("t"), "<a:bodyPr/>", '<a:lstStyle><a:defPPr algn="l"/></a:lstStyle>')
					)
				}
			]
		})
		const slide = slides[0] ?? never()
		const title = shape(slide, "Title")
		const resolved = resolveShape(deck, slide.ref, title)

		// The master's titleStyle lvl1pPr centres; the slide's defPPr algn="l" is ignored (MS-OI29500 §2.1.1383).
		expect(resolveParagraph(resolved, title.text?.paragraphs[0] ?? never()).pPr.algn).toBe("ctr")

		const context = shapeBodyContext(deck, slide, title, FONTS, resolved.bodyPr)

		expect(resolveBody(title.text ?? never(), context).paragraphs[0]?.pPr.algn).toBe("ctr")
	})

	it("builds the text adapter's chain from resolveShape", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: sp(3, "Body", 'idx="1"', "", body(para("b"))) }] })
		const slide = slides[0] ?? never()
		const content = shape(slide, "Body")
		const resolved = resolveShape(deck, slide.ref, content)
		const context = shapeBodyContext(deck, slide, content, FONTS, resolved.bodyPr)

		expect(context.listStyles).toEqual(resolved.listStyles.slice(resolved.ownListStyles).reverse())
		expect(resolveBody(content.text ?? never(), context).paragraphs[0]?.defRPr.sz).toBe(2600)
	})

	it("gives notes footer text the notesStyle", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: "", notes: para("n") }] })
		const notes = deck.nodes.get(slides[0]?.notes ?? never()) ?? never()
		const footer: ShapeNode = {
			id: 9,
			name: "Number",
			hidden: false,
			kind: "sp",
			ph: { type: "sldNum", idx: 5, idxWritten: true },
			text: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "1", rPr: {} }] }] }
		}

		notes.shapes.push(footer)

		const context = shapeBodyContext(deck, notes, footer, FONTS, resolveShape(deck, notes.ref, footer).bodyPr)

		// ECMA-376 §19.3.1.28: notesStyle is used on all text within the notes slides.
		expect(resolveBody(footer.text ?? never(), context).paragraphs[0]?.defRPr.sz).toBe(1200)
	})

	it("keeps body bullets out of a placeholder table's cells", async () => {
		const { deck, slides } = await open({ slides: [{ shapes: sp(3, "Body", 'idx="1"', "", body(para("b"))) }] })
		const slide = slides[0] ?? never()
		const frame: ShapeNode = { ...shape(slide, "Body"), kind: "frame" }
		const cell = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r" as const, text: "c", rPr: {} }] }] }
		const context = shapeBodyContext(deck, slide, frame, FONTS, resolveShape(deck, slide.ref, frame).bodyPr, {
			style: { bold: true }
		})
		const paragraph = resolveBody(cell, context).paragraphs[0] ?? never()

		// Table text is no placeholder text (ECMA-376 §19.3.1.35): the master's otherStyle, then the tcTxStyle.
		expect(paragraph.pPr.bullet).toBeUndefined()
		expect(paragraph.defRPr).toMatchObject({ sz: 1800, b: true })
	})

	it("paints a placeholder's own p:style over a farther level's noFill", async () => {
		const layouts = [
			{
				name: "Plain",
				shapes: sp(
					2,
					"Title 1",
					'type="title"',
					`${xfrm(0, 0, 1000, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>`
				)
			}
		]
		const styled =
			'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>' +
			'<p:style><a:lnRef idx="1"><a:schemeClr val="accent2"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>' +
			'<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"/></p:style>' +
			`<p:txBody>${body(para("t"))}</p:txBody></p:sp>`
		const options: FixtureOptions = { layouts, slides: [{ shapes: styled }] }
		const { deck, slides } = await open(options)
		const slide = slides[0] ?? never()
		const resolved = resolveShape(deck, slide.ref, shape(slide, "Title"), {
			document: () => undefined
		})

		// MS-OI29500 §2.1.1284: the style link comes before the master shape.
		expect(resolved.fill).toBeUndefined()
		expect(resolved.ln).toBeUndefined()

		const { render } = await rendered(options)
		const title = render.layers.find(layer => layer.shape.id === 2) ?? never()

		expect(title.drawing.paints).toContainEqual({ kind: "solid", color: rgba("4472C4") })
	})

	it("gives a placeholder no level places a zero box, not the slide", async () => {
		const { render, requests } = await rendered({
			layouts: [{ name: "Empty", shapes: "" }],
			master: '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>',
			slides: [{ shapes: sp(2, "Orphan", 'type="title"', "", body(para("upArrow"))) }]
		})
		const layer = render.layers[0] ?? never()

		expect(layer.matrix.slice(4)).toEqual([0, 0])
		expect(requests[0]?.width ?? 0).toBe(0)
	})
})

import { describe, expect, it } from "vitest"
import { ItemFloat, ItemInt, ItemKind, pathGradientCircle, rgbaHex, type Paint } from "../core/drawingml/displayList"
import type { DrawingData } from "../core/drawingml/data"
import { drawingReader } from "../core/drawingml/reader"
import { renderSlide } from "../core/presentation/render/slide"
import { pickColor } from "../core/presentation/render/smartartText"
import { fitTextWarp, readTextWarp, warpPaths, type TextWarp } from "../core/presentation/render/warp"
import type { ShapeNode } from "../core/presentation/model"
import type { RenderEffects } from "../core/presentation/output"
import { parseXml, type XmlDocument } from "../core/xml/index"
import type { Slicing } from "../core/slicing"
import { paintTextPageCanvas } from "../core/drawingml/canvas"
import { RecordingCanvas } from "./presentationCanvasRecorder"
import { cpuMs, budget } from "./timing"
import {
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
	xfrm
} from "./fixtures/presentation/renderDeck"
import { fixtureTextPage } from "./fixtures/presentation/textPage"

const EMU = 9525
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

function xml(markup: string): XmlDocument {
	return parseXml(new TextEncoder().encode(markup))
}

function apply(matrix: readonly number[], x: number, y: number): [number, number] {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix

	return [a * x + c * y + e, b * x + d * y + f]
}

function warp(preset: string, adjust: Record<string, number> = {}): TextWarp {
	return { preset, adjust: new Map(Object.entries(adjust)) }
}

// Two fixture lines: "abcdefghij" (90 px) and "abcde" (45 px), 24 px each, so the extent is 90 × 48 px.
const PAGE = fixtureTextPage(["abcdefghij", "abcde"], { width: 200 })

describe("WordArt text warps", () => {
	it("reads the preset and its written adjust values from a:bodyPr, and none for textNoShape", () => {
		const document = xml(
			`<p:txBody ${NS}><a:bodyPr><a:prstTxWarp prst="textPlain"><a:avLst><a:gd name="adj" fmla="val 70000"/></a:avLst></a:prstTxWarp></a:bodyPr><a:p/></p:txBody>`
		)
		const plain = readTextWarp(drawingReader(document), document.documentElement())

		expect(plain?.preset).toBe("textPlain")
		expect(plain?.adjust.get("adj")).toBe(70000)

		const none = xml(`<p:txBody ${NS}><a:bodyPr><a:prstTxWarp prst="textNoShape"><a:avLst/></a:prstTxWarp></a:bodyPr><a:p/></p:txBody>`)

		expect(readTextWarp(drawingReader(none), none.documentElement())).toBeUndefined()
	})

	it("evaluates every ECMA-376 preset to at least one path inside its box", () => {
		for (const preset of [
			"textPlain",
			"textArchUp",
			"textArchDown",
			"textCircle",
			"textWave1",
			"textInflate",
			"textSlantUp",
			"textTriangle"
		]) {
			const paths = warpPaths(warp(preset), 200, 100)

			expect(paths?.length, preset).toBeGreaterThan(0)

			for (const path of paths ?? []) {
				for (let k = 0; k < path.length; k += 2) {
					expect(path[k]).toBeGreaterThanOrEqual(-1)
					expect(path[k]).toBeLessThanOrEqual(201)
				}
			}
		}
	})

	it("stretches textPlain text over the whole text box, its extent's corners onto the box's", () => {
		const fit = fitTextWarp(warp("textPlain"), PAGE.page, PAGE.styles, 200, 100)

		expect(fit?.approximate).toBe(false)
		expect(apply(fit?.matrix ?? [], 0, 0).map(value => Math.round(value * 1000) / 1000)).toEqual([0, 0])
		expect(apply(fit?.matrix ?? [], 90, 48).map(value => Math.round(value * 1000) / 1000)).toEqual([200, 100])
	})

	it("shears textPlain with adj 70000 into its parallelogram: the top from l to 0.6 w, the bottom from 0.4 w to r", () => {
		const fit = fitTextWarp(warp("textPlain", { adj: 70000 }), PAGE.page, PAGE.styles, 200, 100)
		const round = (point: [number, number]): number[] => point.map(value => Math.round(value * 1000) / 1000)

		expect(fit?.approximate).toBe(false)
		expect(round(apply(fit?.matrix ?? [], 0, 0))).toEqual([0, 0])
		expect(round(apply(fit?.matrix ?? [], 90, 0))).toEqual([120, 0])
		expect(round(apply(fit?.matrix ?? [], 0, 48))).toEqual([80, 100])
		expect(round(apply(fit?.matrix ?? [], 90, 48))).toEqual([200, 100])
	})

	it("sits textArchUp text on the arc: its bottom centre at the apex for centred text, level there, reported as approximated", () => {
		const fit = fitTextWarp(warp("textArchUp"), fixtureTextPage(["abcdefghij"]).page, fixtureTextPage(["abcdefghij"]).styles, 90, 60)
		const [x, y] = apply(fit?.matrix ?? [], 45, 24)

		expect(fit?.approximate).toBe(true)
		expect(x).toBeCloseTo(45, 0)
		expect(y).toBeCloseTo(0, 0)
		expect(fit?.matrix[1]).toBeCloseTo(0, 2)
	})

	it("places the slide's warped text through the layer's text matrix", async () => {
		const shape = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="WordArt"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(200 * EMU)}" cy="${String(100 * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"><a:prstTxWarp prst="textPlain"><a:avLst/></a:prstTxWarp></a:bodyPr><a:p><a:r><a:t>abcdefghij</a:t></a:r></a:p></p:txBody></p:sp>`
		const fixture = renderServices({ parts: { [THEME_PART]: THEME, [SLIDE_PART]: part(shape) } })
		const node: ShapeNode = {
			id: 2,
			name: "WordArt",
			hidden: false,
			kind: "sp",
			txBox: true,
			xfrm: xfrm(0, 0, 200 * EMU, 100 * EMU),
			src: src(fixture, SLIDE_PART, elementById(fixture.documents.get(SLIDE_PART) as XmlDocument, 2)),
			text: { ...body("abcdefghij"), bodyPr: { insets: { left: 0, top: 0, right: 0, bottom: 0 } } }
		}
		const render = await renderSlide(deckOf([], [], [node]), SLIDE, fixture.services, SLICING)
		const matrix = render.layers[0]?.textMatrix ?? []

		// One 90 × 24 px line stretched over the 200 × 100 px box.
		expect(apply(matrix, 90, 24).map(value => Math.round(value * 1000) / 1000)).toEqual([200, 100])
	})

	it("fits a warp in well under a millisecond", () => {
		const runs: number[] = []

		for (let run = 0; run < 5; run++) {
			const start = cpuMs()

			for (let k = 0; k < 100; k++) fitTextWarp(warp(k % 2 === 0 ? "textArchUp" : "textWave1"), PAGE.page, PAGE.styles, 200 + k, 100)

			runs.push((cpuMs() - start) / 100)
		}

		expect(Math.min(...runs)).toBeLessThan(budget(1))
	})
})

describe("path gradients", () => {
	const path = (left: number, top: number, right: number, bottom: number): Extract<Paint, { kind: "path" }> => ({
		kind: "path",
		shape: "circle",
		stops: { offsets: new Float32Array([0, 1]), colors: new Uint32Array([0xffffffff, 0x000000ff]) },
		focus: { left, top, right, bottom }
	})

	it("centres an inverted fillToRect between its edges (a theme background's l 10% t 110% r 10% b 100%)", () => {
		const circle = pathGradientCircle(path(0.1, 1.1, 0.1, 1))

		expect(circle.cx).toBeCloseTo(0.5, 6)
		expect(circle.cy).toBeCloseTo(0.55, 6)
		// A rectangle with no area has no solid focus.
		expect(circle.inner).toBe(0)
	})

	it("centres l 50% t 50% r 100% b 100% at a quarter of the box, reaching the far corner", () => {
		const circle = pathGradientCircle(path(0.5, 0.5, 1, 1))

		expect(circle.cx).toBeCloseTo(0.25, 6)
		expect(circle.cy).toBeCloseTo(0.25, 6)
		expect(circle.radius).toBeCloseTo(Math.hypot(0.75, 0.75), 6)
	})

	it("keeps an ordinary focus rectangle as before: its centre, solid inside it", () => {
		const circle = pathGradientCircle(path(0.25, 0.25, 0.25, 0.25))

		expect([circle.cx, circle.cy]).toEqual([0.5, 0.5])
		expect(circle.inner).toBeCloseTo(Math.hypot(0.25, 0.25) / Math.hypot(0.5, 0.5), 6)
	})
})

describe("built-in table styles", () => {
	it("draws a table naming PowerPoint's Medium Style 2 - Accent 1 that the tableStyles part does not define", async () => {
		const fixture = renderServices({
			parts: { [THEME_PART]: THEME, "/ppt/tableStyles.xml": `<a:tblStyleLst ${NS} def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` }
		})
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 5,
					name: "Table",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(0, 0, 200 * EMU, 40 * EMU),
					frame: {
						kind: "table",
						table: {
							grid: [100 * EMU, 100 * EMU],
							rows: [
								{ h: 20 * EMU, cells: [{ text: body("A") }, { text: body("B") }] },
								{ h: 20 * EMU, cells: [{ text: body("1") }, { text: body("2") }] }
							],
							styleId: "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
							flags: { firstRow: true, lastRow: false, firstCol: false, lastCol: false, bandRow: true, bandCol: false }
						}
					}
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const data = render.layers[0]?.drawing as DrawingData
		const fills: string[] = []

		for (let item = 0; item < data.itemCount; item++) {
			if (data.itemInts[item * 10 + ItemInt.KIND] !== ItemKind.PATH) continue

			const paint = data.paints[data.itemInts[item * 10 + ItemInt.FILL] ?? -1]

			if (paint?.kind === "solid") fills.push(`${String(data.itemFloats[item * 10 + ItemFloat.Y])}:${rgbaHex(paint.color)}`)
		}

		// The header row in accent1; the first banded row in accent1 at 40% tint (CFD5EA).
		expect(fills[0]).toBe("0:4472C4")
		expect(fills.slice(1).some(fill => fill.endsWith(":CFD5EA"))).toBe(true)
		// The header's text: bold, lt1.
		expect(fixture.requests.find(request => request.cell?.row === 0)?.cell?.style).toMatchObject({ bold: true, color: "FFFFFF" })
	})

	it("gives a row of empty cells the height of their paragraph marks' line", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } }, { textHeight: 30 })
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 5,
					name: "Table",
					hidden: false,
					kind: "frame",
					xfrm: xfrm(0, 0, 100 * EMU, 40 * EMU),
					frame: {
						kind: "table",
						table: {
							grid: [100 * EMU],
							rows: [
								{ h: 0, cells: [{ text: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [] }] } }] },
								{ h: 20 * EMU, cells: [{ text: body("Text") }] }
							],
							flags: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: false, bandCol: false }
						}
					}
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
		const text = render.layers.find(layer => layer.text !== undefined)

		// The empty first row: 30 px of paragraph mark plus the 0.05in margins; the second row's text below it.
		expect(text?.textMatrix?.[5]).toBeGreaterThanOrEqual(30 + 9.6)
	})
})

describe("SmartArt cached text", () => {
	it("takes the colour definition's text fill for the shape's style label, over the cache's fontRef colour", async () => {
		const drawing =
			`<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>` +
			`<dsp:sp modelId="{P1}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(100 * EMU)}" cy="${String(50 * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr>` +
			'<dsp:style><a:lnRef idx="2"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="1"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef><a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>' +
			'<dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Node</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>'
		const data =
			'<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>' +
			'<dgm:pt modelId="{P1}" type="pres"><dgm:prSet presName="node" presStyleLbl="node1" presStyleIdx="0" presStyleCnt="1"/><dgm:spPr/></dgm:pt></dgm:ptLst></dgm:dataModel>'
		const colors =
			'<dgm:colorsDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
			'<dgm:styleLbl name="node1"><dgm:fillClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:fillClrLst><dgm:txFillClrLst meth="repeat"><a:schemeClr val="dk1"/></dgm:txFillClrLst></dgm:styleLbl></dgm:colorsDef>'
		const fixture = renderServices({
			parts: {
				[THEME_PART]: THEME,
				"/ppt/diagrams/drawing1.xml": drawing,
				"/ppt/diagrams/data1.xml": data,
				"/ppt/diagrams/colors1.xml": colors
			}
		})
		const deck = deckOf(
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
						colors: "/ppt/diagrams/colors1.xml",
						drawing: "/ppt/diagrams/drawing1.xml"
					}
				}
			]
		)

		await renderSlide(deck, SLIDE, fixture.services, SLICING)

		expect(fixture.requests[0]?.shape.style?.font.color).toEqual({ kind: "scheme", slot: "dk1" })
	})

	it("picks list colours by ST_ClrAppMethod: repeat starts over, cycle runs back, span spreads the list", () => {
		expect([0, 1, 2, 3].map(index => pickColor("repeat", index, 4, 2))).toEqual([0, 1, 0, 1])
		expect([0, 1, 2, 3, 4].map(index => pickColor("cycle", index, 5, 3))).toEqual([0, 1, 2, 1, 0])
		expect([0, 1, 2, 3, 4].map(index => pickColor(undefined, index, 5, 3))).toEqual([0, 1, 1, 2, 2])
		expect(pickColor("repeat", 7, 9, 1)).toBe(0)
	})
})

describe("text effects in the canvas painter", () => {
	it("draws a text reflection mirrored below the span's box, fading from startAlpha in clipped bands", () => {
		const page = fixtureTextPage(["Quiz"])
		const ctx = new RecordingCanvas()
		const reflection: RenderEffects = [
			{ kind: "reflection", blur: 0, startAlpha: 0.5, endAlpha: 0, endPos: 0.5, distance: 2, direction: 90 }
		]

		paintTextPageCanvas(
			ctx,
			{ ...page, styles: page.styles.map(style => ({ ...style, effects: 0 })), textEffects: [reflection] },
			[1, 0, 0, 1, 0, 0]
		)

		const texts = ctx.ops("fillText")
		const mirrored = texts.filter(call => (call.transform[3] ?? 1) < 0)

		expect(texts[0]?.transform).toEqual([1, 0, 0, 1, 0, 0])
		expect(mirrored.length).toBeGreaterThan(1)
		// Mirrored about the box's bottom (baseline 18 + descent 6, no line-height in the fixture's font) plus half the distance.
		expect(mirrored[0]?.transform[5]).toBeCloseTo(2 * (24 + 1), 6)
		// The band nearest the glyphs is the most opaque, never above startAlpha.
		expect(mirrored[0]?.alpha).toBeLessThanOrEqual(0.5)
		expect(mirrored[0]?.alpha).toBeGreaterThan(mirrored[mirrored.length - 1]?.alpha ?? 1)
	})
})

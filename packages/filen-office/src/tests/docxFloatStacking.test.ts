import { describe, expect, it } from "vitest"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { Layer, OBJECT_FLOATS, OBJECT_INTS, Region, SOURCE_INTS, SourceInt, type DocumentLayout } from "../core/docx/layout/index"
import type { DocxEngineServices } from "../dom/docx/index"
import { exportDocxPdf } from "../dom/docx/pdf"
import { openPdf, pdfAssets } from "./docxPdfFixtures"
import { buildDocx, type SyntheticDocx } from "./docxSynthetic"
import { layOut } from "./layoutFixtures"
import { engineServices } from "./engineFixtures"

// Floating objects stack by wp:anchor/@relativeHeight (ECMA-376 §20.4.2.3), not by where they are anchored: those
// behind the text (behindDoc) among themselves, those in front of it among themselves whatever their wrapping.
// Header and footer objects lie behind the body text with the behindDoc ones, as LibreOffice places them (Opaque
// off). A text box's text is drawn with its box, so a box over another keeps its text on top.

const SECTION =
	'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr>'

interface Shape {
	readonly z: number
	readonly y: number
	readonly wrap?: string
	readonly behind?: boolean
	readonly fill?: string
	readonly text?: string
}

let nextId = 10

// A rectangle anchored to the page at (1in, y EMU), 4in by 1in.
function shape(spec: Shape): string {
	const id = nextId++

	return (
		`<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${spec.z}" behindDoc="${spec.behind === true ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>` +
		`<wp:positionH relativeFrom="page"><wp:posOffset>914400</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${spec.y}</wp:posOffset></wp:positionV>` +
		`<wp:extent cx="3657600" cy="914400"/>${spec.wrap ?? "<wp:wrapNone/>"}<wp:docPr id="${id}" name="s${id}"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
		`<wps:wsp><wps:cNvSpPr${spec.text === undefined ? "" : ' txBox="1"'}/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${spec.fill ?? "FFFFFF"}"/></a:solidFill></wps:spPr>` +
		(spec.text === undefined
			? ""
			: `<wps:txbx><w:txbxContent><w:p><w:r><w:t>${spec.text}</w:t></w:r></w:p></w:txbxContent></wps:txbx>`) +
		'<wps:bodyPr lIns="91440" tIns="45720" rIns="91440" bIns="45720"/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
	)
}

function anchoredIn(...shapes: Shape[]): string {
	return `<w:p>${shapes.map(shape).join("")}<w:r><w:t>Body text over which the shapes lie.</w:t></w:r></w:p>`
}

async function layout(spec: SyntheticDocx): Promise<DocumentLayout> {
	return layOut(buildDocx({ headers: { rIdH: "<w:p/>" }, ...spec, body: `${spec.body ?? ""}${SECTION}` }))
}

// The page's objects in paint order: their top (px) and layer.
function stack(result: DocumentLayout): { y: number; layer: number }[] {
	const page = result.pages[0]
	const out: { y: number; layer: number }[] = []

	for (let o = 0; o < (page?.objectCount ?? 0); o++)
		out.push({ y: Math.round(page?.objectFloats[o * OBJECT_FLOATS + 1] ?? 0), layer: page?.objectInts[o * OBJECT_INTS + 1] ?? -1 })

	return out
}

// The tops of a layer's objects in paint order (each layer is painted on its own).
function layered(result: DocumentLayout, layer: number): number[] {
	return stack(result)
		.filter(entry => entry.layer === layer)
		.map(entry => entry.y)
}

// 1in = 96 px; shapes at 1in + k/10in.
const at = (tenths: number): number => 914400 + tenths * 91440
const px = (tenths: number): number => Math.round(96 + tenths * 9.6)

describe("floating object stacking", () => {
	it("paints floats in front of the text by relativeHeight, not by anchor order", async () => {
		const result = await layout({ body: anchoredIn({ z: 3, y: at(0) }, { z: 1, y: at(1) }, { z: 2, y: at(2) }) })

		expect(stack(result)).toEqual([
			{ y: px(1), layer: Layer.FRONT },
			{ y: px(2), layer: Layer.FRONT },
			{ y: px(0), layer: Layer.FRONT }
		])
	})

	it("keeps anchor order between floats of equal relativeHeight", async () => {
		const result = await layout({ body: anchoredIn({ z: 5, y: at(3) }, { z: 5, y: at(1) }, { z: 2, y: at(2) }) })

		expect(stack(result).map(entry => entry.y)).toEqual([px(2), px(3), px(1)])
	})

	it("stacks wrapped and unwrapped floats in front of the text in one order", async () => {
		const square = '<wp:wrapSquare wrapText="bothSides"/>'
		const result = await layout({ body: anchoredIn({ z: 4, y: at(0), wrap: square }, { z: 2, y: at(1) }) })

		expect(stack(result)).toEqual([
			{ y: px(1), layer: Layer.FRONT },
			{ y: px(0), layer: Layer.FRONT }
		])
	})

	it("stacks behindDoc floats among themselves by relativeHeight", async () => {
		const result = await layout({
			body: anchoredIn({ z: 9, y: at(0), behind: true }, { z: 1, y: at(1) }, { z: 3, y: at(2), behind: true })
		})

		expect(layered(result, Layer.BEHIND)).toEqual([px(2), px(0)])
		expect(layered(result, Layer.FRONT)).toEqual([px(1)])
	})

	it("puts header floats behind the body text, ordered with the behindDoc floats", async () => {
		const result = await layout({
			body: anchoredIn({ z: 4, y: at(1), behind: true }, { z: 1, y: at(2) }),
			headers: { rIdH: anchoredIn({ z: 9, y: at(0) }, { z: 2, y: at(3), behind: true }) }
		})

		expect(layered(result, Layer.BEHIND)).toEqual([px(3), px(1), px(0)])
		expect(layered(result, Layer.FRONT)).toEqual([px(2)])
	})

	it("records which text box holds each paragraph laid out inside one", async () => {
		const result = await layout({ body: anchoredIn({ z: 2, y: at(0), text: "Inside the box" }) })
		const page = result.pages[0]
		const owners: { region: number; owner: number }[] = []

		for (let s = 0; s < (page?.sourceCount ?? 0); s++)
			owners.push({ region: page?.sourceInts[s * SOURCE_INTS + SourceInt.REGION] ?? -1, owner: page?.sourceOwners[s] ?? -2 })

		const box = page?.objectInts[0] ?? -1

		expect(box).toBeGreaterThanOrEqual(0)
		expect(owners.filter(entry => entry.region === Region.TEXTBOX).map(entry => entry.owner)).toEqual([box])
		expect(owners.filter(entry => entry.region !== Region.TEXTBOX).every(entry => entry.owner === -1)).toBe(true)
	})
})

function services(): DocxEngineServices {
	return engineServices({
		yield: () => new Promise(resolve => setTimeout(resolve, 0)),
		sliceMs: 8
	})
}

describe("floating object stacking in the PDF export", () => {
	it("draws a text box's text over the box and over a lower box anchored after it", async () => {
		// The text box (relativeHeight 2) comes first in the text, the filled rectangle (relativeHeight 1) after it.
		const bytes = buildDocx({
			body: anchoredIn({ z: 2, y: at(0), text: "Boxed words" }, { z: 1, y: at(1), fill: "CFDCE3" }) + SECTION,
			headers: { rIdH: "<w:p/>" }
		})
		const exported = await exportDocxPdf(bytes, services(), pdfAssets, {
			options: { title: "Floats", deterministic: true },
			signal: { aborted: false },
			onProgress: () => undefined
		})
		const pdf = await openPdf(new Uint8Array(await exported.blob.arrayBuffer()))
		const list = await (await pdf.getPage(1)).getOperatorList()
		const fills: string[] = []
		let rectangle = -1
		let box = -1
		let text = -1

		for (let k = 0; k < list.fnArray.length; k++) {
			const op = list.fnArray[k]
			const args = list.argsArray[k] as unknown[]

			if (op === OPS.setFillRGBColor) fills.push(String(args[0]))
			if (op === OPS.setFillRGBColor && /cfdce3/i.test(String(args[0]))) rectangle = k
			if (op === OPS.setFillRGBColor && /^#ffffff$/i.test(String(args[0])) && rectangle >= 0 && box < 0) box = k
			if (op === OPS.showText && text < 0) {
				const glyphs = (args[0] as ({ unicode?: string } | number)[]).map(glyph =>
					typeof glyph === "number" ? "" : (glyph.unicode ?? "")
				)

				if (glyphs.join("").includes("Boxed")) text = k
			}
		}

		expect(rectangle).toBeGreaterThanOrEqual(0)
		expect(box).toBeGreaterThan(rectangle)
		expect(text).toBeGreaterThan(box)
	}, 60000)
})

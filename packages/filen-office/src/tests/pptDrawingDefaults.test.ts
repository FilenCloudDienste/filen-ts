import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { buildPpt } from "./pptFixtures"

// A PowerPoint 97–2003 deck's drawing defaults (the drawing group's drawingPrimaryOptions) are not taken as what an
// existing shape inherits: read that way they leave the corpus's table cells unwrapped and cut off and fill its boxes
// in a scheme colour, against what the authors left and LibreOffice 7.5 renders. A property a shape or background
// leaves unset takes MS-ODRAW's default (white fill, black 0.75 pt line, text wrapped and anchored at the top), and a
// placeholder that sets no fill or line of its own takes its master placeholder's in the converted pptx. A text box
// whose fill booleans leave fFilled unset (fUsefFilled clear) and that names no fill colour is drawn unfilled, as
// LibreOffice draws it; one that names a colour is filled with it.

// Fill colour scheme 4 (written 00CC99), line colour scheme 1, filled, lined 2.25 pt, text anchored in the middle and
// not wrapped.
const DEFAULTS: readonly (readonly [number, number])[] = [
	[0x0181, 0x08000004],
	[0x01c0, 0x08000001],
	[0x01bf, 0x00100010],
	[0x01ff, 0x00080008],
	[0x01cb, 28575],
	[0x0087, 1],
	[0x0085, 2]
]

async function converted(options: Parameters<typeof buildPpt>[0]): Promise<(name: string) => Promise<string>> {
	const built = await buildPpt(options)
	const result = await pptToPptx(bytesSource(built.bytes))

	if (result.kind !== "converted") throw new Error(JSON.stringify(result))

	return async name => new TextDecoder().decode(await result.pptx.read(name))
}

describe("a converted .ppt's drawing defaults", () => {
	it("give a filled background without a colour MS-ODRAW's white, not the defaults' colour", async () => {
		const part = await converted({
			slides: [{ shapes: [] }],
			drawingDefaults: DEFAULTS,
			masterBackground: [[0x01bf, 0x00100010]]
		})
		const master = await part("ppt/slideMasters/slideMaster1.xml")

		expect(master).toMatch(/<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"\/>/u)
		expect(master).not.toContain("00CC99")
	})

	it("leave a placeholder that sets no fill or line its master placeholder's, anchored as MS-ODRAW defaults it", async () => {
		const part = await converted({
			slides: [
				{
					shapes: [
						{ text: "Title", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] },
						{ text: "Body", textType: 1, placeholder: { type: 14, position: 1 }, anchor: [900, 300, 5400, 4000] }
					]
				}
			],
			drawingDefaults: DEFAULTS
		})
		const slide = await part("ppt/slides/slide1.xml")
		const master = await part("ppt/slideMasters/slideMaster1.xml")

		for (const xml of [slide, master]) {
			expect(xml).not.toContain("00CC99")
			expect(xml).not.toMatch(/<p:ph [^>]*\/><\/p:nvPr><\/p:nvSpPr><p:spPr>(?:(?!<\/p:spPr>).)*<a:solidFill>/u)
			expect(xml).not.toContain('anchor="ctr"')
		}
	})

	it("leave a plain shape's unset fill, line and text body MS-ODRAW's, not the defaults'", async () => {
		const part = await converted({
			slides: [{ shapes: [{ text: "Plain", anchor: [100, 300, 5400, 700] }] }],
			drawingDefaults: DEFAULTS
		})
		const slide = await part("ppt/slides/slide1.xml")

		expect(slide).not.toContain("00CC99")
		expect(slide).toContain('<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>')
		expect(slide).not.toContain('w="28575"')
		expect(slide).toMatch(/<a:bodyPr [^>]*wrap="square"/u)
		expect(slide).not.toContain('anchor="ctr"')
	})

	it("leave a text box that leaves fFilled unset (fUsefFilled clear) and names no fill colour unfilled", async () => {
		const part = await converted({
			slides: [{ shapes: [{ text: "Box", shapeType: 202, anchor: [100, 300, 5400, 700], properties: [[0x01bf, 0x00600000]] }] }],
			drawingDefaults: DEFAULTS
		})
		const slide = await part("ppt/slides/slide1.xml")

		expect(slide).toMatch(/<p:spPr>(?:(?!<\/p:spPr>).)*<a:noFill\/>(?:(?!<\/p:spPr>).)*<a:ln/u)
		expect(slide).not.toContain("00CC99")
		expect(slide).not.toContain('<a:srgbClr val="FFFFFF"/>')
	})

	it("fill a text box that leaves fFilled unset but names a fill colour with that colour", async () => {
		const part = await converted({
			slides: [
				{
					shapes: [
						{
							text: "Box",
							shapeType: 202,
							anchor: [100, 300, 5400, 700],
							properties: [
								[0x01bf, 0x00200000],
								[0x0181, 0x00f0efdc]
							]
						}
					]
				}
			],
			drawingDefaults: DEFAULTS
		})
		const slide = await part("ppt/slides/slide1.xml")

		expect(slide).toContain('<a:solidFill><a:srgbClr val="DCEFF0"/></a:solidFill>')
	})
})

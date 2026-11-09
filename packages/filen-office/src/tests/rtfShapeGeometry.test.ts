import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { readRtf, type RtfReadResult } from "../core/rtf/index"

// RTF shapes without a picture, text box or WordArt (RTF 1.9.1 "Shapes") drawn from their property list as Word draws
// them: the preset geometry of their shapeType with their fill and line, where they are placed.

function bytes(text: string): Uint8Array {
	const out = new Uint8Array(text.length)

	for (let k = 0; k < text.length; k++) out[k] = text.charCodeAt(k) & 0xff

	return out
}

async function read(body: string): Promise<RtfReadResult> {
	const result = await readRtf(bytes(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}${body}}`))

	if (!result.ok) throw new Error(result.reason)

	return result
}

function documentXml(result: RtfReadResult): string {
	return strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array())
}

const sp = (name: string, value: string | number): string => `{\\sp{\\sn ${name}}{\\sv ${String(value)}}}`

describe("RTF shapes drawn from their properties", () => {
	it("draws an ellipse with its fill and line colours (COLORREF, blue in the high byte) where it is placed", async () => {
		const result = await read(
			"\\pard {\\shp{\\*\\shpinst\\shpleft1440\\shptop720\\shpright4320\\shpbottom2160\\shpbxpage\\shpbypage\\shpwr3" +
				`${sp("shapeType", 3)}${sp("fillColor", 0x0000ff)}${sp("lineColor", 0xff0000)}${sp("lineWidth", 25400)}}}Text\\par`
		)
		const xml = documentXml(result)

		expect(result.undrawn).toBe(0)
		expect(xml).toContain('<wp:positionH relativeFrom="page"><wp:posOffset>914400</wp:posOffset>')
		expect(xml).toContain('<wp:positionV relativeFrom="page"><wp:posOffset>457200</wp:posOffset>')
		expect(xml).toContain('<wp:extent cx="1828800" cy="914400"/>')
		expect(xml).toContain("<wp:wrapNone/>")
		expect(xml).toContain('<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>')
		expect(xml).toContain('<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="0000FF"/>')
		// The markup declares the namespaces it uses.
		expect(xml).toMatch(/<wp:anchor xmlns:a="[^"]+" xmlns:wps="[^"]+"/u)
		// The shape stays in the source, written again as it was.
		expect(result.preserved.map(entry => entry.kind)).toEqual(["shape"])
	})

	it("defaults to a white fill and a black line, and leaves out what fFilled and fLine turn off", async () => {
		const plain = documentXml(await read(`\\pard {\\shp{\\*\\shpinst\\shpright1440\\shpbottom1440${sp("shapeType", 1)}}}\\par`))

		expect(plain).toContain('<a:prstGeom prst="rect">')
		expect(plain).toContain('<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/>')

		const bare = documentXml(
			await read(
				`\\pard {\\shp{\\*\\shpinst\\shpright1440\\shpbottom1440${sp("shapeType", 2)}${sp("fFilled", 0)}${sp("fLine", 0)}}}\\par`
			)
		)

		expect(bare).toContain('<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>')
	})

	it("draws a line unfilled with its flips, and a callout as its preset", async () => {
		const xml = documentXml(
			await read(
				`\\pard {\\shp{\\*\\shpinst\\shpright2880\\shpbottom1440${sp("shapeType", 20)}${sp("fFlipV", 1)}${sp("rotation", 90 * 65536)}}}` +
					`{\\shp{\\*\\shpinst\\shpright2880\\shpbottom1440${sp("shapeType", 61)}}}\\par`
			)
		)

		expect(xml).toContain('<a:xfrm rot="5400000" flipV="1">')
		expect(xml).toContain('<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/>')
		expect(xml).toContain('<a:prstGeom prst="wedgeRectCallout">')
	})

	it("places a group's shapes in its coordinate space and counts only those it cannot draw", async () => {
		const member = (type: number, rel: readonly number[]): string =>
			`{\\shp{\\*\\shpinst${sp("shapeType", type)}${sp("relLeft", rel[0] ?? 0)}${sp("relTop", rel[1] ?? 0)}${sp("relRight", rel[2] ?? 0)}${sp("relBottom", rel[3] ?? 0)}}}`
		const result = await read(
			"\\pard {\\shpgrp{\\*\\shpinst\\shpleft1000\\shptop0\\shpright3000\\shpbottom1000" +
				`${sp("groupLeft", 0)}${sp("groupTop", 0)}${sp("groupRight", 200)}${sp("groupBottom", 100)}` +
				`${member(1, [100, 50, 200, 100])}${member(0, [0, 0, 100, 50])}}}\\par`
		)
		const xml = documentXml(result)

		// relLeft 100 of 200 across 2000 twips: 1000 twips in, 1000 wide, 500 high.
		expect(xml).toContain(`<wp:posOffset>${String(2000 * 635)}</wp:posOffset>`)
		expect(xml).toContain(`<wp:posOffset>${String(500 * 635)}</wp:posOffset>`)
		expect(xml).toContain(`<wp:extent cx="${String(1000 * 635)}" cy="${String(500 * 635)}"/>`)
		// The freeform (shapeType 0) has no preset: drawn nowhere.
		expect(result.undrawn).toBe(1)
		expect(xml.match(/<wps:wsp>/gu)?.length).toBe(1)
	})

	it("leaves a shape of an unknown type undrawn", async () => {
		const result = await read(`\\pard {\\shp{\\*\\shpinst\\shpright1440\\shpbottom1440${sp("shapeType", 0)}}}\\par`)

		expect(result.undrawn).toBe(1)
		expect(documentXml(result)).not.toContain("<w:drawing>")
	})
})

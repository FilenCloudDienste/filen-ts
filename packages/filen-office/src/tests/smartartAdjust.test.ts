import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { D, drawingReader } from "../core/drawingml/reader"
import { adjustGuideValue } from "../core/smartart/adjust"
import { parseXml } from "../core/xml/index"
import { AVERAGE_MEASURER, relayoutDiagram } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"

// The guides of every prstGeom of `preset` in a diagram drawing, in document order.
function presetGuides(drawingXml: Uint8Array | string, preset: string): string[][] {
	const document = parseXml(typeof drawingXml === "string" ? new TextEncoder().encode(drawingXml) : drawingXml)
	const reader = drawingReader(document)
	const out: string[][] = []
	const visit = (node: number): void => {
		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "prstGeom" && reader.attr(child, "prst") === preset) {
				out.push(
					reader
						.children(reader.child(child, D.A, "avLst"), D.A, "gd")
						.map(gd => `${reader.attr(gd, "name")} ${reader.attr(gd, "fmla")}`)
				)
			} else visit(child)
		}
	}

	visit(document.documentElement())

	return out
}

describe("SmartArt layout adjustments as shape guides", () => {
	it("writes an adjustment a rotation handle turns in 60000ths of a degree, any other in 100000ths", () => {
		expect(adjustGuideValue("pie", "adj1", 270)).toBe(16_200_000)
		expect(adjustGuideValue("pie", "adj2", 30)).toBe(1_800_000)
		expect(adjustGuideValue("circularArrow", "adj2", 90)).toBe(5_400_000)
		// circularArrow's adj1 is the arrow's thickness, a fraction.
		expect(adjustGuideValue("circularArrow", "adj1", 0.125)).toBe(12_500)
		expect(adjustGuideValue("roundRect", "adj", 0.1)).toBe(10_000)
		expect(adjustGuideValue("unknownPreset", "adj1", 0.5)).toBe(50_000)
	})
})

const PIE = join(CORPUS_DIR, "pptx/lo__tdf149551_SmartArt_Pie.pptx")

describe.skipIf(!existsSync(PIE))("SmartArt relayout of a pie diagram", () => {
	it("gives each pie wedge the angles PowerPoint's own drawing has", () => {
		const parts = unzipSync(new Uint8Array(readFileSync(PIE)))
		const part = (name: string): Uint8Array => {
			const bytes = parts[`ppt/diagrams/${name}`]

			if (bytes === undefined) throw new Error(`${name} is missing`)

			return bytes
		}
		const emitted = relayoutDiagram(
			{
				data: parseXml(part("data1.xml")),
				layout: parseXml(part("layout1.xml")),
				style: parseXml(part("quickStyle1.xml")),
				colors: parseXml(part("colors1.xml"))
			},
			{ w: 5_760_509, h: 3_840_339 },
			() => AVERAGE_MEASURER
		)
		const source = presetGuides(part("drawing1.xml"), "pie")

		expect(source).toEqual([
			["adj1 val 16200000", "adj2 val 1800000"],
			["adj1 val 1800000", "adj2 val 9000000"],
			["adj1 val 9000000", "adj2 val 16200000"]
		])
		expect(presetGuides(emitted.drawingXml, "pie")).toEqual(source)
	})
})

describe.skipIf(!existsSync(PIE))("SmartArt relayout of a pie diagram's text", () => {
	it("gives each wedge its own text where PowerPoint's drawing puts it, with the point's anchor, alignment and level", () => {
		const parts = unzipSync(new Uint8Array(readFileSync(PIE)))
		const part = (name: string): Uint8Array => {
			const bytes = parts[`ppt/diagrams/${name}`]

			if (bytes === undefined) throw new Error(`${name} is missing`)

			return bytes
		}
		const data = parseXml(part("data1.xml"))
		const emitted = relayoutDiagram(
			{
				data,
				layout: parseXml(part("layout1.xml")),
				style: parseXml(part("quickStyle1.xml")),
				colors: parseXml(part("colors1.xml"))
			},
			{ w: 5_760_509, h: 3_840_339 },
			() => AVERAGE_MEASURER
		)
		// Per shape: its text's first character, text box, anchor, insets and the first paragraph's level and alignment.
		const shapes = (xml: Uint8Array | string): string[][] => {
			const text = typeof xml === "string" ? xml : new TextDecoder().decode(xml)

			return [...text.matchAll(/<dsp:sp [\s\S]*?<\/dsp:sp>/gu)].map(([sp]) => [
				/<a:t>(.)/u.exec(sp)?.[1] ?? "",
				...[...(/<dsp:txXfrm><a:off x="(\d+)" y="(\d+)"\/>/u.exec(sp) ?? [])]
					.slice(1)
					.map(v => String(Math.round(Number(v) / 100))),
				/<a:bodyPr [^>]*lIns="(\d+)"[^>]*anchor="(\w+)" anchorCtr="(\d)"/u.exec(sp)?.slice(1).join(" ") ?? "",
				/<a:pPr [^>]*lvl="(\d)"[^>]*algn="(\w+)"/u.exec(sp)?.slice(1).join(" ") ?? "",
				sp.includes("<a:buChar") ? "bullet" : "no bullet"
			])
		}

		expect(shapes(emitted.drawingXml)).toEqual(shapes(part("drawing1.xml")))
	})
})

const GEAR = join(CORPUS_DIR, "pptx/lo__tdf149551_SmartArt_Gear.pptx")

describe.skipIf(!existsSync(GEAR))("SmartArt relayout of a gear diagram", () => {
	it("gives its circular arrows the angles PowerPoint's own drawing has", () => {
		const parts = unzipSync(new Uint8Array(readFileSync(GEAR)))
		const part = (name: string): Uint8Array => {
			const bytes = parts[name]

			if (bytes === undefined) throw new Error(`${name} is missing`)

			return bytes
		}
		const slide = new TextDecoder().decode(part("ppt/slides/slide1.xml"))
		const ext = /<p:graphicFrame>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/u.exec(slide)
		const emitted = relayoutDiagram(
			{
				data: parseXml(part("ppt/diagrams/data1.xml")),
				layout: parseXml(part("ppt/diagrams/layout1.xml")),
				style: parseXml(part("ppt/diagrams/quickStyle1.xml")),
				colors: parseXml(part("ppt/diagrams/colors1.xml"))
			},
			{ w: Number(ext?.[1]), h: Number(ext?.[2]) },
			() => AVERAGE_MEASURER
		)
		const source = part("ppt/diagrams/drawing1.xml")
		// Angles to a degree (60000): the arcs follow the laid-out gears, not PowerPoint's to the unit.
		const angles = (xml: Uint8Array | string): number[][] =>
			[...presetGuides(xml, "circularArrow"), ...presetGuides(xml, "leftCircularArrow")].map(guides =>
				guides.filter(guide => /^adj[234] /u.test(guide)).map(guide => Math.round(Number(guide.split(" val ")[1]) / 60000))
			)

		expect(angles(emitted.drawingXml).length).toBeGreaterThan(0)
		expect(angles(emitted.drawingXml)).toEqual(angles(source))

		// Its text: the points' own zero insets, and the turned gear's text kept upright (txXfrm turned back).
		const texts = (xml: Uint8Array | string): string[] => {
			const markup = typeof xml === "string" ? xml : new TextDecoder().decode(xml)

			return [...markup.matchAll(/<dsp:sp [\s\S]*?<\/dsp:sp>/gu)]
				.map(([sp]) => sp)
				.filter(sp => sp.includes("<a:t>"))
				.map(
					sp =>
						`${/<a:t>([^<]*)/u.exec(sp)?.[1] ?? ""} ${/lIns="(\d+)"/u.exec(sp)?.[1] ?? ""} ${/<dsp:txXfrm rot="(-?\d+)"/u.exec(sp)?.[1] ?? "0"}`
				)
		}

		expect(texts(emitted.drawingXml)).toEqual(texts(source))
	})
})

import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList } from "../core/drawingml/displayList"
import { convertSmartArt } from "../core/drawingml/smartart"
import { newDiagramData } from "../core/smartart/edit"
import { smartArtColorsDef, smartArtLayoutDef, smartArtStyleDef } from "../core/smartart/gallery/defs"
import { SMARTART_COLORS, SMARTART_LAYOUTS, SMARTART_STYLES } from "../core/smartart/gallery/index"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { relayoutDiagram, sampleData } from "../dom/presentation/engine/smartart"
import { adapterMeasurers } from "./smartartFixtures"
import { budget, cpuMs } from "./timing"

// The gallery's cost in the presentation worker (plan §1.12): every registry layout's preview, laid out from a
// three-item sample with the default style and colours and drawn into a display list, within 1 s of CPU together
// (smartartGalleryPerf); and every registry layout relaid with 30 items through the slide text adapter within the
// 60 ms relayout budget.

const PREVIEW_BOX = { w: 4_572_000, h: 3_429_000 }
const SLIDE_BOX = { w: 8_000_000, h: 4_500_000 }
const SAMPLE = ["First item", "Second item", "Third item"]
const THIRTY = Array.from({ length: 30 }, (_, i) =>
	i % 3 === 2 ? `\tDetail ${String(i)} of the step` : `Step ${String(i)} of the process`
)
const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>
	<a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
		<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
	<a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
	<a:fmtScheme name="m">
		<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst>
		<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
		<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>
		<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
	</a:fmtScheme></a:themeElements></a:theme>`

function doc(xml: string | undefined): XmlDocument | undefined {
	return xml === undefined ? undefined : parseXml(encodeUtf8(xml))
}

function required(xml: string | undefined, what: string): XmlDocument {
	const document = doc(xml)

	if (document === undefined) throw new Error(`no ${what}`)

	return document
}

describe("SmartArt gallery performance", () => {
	it("draws every registry layout's preview from a three-item sample within 1 s of CPU", { timeout: 60_000 }, async () => {
		const measurers = await adapterMeasurers(SAMPLE)
		const theme = drawingTheme(required(THEME, "theme"), () => undefined)
		const style = doc(smartArtStyleDef(SMARTART_STYLES[0]?.uniqueId ?? ""))
		const colors = doc(smartArtColorsDef(SMARTART_COLORS[0]?.uniqueId ?? ""))
		const layouts = SMARTART_LAYOUTS.map(entry => required(smartArtLayoutDef(entry.uniqueId), entry.uniqueId))
		const sample = sampleData(SAMPLE.map(text => ({ level: 1, text })))
		const draw = (): number => {
			let items = 0

			for (const layout of layouts) {
				const emitted = relayoutDiagram({ data: sample, layout, style, colors }, PREVIEW_BOX, () => measurers())
				const list = new DrawingList()
				const converted = convertSmartArt(
					{ list, theme, images: () => undefined, effects: true },
					required(emitted.drawingXml, "drawing"),
					PREVIEW_BOX.w,
					PREVIEW_BOX.h
				)

				items += converted === undefined ? 0 : list.itemCount
			}

			return items
		}

		// The faces are warm in a session that has drawn a slide; the least of three runs.
		draw()

		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()

			expect(draw()).toBeGreaterThan(0)
			best = Math.min(best, cpuMs() - start)
		}

		expect(best).toBeLessThanOrEqual(budget(1000))
	})

	it("relays every registry layout out with 30 items through the text adapter within 60 ms of CPU", { timeout: 120_000 }, async () => {
		const measurers = await adapterMeasurers(THIRTY.map(text => text.trim()))
		const style = doc(smartArtStyleDef(SMARTART_STYLES[0]?.uniqueId ?? ""))
		const colors = doc(smartArtColorsDef(SMARTART_COLORS[0]?.uniqueId ?? ""))

		for (const entry of SMARTART_LAYOUTS) {
			const layout = required(smartArtLayoutDef(entry.uniqueId), entry.uniqueId)
			const data = required(newDiagramData(THIRTY, { layout: { uniqueId: entry.uniqueId } }), "data")
			const sources = { data, layout, style, colors }

			relayoutDiagram(sources, SLIDE_BOX, () => measurers())

			let best = Number.POSITIVE_INFINITY

			for (let run = 0; run < 3; run++) {
				const start = cpuMs()

				relayoutDiagram(sources, SLIDE_BOX, () => measurers())
				best = Math.min(best, cpuMs() - start)
			}

			expect(best, entry.uniqueId).toBeLessThanOrEqual(budget(60))
		}
	})
})

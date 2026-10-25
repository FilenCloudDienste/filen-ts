import { describe, expect, it } from "vitest"
import { FontManager, LINE_METRICS, CLONE_METRICS, lineSpacingUnits, verticalMetrics, type FontRequest } from "@filen/office/core/fonts"
import { buildDocx } from "./docxSynthetic"
import { layOut, nodeFontAssets, nodeFontHost, pageLines } from "./layoutFixtures"
import { odtBytes, odtLayout } from "./odtFixtures"
import { openPdf, pdfOf, snapshotOf } from "./docxPdfFixtures"
import { embeddedFontNames } from "./pdfWriteFixtures"

// Layout units are CSS pixels.
const PT = 0.75
// Georgia 5.00x-4: win 1878 + 449 (the GDI line height Word lays out with, OpenType OS/2 usWinAscent and
// usWinDescent) equals hhea 1878 - (-449) + 0 (what LibreOffice reads), 2327 units of 2048, and USE_TYPO_METRICS is
// clear: a 10 pt line is 11.36 pt in both (LibreOffice 7.5's PDF export with Georgia installed: 11.35 pt).
const GEORGIA_LINE_10PT = (10 * 2327) / 2048

function request(family: string): FontRequest {
	return { family, bold: false, italic: false, slot: "ascii" }
}

function pitches(lines: readonly { readonly text: string; readonly top: number }[]): number[] {
	const body = lines.filter(line => line.text.startsWith("Line "))
	const out: number[] = []

	for (let i = 1; i < body.length; i++) out.push(((body[i]?.top ?? 0) - (body[i - 1]?.top ?? 0)) * PT)

	return out
}

// Four 10 pt Georgia paragraphs, single spaced; the paragraph mark is Georgia too, as its font counts toward
// the line.
function georgiaDocx(): Uint8Array {
	const georgia = '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="20"/></w:rPr>'
	const paragraph = (text: string) =>
		`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${georgia}</w:pPr><w:r>${georgia}<w:t>${text}</w:t></w:r></w:p>`

	return buildDocx({ body: [0, 1, 2, 3].map(i => paragraph(`Line ${i}`)).join("") })
}

describe("Georgia drawn with Gelasio", () => {
	it("takes its line metrics from Georgia itself, the same in every style", () => {
		const georgia = verticalMetrics(2048, 1878, -449, 0, 1549, -444, 198, 1878, 449, false)

		expect(LINE_METRICS.get("georgia")).toMatchObject({ basis: "original", metrics: georgia })
		expect(CLONE_METRICS.get("gelasio")?.metrics).toEqual(georgia)
		expect(lineSpacingUnits(georgia, "gdi")).toBe(2327)
		expect(lineSpacingUnits(georgia, "typoWhenFlagged")).toBe(2327)
	})

	it("resolves to Gelasio's outlines with Georgia's metrics", async () => {
		const manager = new FontManager(nodeFontHost, nodeFontAssets, undefined, "fogeorgia")

		await manager.prepare([request("Georgia")])

		const font = manager.resolve(request("Georgia"))

		expect(font).toMatchObject({ family: "fogeorgia-gelasio", metricsBasis: "original", scale: 1 })
		expect(font.metrics?.winAscent).toBe(1878)
	})

	it("sets 10 pt docx lines Georgia's 11.36 pt apart, not Gelasio's 16.6 pt", async () => {
		const layout = await layOut(georgiaDocx())

		for (const pitch of pitches(pageLines(layout, 0))) expect(pitch).toBeCloseTo(GEORGIA_LINE_10PT, 2)
	})

	it("places PDF baselines Georgia's 11.36 pt apart and still draws Gelasio's glyphs", async () => {
		const result = await pdfOf(await snapshotOf(georgiaDocx()))
		const pdf = await openPdf(result.bytes)
		const page = await pdf.getPage(1)
		const content = await page.getTextContent()
		const baselines = content.items.flatMap(item =>
			"str" in item && item.str.startsWith("Line ") ? [item.transform[5] as number] : []
		)

		expect(baselines).toHaveLength(4)

		for (let i = 1; i < baselines.length; i++) expect((baselines[i - 1] ?? 0) - (baselines[i] ?? 0)).toBeCloseTo(GEORGIA_LINE_10PT, 2)

		const fonts = new Set(content.items.flatMap(item => ("str" in item && item.str.startsWith("Line ") ? [item.fontName] : [])))

		// One face draws every line, and the only one the PDF embeds is a Gelasio subset.
		expect(fonts.size).toBe(1)
		expect(embeddedFontNames(result.bytes)).toEqual([expect.stringMatching(/^[A-Z]{6}\+Gelasio/)])
	})

	it("sets 10 pt odt lines Georgia's 11.36 pt apart, as LibreOffice does", async () => {
		const { layout } = await odtLayout(
			odtBytes({
				automatic:
					'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0in"/><style:text-properties fo:font-family="Georgia" fo:font-size="10pt"/></style:style>',
				body: [0, 1, 2, 3].map(i => `<text:p text:style-name="P1">Line ${i}</text:p>`).join("")
			})
		)

		for (const pitch of pitches(pageLines(layout, 0))) expect(pitch).toBeCloseTo(GEORGIA_LINE_10PT, 2)
	})
})

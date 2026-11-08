import { describe, expect, it } from "vitest"
import { OPS as pdfjsOps } from "pdfjs-dist/legacy/build/pdf.mjs"
import { buildDocx } from "./docxSynthetic"
import { openPdf, pdfOf, snapshotOf } from "./docxPdfFixtures"

// The PDF export strokes each line of a multi-line border (ST_Border triple, thinThick*, thickThin*) on its own,
// as the page painter draws it, within the width the layout reserves.

async function paths(style: string): Promise<number> {
	const body =
		`<w:p><w:pPr><w:pBdr><w:top w:val="${style}" w:sz="24" w:space="1" w:color="000000"/></w:pBdr></w:pPr>` +
		'<w:r><w:t xml:space="preserve">Bordered</w:t></w:r></w:p>'
	const pdf = await openPdf((await pdfOf(await snapshotOf(buildDocx({ body })))).bytes)
	const operators = (await (await pdf.getPage(1)).getOperatorList()).fnArray

	return operators.filter(op => op === pdfjsOps.constructPath).length
}

describe("multi-line borders in the PDF export", () => {
	it("draws a triple border as three lines and thin-thick borders as two", async () => {
		const single = await paths("single")

		expect(await paths("triple")).toBe(single + 2)
		expect(await paths("thinThickMediumGap")).toBe(single + 1)
		expect(await paths("thickThinLargeGap")).toBe(single + 1)
	})
})

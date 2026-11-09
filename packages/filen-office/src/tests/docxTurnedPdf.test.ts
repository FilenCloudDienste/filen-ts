import { describe, expect, it } from "vitest"
import { buildDocx } from "./docxSynthetic"
import { openPdf, pdfOf, snapshotOf } from "./docxPdfFixtures"

// The PDF export draws a sideways table cell's text turned as the page shows it (w:textDirection): read bottom to
// top for btLr, top to bottom for tbRl, upright text unturned.

const SECTION =
	'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

function docx(direction: string): Uint8Array {
	const cell = (text: string, tcPr = ""): string =>
		`<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`

	return buildDocx({
		body:
			'<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>' +
			`<w:tr>${cell("Sideways", `<w:textDirection w:val="${direction}"/>`)}${cell("Upright")}</w:tr></w:tbl>${SECTION}`
	})
}

// The text matrix of each text item, by its text.
async function transforms(direction: string): Promise<Map<string, number[]>> {
	const pdf = await openPdf((await pdfOf(await snapshotOf(docx(direction)))).bytes)
	const content = await (await pdf.getPage(1)).getTextContent()
	const out = new Map<string, number[]>()

	for (const item of content.items) if ("str" in item && item.str.trim() !== "") out.set(item.str.trim(), item.transform as number[])

	return out
}

describe("sideways cells in the PDF export", () => {
	it("turns bottom to top text a quarter turn anticlockwise and top to bottom text clockwise", async () => {
		const up = await transforms("btLr")
		const down = await transforms("tbRl")
		const [ua, ub] = up.get("Sideways") ?? []
		const [da, db] = down.get("Sideways") ?? []
		const [ra, rb] = up.get("Upright") ?? []

		// PDF space has y up: a run read bottom to top advances along +y, one read top to bottom along -y.
		expect(Math.abs(ua ?? 1)).toBeLessThan(1e-6)
		expect(ub ?? 0).toBeGreaterThan(0)
		expect(Math.abs(da ?? 1)).toBeLessThan(1e-6)
		expect(db ?? 0).toBeLessThan(0)
		expect(ra ?? 0).toBeGreaterThan(0)
		expect(Math.abs(rb ?? 1)).toBeLessThan(1e-6)
	})
})

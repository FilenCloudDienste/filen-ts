import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { installPresentationRealm } from "../dom/presentation/services"
import { openPdf, pageText } from "./docxPdfFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { deckPdf, installTestRealm, openDeck } from "./presentationExportFixtures"

// Text effects (shadow, glow, reflection) the PDF does not draw: the text is drawn plain and the report counts
// them as content the pages lack, one per fragment drawn with them.

const EMU = 9525
const GLOW = '<a:effectLst><a:glow rad="38100"><a:srgbClr val="FFC000"/></a:glow></a:effectLst>'

function deck(paragraphs: string): Uint8Array {
	return buildPptx({
		sldSz: '<p:sldSz cx="9144000" cy="5143500"/>',
		slides: [{ shapes: sp(2, "Title 1", 'type="title"', xfrm(100 * EMU, 40 * EMU, 760 * EMU, 80 * EMU), body(paragraphs)) }]
	})
}

beforeAll(() => {
	installTestRealm()
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("presentation PDF text effects", () => {
	it("counts a run with a glow as left out and still draws its text", { timeout: 60_000 }, async () => {
		const glowing = `<a:p><a:r><a:rPr lang="en-GB">${GLOW}</a:rPr><a:t>Glowing title</a:t></a:r></a:p>`
		const { bytes, outcome } = await deckPdf(await openDeck(deck(glowing)))

		expect(await pageText(await openPdf(bytes), 1)).toContain("Glowing title")
		expect(outcome.pdf?.refused).toEqual([["untranslated", 1]])
	})

	it("reports nothing for text without effects", { timeout: 60_000 }, async () => {
		const { outcome } = await deckPdf(await openDeck(deck(para("Plain title"))))

		expect(outcome.pdf?.refused ?? []).toEqual([])
	})
})

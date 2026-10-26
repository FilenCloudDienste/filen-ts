import { describe, expect, it } from "vitest"
import type { DocxPdfDocument, DocxPdfStyle } from "../core/docx/pdf/types"
import { toDocxPdfPage } from "../core/presentation/text/page"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { pdfOf } from "./docxPdfFixtures"

// DocxPagePainter drawing DrawingML text (a presentation TextPage through toDocxPdfPage): a style's paint, alpha
// and outline as PDF operators; a document's styles (none of those fields) as before.

const PLAIN: DocxPdfStyle = {
	face: 0,
	bold: false,
	italic: false,
	slot: "ascii",
	language: "en-GB",
	size: 20,
	color: 0x1f2937ff,
	letterSpacing: 0,
	scaleX: 1,
	shift: 0,
	fit: "spread"
}

function documentOf(styles: readonly DocxPdfStyle[]): DocxPdfDocument {
	const text = fixtureTextPage(["Plain line", "Gradient title"], { decorated: [1] })

	return {
		pages: [toDocxPdfPage(text)],
		styles,
		faces: [{ kind: "bundled", family: "carlito", weight: 400, italic: false }],
		decorations: [],
		links: [],
		objects: new Map(),
		media: new Map(),
		destinations: new Map(),
		outline: [],
		lang: "en-GB",
		title: "Deck",
		paints: text.paints,
		strokes: text.strokes,
		textEffects: text.textEffects
	}
}

async function contentOf(styles: readonly DocxPdfStyle[]): Promise<string> {
	const result = await pdfOf(documentOf(styles), { deflate: null })

	return new TextDecoder("latin1").decode(result.bytes)
}

describe("PDF page painter: DrawingML text paint", () => {
	it("draws an outlined, gradient-filled title and translucent text with their outline and opacity", async () => {
		const content = await contentOf([
			{ ...PLAIN, alpha: 0.5, outline: 0 },
			{ ...PLAIN, paint: 1, alpha: 0.8, outline: 0, effects: 0 }
		])

		// A solid fill with an outline: fill then stroke (mode 2), reset after the text.
		expect(content).toMatch(/\n2 Tr\n/)
		expect(content).toMatch(/\n0 Tr\n/)
		// The solid fill's opacity through an ExtGState (constant alpha 0.5); a paint's alpha is its own, not 0.8.
		expect(content).toMatch(/\/ca 0\.5/)
		expect(content).not.toMatch(/\/ca 0\.8/)
		// The gradient: the glyphs as a clip (mode 7), the shading painted through it inside one q … Q, then the
		// outline stroked over (mode 1) in its own colour (the fixture's outline paint, 1F2937), reading as nothing.
		expect(content).toMatch(/q\n[^Q]*\n7 Tr\n[\s\S]*?ET\n[^Q]*\/Sh\w* sh\n[\s\S]*?Q\n/)
		expect(content).toMatch(/\n1 Tr\n/)
		expect(content).toMatch(/0\.122 0\.161 0\.216 RG/)
		expect(content).toMatch(/\/ActualText \(\)|\/ActualText <FEFF>|\/ActualText <>/)
	})

	it("draws a document's styles exactly as before", async () => {
		const plain = await contentOf([PLAIN, PLAIN])
		const withTables = await contentOf([PLAIN, { ...PLAIN }])

		expect(withTables).toBe(plain)
		expect(plain).not.toMatch(/ Tr\n/)
	})
})

import { describe, expect, it } from "vitest"
import { paintTextPageCanvas } from "../core/drawingml/canvas"
import type { DocxPdfDocument, DocxPdfStyle } from "../core/docx/pdf/types"
import { toDocxPdfPage } from "../core/presentation/text/page"
import { FIXTURE_ADVANCE, FIXTURE_ASCENT } from "./fixtures/presentation/textPage"
import { uprightPage } from "./fixtures/presentation/uprightPage"
import { pdfOf } from "./docxPdfFixtures"
import { RecordingCanvas } from "./presentationCanvasRecorder"

// East Asian characters of sideways (eaVert) text: a fragment flagged UPRIGHT is turned back upright about its cell.

describe("painters: upright clusters of sideways text", () => {
	it("canvas: turns an upright fragment 90° counter-clockwise about its cell's centre, and nothing else", () => {
		const ctx = new RecordingCanvas()

		paintTextPageCanvas(ctx, uprightPage(), [1, 0, 0, 1, 0, 0])

		const [upright, plain] = ctx.ops("fillText")
		// The cell's centre: half the 9 px advance along the line, (18 − 6) / 2 above the baseline at 18.
		const cx = FIXTURE_ADVANCE / 2
		const cy = FIXTURE_ASCENT - (18 - 6) / 2

		expect(upright?.args).toEqual(["日", 0, 18])
		expect(upright?.transform).toEqual([0, -1, 1, 0, cx - cy, cy + cx])
		expect(plain?.transform).toEqual([1, 0, 0, 1, 0, 0])
	})

	it("PDF: draws an upright fragment with a text matrix turned 90° counter-clockwise, and a plain one as before", async () => {
		const style: DocxPdfStyle = {
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
		const text = uprightPage()
		const document: DocxPdfDocument = {
			pages: [toDocxPdfPage(text)],
			styles: [style],
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
		const content = new TextDecoder("latin1").decode((await pdfOf(document, { deflate: null })).bytes)
		const matrices = [...content.matchAll(/\n(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm\n/g)].map(match =>
			match.slice(1, 5).map(Number)
		)

		// Text space is y-up: the page's [0 −1 1 0] turn is written 0 −1 −1 0; the plain line keeps 1 0 0 −1.
		expect(matrices).toEqual([
			[0, -1, -1, 0],
			[1, 0, 0, -1]
		])
	})
})

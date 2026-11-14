import { describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { matchPdfFont } from "../../core/pdfedit/fontMatch"
import { layoutTextOverlay } from "../../core/pdfedit/textLayout"
import { PdfOverlayError, fitOverlay, graftOverlay } from "../../dom/pdfedit/overlay"
import { nodeFontAssets } from "../sheetPdfFixtures"
import { budget } from "../timing"
import { LATIN_CONTENT, makeDocument, pageChars, pdfjsRuns, reopen, save, type PageSpec } from "./textEditFixtures"

const TIMEOUT = budget(30_000)
const ARIMO = matchPdfFont({ name: "Arimo", bold: false, italic: false, serif: false, mono: false })

// A one-page overlay of `width` × `height` points with `text` on a baseline starting at (x, y), display space.
async function overlay(width: number, height: number, text: string, x: number, y: number): Promise<Uint8Array> {
	const laid = await layoutTextOverlay({
		pageWidth: width,
		pageHeight: height,
		frame: { origin: [x, y], direction: [1, 0], width: null, lineHeight: 14 },
		style: { font: ARIMO, size: 12, color: 0 },
		text,
		assets: nodeFontAssets
	})

	return laid.bytes
}

function displaySize(document: mupdf.PDFDocument, index: number): [number, number] {
	const page = document.loadPage(index)
	const bounds = page.getBounds()

	page.destroy()
	expect(bounds[0]).toBeCloseTo(0, 6)
	expect(bounds[1]).toBeCloseTo(0, 6)

	return [bounds[2], bounds[3]]
}

async function expectLanded(page: PageSpec, x: number, y: number): Promise<void> {
	// The page's own content leaves a translation behind (no q/Q): the overlay must not inherit it.
	const document = makeDocument({ pages: [{ ...page, content: `1 0 0 1 30 30 cm ${page.content}` }, { content: LATIN_CONTENT }] })
	const [width, height] = displaySize(document, 0)

	graftOverlay(mupdf, document, 0, await overlay(width, height, "Landed", x, y))

	const bytes = save(document)
	const saved = reopen(bytes)
	const first = pageChars(saved, 0).find(char => char.c === "L")

	expect(first?.x).toBeCloseTo(x, 0)
	expect(first?.y).toBeCloseTo(y, 0)
	expect(Math.abs((first?.x ?? 0) - x)).toBeLessThanOrEqual(1)
	expect(Math.abs((first?.y ?? 0) - y)).toBeLessThanOrEqual(1)

	const run = (await pdfjsRuns(bytes, 1)).find(item => item.text.startsWith("Landed"))

	expect(Math.abs((run?.x ?? Infinity) - x)).toBeLessThanOrEqual(1)
	expect(Math.abs((run?.y ?? Infinity) - y)).toBeLessThanOrEqual(1)

	// The other page shares the first page's resources object; it never sees the overlay's name.
	expect(saved.loadPage(1).getObject().get("Resources").get("XObject").isNull()).toBe(true)
	saved.destroy()
	document.destroy()
}

describe("overlay graft", () => {
	it("lands where the overlay put it on a plain page", { timeout: TIMEOUT }, async () => {
		await expectLanded({ content: LATIN_CONTENT }, 100, 200)
	})

	it("lands where expected on a page turned by /Rotate 90 with a CropBox away from the origin", { timeout: TIMEOUT }, async () => {
		await expectLanded({ content: LATIN_CONTENT, mediaBox: [0, 0, 600, 800], cropBox: [50, 100, 550, 700], rotate: 90 }, 100, 200)
	})

	it("lands where expected on pages turned 180 and 270 degrees", { timeout: TIMEOUT }, async () => {
		await expectLanded({ content: LATIN_CONTENT, cropBox: [20, 40, 500, 800], rotate: 180 }, 60, 90)
		await expectLanded({ content: LATIN_CONTENT, mediaBox: [-100, -50, 500, 700], rotate: 270 }, 300, 400)
	})

	it("lands where expected on a page with a /UserUnit", { timeout: TIMEOUT }, async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT, userUnit: 2 }] })
		const [width, height] = displaySize(document, 0)

		expect(width).toBeCloseTo(1190, 0)
		expect(height).toBeCloseTo(1684, 0)
		document.destroy()
		await expectLanded({ content: LATIN_CONTENT, userUnit: 2 }, 500, 900)
	})

	it("stretches an overlay of another size over the page (OCR)", { timeout: TIMEOUT }, async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT, mediaBox: [0, 0, 600, 800], rotate: 90 }] })
		const [width, height] = displaySize(document, 0)
		// A page rendered at 300 dpi and read back at 72 dpi is the display size × 300 / 72 pixels, × 72 / 300 points:
		// here a stand-in twice the display size.
		const bytes = await overlay(width * 2, height * 2, "Scanned", 400, 300)

		graftOverlay(mupdf, document, 0, bytes, { toDisplay: fitOverlay(width * 2, height * 2, width, height) })

		const first = pageChars(reopen(save(document)), 0).find(char => char.c === "S" && char.size < 7)

		expect(first?.x).toBeCloseTo(200, 0)
		expect(first?.y).toBeCloseTo(150, 0)
		expect(first?.size).toBeCloseTo(6, 1)
		document.destroy()
	})

	it("names each graft apart and keeps earlier ones", { timeout: TIMEOUT }, async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const one = graftOverlay(mupdf, document, 0, await overlay(595, 842, "One", 72, 300))
		const two = graftOverlay(mupdf, document, 0, await overlay(595, 842, "Two", 72, 340))

		expect(one.name).not.toBe(two.name)

		const text = pageChars(reopen(save(document)), 0)
			.map(char => char.c)
			.join("")

		expect(text).toContain("One")
		expect(text).toContain("Two")
		expect(text).toContain("Hello brave new world")
		document.destroy()
	})

	it("refuses an overlay without a page", () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const empty = new mupdf.PDFDocument()
		const bytes = empty.saveToBuffer("").asUint8Array().slice()

		expect(() => graftOverlay(mupdf, document, 0, bytes)).toThrow(PdfOverlayError)
		empty.destroy()
		document.destroy()
	})
})

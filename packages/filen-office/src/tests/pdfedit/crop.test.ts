import { describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { contentBounds, cropPages, cropPagesToContent, outsideCropRects, pageBounds } from "../../dom/pdfedit/pages"
import { openPdf } from "../docxPdfFixtures"
import { makeMarginsPdf } from "./pageFixtures"

// Crop on a live document: /CropBox through setPageBox in view space (rotation applied), the content bounds behind
// "Remove white margins", and the outside regions handed to redaction; saved files reopened in MuPDF and pdf.js.

function open(bytes: Uint8Array): mupdf.PDFDocument {
	const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

	if (doc === null) throw new Error("not a PDF")

	doc.enableJournal()

	return doc
}

function op<T>(doc: mupdf.PDFDocument, run: () => T): T {
	doc.beginOperation("Crop")

	const result = run()

	doc.endOperation()

	return result
}

async function pdfjsView(bytes: Uint8Array, page: number): Promise<readonly number[]> {
	const pdf = await openPdf(bytes)
	const view = (await pdf.getPage(page)).view

	await pdf.loadingTask.destroy()

	return view
}

describe("crop", () => {
	it("crops by margins in view space and undoes", async () => {
		const doc = open(makeMarginsPdf())
		const result = op(doc, () => cropPages(doc, [0, 1], { left: 10, top: 20, right: 30, bottom: 40 }))

		expect([...result.touched]).toEqual([0, 1])
		expect(pageBounds(doc, 0)).toEqual([0, 0, 555, 782])
		// The crop box in PDF space: y up, so the top margin comes off y1.
		expect(doc.findPage(0).get("CropBox").toString()).toBe("[10 40 565 822]")

		doc.undo()
		expect(pageBounds(doc, 0)).toEqual([0, 0, 595, 842])
		doc.redo()
		expect(await pdfjsView(doc.saveToBuffer("garbage=compact").asUint8Array().slice(), 1)).toEqual([10, 40, 565, 822])
	})

	it("takes the margins as the page shows them on a rotated page", () => {
		const doc = open(makeMarginsPdf())

		op(doc, () => {
			doc.findPage(0).put("Rotate", 90)
		})
		op(doc, () => cropPages(doc, [0], { left: 10, top: 0, right: 0, bottom: 0 }))

		// Rotated 90° clockwise, the shown left edge is the PDF's bottom edge (y0).
		expect(doc.findPage(0).get("CropBox").toString()).toBe("[0 10 595 842]")
		expect(pageBounds(doc, 0)).toEqual([0, 0, 832, 595])
	})

	it("leaves pages alone when the margins would leave too little", () => {
		const doc = open(makeMarginsPdf())
		const result = op(doc, () => cropPages(doc, [0], { left: 300, top: 0, right: 290, bottom: 0 }))

		expect(result.touched).toEqual([])
		expect(doc.findPage(0).get("CropBox").isNull()).toBe(true)
	})

	it("finds the content bounds without the white background, and crops to them", () => {
		const doc = open(makeMarginsPdf())

		expect(contentBounds(mupdf, doc.loadPage(0))).toEqual([200, 300, 400, 500])
		expect(contentBounds(mupdf, doc.loadPage(1))).toBeNull()

		const result = op(doc, () => cropPagesToContent(mupdf, doc, [0, 1], 4))

		// The blank page keeps its box.
		expect([...result.touched]).toEqual([0])
		expect(pageBounds(doc, 0)).toEqual([0, 0, 208, 208])
	})

	it("returns the media box outside the crop for redaction, crop box included", () => {
		const doc = open(makeMarginsPdf())

		op(doc, () => cropPages(doc, [0], { left: 95, top: 0, right: 0, bottom: 0 }))

		const rects = outsideCropRects(doc, [0], { left: 0, top: 42, right: 0, bottom: 0 })

		// In view space of the cropped page: the media box starts 95 pt left of it.
		expect(rects.get(0)).toEqual([
			[-95, 0, 500, 42],
			[-95, 0 + 42, 0, 842]
		])
	})
})

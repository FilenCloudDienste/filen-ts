import { describe, expect, it } from "vitest"
import { DrawingList, ItemKind } from "../core/drawingml/displayList"
import { paintDrawingPdf } from "../core/drawingml/pdf"
import { PdfFontSet } from "../core/pdfwrite/fonts/fontSet"
import { PdfWriter } from "../core/pdfwrite/writer"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"

// A 100 x 50 rectangle filled with a two-stop 45 degree linear gradient; its axial shading's coordinates.
async function axialLine(scaled: boolean): Promise<number[]> {
	const list = new DrawingList()

	list.width = 100
	list.height = 50

	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	list.moveTo(0, 0)
	list.lineTo(100, 0)
	list.lineTo(100, 50)
	list.lineTo(0, 50)
	list.close()

	const paint = list.paint({
		kind: "linear",
		stops: { offsets: Float32Array.of(0, 1), colors: Uint32Array.of(0xff0000ff, 0x0000ffff) },
		angle: 45,
		scaled
	})

	list.addItem(ItemKind.PATH, [1, 0, 0, 1, 0, 0], 0, 0, 100, 50, firstCommand, firstCoord, paint, -1, -1, -1, 0, 0)

	const writer = await PdfWriter.create({ deterministic: true, deflate: null })
	const fonts = new PdfFontSet({ assets: nodeFontAssets, deterministic: true })
	const page = writer.beginPage(200, 200)

	await paintDrawingPdf(
		{ page, fonts, image: () => Promise.resolve(undefined), defaultFamily: "Calibri" },
		{
			width: list.width,
			height: list.height,
			commands: list.commands,
			coords: list.coords,
			itemCount: list.itemCount,
			itemFloats: list.itemFloats,
			itemInts: list.itemInts,
			paints: list.paints,
			strokes: list.strokes,
			images: list.images,
			texts: list.texts
		},
		[1, 0, 0, 1, 0, 0]
	)
	await writer.endPage(page)

	const text = Buffer.from(pdfBytes((await writer.finish()).parts)).toString("latin1")

	fonts.close()

	const coords = /\/ShadingType 2[\s\S]*?\/Coords\s*\[([^\]]*)\]/.exec(text)?.[1]

	if (coords === undefined) throw new Error("no axial shading")

	return coords.trim().split(/\s+/).map(Number)
}

describe("linear gradients in PDF", () => {
	it("keeps an unscaled angle true in pixels and skews a scaled one with the box (lin@scaled)", async () => {
		for (const scaled of [false, true]) {
			const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = await axialLine(scaled)
			const stretched = Math.atan2(100, 50)
			const angle = scaled ? (stretched * 180) / Math.PI : 45
			const length = scaled ? 100 * Math.cos(stretched) + 50 * Math.sin(stretched) : 150 * Math.SQRT1_2

			// Through the box's centre, as long as the box's projection onto the gradient line.
			expect((Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI).toBeCloseTo(angle, 2)
			expect((x0 + x1) / 2).toBeCloseTo(50, 3)
			expect((y0 + y1) / 2).toBeCloseTo(25, 3)
			expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(length, 3)
		}
	})
})

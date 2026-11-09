import { describe, expect, it } from "vitest"
import { paintDrawingCanvas } from "../core/drawingml/canvas"
import { closedCommands, commandBounds, compoundMask } from "../core/drawingml/compoundLine"
import type { DrawingData } from "../core/drawingml/data"
import { DrawingList, IDENTITY, ItemFlag, ItemKind, PathCommand, rgba, type Stroke } from "../core/drawingml/index"
import { paintDrawingPdf, type PdfDrawingData } from "../core/drawingml/pdf"
import { PdfFontSet } from "../core/pdfwrite/fonts/fontSet"
import { PdfWriter } from "../core/pdfwrite/writer"
import { RecordingCanvas, recordingSurfaces, type RecordedImage } from "./presentationCanvasRecorder"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"

function line(overrides: Partial<Stroke>): Stroke {
	return {
		width: 6,
		paint: 0,
		dash: "solid",
		customDash: null,
		cap: "flat",
		join: "miter",
		miterLimit: 8,
		compound: "sng",
		inset: false,
		...overrides
	}
}

// A 100 x 50 rectangle at (10, 20), outlined in red; closed unless `open`.
function outlined(stroke: Stroke, open = false, flags = 0): DrawingData & PdfDrawingData {
	const list = new DrawingList()

	list.width = 200
	list.height = 100

	const strokeIndex = list.stroke({ ...stroke, paint: list.paint({ kind: "solid", color: rgba("FF0000") }) })
	const command = list.commandCount
	const coord = list.coordCount

	list.moveTo(10, 20)
	list.lineTo(110, 20)
	list.lineTo(110, 70)
	list.lineTo(10, 70)

	if (!open) list.close()

	list.addItem(ItemKind.PATH, IDENTITY, 10, 20, 100, 50, command, coord, -1, strokeIndex, -1, -1, flags, 0)

	const c = list.compact()

	return {
		width: c.width,
		height: c.height,
		commands: c.commands,
		coords: c.coords,
		itemCount: c.itemCount,
		itemFloats: c.itemFloats,
		itemInts: c.itemInts,
		paints: c.paints,
		strokes: c.strokes,
		images: c.images,
		texts: c.texts,
		shadows: c.shadows
	}
}

const NO_IMAGES = { image: (): RecordedImage | undefined => undefined }

describe("compound line masks", () => {
	it("describes each compound type and inset pen as keeping and clearing strokes", () => {
		expect(compoundMask("sng", 6, false)).toBeUndefined()
		expect(compoundMask("dbl", 6, false)).toEqual({
			pen: 6,
			outer: [
				{ width: 6, keep: true },
				{ width: expect.closeTo(2, 9) as number, keep: false }
			],
			inner: null
		})
		expect(compoundMask("thickThin", 8, false)).toEqual({
			pen: 8,
			outer: [{ width: 8, keep: true }],
			inner: [
				{ width: 8, keep: true },
				{ width: 4, keep: false }
			]
		})
		expect(compoundMask("sng", 5, true)).toEqual({ pen: 10, outer: [], inner: [{ width: 10, keep: true }] })
	})

	it("finds closed command ranges and their bounds", () => {
		const { MOVE, LINE, CLOSE } = PathCommand

		expect(closedCommands([MOVE, LINE, LINE, CLOSE], 0, 4)).toBe(true)
		expect(closedCommands([MOVE, LINE, CLOSE, MOVE, LINE, CLOSE], 0, 6)).toBe(true)
		expect(closedCommands([MOVE, LINE, MOVE, LINE, CLOSE], 0, 5)).toBe(false)
		expect(closedCommands([MOVE, LINE, LINE], 0, 3)).toBe(false)
		expect(closedCommands([], 0, 0)).toBe(false)
		expect(commandBounds([MOVE, LINE, CLOSE], [5, 9, -3, 40], 0, 3, 0)).toEqual([-3, 9, 5, 40])
		expect(commandBounds([CLOSE], [], 0, 1, 0)).toBeUndefined()
	})
})

describe("compound lines on canvas", () => {
	it("draws a double line as its mask on a scratch layer, then the pen kept by it", () => {
		const ctx = new RecordingCanvas()
		const surfaces = recordingSurfaces()

		paintDrawingCanvas(ctx, outlined(line({ compound: "dbl" })), [2, 0, 0, 2, 0, 0], { ...NO_IMAGES, surface: surfaces.surface })

		const layer = surfaces.made[0]

		expect(ctx.ops("stroke")).toHaveLength(0)
		expect(layer?.ops("stroke").map(call => [call.lineWidth, call.composite])).toEqual([
			[6, "source-over"],
			[2, "destination-out"],
			[6, "source-in"]
		])
		expect(layer?.ops("stroke")[2]?.stroke).toBe("#ff0000ff")
		// The outline's device bounds: the path at scale 2, padded by the miter reach (3 * 8 + 1 local units).
		expect(layer?.ops("moveTo")[0]?.transform).toEqual([2, 0, 0, 2, 30, 10])
		expect([layer?.width, layer?.height]).toEqual([300, 200])
		expect(ctx.ops("drawImage")[0]?.args).toEqual(["surface0", -30, -10, 300, 200])
		expect(ctx.ops("drawImage")[0]?.transform).toEqual([1, 0, 0, 1, 0, 0])
	})

	it("clears the interior and draws an inset pen's inner band inside the path", () => {
		const ctx = new RecordingCanvas()
		const surfaces = recordingSurfaces()

		paintDrawingCanvas(ctx, outlined(line({ inset: true }), false, ItemFlag.EVEN_ODD), IDENTITY, {
			...NO_IMAGES,
			surface: surfaces.surface
		})

		const layer = surfaces.made[0]

		expect(layer?.ops("clip")[0]?.args).toEqual(["evenodd"])
		expect(layer?.ops("fill")[0]?.composite).toBe("destination-out")
		expect(layer?.ops("stroke").map(call => [call.lineWidth, call.composite])).toEqual([
			[12, "source-over"],
			[12, "source-in"]
		])
	})

	it("strokes an open path's inset pen centred, and every line as one pen without a scratch canvas", () => {
		const open = new RecordingCanvas()
		const surfaces = recordingSurfaces()

		paintDrawingCanvas(open, outlined(line({ inset: true }), true), IDENTITY, { ...NO_IMAGES, surface: surfaces.surface })

		expect(surfaces.made).toHaveLength(0)
		expect(open.ops("stroke").map(call => call.lineWidth)).toEqual([6])

		const plain = new RecordingCanvas()

		paintDrawingCanvas(plain, outlined(line({ compound: "tri" })), IDENTITY, NO_IMAGES)

		expect(plain.ops("stroke").map(call => call.lineWidth)).toEqual([6])
	})

	it("keeps the line's dashes on the pen only", () => {
		const ctx = new RecordingCanvas()
		const surfaces = recordingSurfaces()

		paintDrawingCanvas(ctx, outlined(line({ compound: "thinThick", dash: "dash" })), IDENTITY, {
			...NO_IMAGES,
			surface: surfaces.surface
		})

		const strokes = surfaces.made[0]?.ops("stroke") ?? []

		expect(strokes.slice(0, -1).every(call => call.dash.length === 0)).toBe(true)
		expect(strokes[strokes.length - 1]?.dash.length).toBeGreaterThan(0)
	})
})

async function pdfText(data: PdfDrawingData): Promise<string> {
	const writer = await PdfWriter.create({ deterministic: true, deflate: null })
	const fonts = new PdfFontSet({ assets: nodeFontAssets, deterministic: true })
	const page = writer.beginPage(300, 200)

	await paintDrawingPdf({ page, fonts, image: () => Promise.resolve(undefined), defaultFamily: "Calibri" }, data, [1, 0, 0, 1, 0, 0])
	await writer.endPage(page)

	const text = Buffer.from(pdfBytes((await writer.finish()).parts)).toString("latin1")

	fonts.close()

	return text
}

describe("compound lines in PDF", () => {
	it("strokes a double line's pen under a luminosity soft mask of its bands", async () => {
		const text = await pdfText(outlined(line({ compound: "dbl" })))

		expect(text).toMatch(/\/SMask\s*<<[^>]*\/S \/Luminosity/)
		expect(text).toMatch(/\/Subtype \/Form[\s\S]*?\/CS \/DeviceGray/)
		// The mask: a white stroke the pen's width, then a black one over the gap.
		expect(text).toMatch(/1 G\n6 w\n[^S]*S\n0 G\n2 w\n[^S]*S/)
		// The page: the mask set (gs) before the pen is stroked inside q/Q.
		expect(text).toMatch(/q\n\/GS\d+ gs\n[\s\S]*?6 w\n[\s\S]*?S\nQ/)
	})

	it("clears the interior for an inset pen and strokes a single centred line as before", async () => {
		const inset = await pdfText(outlined(line({ inset: true })))

		expect(inset).toMatch(/W n\n0 g\n[^f]*f\n1 G\n12 w/)

		const single = await pdfText(outlined(line({})))

		expect(single).not.toContain("/SMask")
	})
})

import { describe, expect, it } from "vitest"
import { paintDrawingCanvas } from "../core/drawingml/canvas"
import type { DrawingData } from "../core/drawingml/data"
import { DrawingList, IDENTITY, ItemKind, rgba, type DrawingText, type TextRun } from "../core/drawingml/displayList"
import { paintDrawingPdf, type PdfDrawingData } from "../core/drawingml/pdf"
import { PdfFontSet } from "../core/pdfwrite/fonts/fontSet"
import { PdfWriter } from "../core/pdfwrite/writer"
import { RECORDED_ADVANCE, RecordedGradient, RecordingCanvas, type RecordedImage } from "./presentationCanvasRecorder"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"

// Block text stretched to its rectangle (VML WordArt fitshape) in every display-list renderer.

const RUN: TextRun = {
	text: "AB",
	size: 30,
	bold: false,
	italic: false,
	underline: "none",
	strike: "noStrike",
	color: rgba("FF0000"),
	font: "Arial",
	baseline: 0,
	caps: "none",
	spacing: 0,
	lineBreak: false
}

function block(stretch: boolean, fill?: number): Extract<DrawingText, { kind: "block" }> {
	return {
		kind: "block",
		run: RUN,
		width: 180,
		height: 40,
		align: "middle",
		lineAlign: "middle",
		wrap: false,
		clip: false,
		lineLimit: false,
		trimming: "none",
		lineHeight: 40,
		ascent: 0.8,
		rtl: false,
		...(fill !== undefined && { fill }),
		...(stretch && { stretch: true })
	}
}

function drawing(stretch: boolean, gradient: boolean = false): DrawingList {
	const list = new DrawingList()

	list.width = 180
	list.height = 40

	const fill = gradient
		? list.paint({
				kind: "linear",
				stops: { offsets: Float32Array.of(0, 1), colors: Uint32Array.of(rgba("0000FF"), rgba("FF0000")) },
				angle: 45,
				scaled: false
			})
		: undefined

	list.addItem(ItemKind.TEXT, IDENTITY, 0, 0, 180, 40, 0, 0, -1, -1, list.text(block(stretch, fill)), -1, 0, 0)

	return list.compact()
}

function canvasData(list: DrawingList): DrawingData {
	return {
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
		texts: list.texts,
		shadows: list.shadows
	}
}

function pdfData(list: DrawingList): PdfDrawingData {
	return {
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
	}
}

const NO_IMAGES = { image: (): RecordedImage | undefined => undefined }

describe("stretched block text", () => {
	it("scales the canvas on x so the widest line spans the rectangle", () => {
		const natural = 2 * RECORDED_ADVANCE
		const plain = new RecordingCanvas()
		const stretched = new RecordingCanvas()

		paintDrawingCanvas(plain, canvasData(drawing(false)), IDENTITY, NO_IMAGES)
		paintDrawingCanvas(stretched, canvasData(drawing(true)), IDENTITY, NO_IMAGES)

		expect(plain.ops("fillText")[0]?.transform).toEqual([1, 0, 0, 1, 0, 0])
		expect(plain.ops("fillText")[0]?.args).toEqual(["AB", 90 - natural / 2, 32])

		const call = stretched.ops("fillText")[0]

		expect(call?.transform[0]).toBeCloseTo(180 / natural)
		expect(call?.transform.slice(1)).toEqual([0, 0, 1, 0, 0])
		// At the natural width's middle, which the scale maps onto the rectangle's.
		expect(call?.args).toEqual(["AB", 0, 32])
	})

	it("maps a linear gradient back out of the canvas stretch so it lies over the box unstretched", () => {
		const plain = new RecordingCanvas()
		const stretched = new RecordingCanvas()

		paintDrawingCanvas(plain, canvasData(drawing(false, true)), IDENTITY, NO_IMAGES)
		paintDrawingCanvas(stretched, canvasData(drawing(true, true)), IDENTITY, NO_IMAGES)

		const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = (plain.ops("fillText")[0]?.fill as RecordedGradient).args
		const call = stretched.ops("fillText")[0]
		const s = call?.transform[0] ?? 1
		const [u0 = 0, v0 = 0, u1 = 0, v1 = 0] = (call?.fill as RecordedGradient).args
		// The gradient's value at a device point: its projection onto the start-to-end line.
		const at = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number =>
			((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)

		for (const [px, py] of [
			[0, 0],
			[180, 40],
			[60, 10],
			[150, 35]
		] as const)
			expect(at(px / s, py, u0, v0, u1, v1)).toBeCloseTo(at(px, py, x0, y0, x1, y1), 6)
	})

	it("concatenates the x scale in PDF", async () => {
		const content = async (stretch: boolean): Promise<string> => {
			const writer = await PdfWriter.create({ deterministic: true, deflate: null })
			const fonts = new PdfFontSet({ assets: nodeFontAssets, deterministic: true })
			const page = writer.beginPage(200, 200)

			await paintDrawingPdf(
				{ page, fonts, image: () => Promise.resolve(undefined), defaultFamily: "Calibri" },
				pdfData(drawing(stretch)),
				[1, 0, 0, 1, 0, 0]
			)
			await writer.endPage(page)

			const text = Buffer.from(pdfBytes((await writer.finish()).parts)).toString("latin1")

			fonts.close()

			return text
		}
		const scales = (text: string): number[] =>
			Array.from(text.matchAll(/(-?[\d.]+) 0 0 1 0 0 cm/g), match => Number(match[1])).filter(value => value !== 1)

		expect(scales(await content(false))).toEqual([])

		const [scale] = scales(await content(true))

		expect(scale).toBeGreaterThan(1)
	})
})

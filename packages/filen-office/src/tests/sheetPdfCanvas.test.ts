import { describe, expect, it } from "vitest"
import { DrawingList, ItemFloat, ItemInt, ItemKind, PathCommand, rgba } from "../core/drawingml/displayList"
import { paintDrawingPdf, type PdfDrawingData } from "../core/drawingml/pdf"
import { PdfFontSet } from "../core/pdfwrite/fonts/fontSet"
import { PdfWriter } from "../core/pdfwrite/writer"
import { PdfCanvas, PdfShapeCache, canvasFont, cssColor } from "../react/sheet/print/pdfCanvas"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"

// The PDF canvas the grid's painters draw printed pages on, and the display-list painter objects and charts print
// through: what reaches the page's content stream.

async function page(draw: (canvas: PdfCanvas, shapes: PdfShapeCache) => Promise<void> | void): Promise<string> {
	const writer = await PdfWriter.create({ tagged: true, deterministic: true, deflate: null })
	const fonts = new PdfFontSet({ assets: nodeFontAssets, deterministic: true })
	const shapes = new PdfShapeCache(fonts)
	const probe = new PdfCanvas({ page: null, shapes, base: [1, 0, 0, 1, 0, 0], gray: false, tagged: true })

	await draw(probe, shapes)
	await Promise.all(probe.loads)

	const pdfPage = writer.beginPage(400, 300)
	const canvas = new PdfCanvas({ page: pdfPage, shapes, base: [1, 0, 0, 1, 0, 0], gray: false, tagged: true })

	await draw(canvas, shapes)
	canvas.flush()

	const cell = writer.open("TD")

	canvas.drawCell(7, cell)
	writer.close(cell)
	await writer.endPage(pdfPage)

	const text = Buffer.from(pdfBytes((await writer.finish()).parts)).toString("latin1")

	fonts.close()

	return text
}

describe("CSS colours and canvas fonts", () => {
	it("reads hex, rgb() and rgba() colours as 0xRRGGBBAA, anything else as black", () => {
		expect(cssColor("#a6a6a6")).toBe(0xa6a6a6ff)
		expect(cssColor("#fff")).toBe(0xffffffff)
		expect(cssColor("rgba(255, 0, 0, 0.5)")).toBe(0xff000080)
		expect(cssColor("rgb(0, 128, 255)")).toBe(0x0080ffff)
		expect(cssColor("transparent")).toBe(0)
		expect(cssColor("tomato")).toBe(0x000000ff)
	})

	it("reads a canvas font as a face request: the first family, quoted or not, its weight and style", () => {
		expect(canvasFont('italic bold 14.67px "Calibri", Carlito, Arial, sans-serif')).toEqual({
			px: 14.67,
			request: { family: "Calibri", bold: true, italic: true, slot: "hAnsi" }
		})
		expect(canvasFont("11px sans-serif").request.family).toBe("Arial")
	})
})

describe("the PDF canvas", () => {
	it("draws fills and lines as layout artifacts, clipped to the box of the clip path", async () => {
		const text = await page(canvas => {
			canvas.setTransform(1, 0, 0, 1, 10, 0)
			canvas.fillStyle = "#ff0000"
			canvas.save()
			canvas.beginPath()
			canvas.rect(0, 0, 50, 50)
			canvas.clip()
			canvas.fillRect(5, 5, 20, 10)
			canvas.restore()
			canvas.strokeStyle = "#00ff00"
			canvas.setLineDash([2, 1])
			canvas.beginPath()
			canvas.moveTo(0, 0)
			canvas.lineTo(30, 0)
			canvas.stroke()
		})

		expect(text).toContain("/Artifact <</Type /Layout>> BDC")
		expect(text).toContain("10 0 50 50 re\nW n")
		expect(text).toContain("15 5 20 10 re\nf")
		expect(text).toContain("[2 1 ] 0 d")
		expect(text).toContain("10 0 m\n40 0 l\nS")
	})

	it("keeps a cell's text and draws it as that cell's structure element, tabs as spaces", async () => {
		const text = await page(canvas => {
			canvas.font = "11px Calibri"
			canvas.content = 7
			canvas.fillText("A\tB", 5, 20)
			canvas.content = null
		})

		expect(text).toMatch(/\/TD <<\/MCID 0>> BDC/)
		expect(text).toMatch(/\/S \/TD/)
		// Three glyphs (the tab a space), two-byte codes, none of them .notdef (code 0).
		const shown = /\[\(([\s\S]*?)\)\] TJ/.exec(text)?.[1] ?? ""
		const codes = Array.from({ length: shown.length / 2 }, (_, k) => shown.charCodeAt(2 * k) * 256 + shown.charCodeAt(2 * k + 1))

		expect(codes).toHaveLength(3)
		expect(codes).not.toContain(0)
	})

	it("draws a data bar's fade as bands of its colours", async () => {
		const text = await page(canvas => {
			const fade = canvas.createLinearGradient(0, 0, 32, 0)

			fade.addColorStop(0, "#000000")
			fade.addColorStop(1, "#ffffff")
			canvas.fillStyle = fade
			canvas.fillRect(0, 0, 32, 4)
		})

		expect(text.match(/re\nf/g)?.length).toBe(32)
	})
})

describe("drawings on a PDF page", () => {
	it("fills and strokes a path through its matrix inside the drawing's placement, and draws body text", async () => {
		const list = new DrawingList()
		const first = list.commandCount

		list.commands[0] = PathCommand.MOVE
		list.commands[1] = PathCommand.LINE
		list.commands[2] = PathCommand.CLOSE
		list.commandCount = 3
		list.coords.set([0, 0, 10, 10])
		list.coordCount = 4
		list.itemCount = 2
		list.itemFloats.set([1, 0, 0, 1, 5, 5, 0, 0, 10, 10], 0)
		list.itemInts.set(
			[ItemKind.PATH, first, 3, 0, list.paint({ kind: "solid", color: rgba("336699") }), list.stroke(STROKE(list)), -1, -1, 0, 0],
			0
		)

		const run = {
			text: "Chart",
			size: 10,
			bold: false,
			italic: false,
			underline: "none",
			strike: "noStrike",
			color: rgba("000000"),
			font: "",
			baseline: 0,
			caps: "none",
			spacing: 0,
			lineBreak: false
		} as const
		const body = {
			insets: { left: 0, top: 0, right: 0, bottom: 0 },
			anchor: "t",
			anchorCenter: false,
			vertical: "horz",
			wrap: true,
			rotation: 0,
			upright: false,
			columns: 1,
			columnSpacing: 0,
			autofit: "none",
			fontScale: 1,
			lineSpacingReduction: 0
		} as const
		const paragraph = {
			align: "l",
			level: 0,
			marginLeft: 0,
			indent: 0,
			lineSpacing: 0,
			spaceBefore: 0,
			spaceAfter: 0,
			rtl: false,
			bullet: "",
			bulletFont: "",
			runs: [run],
			endSize: 10
		} as const

		list.itemFloats.set([1, 0, 0, 1, 0, 0, 0, 20, 100, 20], 10)
		list.itemInts.set([ItemKind.TEXT, 0, 0, 0, -1, -1, list.text({ kind: "body", body, paragraphs: [paragraph] }), -1, 0, 0], 10)
		list.width = 100
		list.height = 50

		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const fonts = new PdfFontSet({ assets: nodeFontAssets, deterministic: true })
		const pdfPage = writer.beginPage(200, 200)

		// The drawing as a worker answers it: no clips, so no clip table.
		const data: PdfDrawingData = {
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

		await paintDrawingPdf(
			{ page: pdfPage, fonts, image: () => Promise.resolve(undefined), defaultFamily: "Calibri" },
			data,
			[2, 0, 0, 2, 10, 10]
		)
		await writer.endPage(pdfPage)

		const text = Buffer.from(pdfBytes((await writer.finish()).parts)).toString("latin1")

		fonts.close()
		expect(text).toContain("2 0 0 2 10 10 cm")
		expect(text).toContain("1 0 0 1 5 5 cm")
		// Colour, width and dashes set before the path is built (no state operators inside a path object).
		expect(text).toContain("0.2 0.4 0.6 rg\n0 0 m\n10 10 l\nh\nf")
		expect(text).toContain("[4 3 ] 0 d\n0 0 m\n10 10 l\nh\nS")
		expect(text).toMatch(/\/F\d+ 13\.33 Tf/)
		expect(ItemFloat.WIDTH).toBe(8)
		expect(ItemInt.REF).toBe(6)
	})
})

function STROKE(list: DrawingList) {
	return {
		width: 1,
		paint: list.paint({ kind: "solid", color: rgba("000000") }),
		dash: "dash",
		customDash: null,
		cap: "flat",
		join: "miter",
		miterLimit: 8,
		compound: "sng",
		inset: false
	} as const
}

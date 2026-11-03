import { zlibSync } from "fflate"
import { describe, expect, it } from "vitest"
import { recolorPixels } from "../core/drawingml/canvas"
import { lumTransfer } from "../core/drawingml/lum"
import { DrawingList, ItemKind, type DrawingImage, type ImageTile } from "../core/drawingml/displayList"
import { paintDrawingPdf, pictureKey, pictureSource, type PdfDrawingData } from "../core/drawingml/pdf"
import { PdfFontSet } from "../core/pdfwrite/fonts/fontSet"
import type { PdfImage } from "../core/pdfwrite/page"
import { PdfWriter } from "../core/pdfwrite/writer"
import { nodePngDecoder } from "./presentationExportFixtures"
import { encodePng } from "./oracles/presentation/pixel"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"

// A 2 x 2 picture: red, green, blue and white.
const PIXELS = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255)
const PNG = encodePng({ width: 2, height: 2, data: PIXELS })

function picture(overrides: Partial<DrawingImage> = {}): DrawingImage {
	return {
		partName: "/ppt/media/image1.png",
		format: "png",
		handling: "native",
		svgPartName: undefined,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		alpha: 1,
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0,
		colorChange: null,
		...overrides
	}
}

function data(list: DrawingList): PdfDrawingData {
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

// The same picture as an 8-bit RGB PNG, which the writer embeds as it is (no decoder needed).
function rgbPng(): Uint8Array {
	const crc = (bytes: Uint8Array): number => {
		let c = 0xffffffff

		for (const byte of bytes) {
			c ^= byte

			for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
		}

		return (c ^ 0xffffffff) >>> 0
	}
	const chunk = (type: string, data: Uint8Array): number[] => {
		const body = Uint8Array.from([...type].map(c => c.charCodeAt(0)).concat(Array.from(data)))
		const out = new DataView(new ArrayBuffer(12 + data.length))

		out.setUint32(0, data.length)
		new Uint8Array(out.buffer).set(body, 4)
		out.setUint32(8 + data.length, crc(body))

		return Array.from(new Uint8Array(out.buffer))
	}
	const header = new DataView(new ArrayBuffer(13))

	header.setUint32(0, 2)
	header.setUint32(4, 2)
	header.setUint8(8, 8)
	header.setUint8(9, 2)

	const rows = Uint8Array.of(0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255)

	return Uint8Array.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10,
		...chunk("IHDR", new Uint8Array(header.buffer)),
		...chunk("IDAT", zlibSync(rows)),
		...chunk("IEND", new Uint8Array(0))
	])
}

// A 100 x 50 rectangle filled with the picture (tiled when `tile` is given), as an uncompressed PDF's text; without
// `decoder`, a writer that can only embed pictures as they are.
async function painted(image: DrawingImage, tile?: ImageTile, decoder: boolean = true): Promise<string> {
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

	const ref = list.image(image)
	const paint = list.paint({ kind: "image", image: ref, stretch: undefined, tile })

	list.addItem(ItemKind.PATH, [1, 0, 0, 1, 0, 0], 0, 0, 100, 50, firstCommand, firstCoord, paint, -1, -1, -1, 0, 0)

	const writer = await PdfWriter.create({ deterministic: true, deflate: null, ...(decoder ? { decoder: nodePngDecoder } : {}) })
	const bytes = decoder ? PNG : rgbPng()
	const fonts = new PdfFontSet({ assets: nodeFontAssets, deterministic: true })
	const page = writer.beginPage(200, 200)
	const images = new Map<string, Promise<PdfImage>>()

	await paintDrawingPdf(
		{
			page,
			fonts,
			// As the exports do: the picture's bytes through pictureSource, shared by pictureKey.
			image: entry => {
				const part = entry.partName ?? ""
				const key = pictureKey(entry, part)
				const held = images.get(key) ?? writer.image(pictureSource(entry, bytes, part))

				images.set(key, held)

				return held
			},
			defaultFamily: "Calibri"
		},
		data(list),
		[1, 0, 0, 1, 0, 0]
	)
	await writer.endPage(page)

	const text = Buffer.from(pdfBytes((await writer.finish()).parts)).toString("latin1")

	fonts.close()

	return text
}

function recolored(image: DrawingImage): string {
	const pixels = new Uint8ClampedArray(PIXELS)

	recolorPixels(pixels, image)

	const rgb: number[] = []

	for (let k = 0; k < pixels.length; k += 4) rgb.push(pixels[k] ?? 0, pixels[k + 1] ?? 0, pixels[k + 2] ?? 0)

	return String.fromCharCode(...rgb)
}

const TILE: ImageTile = { tx: 0, ty: 0, sx: 1, sy: 1, flip: "none", align: "tl", width: 10, height: 5, matrix: [1, 0, 0, 1, 0, 0] }

describe("picture fills in PDF", () => {
	it("repeats a tiled picture through a tiling pattern of the tile's size", async () => {
		const text = await painted(picture(), TILE)

		expect(text).toMatch(/\/PatternType 1/u)
		expect(text).toMatch(/\/XStep 10\b/u)
		expect(text).toMatch(/\/YStep 5\b/u)
		expect(text).toMatch(/\/Pattern cs/u)
		// The page names the pattern among its resources; the picture is embedded once.
		expect(text).toMatch(/\/Pattern <<\s*\/P\d+ \d+ 0 R/u)
		expect(text.match(/\/Subtype \/Image/gu)?.length).toBe(1)
	})

	it("doubles a mirrored tile's cell and draws the picture once per mirror", async () => {
		const text = await painted(picture(), { ...TILE, flip: "xy" })

		expect(text).toMatch(/\/XStep 20\b/u)
		expect(text).toMatch(/\/YStep 10\b/u)
		expect(text.match(/\/Im\d+ Do/gu)?.length).toBe(4)
	})

	it("draws an explicit tile marked clamp once, without a pattern", async () => {
		const text = await painted(picture(), { ...TILE, clamp: true })

		expect(text).not.toMatch(/\/PatternType/u)
		expect(text.match(/\/Im\d+ Do/gu)?.length).toBe(1)
	})

	it.each([
		["grayscale", picture({ grayscale: true })],
		["bi-level", picture({ biLevel: 0.5 })],
		["duotone", picture({ duotone: [0x000080ff, 0xffff00ff] })],
		["brightness and contrast", picture({ brightness: -0.3, contrast: 0.2 })],
		["colour change", picture({ colorChange: [0xff0000ff, 0x00ff00ff] })]
	])("embeds the %s picture with its pixels recoloured as the screen draws them", async (_name, image) => {
		const text = await painted(image)

		expect(text).toContain(recolored(image))
		// The recoloured picture replaces the original: one image on the page.
		expect(text.match(/\/Im\d+ Do/gu)?.length).toBe(1)
	})

	it("keeps a washed-out picture legible: Office's Washout lightens the dark blue of a page's waves to a pale blue", () => {
		// a:lum bright="70000" contrast="-70000", as LibreOffice 7.5 draws it: (1, 82, 148) becomes (217, 241, 254).
		const pixels = Uint8ClampedArray.of(1, 82, 148, 255)

		recolorPixels(pixels, picture({ brightness: 0.7, contrast: -0.7 }))

		expect(Math.abs((pixels[0] ?? 0) - 217)).toBeLessThanOrEqual(8)
		expect(Math.abs((pixels[1] ?? 0) - 241)).toBeLessThanOrEqual(8)
		expect(Math.abs((pixels[2] ?? 0) - 254)).toBeLessThanOrEqual(8)
	})

	it("scales contrast about the middle grey, steeper above zero by its reciprocal", () => {
		expect(lumTransfer(0, -0.5)).toEqual([0.5, 0.25])
		expect(lumTransfer(0, 0.5)).toEqual([2, -0.5])
		expect(lumTransfer(0.2, 0)).toEqual([1, 0.2])
	})

	it("draws a recoloured picture unchanged where nothing can decode it, rather than leaving it out", async () => {
		const text = await painted(picture({ grayscale: true }), undefined, false)

		expect(text.match(/\/Im\d+ Do/gu)?.length).toBe(1)
		expect(text).toMatch(/\/Filter \/FlateDecode/u)
	})

	it("recolours a tiled picture too", async () => {
		const image = picture({ duotone: [0x000080ff, 0xffff00ff] })
		const text = await painted(image, TILE)

		expect(text).toMatch(/\/PatternType 1/u)
		expect(text).toContain(recolored(image))
	})
})

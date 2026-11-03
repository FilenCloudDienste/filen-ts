import { describe, expect, it } from "vitest"
import { DrawingList, ItemKind } from "../core/drawingml/displayList"
import { paintDrawingPdf, type PdfDrawingData } from "../core/drawingml/pdf"
import { PdfFontSet } from "../core/pdfwrite/fonts/fontSet"
import { ByteWriter } from "../core/pdfwrite/bytes"
import { meshStream } from "../core/pdfwrite/shading"
import { PdfWriter } from "../core/pdfwrite/writer"
import { nodeFontAssets, pdfBytes } from "./sheetPdfFixtures"

// Two triangles of a Gouraud mesh: red, green, blue corners, then a uniform grey one.
const POINTS = Float32Array.of(0, 0, 100, 0, 0, 50, 100, 0, 100, 50, 0, 50)
const COLORS = Uint32Array.of(0xff0000ff, 0x00ff00ff, 0x0000ffff, 0x808080ff, 0x808080ff, 0x808080ff)

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

async function painted(colors: Uint32Array, ramp: boolean, copies = 1, points: Float32Array = POINTS): Promise<string> {
	const list = new DrawingList()

	list.width = 100
	list.height = 50

	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	for (let t = 0; t < 2; t++) {
		list.moveTo(POINTS[t * 6] ?? 0, POINTS[t * 6 + 1] ?? 0)
		list.lineTo(POINTS[t * 6 + 2] ?? 0, POINTS[t * 6 + 3] ?? 0)
		list.lineTo(POINTS[t * 6 + 4] ?? 0, POINTS[t * 6 + 5] ?? 0)
		list.close()
	}

	// Each copy its own paint with equal arrays (as every slide showing one master's scene has).
	for (let copy = 0; copy < copies; copy++) {
		const paint = list.paint({
			kind: "shaded",
			points: points.slice(),
			colors: colors.slice(),
			ramp: ramp ? { center: 0xffffffff, offsets: null, colors: null, positions: null, factors: null, focus: 0 } : null
		})

		list.addItem(ItemKind.PATH, [1, 0, 0, 1, 0, 0], 0, 0, 100, 50, firstCommand, firstCoord, paint, -1, -1, -1, 0, 0)
	}

	const writer = await PdfWriter.create({ deterministic: true, deflate: null })
	const fonts = new PdfFontSet({ assets: nodeFontAssets, deterministic: true })
	const page = writer.beginPage(200, 200)

	await paintDrawingPdf(
		{ page, fonts, image: () => Promise.resolve(undefined), defaultFamily: "Calibri" },
		data(list),
		[1, 0, 0, 1, 0, 0]
	)
	await writer.endPage(page)

	const text = Buffer.from(pdfBytes((await writer.finish()).parts)).toString("latin1")

	fonts.close()

	return text
}

describe("Gouraud meshes in PDF", () => {
	it("writes each triangle's corners and colours as a free-form mesh at the fewest coordinate bits it needs", () => {
		const stream = meshStream(POINTS, COLORS)

		if (stream === undefined) throw new Error("refused")

		// 1/4096 of a 100-unit mesh of 50-unit triangles: 12 bits, so a corner is a flag, three bytes of coordinates and
		// three components.
		expect(stream.bitsPerCoordinate).toBe(12)
		expect(stream.decode).toEqual([0, 100, 0, 50, 0, 1, 0, 1, 0, 1])
		expect(stream.data.length).toBe(6 * 7)
		// The first corner: flag 0 at (0, 0) in red; the second at (100, 0), its x the coordinate range's top.
		expect(Array.from(stream.data.subarray(0, 7))).toEqual([0, 0, 0, 0, 255, 0, 0])
		expect(Array.from(stream.data.subarray(7, 14))).toEqual([0, 255, 240, 0, 0, 255, 0])
	})

	it("takes more bits for a mesh of small triangles, so each keeps its shape", () => {
		const small = Float32Array.of(0, 0, 100_000, 0, 0, 100_000, 10, 10, 11, 10, 10, 11)
		const stream = meshStream(small, COLORS)

		expect(stream?.bitsPerCoordinate).toBe(24)
		expect(stream?.data.length).toBe(6 * 10)
	})

	it("refuses a mesh whose bounds are no page geometry", () => {
		expect(
			meshStream(
				POINTS.map(value => value * 1e30 - 3e30),
				COLORS
			)
		).toBeUndefined()
	})

	it("paints a plain mesh as a type 4 shading with no clip path, the shading being its own outline", async () => {
		const text = await painted(COLORS, false)

		expect(text).toMatch(/\/ShadingType 4/)
		expect(text).toMatch(/\/BitsPerFlag 8/)
		expect(text).toMatch(/\/Sh\d+ sh/)
		expect(text).not.toMatch(/W n/)
	})

	it("applies a mesh's own transparency through its graphics state", async () => {
		const half = COLORS.map(color => ((color & 0xffffff00) | 0x80) >>> 0)

		expect(await painted(half, false)).toMatch(/\/ca 0\.5/)
	})

	it("keeps drawing a ramped mesh (a path gradient's centre falloff) in its mean colour", async () => {
		const text = await painted(COLORS, true)

		expect(text).not.toMatch(/\/ShadingType 4/)
	})

	it("writes a mesh painted many times as one shading", async () => {
		const text = await painted(COLORS, false, 5)

		expect(text.match(/\/ShadingType 4/g)).toHaveLength(1)
		expect(text.match(/\/Sh\d+ sh/g)).toHaveLength(5)
	})

	it("paints a mesh at bounds no page has in its mean colour, with no oversized number in the file", async () => {
		const text = await painted(
			COLORS,
			false,
			1,
			POINTS.map(value => value * 1e30 - 3e30)
		)

		expect(text).not.toMatch(/\/ShadingType 4/)
		expect(text).not.toMatch(/\d{11}/)
	})

	it("writes an integer past the safe range as a bounded real, every digit within the writer's reservation", () => {
		const out = new ByteWriter(16)

		out.ascii("x".repeat(14)).int(-3e30).space().int(123456789012345)

		expect(new TextDecoder().decode(out.view())).toBe(`${"x".repeat(14)}-1000000000 123456789012345`)
	})
})

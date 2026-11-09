import { describe, expect, it } from "vitest"
import { rampColor, shadeRaster } from "../core/drawingml/shade"
import {
	DrawingList,
	IDENTITY,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	type DrawingImage,
	type DrawingText,
	type Paint,
	type ShadeRamp
} from "../core/drawingml/displayList"
import { encodePng } from "../core/metafile/dib"
import { effectImage } from "../core/metafile/effects"
import { expandMetafiles } from "../core/metafile/index"
import { combineRects, normalizeRects } from "../core/metafile/region"
import {
	ByteWriter,
	EmfBuilder,
	WmfBuilder,
	bounds,
	brush,
	converted,
	dib24,
	emf,
	glyphs,
	plusHeader,
	plusRecord,
	rectangle,
	wmf
} from "./metafileFixtures"

const free = (): void => undefined

function paintOf(list: DrawingList, item: number): Paint | undefined {
	return list.paints[list.itemInt(item, ItemInt.FILL)]
}

function stretchDibits(
	info: Uint8Array,
	bits: Uint8Array,
	rop: number,
	width: number = 500,
	height: number = 500
): (writer: ByteWriter) => void {
	return writer =>
		writer
			.i32(0)
			.i32(0)
			.i32(0)
			.i32(0)
			.i32(0)
			.i32(0)
			.i32(0)
			.i32(0)
			.i32(2)
			.i32(2)
			.u32(80)
			.u32(info.length)
			.u32(80 + info.length)
			.u32(bits.length)
			.u32(0)
			.u32(rop)
			.i32(width)
			.i32(height)
			.raw(info)
			.raw(bits)
}

function blendOf(list: DrawingList, item: number): number {
	return list.itemInt(item, ItemInt.FLAGS) & ItemFlag.BLEND_MASK
}

describe("rectangle regions", () => {
	it("normalises overlapping rectangles into disjoint bands and combines them exactly", () => {
		const a = normalizeRects([0, 0, 10, 10, 5, 5, 15, 15], free)

		// Three bands: the top of the first, the overlap row, the bottom of the second.
		expect(Array.from(a)).toEqual([0, 0, 10, 5, 0, 5, 15, 10, 5, 10, 15, 15])

		const b = normalizeRects([5, 0, 20, 10], free)

		expect(Array.from(combineRects(a, b, "and", free))).toEqual([5, 0, 10, 5, 5, 5, 15, 10])
		expect(Array.from(combineRects(a, b, "diff", free))).toEqual([0, 0, 5, 10, 5, 10, 15, 15])
		expect(Array.from(combineRects(a, b, "xor", free))).toEqual([0, 0, 5, 5, 10, 0, 20, 5, 0, 5, 5, 10, 15, 5, 20, 10, 5, 10, 15, 15])
		expect(Array.from(combineRects(normalizeRects([0, 0, 10, 10], free), normalizeRects([10, 0, 20, 10], free), "or", free))).toEqual([
			0, 0, 20, 10
		])
	})
})

describe("clip regions", () => {
	it("subtracts rectangles exactly (ExcludeClipRect) and unites regions (EXTSELECTCLIPRGN OR)", () => {
		const builder = brush(emf(), 1, 0x0000ff)
			.record(30, writer => writer.i32(0).i32(0).i32(1000).i32(1000))
			.record(29, writer => writer.i32(0).i32(0).i32(500).i32(1000))

		rectangle(builder, 0, 0, 1000, 1000)

		const list = converted(builder.build()).list
		const clip = list.clips[list.itemClip(0)]

		// The right half: one rectangle region, no even-odd trick.
		expect(clip?.add).toBeUndefined()
		expect(clip?.evenOdd).toBe(false)
		expect(bounds(list, 0)).toEqual([48, 0, 96, 96])
	})

	it("keeps a path region minus a rectangle exact as a boolean region", () => {
		const builder = brush(emf(), 1, 0x0000ff)
			.record(59)
			.record(42, writer => writer.i32(0).i32(0).i32(1000).i32(1000))
			.record(60)
			.record(67, writer => writer.u32(5))
			.record(29, writer => writer.i32(0).i32(0).i32(500).i32(1000))

		rectangle(builder, 0, 0, 1000, 1000)

		const list = converted(builder.build()).list
		const clip = list.clips[list.itemClip(0)]

		expect(clip?.add).toHaveLength(1)
		expect(clip?.subtract).toHaveLength(1)
	})

	it("moves clips with OffsetClipRgn", () => {
		const builder = brush(emf(), 1, 0x0000ff)
			.record(30, writer => writer.i32(0).i32(0).i32(500).i32(500))
			.record(26, writer => writer.i32(500).i32(0))

		rectangle(builder, 0, 0, 1000, 1000)

		expect(bounds(converted(builder.build()).list, 0)).toEqual([48, 0, 96, 48])
	})

	it("builds an EMF+ path's clip geometry once for repeated SetClipPath", () => {
		const path = plusRecord(0x4008, 0x0300, writer =>
			writer.u32(0xdbc01002).u32(3).u32(0).f32(0).f32(0).f32(10).f32(0).f32(10).f32(10).u8(0).u8(1).u8(0x81).pad(4)
		)
		const fill = plusRecord(0x400a, 0x8000, writer => writer.u32(0xff000000).u32(1).f32(0).f32(0).f32(48).f32(48))
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([path, plusRecord(0x4033, 0), fill, plusRecord(0x4031, 0), plusRecord(0x4033, 0), fill])
				.build()
		).list
		const first = list.clips[list.itemClip(0)]
		const second = list.clips[list.itemClip(1)]

		expect(first?.firstCommand).toBe(second?.firstCommand)
		expect(list.itemClip(0)).not.toBe(list.itemClip(1))
	})
})

describe("bitmaps and raster operations", () => {
	it("composites AND, OR and XOR blits and inverts for NOTSRCCOPY", () => {
		const { info, bits } = dib24(2, 2, 0x00ff00)
		const builder = emf()

		for (const rop of [0x008800c6, 0x00ee0086, 0x00660046, 0x00330008]) builder.record(81, stretchDibits(info, bits, rop))

		const list = converted(builder.build()).list

		expect([0, 1, 2, 3].map(item => blendOf(list, item))).toEqual([
			ItemFlag.BLEND_MULTIPLY,
			ItemFlag.BLEND_LIGHTEN,
			ItemFlag.BLEND_DIFFERENCE,
			0
		])
		// The inverted copy is decoded and re-encoded.
		expect(list.images[list.itemInt(3, ItemInt.REF)]?.format).toBe("png")
	})

	it("inverts the destination for DSTINVERT and before SRCERASE", () => {
		const { info, bits } = dib24(2, 2, 0x00ff00)
		const builder = emf()
			.record(76, writer => {
				writer.i32(0).i32(0).i32(0).i32(0).i32(0).i32(0).i32(1000).i32(1000).u32(0x00550009).i32(0).i32(0)

				for (let k = 0; k < 6; k++) writer.f32(k === 0 || k === 3 ? 1 : 0)

				writer.u32(0).u32(0).u32(0).u32(0).u32(0).u32(0)
			})
			.record(81, stretchDibits(info, bits, 0x00440328))
		const list = converted(builder.build()).list

		expect(list.kind(0)).toBe(ItemKind.PATH)
		expect(blendOf(list, 0)).toBe(ItemFlag.BLEND_DIFFERENCE)
		expect(paintOf(list, 0)).toEqual({ kind: "solid", color: 0xffffffff })
		expect(blendOf(list, 1)).toBe(ItemFlag.BLEND_DIFFERENCE)
		expect(list.kind(2)).toBe(ItemKind.IMAGE)
		expect(blendOf(list, 2)).toBe(ItemFlag.BLEND_MULTIPLY)
	})

	it("passes PNG bitmaps through without a colour table and refuses dimension bombs", () => {
		const png = encodePng(new Uint8Array(4).fill(255), 1, 1)
		const pngInfo = new ByteWriter().u32(40).i32(1).i32(1).u16(1).u16(0).u32(5).u32(png.length).u32(0).u32(0).u32(0).u32(0).done()
		const bomb = new ByteWriter()
			.u32(40)
			.i32(40_000)
			.i32(40_000)
			.u16(1)
			.u16(8)
			.u32(1)
			.u32(4)
			.u32(0)
			.u32(0)
			.u32(2)
			.u32(0)
			.u32(0xff0000)
			.u32(0xff00)
			.done()
		const result = converted(
			emf()
				.record(81, stretchDibits(pngInfo, png, 0x00cc0020))
				.record(81, stretchDibits(bomb, Uint8Array.of(0, 1), 0x00cc0020))
				.build()
		)

		expect(result.list.itemCount).toBe(1)
		expect(result.list.images.every(image => image.format === "png")).toBe(true)
		expect(result.unsupported).toBe(1)
	})

	it("tiles DIB pattern brushes in device pixels and draws mono brushes in the text and background colours", () => {
		const { info, bits } = dib24(4, 2, 0x112233)
		const mono = new ByteWriter()
			.u32(40)
			.i32(8)
			.i32(1)
			.u16(1)
			.u16(1)
			.u32(0)
			.u32(4)
			.u32(0)
			.u32(0)
			.u32(2)
			.u32(0)
			.u32(0)
			.u32(0xffffff)
			.done()
		const builder = emf()
			.record(94, writer =>
				writer
					.u32(1)
					.u32(0)
					.u32(32)
					.u32(info.length)
					.u32(32 + info.length)
					.u32(bits.length)
					.raw(info)
					.raw(bits)
			)
			.record(37, writer => writer.u32(1))
			.record(37, writer => writer.u32(0x80000008))

		rectangle(builder, 0, 0, 1000, 1000)
		builder
			.record(93, writer =>
				writer
					.u32(2)
					.u32(0)
					.u32(32)
					.u32(mono.length)
					.u32(32 + mono.length)
					.u32(4)
					.raw(mono)
					.raw([0xf0, 0, 0, 0])
			)
			.record(37, writer => writer.u32(2))
			.record(24, writer => writer.u32(0x0000ff))
		rectangle(builder, 0, 0, 1000, 1000)

		const list = converted(builder.build()).list
		const dib = paintOf(list, 0)
		const monoPaint = paintOf(list, 1)

		expect(dib?.kind === "image" && dib.tile).toMatchObject({ width: 4, height: 2, matrix: [1, 0, 0, 1, 0, 0] })
		expect(monoPaint?.kind === "image" && monoPaint.tile).toMatchObject({ width: 8, height: 1 })
		expect(list.images.map(image => image.format)).toEqual(["bmp", "png"])
	})

	it("shades gradient rectangles as linear gradients and triangles as shaded paints", () => {
		const builder = emf().record(118, writer => {
			writer.i32(0).i32(0).i32(0).i32(0).u32(2).u32(1).u32(0)
			writer.i32(0).i32(0).u16(0xff00).u16(0).u16(0).u16(0)
			writer.i32(1000).i32(500).u16(0).u16(0).u16(0xff00).u16(0)
			writer.u32(0).u32(1)
		})

		builder.record(118, writer => {
			writer.i32(0).i32(0).i32(0).i32(0).u32(3).u32(1).u32(2)
			writer.i32(0).i32(0).u16(0xff00).u16(0).u16(0).u16(0)
			writer.i32(1000).i32(0).u16(0).u16(0xff00).u16(0).u16(0)
			writer.i32(0).i32(1000).u16(0).u16(0).u16(0xff00).u16(0)
			writer.u32(0).u32(1).u32(2)
		})

		const list = converted(builder.build()).list
		const linear = paintOf(list, 0)
		const tile = paintOf(list, 1)

		expect(linear).toMatchObject({ kind: "gradient", type: "linear", matrix: [96, 0, 0, 48, 0, 0] })
		// A shaded paint the renderer rasterises: three vertices with their colours, in output space.
		expect(tile?.kind).toBe("shaded")
		expect(tile?.kind === "shaded" && Array.from(tile.points)).toEqual([0, 0, 96, 0, 0, 96])
		expect(tile?.kind === "shaded" && Array.from(tile.colors)).toEqual([0xff0000ff, 0x00ff00ff, 0x0000ffff])
		expect(bounds(list, 1)).toEqual([0, 0, 96, 96])
	})
})

describe("WMF specifics", () => {
	it("maps the window onto a viewport the records may replace", () => {
		const builder = wmf()
			.record(0x103, [8])
			.record(0x20e, [24, 48])
			.recordBytes(0x2fc, new ByteWriter().u16(0).u32(0xff).u16(0).done())
			.record(0x12d, [0])
			.record(0x41b, [720, 1440, 0, 0])

		expect(bounds(converted(builder.build([0, 0, 1440, 720])).list, 0)).toEqual([-0.5, -0.5, 48.5, 24.5])
	})

	it("draws the EMF a WMF carries in its comments instead of the WMF records", () => {
		const inner = rectangle(brush(emf(), 1, 0x00ff00), 0, 0, 500, 500).build()
		const half = Math.ceil(inner.length / 2)
		const chunk = (part: Uint8Array): Uint8Array =>
			new ByteWriter()
				.u16(0x000f)
				.u16(34 + part.length)
				.u32(0x43464d57)
				.u32(1)
				.u32(0x10000)
				.u16(0)
				.u32(0)
				.u32(2)
				.u32(part.length)
				.u32(inner.length - part.length)
				.u32(inner.length)
				.raw(part)
				.done()
		const bytes = wmf()
			.recordBytes(0x626, chunk(inner.subarray(0, half)))
			.recordBytes(0x626, chunk(inner.subarray(half)))
			.record(0x41b, [720, 1440, 0, 0])
			.build([0, 0, 1440, 720])
		const result = converted(bytes)

		expect(result.format).toBe("emf")
		expect(result.list.paints[result.list.itemInt(0, ItemInt.FILL)]).toEqual({ kind: "solid", color: 0x00ff00ff })
	})

	it("draws monochrome Bitmap16 pattern brushes", () => {
		const params = new ByteWriter().i16(0).i16(8).i16(2).i16(2).u8(1).u8(1).raw(new Uint8Array(22)).raw([0xaa, 0, 0x55, 0]).done()
		const list = converted(
			wmf().recordBytes(0x1f9, params).record(0x12d, [0]).record(0x41b, [720, 1440, 0, 0]).build([0, 0, 1440, 720])
		).list
		const paint = paintOf(list, 0)

		expect(paint?.kind === "image" && paint.tile).toMatchObject({ width: 8, height: 2 })
	})
})

function brushObject(id: number, body: (writer: ByteWriter) => void): Uint8Array {
	return plusRecord(0x4008, 0x0100 | id, writer => {
		writer.u32(0xdbc01002)
		body(writer)
	})
}

function fillRect(brushId: number, x: number, y: number, w: number, h: number): Uint8Array {
	return plusRecord(0x400a, 0, writer => writer.u32(brushId).u32(1).f32(x).f32(y).f32(w).f32(h))
}

describe("EMF+ paints, pens and text", () => {
	it("draws linear gradients in drawing space with their wrap mode", () => {
		const gradient = brushObject(0, writer =>
			writer.u32(4).u32(0).u32(0).f32(0).f32(0).f32(10).f32(10).u32(0xffff0000).u32(0xff0000ff).u32(0).u32(0)
		)
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([gradient, fillRect(0, 0, 0, 20, 10)])
				.build()
		).list

		expect(paintOf(list, 0)).toMatchObject({ kind: "gradient", type: "linear", spread: "repeat", matrix: [10, 0, 0, 10, 0, 0] })
	})

	it("draws elliptical path gradients as focused radial gradients and polygons as shaded tiles", () => {
		const k = 0.5523
		const ellipse = (writer: ByteWriter): void => {
			const points = [
				10,
				5,
				10,
				5 + 5 * k,
				5 + 5 * k,
				10,
				5,
				10,
				5 - 5 * k,
				10,
				0,
				5 + 5 * k,
				0,
				5,
				0,
				5 - 5 * k,
				5 - 5 * k,
				0,
				5,
				0,
				5 + 5 * k,
				0,
				10,
				5 - 5 * k,
				10,
				5
			]
			const path = new ByteWriter().u32(0xdbc01002).u32(13).u32(0)

			for (const value of points) path.f32(value)

			path.u8(0)

			for (let n = 0; n < 12; n++) path.u8(n === 11 ? 0x83 : 3)

			path.pad(4)

			const bytes = path.done()

			writer.u32(bytes.length).raw(bytes)
		}
		const radial = brushObject(0, writer => {
			writer.u32(3).u32(1).u32(0).u32(0xffffffff).f32(7).f32(5).u32(1).u32(0xff000000)
			ellipse(writer)
		})
		const polygon = brushObject(1, writer => {
			writer.u32(3).u32(0).u32(0).u32(0xffffffff).f32(5).f32(5).u32(3).u32(0xffff0000).u32(0xff00ff00).u32(0xff0000ff)
			writer.u32(3).f32(0).f32(0).f32(10).f32(0).f32(5).f32(10)
		})
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([radial, polygon, fillRect(0, 0, 0, 10, 10), fillRect(1, 0, 0, 10, 10)])
				.build()
		).list
		const first = paintOf(list, 0)
		const second = paintOf(list, 1)

		expect(first).toMatchObject({ kind: "gradient", type: "radial", matrix: [5, 0, 0, 5, 5, 5] })
		expect(first?.kind === "gradient" && first.focus?.[0]).toBeCloseTo(0.4)
		expect(first?.kind === "gradient" && Array.from(first.stops.colors)).toEqual([0xffffffff, 0x000000ff])
		// A fan of three triangles from the centre point, the centre colour first.
		expect(second?.kind === "shaded" && second.points.length).toBe(18)
		expect(second?.kind === "shaded" && second.colors[0]).toBe(0xffffffff)
		expect(second?.kind === "shaded" && second.ramp?.center).toBe(0xffffffff)
	})

	it("tiles texture brushes with their wrap mode's mirroring", () => {
		const texture = brushObject(0, writer =>
			writer.u32(2).u32(0).u32(3).u32(0xdbc01002).u32(1).i32(2).i32(1).i32(8).u32(0x0026200a).u32(0).raw(new Uint8Array(8).fill(200))
		)
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([texture, fillRect(0, 0, 0, 10, 10)])
				.build()
		).list
		const paint = paintOf(list, 0)

		expect(paint?.kind === "image" && paint.tile).toMatchObject({ flip: "xy", width: 2, height: 1 })
	})

	it("expands anchor caps into filled geometry", () => {
		// A pen with an arrow anchor at its start and a round end, then a line.
		const pen = plusRecord(0x4008, 0x0200, writer =>
			writer.u32(0xdbc01002).u32(0).u32(0x06).u32(0).f32(2).u32(0x14).u32(2).u32(0xdbc01002).u32(0).u32(0xff000000)
		)
		const line = plusRecord(0x400d, 0, writer => writer.u32(2).f32(10).f32(10).f32(40).f32(10))
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([pen, line])
				.build()
		).list

		expect(list.itemCount).toBe(2)
		expect(list.strokes[list.itemInt(0, ItemInt.STROKE)]?.cap).toBe("flat")
		expect(list.itemInt(1, ItemInt.FILL)).toBeGreaterThanOrEqual(0)
		// The arrow is 4/sqrt(3) widths across, the round cap reaches half a width past the end.
		expect(bounds(list, 1)).toEqual([10, 7.69, 41, 12.31])
	})

	it("lays DrawString out as block text per its string format", () => {
		const font = plusRecord(0x4008, 0x0602, writer => writer.u32(0xdbc01002).f32(10).u32(2).i32(1).u32(0).u32(5).utf16("Arial"))
		const format = plusRecord(0x4008, 0x0703, writer => {
			writer.u32(0xdbc01002).u32(0x2000).u32(0).u32(1).u32(2)

			for (let k = 0; k < 7; k++) writer.u32(0)

			writer.u32(4).u32(0).u32(0)
		})
		const text = plusRecord(0x401c, 0x8002, writer =>
			writer.u32(0xff000000).u32(3).u32(11).f32(5).f32(5).f32(40).f32(20).utf16("Hello world")
		)
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([font, format, text])
				.build()
		).list
		const block = list.texts[0]

		expect(block).toMatchObject({
			kind: "block",
			width: 40,
			height: 20,
			align: "middle",
			lineAlign: "end",
			wrap: true,
			clip: true,
			lineLimit: true,
			trimming: "ellipsisWord"
		})
		expect(block?.kind === "block" && block.run).toMatchObject({ text: "Hello world", bold: true })
	})

	it("pads DrawString without a format by 1/6 em per side and clips at the full layout rectangle", () => {
		const font = plusRecord(0x4008, 0x0602, writer => writer.u32(0xdbc01002).f32(12).u32(2).i32(0).u32(0).u32(5).utf16("Arial"))
		// Format id 9 names no object: GDI+ falls back to its generic default format.
		const text = plusRecord(0x401c, 0x8002, writer => writer.u32(0xff000000).u32(9).u32(2).f32(5).f32(5).f32(40).f32(20).utf16("Hi"))
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([font, text])
				.build()
		).list
		const block = list.texts[0]

		expect(block).toMatchObject({ kind: "block", width: 36, height: 20, clip: false })
		expect(list.itemFloat(0, ItemFloat.E)).toBeCloseTo(7)
		expect(list.itemFloat(0, ItemFloat.F)).toBeCloseTo(5)
		expect(list.itemClip(0)).toBeGreaterThanOrEqual(0)
	})

	it("reads DrawString margins from the string format and lays vertical text down the layout rectangle", () => {
		const font = plusRecord(0x4008, 0x0602, writer => writer.u32(0xdbc01002).f32(12).u32(2).i32(0).u32(0).u32(5).utf16("Arial"))
		const format = (flags: number, leading: number, trailing: number): Uint8Array =>
			plusRecord(0x4008, 0x0703, writer => {
				writer.u32(0xdbc01002).u32(flags).u32(0).u32(0).u32(0).u32(0).u32(0).f32(0).u32(0).f32(leading).f32(trailing).f32(1)
				writer.u32(0).u32(0).u32(0)
			})
		const text = plusRecord(0x401c, 0x8002, writer => writer.u32(0xff000000).u32(3).u32(2).f32(5).f32(5).f32(40).f32(20).utf16("Hi"))
		const draw = (records: Uint8Array): ReturnType<typeof converted>["list"] =>
			converted(
				new EmfBuilder()
					.plus([plusHeader(false)])
					.plus([font, records, text])
					.build()
			).list
		// RTL puts the leading margin on the right.
		const rtl = draw(format(0x1, 0.5, 0.25))

		expect(rtl.texts[0]).toMatchObject({ kind: "block", width: 31, rtl: true })
		expect(rtl.itemFloat(0, ItemFloat.E)).toBeCloseTo(8)

		const vertical = draw(format(0x2, 0, 0))

		expect(vertical.texts[0]).toMatchObject({ kind: "block", width: 20, height: 40, clip: true })
		expect([0, 1, 2, 3, 4, 5].map(field => vertical.itemFloat(0, field))).toEqual([0, 1, -1, 0, 45, 5])
	})

	it("strokes only DrawCurve's segments from Offset, shaped by the hidden points", () => {
		const pen = plusRecord(0x4008, 0x0200, writer =>
			writer.u32(0xdbc01002).u32(0).u32(0).u32(0).f32(1).u32(0xdbc01002).u32(0).u32(0xff000000)
		)
		const curve = (offset: number, segments: number): Uint8Array =>
			plusRecord(0x4018, 0, writer =>
				writer.f32(0.5).u32(offset).u32(segments).u32(4).f32(0).f32(0).f32(10).f32(0).f32(20).f32(0).f32(30).f32(0)
			)
		const draw = (record: Uint8Array): ReturnType<typeof converted>["list"] =>
			converted(
				new EmfBuilder()
					.plus([plusHeader(false)])
					.plus([pen, record])
					.build()
			).list
		const list = draw(curve(1, 1))
		const first = list.itemInt(0, ItemInt.FIRST_COORD)

		expect(list.itemInt(0, ItemInt.COMMAND_COUNT)).toBe(2)
		// Tangents at 10 and 20 come from the hidden end points 0 and 30.
		expect(Array.from(list.coords.subarray(first, first + 8), value => Math.round(value * 100) / 100)).toEqual([
			10, 0, 13.33, 0, 16.67, 0, 20, 0
		])
		expect(draw(curve(1, 0)).itemCount).toBe(0)
	})

	it("fills text drawn with a gradient brush with that gradient in the text's space", () => {
		const font = plusRecord(0x4008, 0x0602, writer => writer.u32(0xdbc01002).f32(10).u32(2).i32(0).u32(0).u32(5).utf16("Arial"))
		const gradient = brushObject(0, writer =>
			writer.u32(4).u32(0).u32(4).f32(0).f32(0).f32(10).f32(10).u32(0xffff0000).u32(0xff0000ff).u32(0).u32(0)
		)
		const text = plusRecord(0x4036, 0x0002, writer => writer.u32(0).u32(1).u32(0).u32(1).u16(0x41).f32(10).f32(20))
		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([font, gradient, text])
				.build()
		).list
		const [run] = glyphs(list)
		const fill = run?.fill === undefined ? undefined : list.paints[run.fill]

		expect(fill).toMatchObject({ kind: "gradient", spread: "pad" })
		// The gradient's origin lies at (-10, -20) of the text, which sits at (10, 20).
		expect(fill?.kind === "gradient" && fill.matrix.slice(4)).toEqual([-10, -20])
	})

	it("tiles or clamps DrawImage where its source leaves the image, per the image attributes", () => {
		const image = plusRecord(0x4008, 0x0500, writer =>
			writer.u32(0xdbc01002).u32(1).i32(2).i32(2).i32(8).u32(0x0026200a).u32(0).raw(new Uint8Array(16).fill(255))
		)
		const attributes = (wrap: number, clamp: number): Uint8Array =>
			plusRecord(0x4008, 0x0801, writer => writer.u32(0xdbc01002).u32(0).u32(wrap).u32(clamp).u32(0).u32(0))
		const draw = plusRecord(0x401a, 0x0000, writer => writer.u32(1).u32(2).f32(0).f32(0).f32(4).f32(4).f32(0).f32(0).f32(20).f32(20))
		const tiled = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([image, attributes(0, 0), draw])
				.build()
		).list
		const clamped = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([image, attributes(4, 0xff00ff00), draw])
				.build()
		).list
		const tile = paintOf(tiled, 0)

		expect(tiled.itemCount).toBe(1)
		expect(tile?.kind === "image" && tile.tile).toMatchObject({ width: 2, height: 2 })
		expect(clamped.itemCount).toBe(2)
		expect(paintOf(clamped, 0)).toEqual({ kind: "solid", color: 0x00ff00ff })
		expect(clamped.kind(1)).toBe(ItemKind.IMAGE)
	})

	it("prefers the rendition that misses less when a dual picture's EMF+ records are not all drawn", () => {
		const glyphIndexText = (writer: ByteWriter): void => {
			writer
				.i32(0)
				.i32(0)
				.i32(0)
				.i32(0)
				.u32(1)
				.f32(0)
				.f32(0)
				.i32(0)
				.i32(0)
				.u32(1)
				.u32(76)
				.u32(0x10)
				.i32(0)
				.i32(0)
				.i32(0)
				.i32(0)
				.u32(0)
				.utf16("A")
		}
		const builder = new EmfBuilder()
			.plus([plusHeader(true)])
			.plus([
				plusRecord(0x400a, 0x8000, writer => writer.u32(0xff112233).u32(1).f32(0).f32(0).f32(48).f32(48)),
				plusRecord(0x40ff, 0)
			])
			.record(84, glyphIndexText)
			.record(84, glyphIndexText)
		const result = converted(builder.build())

		expect(result.format).toBe("emf+")
	})
})

function metafileImage(effects: Partial<DrawingImage>): DrawingImage {
	return {
		partName: "/word/media/image1.emf",
		format: "emf",
		handling: "metafile",
		svgPartName: undefined,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		alpha: 1,
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0,
		colorChange: null,
		...effects
	}
}

describe("picture effects on converted metafiles", () => {
	it("recolours vector content, passes effects to embedded bitmaps and draws alpha as group opacity", async () => {
		const { info, bits } = dib24(2, 2, 0xff0000)
		const conversion = converted(
			rectangle(brush(emf(), 1, 0x0000ff), 0, 0, 500, 500)
				.record(81, stretchDibits(info, bits, 0x00cc0020))
				.build()
		)
		const host = new DrawingList()

		host.width = 96
		host.height = 96
		host.addItem(
			ItemKind.IMAGE,
			IDENTITY,
			0,
			0,
			96,
			96,
			0,
			0,
			-1,
			-1,
			host.image(metafileImage({ grayscale: true, alpha: 0.5, colorChange: [0x00ff00ff, 0x00000000] })),
			-1,
			0,
			0
		)

		const out = await expandMetafiles(host, async () => conversion)
		const fill = out.paints[out.itemInt(0, ItemInt.FILL)]
		const image = out.images[out.itemInt(1, ItemInt.REF)]
		const frame = out.clips[out.clips.length - 1]

		// Red through grey: its luminance in every channel.
		expect(fill).toEqual({ kind: "solid", color: 0x363636ff })
		expect(image?.grayscale).toBe(true)
		expect(out.clips.some(clip => clip.opacity === 0.5)).toBe(true)
		expect(frame).toBeDefined()
	})

	it("applies a colour change to vector colours", async () => {
		const conversion = converted(rectangle(brush(emf(), 1, 0x00ff00), 0, 0, 500, 500).build())
		const host = new DrawingList()

		host.addItem(
			ItemKind.IMAGE,
			IDENTITY,
			0,
			0,
			96,
			96,
			0,
			0,
			-1,
			-1,
			host.image(metafileImage({ colorChange: [0x00ff00ff, 0xff000000] })),
			-1,
			0,
			0
		)

		const out = await expandMetafiles(host, async () => conversion)
		const text: DrawingText | undefined = out.texts[0]

		expect(out.paints[out.itemInt(0, ItemInt.FILL)]).toEqual({ kind: "solid", color: 0xff000000 })
		expect(text).toBeUndefined()
	})
})

describe("WMF fixture sanity", () => {
	it("builds a placeable WMF the converter accepts", () => {
		expect(converted(new WmfBuilder().build([0, 0, 10, 10])).format).toBe("wmf")
	})
})

describe("caches and surfaces", () => {
	it("makes a path-gradient brush's paint once however many shapes it fills", () => {
		const polygon = brushObject(1, writer => {
			writer.u32(3).u32(0).u32(0).u32(0xffffffff).f32(5).f32(5).u32(3).u32(0xffff0000).u32(0xff00ff00).u32(0xff0000ff)
			writer.u32(3).f32(0).f32(0).f32(10).f32(0).f32(5).f32(10)
		})
		const fills: Uint8Array[] = []

		for (let k = 0; k < 50; k++) fills.push(fillRect(1, 0, 0, 10, 10))

		const list = converted(
			new EmfBuilder()
				.plus([plusHeader(false)])
				.plus([polygon, ...fills])
				.build()
		).list

		expect(list.itemCount).toBe(50)
		// One paint, shared by every fill.
		expect(new Set(Array.from({ length: 50 }, (_, item) => list.itemInt(item, ItemInt.FILL))).size).toBe(1)
		expect(paintOf(list, 0)?.kind).toBe("shaded")
	})

	it("starts pictures with raster operations on a white surface, under the picture when placed", async () => {
		const { info, bits } = dib24(2, 2, 0x00ff00)
		const conversion = converted(
			emf()
				.record(81, stretchDibits(info, bits, 0x00660046))
				.build()
		)

		expect(conversion.list.background).toBe(0xffffffff)

		const host = new DrawingList()

		host.addItem(ItemKind.IMAGE, IDENTITY, 10, 10, 96, 96, 0, 0, -1, -1, host.image(metafileImage({})), -1, 0, 0)

		const out = await expandMetafiles(host, async () => conversion)

		expect(out.kind(0)).toBe(ItemKind.PATH)
		expect(out.paints[out.itemInt(0, ItemInt.FILL)]).toEqual({ kind: "solid", color: 0xffffffff })
		expect(bounds(out, 0)).toEqual([10, 10, 106, 106])
		expect(blendOf(out, 1)).toBe(ItemFlag.BLEND_DIFFERENCE)
		expect(converted(rectangle(brush(emf(), 1, 0xff), 0, 0, 10, 10).build()).list.background).toBeUndefined()
	})

	it("recolours an embedded bitmap once per colour change, within the pixel budget", () => {
		const bytes = encodePng(new Uint8Array(16).fill(255), 2, 2)
		const image: DrawingImage = { ...metafileImage({}), partName: undefined, format: "png", handling: "native", bytes }
		const picture = metafileImage({ colorChange: [0xffffffff, 0x00000000] })
		let spent = 0
		const budget = {
			spend: (pixels: number): boolean => {
				spent += pixels

				return true
			}
		}
		const first = effectImage(image, picture, budget)
		const second = effectImage(image, picture, budget)

		expect(first.bytes).not.toBe(bytes)
		expect(second.bytes).toBe(first.bytes)
		expect(spent).toBe(4)
		expect(effectImage({ ...image, bytes: encodePng(new Uint8Array(16), 2, 2) }, picture, { spend: () => false }).format).toBe("png")
	})
})

describe("shading", () => {
	it("rasterises shaded triangles at the requested scale, within the pixel bound, with ramps from the centre", () => {
		const points = Float32Array.of(0, 0, 10, 0, 0, 10, 10, 0, 10, 10, 0, 10)
		const colors = Uint32Array.of(0xff0000ff, 0xff0000ff, 0xff0000ff, 0x0000ffff, 0x0000ffff, 0x0000ffff)
		const raster = shadeRaster(points, colors, null, 4, 1_000_000)

		expect([raster?.width, raster?.height]).toEqual([40, 40])
		expect(Array.from(raster?.rgba.subarray(0, 4) ?? [])).toEqual([255, 0, 0, 255])
		expect(Array.from(raster?.rgba.subarray((39 * 40 + 39) * 4, (39 * 40 + 39) * 4 + 4) ?? [])).toEqual([0, 0, 255, 255])

		const small = shadeRaster(points, colors, null, 100, 400)

		expect((small?.width ?? 0) * (small?.height ?? 0)).toBeLessThanOrEqual(441)

		const ramp: ShadeRamp = { center: 0xffffffff, offsets: null, colors: null, positions: null, factors: null, focus: 0.5 }

		// Inside the focus scale the centre colour is solid; at the edge the edge colour shows.
		expect(rampColor(ramp, 0.6, 0x000000ff)).toBe(0xffffffff)
		expect(rampColor(ramp, 0, 0x000000ff)).toBe(0x000000ff)
	})
})

describe("EMF region frames, inversions and small text", () => {
	// The record's fields, then RGNDATA: header (size, type, count, buffer size, bounds) and the rectangles in
	// device units.
	const region =
		(fields: readonly number[], rects: readonly number[]): ((writer: ByteWriter) => void) =>
		writer => {
			for (const value of [...fields, 32, 1, rects.length / 4, rects.length * 4, 0, 0, 0, 0, ...rects]) writer.i32(value)
		}
	const coordsOf = (list: DrawingList): number[] => Array.from(list.coords.subarray(0, list.coordCount), value => Math.round(value))

	it("frames a region with its brush, Width across and Height down (EMR_FRAMERGN)", () => {
		// Bounds, RgnDataSize, ihBrush, Width, Height.
		const builder = brush(emf(), 1, 0x0000ff).record(72, region([0, 0, 0, 0, 48, 1, 250, 125], [0, 0, 96, 96]))
		const result = converted(builder.build())
		const list = result.list

		expect(result.unsupported).toBe(0)
		expect(list.itemCount).toBe(1)
		expect(paintOf(list, 0)).toEqual({ kind: "solid", color: 0xff0000ff })
		expect(bounds(list, 0)).toEqual([0, 0, 96, 96])

		// 250 logical units are 24 pixels, 125 are 12: the region minus its inside [24, 12, 72, 84].
		const coords = coordsOf(list)

		expect(coords).toContain(24)
		expect(coords).toContain(72)
		expect(coords).toContain(12)
		expect(coords).toContain(84)
		expect(coords).not.toContain(48)
	})

	it("frames the inner corner of an L-shaped region as well as its outline", () => {
		// An L: the top band full width, the bottom band only its left half.
		const builder = brush(emf(), 1, 0x0000ff).record(72, region([0, 0, 0, 0, 64, 1, 125, 125], [0, 0, 96, 48, 0, 48, 48, 96]))
		const list = converted(builder.build()).list
		const coords = coordsOf(list)

		// The inside of the L (12 pixels in) leaves a frame along the inner edges x = 48 and y = 48 too.
		expect(list.itemCount).toBe(1)
		expect(coords).toContain(36)
		expect(coords).toContain(84)
	})

	it("inverts a region as white differenced with the destination (EMR_INVERTRGN)", () => {
		// Bounds, RgnDataSize.
		const builder = emf().record(73, region([0, 0, 0, 0, 48], [0, 0, 48, 48]))
		const result = converted(builder.build())
		const list = result.list

		expect(result.unsupported).toBe(0)
		expect(list.itemCount).toBe(1)
		expect(blendOf(list, 0)).toBe(ItemFlag.BLEND_DIFFERENCE)
		expect(paintOf(list, 0)).toEqual({ kind: "solid", color: 0xffffffff })
		expect(bounds(list, 0)).toEqual([0, 0, 48, 48])
	})

	// x, y, cChars, fuOptions (with ETO_SMALL_CHARS), iGraphicsMode, exScale, eyScale, Bounds unless ETO_NO_RECT.
	const smallText =
		(options: number): ((writer: ByteWriter) => void) =>
		writer => {
			const rect = (options & 0x100) === 0 ? [0, 0, 500, 500] : []

			for (const value of [0, 0, 2, options | 0x200, 1, 0, 0, ...rect]) writer.i32(value)

			writer.ascii("Hi").pad(4)
		}

	it("fills EMR_SMALLTEXTOUT's Bounds with the background colour for ETO_OPAQUE", () => {
		const list = converted(
			emf()
				.record(25, writer => writer.u32(0x00ff00))
				.record(108, smallText(0x2))
				.build()
		).list

		expect(paintOf(list, 0)).toEqual({ kind: "solid", color: 0x00ff00ff })
		expect(bounds(list, 0)).toEqual([0, 0, 48, 48])
		expect(glyphs(list)[0]?.run.text).toBe("Hi")
	})

	it("clips EMR_SMALLTEXTOUT to its Bounds for ETO_CLIPPED and reads no Bounds with ETO_NO_RECT", () => {
		const clipped = converted(emf().record(108, smallText(0x4)).build()).list
		// ETO_CLIPPED | ETO_NO_RECT.
		const unclipped = converted(emf().record(108, smallText(0x104)).build()).list

		expect(clipped.itemClip(0)).toBeGreaterThanOrEqual(0)
		expect(unclipped.itemClip(0)).toBe(-1)
		expect(glyphs(unclipped)[0]?.run.text).toBe("Hi")
	})

	it("counts glyph-index and overlong EMR_SMALLTEXTOUT strings without drawing them", () => {
		const glyphIndex = converted(emf().record(108, smallText(0x10)).build())
		const overlong = converted(
			emf()
				.record(108, writer => writer.i32(0).i32(0).u32(400).u32(0x300).u32(1).f32(0).f32(0).ascii("Hi").pad(4))
				.build()
		)

		expect(glyphIndex.list.itemCount).toBe(0)
		expect(glyphIndex.unsupported).toBe(1)
		expect(overlong.list.itemCount).toBe(0)
	})
})

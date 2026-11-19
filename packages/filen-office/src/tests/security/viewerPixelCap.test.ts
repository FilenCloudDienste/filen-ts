import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { DocxEngine } from "@filen/office/dom/docx"
import { rasterPixels, sniffImage, viewable, type DocxImageInfo } from "../../core/docx/objects/images"
import { buildDocx } from "../docxSynthetic"
import { engineServices, png } from "./generate"

// The viewer hands pictures to the platform's decoders: one whose header declares more pixels than the cap
// is not handed over at all (a placeholder shows), so a few bytes cannot ask for gigabytes of decode memory.

function webp(chunk: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Uint8Array {
	const b = new Uint8Array(40)
	const view = new DataView(b.buffer)

	b.set(new TextEncoder().encode(`RIFF\0\0\0\0WEBP${chunk}`))

	if (chunk === "VP8X") {
		for (let k = 0; k < 3; k++) {
			b[24 + k] = ((width - 1) >>> (8 * k)) & 0xff
			b[27 + k] = ((height - 1) >>> (8 * k)) & 0xff
		}
	} else if (chunk === "VP8L") {
		b[20] = 0x2f
		view.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true)
	} else {
		b.set([0x9d, 0x01, 0x2a], 23)
		view.setUint16(26, width, true)
		view.setUint16(28, height, true)
	}

	return b
}

// A JPEG declaring 60000 x 60000 with one stray byte before its SOF0 marker (decoders skip it and decode on).
function jpegWithStrayByte(): Uint8Array {
	const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]
	const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0xea, 0x60, 0xea, 0x60, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]

	return new Uint8Array([0xff, 0xd8, ...app0, 0x00, ...sof, 0xff, 0xd9])
}

// A JPEG whose FF 00 (a stuffed zero, no segment) a walk by length would skip to a 1 x 1 frame header hidden in a
// comment, past the real SOF0 declaring 23000 x 23000 that a decoder reads.
function jpegWithStuffedZero(): Uint8Array {
	const sof = (size: number): number[] => [
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		size >> 8,
		size & 0xff,
		size >> 8,
		size & 0xff,
		0x03,
		0x01,
		0x22,
		0x00,
		0x02,
		0x11,
		0x01,
		0x03,
		0x11,
		0x01
	]
	const head = [0xff, 0xd8, 0xff, 0x00, 0x00, 0x20, ...sof(23_000)]
	const padding = [0, 0, 0, 0, 0, 0, 0]
	const comment = [0xff, 0xfe, 0x00, 2 + padding.length + 19, ...padding, ...sof(1)]
	const bytes = new Uint8Array([...head, ...comment, 0xff, 0xd9])

	// The fake frame header lies where a length walk from the FF 00 lands.
	if (bytes[36] !== 0xff || bytes[37] !== 0xc0) throw new Error("fake SOF misplaced")

	return bytes
}

function u32be(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function box(type: string, body: number[]): number[] {
	return [...u32be(8 + body.length), ...[...type].map(c => c.charCodeAt(0)), ...body]
}

// An AVIF whose ispe declares 60000 x 60000.
function avif(): Uint8Array {
	const ftyp = box("ftyp", [...[..."avif"].map(c => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."mif1avif"].map(c => c.charCodeAt(0))])
	const ispe = box("ispe", [0, 0, 0, 0, ...u32be(60_000), ...u32be(60_000)])

	return new Uint8Array([...ftyp, ...box("meta", [0, 0, 0, 0, ...box("iprp", box("ipco", ispe))])])
}

// A little-endian TIFF declaring 60000 x 60000 (Safari decodes TIFF).
function tiff(): Uint8Array {
	const b = new Uint8Array(38)
	const view = new DataView(b.buffer)

	b.set([0x49, 0x49, 0x2a, 0x00])
	view.setUint32(4, 8, true)
	view.setUint16(8, 2, true)
	view.setUint16(10, 256, true)
	view.setUint16(12, 4, true)
	view.setUint32(14, 1, true)
	view.setUint32(18, 60_000, true)
	view.setUint16(22, 257, true)
	view.setUint16(24, 4, true)
	view.setUint32(26, 1, true)
	view.setUint32(30, 60_000, true)

	return b
}

describe("viewer pixel cap", () => {
	it("reads pixel counts from raster headers", () => {
		expect(rasterPixels(png(100, 50))).toBe(5000)
		expect(rasterPixels(webp("VP8X", 16_000, 16_000))).toBe(256_000_000)
		expect(rasterPixels(webp("VP8L", 300, 200))).toBe(60_000)
		expect(rasterPixels(webp("VP8 ", 640, 480))).toBe(307_200)
		expect(rasterPixels(new TextEncoder().encode("<svg/>"))).toBeUndefined()
	})

	it("serves pictures under the cap and refuses ones declaring more", async () => {
		const bytes = buildDocx({
			body: "<w:p/>",
			parts: [
				{ name: "word/media/small.png", contentType: "image/png", data: png(640, 480) },
				{ name: "word/media/huge.png", contentType: "image/png", data: png(65_535, 65_535) },
				{ name: "word/media/huge.webp", contentType: "image/webp", data: webp("VP8X", 16_000, 16_000) }
			]
		})
		const engine = new DocxEngine(bytesSource(bytes), engineServices(), () => undefined)

		await engine.run()

		expect(await engine.media("word/media/small.png")).not.toBeNull()
		expect(await engine.media("word/media/huge.png")).toBeNull()
		expect(await engine.media("word/media/huge.webp")).toBeNull()
	})

	it("refuses pictures it cannot read the size of, whatever their part is labelled", async () => {
		const bytes = buildDocx({
			body: "<w:p/>",
			parts: [
				{ name: "word/media/stray.jpeg", contentType: "image/jpeg", data: jpegWithStrayByte() },
				{ name: "word/media/avif.png", contentType: "image/png", data: avif() },
				{ name: "word/media/tiff.png", contentType: "image/png", data: tiff() },
				{ name: "word/media/junk.png", contentType: "image/png", data: new TextEncoder().encode("not a picture") },
				{
					name: "word/media/drawing.svg",
					contentType: "image/svg+xml",
					data: new TextEncoder().encode('<svg width="10" height="10"/>')
				}
			]
		})
		const engine = new DocxEngine(bytesSource(bytes), engineServices(), () => undefined)

		await engine.run()

		expect(rasterPixels(jpegWithStrayByte())).toBe(3_600_000_000)
		expect(await engine.media("word/media/stray.jpeg")).toBeNull()
		expect(await engine.media("word/media/avif.png")).toBeNull()
		expect(await engine.media("word/media/tiff.png")).toBeNull()
		expect(await engine.media("word/media/junk.png")).toBeNull()
		expect(await engine.media("word/media/drawing.svg")).not.toBeNull()
	})

	it("refuses a JPEG whose FF 00 would lead a length walk to a fake frame header", () => {
		expect(rasterPixels(jpegWithStuffedZero())).toBeUndefined()
		expect(viewable(jpegWithStuffedZero(), 50_000_000)).toBe(false)
		expect(sniffImage(jpegWithStuffedZero())).toBe("corrupt")
		// Stray bytes before a marker are still read past.
		expect(rasterPixels(jpegWithStrayByte())).toBe(3_600_000_000)
	})

	it("reads SVG lengths in time linear in their size, and ordinary ones as before", () => {
		const digits = "1".repeat(60_000)
		const hostile = new TextEncoder().encode(`<svg width="${digits}x" height="${digits}x"/>`)
		const started = performance.now()

		expect(viewable(hostile, 50_000_000)).toBe(true)
		expect(sniffImage(hostile)).toMatchObject({ format: "svg", width: 300, height: 150 })
		expect(performance.now() - started).toBeLessThan(100)

		const size = (width: string, height: string): DocxImageInfo =>
			sniffImage(new TextEncoder().encode(`<svg width="${width}" height="${height}"/>`)) as DocxImageInfo

		expect(size("100", "1e2px")).toMatchObject({ width: 100, height: 100 })
		expect(size("1.5in", ".5cm")).toMatchObject({ width: 144, height: 19 })
		expect(size("2.", "-3")).toMatchObject({ width: 300, height: 150 })
	})

	it("caps a GIF by its first frame when that is larger than its logical screen", () => {
		const gif = (frame: number[]): Uint8Array =>
			new Uint8Array([
				...new TextEncoder().encode("GIF89a"),
				1,
				0,
				1,
				0,
				0x00,
				0,
				0,
				0x2c,
				...frame,
				0x00,
				0x02,
				0x02,
				0x44,
				0x01,
				0x00,
				0x3b
			])
		// 60000 x 60000 at (0, 0) on a 1 x 1 screen.
		const huge = gif([0, 0, 0, 0, 0x60, 0xea, 0x60, 0xea])

		expect(rasterPixels(huge)).toBe(3_600_000_000)
		expect(viewable(huge, 50_000_000)).toBe(false)
		expect(rasterPixels(gif([0, 0, 0, 0, 1, 0, 1, 0]))).toBe(1)
		// No frame to read: refused.
		expect(viewable(new Uint8Array([...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0x00, 0, 0, 0x3b]), 50_000_000)).toBe(false)
	})
})

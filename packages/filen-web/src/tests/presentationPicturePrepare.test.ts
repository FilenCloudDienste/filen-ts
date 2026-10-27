import { describe, expect, it, vi } from "vitest"

vi.mock("@/features/preview/lib/docxImages", () => ({
	BROWSER_PICTURE_CODECS: {},
	driveSource: () => undefined,
	fileSource: () => undefined
}))

import { preparePresentationPicture } from "@/features/presentation/components/ribbon/insertObjects"
import type { PictureCodecs } from "@/features/preview/lib/docxImages.logic"

// Pictures prepared for a slide within the presentation's 50-megapixel budget: read once, sized as their EXIF
// orientation turns them, and WebP made PNG across the whole budget, as under Word's 20 megapixels.

// A JPEG header: SOI, APP1 Exif (orientation), SOF0 (width × height), EOI.
function jpeg(width: number, height: number, orientation: number): Uint8Array {
	const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0]
	const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
	const app1 = [0xff, 0xe1, ((exif.length + 2) >> 8) & 0xff, (exif.length + 2) & 0xff, ...exif]
	const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]

	return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9])
}

// A lossy WebP's VP8X header of width × height.
function webp(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(30)

	bytes.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0])
	bytes.set(
		[
			(width - 1) & 0xff,
			((width - 1) >> 8) & 0xff,
			(width - 1) >> 16,
			(height - 1) & 0xff,
			((height - 1) >> 8) & 0xff,
			(height - 1) >> 16
		],
		24
	)

	return bytes
}

// A PNG's IHDR of width × height.
function png(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33)

	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	new DataView(bytes.buffer).setUint32(16, width)
	new DataView(bytes.buffer).setUint32(20, height)
	bytes.set([8, 6, 0, 0, 0], 24)

	return bytes
}

const signal = new AbortController().signal

function source(bytes: Uint8Array, name: string): { size: number; name: string; read: () => Promise<Uint8Array> } {
	return { size: bytes.length, name, read: vi.fn(() => Promise.resolve(bytes)) }
}

describe("presentation picture preparation", () => {
	it("sizes a 24-megapixel portrait photo as its EXIF orientation turns it, reading it once", async () => {
		const photo = source(jpeg(6000, 4000, 6), "photo.jpg")
		const prepared = await preparePresentationPicture(photo, signal)

		expect(prepared.ok && [prepared.image.width, prepared.image.height, prepared.image.contentType]).toEqual([4000, 6000, "image/jpeg"])
		expect(photo.read).toHaveBeenCalledTimes(1)
	})

	it("makes a WebP over Word's budget but within the presentation's a PNG, and refuses one past it as too many pixels", async () => {
		const webpToPng = vi.fn(() => Promise.resolve(png(6000, 5000)))
		const codecs: PictureCodecs = {
			webpToPng,
			svgToPng: () => Promise.reject(new Error("no SVG here"))
		}
		const within = await preparePresentationPicture(source(webp(6000, 5000), "wide.webp"), signal, codecs)

		expect(within.ok && [within.image.width, within.image.height, within.image.contentType]).toEqual([6000, 5000, "image/png"])

		const past = await preparePresentationPicture(source(webp(9000, 6000), "huge.webp"), signal, codecs)

		expect(past).toEqual({ ok: false, refusal: "pixels" })
		expect(webpToPng).toHaveBeenCalledTimes(1)
	})
})

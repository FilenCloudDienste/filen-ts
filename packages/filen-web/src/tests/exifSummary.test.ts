import { describe, expect, it } from "vitest"
import {
	cameraLabel,
	formatCoordinates,
	formatExposure,
	formatFNumber,
	formatFocalLength,
	readExifSummary
} from "@/features/preview/imageEdit/lib/exifSummary"
import { IMAGE_DETAILS_HEAD_BYTES, imageDetailsFromHead } from "@/features/drive/lib/imageDetails.logic"
import { exifBlock, field, jpegWithExif, pngWithExif, webpWithExif, type ExifSpec } from "@/tests/support/exifBytes"
import { heif } from "@/tests/support/heifBytes"

// The details' photo section: what a photo's Exif says (CIPA DC-008), read from the TIFF block alone, in both byte
// orders, from every carrier the sniffers locate, and nothing from a malformed value.

function camera(le: boolean): ExifSpec {
	return {
		ifd0: [field.ascii(0x010f, "Canon"), field.ascii(0x0110, "Canon EOS R5"), field.ascii(0x0132, "2020:01:01 00:00:00")],
		exif: [
			field.rational(le, 0x829a, [1, 125]),
			field.rational(le, 0x829d, [18, 10]),
			field.short(le, 0x8827, 400),
			field.ascii(0x9003, "2024:06:15 14:30:05"),
			field.short(le, 0x9209, 0x19),
			field.rational(le, 0x920a, [50, 1]),
			field.short(le, 0xa405, 50),
			field.ascii(0xa433, "Canon"),
			field.ascii(0xa434, "RF50mm F1.8 STM")
		],
		gps: [
			field.ascii(0x0001, "N"),
			field.rational(le, 0x0002, [52, 1], [31, 1], [12, 1]),
			field.ascii(0x0003, "W"),
			field.rational(le, 0x0004, [13, 1], [24, 1], [1800, 100])
		]
	}
}

describe("readExifSummary", () => {
	for (const le of [true, false]) {
		describe(le ? "little endian" : "big endian", () => {
			const summary = readExifSummary(exifBlock(le, camera(le)))

			it("reads the capture date from DateTimeOriginal, as local time", () => {
				expect(summary?.takenMs).toBe(new Date(2024, 5, 15, 14, 30, 5).getTime())
			})

			it("reads make, model and the lens model over the lens make", () => {
				expect(summary?.make).toBe("Canon")
				expect(summary?.model).toBe("Canon EOS R5")
				expect(summary?.lens).toBe("RF50mm F1.8 STM")
			})

			it("reads the shot settings", () => {
				expect(summary?.exposureSeconds).toBeCloseTo(1 / 125)
				expect(summary?.fNumber).toBeCloseTo(1.8)
				expect(summary?.iso).toBe(400)
				expect(summary?.focalLength).toBe(50)
				expect(summary?.focalLength35mm).toBe(50)
				expect(summary?.flashFired).toBe(true)
			})

			it("reads the GPS position as signed decimal degrees", () => {
				expect(summary?.latitude).toBeCloseTo(52 + 31 / 60 + 12 / 3600, 6)
				expect(summary?.longitude).toBeCloseTo(-(13 + 24 / 60 + 18 / 3600), 6)
			})
		})
	}

	it("falls back to IFD0 DateTime and the lens make", () => {
		const summary = readExifSummary(
			exifBlock(true, { ifd0: [field.ascii(0x0132, "2021:03:04 05:06:07")], exif: [field.ascii(0xa433, "Sigma")] })
		)

		expect(summary?.takenMs).toBe(new Date(2021, 2, 4, 5, 6, 7).getTime())
		expect(summary?.lens).toBe("Sigma")
	})

	it("reads every missing tag as null", () => {
		expect(readExifSummary(exifBlock(true, {}))).toEqual({
			takenMs: null,
			make: null,
			model: null,
			lens: null,
			fNumber: null,
			exposureSeconds: null,
			iso: null,
			focalLength: null,
			focalLength35mm: null,
			flashFired: null,
			latitude: null,
			longitude: null
		})
	})

	it("reads a flash that did not fire, and the first of several ISO values", () => {
		const summary = readExifSummary(
			exifBlock(false, { exif: [field.short(false, 0x9209, 0x10), field.short(false, 0x8827, 200, 400, 800)] })
		)

		expect(summary?.flashFired).toBe(false)
		expect(summary?.iso).toBe(200)
	})

	it("reads SRATIONAL values signed", () => {
		const summary = readExifSummary(exifBlock(true, { exif: [field.srational(true, 0x829a, [-1, 60])] }))

		// A negative exposure is no exposure.
		expect(summary?.exposureSeconds).toBeNull()
	})

	it("ignores a zero denominator, a blank date and a corrupt count or offset", () => {
		const blankDate = field.ascii(0x9003, "    :  :     :  :  ")
		const hugeCount = { ...field.ascii(0x010f, "Nikon Corporation"), count: 0x7fffffff }
		const badOffset = { ...field.rational(true, 0x829d, [28, 10]), offset: 0xfffff0 }
		const summary = readExifSummary(
			exifBlock(true, {
				ifd0: [hugeCount],
				exif: [blankDate, badOffset, field.rational(true, 0x920a, [35, 0])]
			})
		)

		expect(summary?.make).toBeNull()
		expect(summary?.takenMs).toBeNull()
		expect(summary?.fNumber).toBeNull()
		expect(summary?.focalLength).toBeNull()
	})

	it("drops a GPS position missing a ref or out of range", () => {
		const noRef = readExifSummary(
			exifBlock(true, {
				gps: [
					field.rational(true, 0x0002, [1, 1], [0, 1], [0, 1]),
					field.ascii(0x0003, "E"),
					field.rational(true, 0x0004, [1, 1], [0, 1], [0, 1])
				]
			})
		)
		const outOfRange = readExifSummary(
			exifBlock(true, {
				gps: [
					field.ascii(0x0001, "N"),
					field.rational(true, 0x0002, [95, 1], [0, 1], [0, 1]),
					field.ascii(0x0003, "E"),
					field.rational(true, 0x0004, [1, 1], [0, 1], [0, 1])
				]
			})
		)

		expect(noRef?.latitude).toBeNull()
		expect(noRef?.longitude).toBeNull()
		expect(outOfRange?.latitude).toBeNull()
	})

	it("survives a block truncated mid-IFD", () => {
		const block = exifBlock(true, camera(true))

		expect(() => readExifSummary(block.subarray(0, 40))).not.toThrow()
		expect(readExifSummary(block.subarray(0, 40))?.lens).toBeNull()
	})

	it("reads RAW magics (ORF, RW2) and rejects what is not TIFF", () => {
		expect(readExifSummary(exifBlock(true, { ...camera(true), magic: 0x4f52 }))?.model).toBe("Canon EOS R5")
		expect(readExifSummary(exifBlock(true, { ...camera(true), magic: 0x55 }))?.model).toBe("Canon EOS R5")
		expect(readExifSummary(exifBlock(true, { ...camera(true), magic: 43 }))).toBeNull()
		expect(readExifSummary(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull()
	})
})

describe("photo details per format", () => {
	const tiff = exifBlock(false, camera(false))

	function details(file: Uint8Array) {
		return imageDetailsFromHead(file.subarray(0, IMAGE_DETAILS_HEAD_BYTES), file.length)
	}

	it("JPEG: APP1 Exif and the frame's size", () => {
		const result = details(jpegWithExif(tiff))

		expect(result?.width).toBe(800)
		expect(result?.height).toBe(600)
		expect(result?.exif?.model).toBe("Canon EOS R5")
	})

	it("PNG: the eXIf chunk", () => {
		expect(details(pngWithExif(tiff))?.exif?.iso).toBe(400)
	})

	it("WebP: the EXIF chunk", () => {
		expect(details(webpWithExif(tiff))?.exif?.fNumber).toBeCloseTo(1.8)
	})

	it("HEIC and AVIF: the Exif item", () => {
		const heic = details(heif({ major: "heic", compatible: ["mif1", "heic"], primaryType: "hvc1", exif: tiff }))
		const avif = details(heif({ major: "avif", compatible: ["mif1", "avif"], primaryType: "av01", exif: tiff }))

		expect(heic?.exif?.lens).toBe("RF50mm F1.8 STM")
		expect(heic?.width).toBe(1200)
		expect(avif?.exif?.latitude).toBeCloseTo(52.52, 2)
	})

	it("TIFF and TIFF-based RAW: the file itself", () => {
		expect(details(exifBlock(true, camera(true)))?.exif?.make).toBe("Canon")
		expect(details(exifBlock(true, { ...camera(true), magic: 0x4f52 }))?.exif?.make).toBe("Canon")
	})

	it("a head with no picture in it has no details", () => {
		expect(details(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBeNull()
	})
})

describe("display", () => {
	it("formats the shot settings compactly", () => {
		expect(formatFNumber(1.8)).toBe("f/1.8")
		expect(formatFNumber(8)).toBe("f/8")
		expect(formatExposure(1 / 120)).toBe("1/120 s")
		expect(formatExposure(2)).toBe("2 s")
		expect(formatExposure(2.5)).toBe("2.5 s")
		expect(formatFocalLength(50, 50)).toBe("50 mm")
		expect(formatFocalLength(4.25, 26)).toBe("4.3 mm (35 mm: 26 mm)")
		expect(formatFocalLength(26, null)).toBe("26 mm")
	})

	it("formats coordinates with hemispheres", () => {
		expect(formatCoordinates(52.52, 13.405)).toBe("52.5200° N, 13.4050° E")
		expect(formatCoordinates(-33.8688, -151.2093)).toBe("33.8688° S, 151.2093° W")
	})

	it("joins make and model unless the model repeats the make", () => {
		expect(cameraLabel("Canon", "Canon EOS R5")).toBe("Canon EOS R5")
		expect(cameraLabel("FUJIFILM", "X-T5")).toBe("FUJIFILM X-T5")
		expect(cameraLabel(null, "iPhone 15")).toBe("iPhone 15")
		expect(cameraLabel("Apple", null)).toBe("Apple")
	})
})

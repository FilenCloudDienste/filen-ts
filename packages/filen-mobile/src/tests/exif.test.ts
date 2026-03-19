import { describe, it, expect } from "vitest"
import { parseExifDate, parseExifOrientationFromBytes } from "@/lib/exif"

describe("parseExifDate", () => {
	const BASE_DATE = "2024:06:15 14:30:45"
	const BASE_TS = Date.parse("2024-06-15T14:30:45Z")

	describe("iOS layout", () => {
		it("reads fields nested under {Exif} and {TIFF}", () => {
			const exif = {
				"{Exif}": {
					DateTimeOriginal: BASE_DATE
				},
				"{TIFF}": {
					DateTime: "2020:01:01 00:00:00"
				}
			}

			expect(parseExifDate(exif)).toBe(BASE_TS)
		})

		it("falls back to {TIFF} DateTime when {Exif} has no date fields", () => {
			const exif = {
				"{Exif}": {},
				"{TIFF}": {
					DateTime: BASE_DATE
				}
			}

			expect(parseExifDate(exif)).toBe(BASE_TS)
		})
	})

	describe("Android layout", () => {
		it("reads flat fields directly", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE
			}

			expect(parseExifDate(exif)).toBe(BASE_TS)
		})
	})

	describe("field priority", () => {
		it("DateTimeOriginal takes priority over DateTimeDigitized and DateTime", () => {
			const exif = {
				DateTimeOriginal: "2024:06:15 10:00:00",
				DateTimeDigitized: "2024:06:15 11:00:00",
				DateTime: "2024:06:15 12:00:00"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T10:00:00Z"))
		})

		it("falls back to DateTimeDigitized when DateTimeOriginal is missing", () => {
			const exif = {
				DateTimeDigitized: "2024:06:15 11:00:00",
				DateTime: "2024:06:15 12:00:00"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T11:00:00Z"))
		})

		it("falls back to DateTime when both above are missing", () => {
			const exif = {
				DateTime: "2024:06:15 12:00:00"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T12:00:00Z"))
		})
	})

	describe("SubSecTimeOriginal", () => {
		it("adds millisecond precision", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				SubSecTimeOriginal: "123"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.123Z"))
		})

		it("pads single-digit subsec to three digits", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				SubSecTimeOriginal: "7"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.700Z"))
		})
	})

	describe("timezone offset", () => {
		it("applies positive OffsetTimeOriginal correctly", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				OffsetTimeOriginal: "+05:30"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45+05:30"))
		})

		it("applies negative offset correctly", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				OffsetTimeOriginal: "-08:00"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45-08:00"))
		})

		it("treats missing offset as UTC", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45Z"))
		})

		it("falls back to UTC when offset format is invalid", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				OffsetTimeOriginal: "not-an-offset"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45Z"))
		})
	})

	describe("SubSecTimeDigitized with DateTimeDigitized", () => {
		it("uses SubSecTimeDigitized when DateTimeOriginal is absent", () => {
			const exif = {
				DateTimeDigitized: BASE_DATE,
				SubSecTimeDigitized: "456"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.456Z"))
		})
	})

	describe("SubSecTimeOriginal padding and truncation", () => {
		it("pads 2-digit subsec to three digits", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				SubSecTimeOriginal: "12"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.120Z"))
		})

		it("truncates subsec longer than 3 digits", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				SubSecTimeOriginal: "12345"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.123Z"))
		})
	})

	describe("zero timezone offset", () => {
		it("zero timezone offset produces same result as no offset", () => {
			const withOffset = parseExifDate({
				DateTimeOriginal: BASE_DATE,
				OffsetTimeOriginal: "+00:00"
			})

			const withoutOffset = parseExifDate({
				DateTimeOriginal: BASE_DATE
			})

			expect(withOffset).toBe(withoutOffset)
		})
	})

	describe("iOS layout edge cases", () => {
		it("reads SubSecTimeOriginal from nested {Exif} group", () => {
			const exif = {
				"{Exif}": {
					DateTimeOriginal: BASE_DATE,
					SubSecTimeOriginal: "789"
				}
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.789Z"))
		})
	})

	describe("SubSecTimeDigitized with DateTimeDigitized", () => {
		it("uses SubSecTimeDigitized when DateTimeOriginal is absent", () => {
			const exif = {
				DateTimeDigitized: BASE_DATE,
				SubSecTimeDigitized: "456"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.456Z"))
		})
	})

	describe("SubSecTimeOriginal padding and truncation", () => {
		it("pads 2-digit subsec to three digits", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				SubSecTimeOriginal: "12"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.120Z"))
		})

		it("truncates subsec longer than 3 digits", () => {
			const exif = {
				DateTimeOriginal: BASE_DATE,
				SubSecTimeOriginal: "12345"
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.123Z"))
		})
	})

	describe("zero timezone offset", () => {
		it("zero timezone offset produces same result as no offset", () => {
			const withOffset = parseExifDate({
				DateTimeOriginal: BASE_DATE,
				OffsetTimeOriginal: "+00:00"
			})

			const withoutOffset = parseExifDate({
				DateTimeOriginal: BASE_DATE
			})

			expect(withOffset).toBe(withoutOffset)
		})
	})

	describe("iOS layout edge cases", () => {
		it("reads SubSecTimeOriginal from nested {Exif} group", () => {
			const exif = {
				"{Exif}": {
					DateTimeOriginal: BASE_DATE,
					SubSecTimeOriginal: "789"
				}
			}

			expect(parseExifDate(exif)).toBe(Date.parse("2024-06-15T14:30:45.789Z"))
		})
	})

	describe("edge cases", () => {
		it("returns null for null input", () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect(parseExifDate(null as any)).toBeNull()
		})

		it("returns null for undefined input", () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect(parseExifDate(undefined as any)).toBeNull()
		})

		it("returns null for an empty exif object", () => {
			expect(parseExifDate({})).toBeNull()
		})

		it("returns null for an invalid/unparseable date string", () => {
			const exif = {
				DateTimeOriginal: "not-a-date"
			}

			expect(parseExifDate(exif)).toBeNull()
		})

		it("skips non-string date values", () => {
			const exif = {
				DateTimeOriginal: 12345,
				DateTimeDigitized: null,
				DateTime: BASE_DATE
			}

			expect(parseExifDate(exif as Record<string, unknown>)).toBe(BASE_TS)
		})

		it("falls back to flat lookup when {Exif} is a non-object", () => {
			const exif = {
				"{Exif}": "not-an-object",
				DateTimeOriginal: BASE_DATE
			}

			expect(parseExifDate(exif)).toBe(BASE_TS)
		})

		it("works when {TIFF} is null and date is at top level", () => {
			const exif = {
				"{TIFF}": null,
				DateTimeOriginal: BASE_DATE
			}

			expect(parseExifDate(exif as Record<string, unknown>)).toBe(BASE_TS)
		})

		it("falls back to flat lookup when {Exif} is a non-object", () => {
			const exif = {
				"{Exif}": "not-an-object",
				DateTimeOriginal: BASE_DATE
			}

			expect(parseExifDate(exif)).toBe(BASE_TS)
		})

		it("works when {TIFF} is null and date is at top level", () => {
			const exif = {
				"{TIFF}": null,
				DateTimeOriginal: BASE_DATE
			}

			expect(parseExifDate(exif as Record<string, unknown>)).toBe(BASE_TS)
		})
	})
})

/**
 * Builds a minimal JPEG with an EXIF APP1 segment containing the given orientation value.
 * The structure is: SOI + APP1(Exif header + TIFF IFD with orientation tag).
 */
function buildJpegWithOrientation(orientation: number, littleEndian = true): Uint8Array {
	const byteOrder = littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]
	const magic42 = littleEndian ? [0x2a, 0x00] : [0x00, 0x2a]
	// IFD0 offset = 8 (relative to TIFF start)
	const ifdOffset = littleEndian ? [0x08, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x08]
	// 1 entry in the IFD
	const entryCount = littleEndian ? [0x01, 0x00] : [0x00, 0x01]
	// Orientation tag = 0x0112, type SHORT = 0x0003, count = 1
	const orientTag = littleEndian ? [0x12, 0x01] : [0x01, 0x12]
	const typeShort = littleEndian ? [0x03, 0x00] : [0x00, 0x03]
	const count1 = littleEndian ? [0x01, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x01]
	const orientValue = littleEndian ? [orientation, 0x00, 0x00, 0x00] : [0x00, orientation, 0x00, 0x00]

	// TIFF IFD: byteOrder(2) + magic(2) + ifdOffset(4) + entryCount(2) + entry(12)
	const tiffIfd = [...byteOrder, ...magic42, ...ifdOffset, ...entryCount, ...orientTag, ...typeShort, ...count1, ...orientValue]

	// APP1 segment: "Exif\0\0" + TIFF IFD
	const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
	const app1Data = [...exifHeader, ...tiffIfd]
	const app1Length = app1Data.length + 2 // +2 for the length field itself

	return new Uint8Array([
		// SOI
		0xff,
		0xd8,
		// APP1 marker
		0xff,
		0xe1,
		(app1Length >> 8) & 0xff,
		app1Length & 0xff,
		...app1Data,
		// SOS marker (end of metadata)
		0xff,
		0xda
	])
}

/**
 * Builds a minimal TIFF file (not wrapped in JPEG) with the given orientation value.
 */
function buildTiffWithOrientation(orientation: number, littleEndian = true): Uint8Array {
	const byteOrder = littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]
	const magic42 = littleEndian ? [0x2a, 0x00] : [0x00, 0x2a]
	const ifdOffset = littleEndian ? [0x08, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x08]
	const entryCount = littleEndian ? [0x01, 0x00] : [0x00, 0x01]
	const orientTag = littleEndian ? [0x12, 0x01] : [0x01, 0x12]
	const typeShort = littleEndian ? [0x03, 0x00] : [0x00, 0x03]
	const count1 = littleEndian ? [0x01, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x01]
	const orientValue = littleEndian ? [orientation, 0x00, 0x00, 0x00] : [0x00, orientation, 0x00, 0x00]

	return new Uint8Array([...byteOrder, ...magic42, ...ifdOffset, ...entryCount, ...orientTag, ...typeShort, ...count1, ...orientValue])
}

/**
 * Builds bytes that simulate a HEIC/HEIF file (or any non-JPEG/TIFF container)
 * with an embedded Exif block containing the given orientation value.
 */
function buildHeicWithOrientation(orientation: number, littleEndian = true): Uint8Array {
	// ftyp box header (identifies as HEIC)
	const ftyp = [
		0x00,
		0x00,
		0x00,
		0x14, // box size = 20
		0x66,
		0x74,
		0x79,
		0x70, // "ftyp"
		0x68,
		0x65,
		0x69,
		0x63, // "heic"
		0x00,
		0x00,
		0x00,
		0x00,
		0x68,
		0x65,
		0x69,
		0x63 // compatible brand "heic"
	]

	// Exif data block: "Exif\0\0" + TIFF IFD
	const tiff = buildTiffWithOrientation(orientation, littleEndian)
	const exifMarker = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]

	return new Uint8Array([...ftyp, ...exifMarker, ...tiff])
}

describe("parseExifOrientationFromBytes", () => {
	describe("JPEG", () => {
		it("returns 0 for orientation 1 (normal)", () => {
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(1))).toBe(0)
		})

		it("returns 180 for orientation 3", () => {
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(3))).toBe(180)
		})

		it("returns 90 for orientation 6 (90° CW)", () => {
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(6))).toBe(90)
		})

		it("returns 270 for orientation 8 (270° CW)", () => {
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(8))).toBe(270)
		})

		it("returns 0 for mirror orientations (2, 4, 5, 7)", () => {
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(2))).toBe(0)
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(4))).toBe(0)
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(5))).toBe(0)
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(7))).toBe(0)
		})

		it("handles big-endian JPEG EXIF", () => {
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(6, false))).toBe(90)
			expect(parseExifOrientationFromBytes(buildJpegWithOrientation(3, false))).toBe(180)
		})

		it("returns 0 for JPEG without APP1 segment", () => {
			// SOI + SOS (no APP1)
			const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])

			expect(parseExifOrientationFromBytes(bytes)).toBe(0)
		})

		it("skips non-EXIF APP1 segments", () => {
			// SOI + APP1 with XMP data (not "Exif\0\0") + SOS
			const xmpHeader = [0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f] // "http:/"
			const segLen = xmpHeader.length + 2
			const bytes = new Uint8Array([
				0xff,
				0xd8,
				0xff,
				0xe1,
				(segLen >> 8) & 0xff,
				segLen & 0xff,
				...xmpHeader,
				0xff,
				0xda,
				0x00,
				0x02
			])

			expect(parseExifOrientationFromBytes(bytes)).toBe(0)
		})
	})

	describe("TIFF", () => {
		it("reads orientation from little-endian TIFF", () => {
			expect(parseExifOrientationFromBytes(buildTiffWithOrientation(6))).toBe(90)
		})

		it("reads orientation from big-endian TIFF", () => {
			expect(parseExifOrientationFromBytes(buildTiffWithOrientation(8, false))).toBe(270)
		})

		it("returns 0 for TIFF with normal orientation", () => {
			expect(parseExifOrientationFromBytes(buildTiffWithOrientation(1))).toBe(0)
		})
	})

	describe("HEIC/HEIF (scan-based)", () => {
		it("finds orientation in HEIC-like container", () => {
			expect(parseExifOrientationFromBytes(buildHeicWithOrientation(6))).toBe(90)
		})

		it("handles big-endian EXIF in HEIC", () => {
			expect(parseExifOrientationFromBytes(buildHeicWithOrientation(3, false))).toBe(180)
		})

		it("returns 0 for normal orientation in HEIC", () => {
			expect(parseExifOrientationFromBytes(buildHeicWithOrientation(1))).toBe(0)
		})
	})

	describe("edge cases", () => {
		it("returns 0 for empty buffer", () => {
			expect(parseExifOrientationFromBytes(new Uint8Array(0))).toBe(0)
		})

		it("returns 0 for buffer too small", () => {
			expect(parseExifOrientationFromBytes(new Uint8Array(4))).toBe(0)
		})

		it("returns 0 for PNG (no EXIF orientation)", () => {
			// PNG magic bytes
			const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

			expect(parseExifOrientationFromBytes(png)).toBe(0)
		})

		it("returns 0 for random/garbage bytes", () => {
			const garbage = new Uint8Array(64)

			for (let i = 0; i < 64; i++) {
				garbage[i] = (i * 37 + 13) & 0xff
			}

			expect(parseExifOrientationFromBytes(garbage)).toBe(0)
		})

		it("returns 0 for truncated JPEG EXIF header", () => {
			// SOI + APP1 marker + length but truncated before TIFF header
			const bytes = new Uint8Array([
				0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00
				// Missing TIFF header
			])

			expect(parseExifOrientationFromBytes(bytes)).toBe(0)
		})

		it("returns 0 for TIFF with invalid magic number", () => {
			// Valid byte order but wrong magic (99 instead of 42)
			const bytes = new Uint8Array([
				0x49,
				0x49,
				0x63,
				0x00, // II + bad magic
				0x08,
				0x00,
				0x00,
				0x00,
				0x00,
				0x00,
				0x00,
				0x00
			])

			expect(parseExifOrientationFromBytes(bytes)).toBe(0)
		})

		it("returns 0 when IFD has no orientation tag", () => {
			// JPEG with EXIF but the IFD entry is for a different tag (0x010F = Make)
			const byteOrder = [0x49, 0x49]
			const magic42 = [0x2a, 0x00]
			const ifdOffset = [0x08, 0x00, 0x00, 0x00]
			const entryCount = [0x01, 0x00]
			// Make tag = 0x010F instead of orientation
			const makeTag = [0x0f, 0x01]
			const typeShort = [0x03, 0x00]
			const count1 = [0x01, 0x00, 0x00, 0x00]
			const value = [0x01, 0x00, 0x00, 0x00]

			const tiffIfd = [...byteOrder, ...magic42, ...ifdOffset, ...entryCount, ...makeTag, ...typeShort, ...count1, ...value]
			const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
			const app1Data = [...exifHeader, ...tiffIfd]
			const app1Length = app1Data.length + 2

			const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1Length >> 8) & 0xff, app1Length & 0xff, ...app1Data, 0xff, 0xda])

			expect(parseExifOrientationFromBytes(bytes)).toBe(0)
		})
	})
})

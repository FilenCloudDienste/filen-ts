import { describe, it, expect } from "vitest"
import { parseExifDate } from "@/lib/exif"

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
	})
})

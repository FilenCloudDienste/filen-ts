// EXIF datetime string format: "YYYY:MM:DD HH:MM:SS"
const EXIF_DATE_REGEX = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/

// EXIF timezone offset format: "+HH:MM" or "-HH:MM"
const EXIF_OFFSET_REGEX = /^([+-])(\d{2}):(\d{2})$/

// EXIF orientation tag ID
const ORIENTATION_TAG = 0x0112

function parseExifDateString(dateStr: string, subSec?: string, offset?: string): number | null {
	const match = EXIF_DATE_REGEX.exec(dateStr.trim())

	if (!match) {
		return null
	}

	const [, year, month, day, hour, minute, second] = match

	// Convert EXIF date format (YYYY:MM:DD) to ISO 8601 (YYYY-MM-DD) for Date.parse().
	let iso = `${year}-${month}-${day}T${hour}:${minute}:${second}`

	if (subSec) {
		// SubSec may be 1–3+ digits; pad to 3 then truncate for milliseconds.
		iso += `.${subSec.trim().padEnd(3, "0").slice(0, 3)}`
	}

	if (offset) {
		const offsetMatch = EXIF_OFFSET_REGEX.exec(offset.trim())

		if (offsetMatch) {
			iso += `${offsetMatch[1]}${offsetMatch[2]}:${offsetMatch[3]}`
		} else {
			iso += "Z"
		}
	} else {
		// No offset tag — EXIF stores local time in this case; treat as UTC for consistency.
		iso += "Z"
	}

	const ts = Date.parse(iso)

	return Number.isNaN(ts) ? null : ts
}

/**
 * Extracts a Unix timestamp (ms) from an expo-media-library EXIF data object.
 *
 * Field priority (most to least accurate):
 *   1. DateTimeOriginal  — moment the shutter was pressed (never changes)
 *   2. DateTimeDigitized — when stored as digital data (identical to original for digital cameras)
 *   3. DateTime          — file change date per spec, but often same as original; editing software
 *                          may update it, so it is the least reliable of the three
 *
 * Both iOS (fields nested under "{Exif}" / "{TIFF}") and Android (flat layout)
 * are handled transparently.
 *
 * Returns null if no parseable date field is found.
 */
export function parseExifDate(exif: Record<string, unknown>): number | null {
	if (!exif || typeof exif !== "object") {
		return null
	}

	// iOS groups fields under "{Exif}" and "{TIFF}"; Android uses a flat layout.
	const exifGroup = typeof exif["{Exif}"] === "object" && exif["{Exif}"] !== null ? (exif["{Exif}"] as Record<string, unknown>) : exif

	const tiffGroup = typeof exif["{TIFF}"] === "object" && exif["{TIFF}"] !== null ? (exif["{TIFF}"] as Record<string, unknown>) : {}

	// Returns the first string value found in the group, falling back to the top-level object.
	const str = (group: Record<string, unknown>, key: string): string | undefined => {
		const v = group[key] ?? exif[key]

		return typeof v === "string" ? v : undefined
	}

	// 1. DateTimeOriginal
	const dto = str(exifGroup, "DateTimeOriginal")

	if (dto) {
		const ts = parseExifDateString(dto, str(exifGroup, "SubSecTimeOriginal"), str(exifGroup, "OffsetTimeOriginal"))

		if (ts !== null) {
			return ts
		}
	}

	// 2. DateTimeDigitized
	const dtd = str(exifGroup, "DateTimeDigitized")

	if (dtd) {
		const ts = parseExifDateString(dtd, str(exifGroup, "SubSecTimeDigitized"), str(exifGroup, "OffsetTimeDigitized"))

		if (ts !== null) {
			return ts
		}
	}

	// 3. DateTime (last resort — may have been updated by editing software)
	const dt = str(tiffGroup, "DateTime") ?? str(exifGroup, "DateTime")

	if (dt) {
		const ts = parseExifDateString(dt, str(exifGroup, "SubSecTime"), str(exifGroup, "OffsetTime"))

		if (ts !== null) {
			return ts
		}
	}

	return null
}

/**
 * Reads a 16-bit unsigned integer from a byte array.
 */
function read16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
	if (littleEndian) {
		return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8)
	}

	return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number)
}

/**
 * Reads a 32-bit unsigned integer from a byte array.
 */
function read32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
	if (littleEndian) {
		return (
			(bytes[offset] as number) |
			((bytes[offset + 1] as number) << 8) |
			((bytes[offset + 2] as number) << 16) |
			((bytes[offset + 3] as number) << 24)
		)
	}

	return (
		((bytes[offset] as number) << 24) |
		((bytes[offset + 1] as number) << 16) |
		((bytes[offset + 2] as number) << 8) |
		(bytes[offset + 3] as number)
	)
}

/**
 * Maps an EXIF orientation value to clockwise rotation degrees.
 * Only handles pure rotations (1, 3, 6, 8) since mirror flips
 * are extremely rare in camera photos.
 */
function orientationToDegrees(orientation: number): number {
	switch (orientation) {
		case 3:
			return 180
		case 6:
			return 90
		case 8:
			return 270
		default:
			return 0
	}
}

/**
 * Parses the orientation tag from a TIFF IFD structure.
 * `tiffStart` is the absolute offset of the TIFF header (byte order mark) in the buffer.
 */
function parseTiffOrientation(bytes: Uint8Array, tiffStart: number): number {
	if (tiffStart + 8 > bytes.length) {
		return 0
	}

	const littleEndian = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49
	const bigEndian = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d

	if (!littleEndian && !bigEndian) {
		return 0
	}

	// Verify TIFF magic number (42)
	if (read16(bytes, tiffStart + 2, littleEndian) !== 0x002a) {
		return 0
	}

	// IFD0 offset (relative to TIFF start)
	const ifdOffset = read32(bytes, tiffStart + 4, littleEndian)

	if (ifdOffset === 0) {
		return 0
	}

	const ifdStart = tiffStart + ifdOffset

	if (ifdStart + 2 > bytes.length) {
		return 0
	}

	const entryCount = read16(bytes, ifdStart, littleEndian)

	for (let i = 0; i < entryCount; i++) {
		const entryOffset = ifdStart + 2 + i * 12

		if (entryOffset + 12 > bytes.length) {
			break
		}

		const tag = read16(bytes, entryOffset, littleEndian)

		if (tag === ORIENTATION_TAG) {
			return orientationToDegrees(read16(bytes, entryOffset + 8, littleEndian))
		}
	}

	return 0
}

/**
 * Checks if the bytes at `offset` contain "Exif\0\0".
 */
function isExifMarker(bytes: Uint8Array, offset: number): boolean {
	return (
		offset + 6 <= bytes.length &&
		bytes[offset] === 0x45 &&
		bytes[offset + 1] === 0x78 &&
		bytes[offset + 2] === 0x69 &&
		bytes[offset + 3] === 0x66 &&
		bytes[offset + 4] === 0x00 &&
		bytes[offset + 5] === 0x00
	)
}

/**
 * Parses EXIF orientation from a JPEG file's raw bytes.
 * Walks JPEG markers to find the APP1 segment containing EXIF data.
 */
function parseJpegOrientation(bytes: Uint8Array): number {
	let offset = 2

	while (offset + 4 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			return 0
		}

		const marker = bytes[offset + 1] as number

		// SOS marker — we've passed all metadata
		if (marker === 0xda) {
			return 0
		}

		const segmentLength = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)
		const segmentStart = offset + 4
		const segmentDataLength = segmentLength - 2

		// APP1 marker — may contain EXIF
		if (marker === 0xe1 && segmentDataLength >= 14 && isExifMarker(bytes, segmentStart)) {
			return parseTiffOrientation(bytes, segmentStart + 6)
		}

		offset += 2 + segmentLength
	}

	return 0
}

/**
 * Scans for "Exif\0\0" + TIFF header anywhere in the byte buffer.
 * Works for HEIC/HEIF (ISOBMFF container) and WebP (RIFF container)
 * where EXIF data is stored in format-specific containers but always
 * contains the standard "Exif\0\0" prefix before the TIFF header.
 */
function scanForExifOrientation(bytes: Uint8Array): number {
	// Scan for "Exif\0\0" marker — the TIFF header follows immediately after
	for (let i = 0; i + 14 < bytes.length; i++) {
		if (isExifMarker(bytes, i)) {
			return parseTiffOrientation(bytes, i + 6)
		}
	}

	return 0
}

/**
 * Parses the EXIF orientation from raw image file bytes and returns
 * the clockwise rotation in degrees needed to correct the orientation.
 *
 * Supports JPEG, TIFF, HEIC/HEIF, and WebP formats.
 * Returns 0 if no rotation is needed or the format is not recognized.
 */
export function parseExifOrientationFromBytes(bytes: Uint8Array): number {
	if (bytes.length < 12) {
		return 0
	}

	// JPEG: starts with 0xFFD8 — structured marker walk
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		return parseJpegOrientation(bytes)
	}

	// TIFF: starts with "II" (little-endian) or "MM" (big-endian) + magic 42
	if (
		((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) &&
		read16(bytes, 2, bytes[0] === 0x49) === 0x002a
	) {
		return parseTiffOrientation(bytes, 0)
	}

	// Other formats (HEIC, WebP, etc.) — scan for "Exif\0\0" marker
	return scanForExifOrientation(bytes)
}

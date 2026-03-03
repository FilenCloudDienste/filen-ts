// EXIF datetime string format: "YYYY:MM:DD HH:MM:SS"
const EXIF_DATE_REGEX = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/

// EXIF timezone offset format: "+HH:MM" or "-HH:MM"
const EXIF_OFFSET_REGEX = /^([+-])(\d{2}):(\d{2})$/

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
	// iOS groups fields under "{Exif}" and "{TIFF}"; Android uses a flat layout.
	const exifGroup =
		typeof exif["{Exif}"] === "object" && exif["{Exif}"] !== null
			? (exif["{Exif}"] as Record<string, unknown>)
			: exif

	const tiffGroup =
		typeof exif["{TIFF}"] === "object" && exif["{TIFF}"] !== null
			? (exif["{TIFF}"] as Record<string, unknown>)
			: {}

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

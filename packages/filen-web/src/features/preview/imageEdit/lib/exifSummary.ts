import { entryNumber, findEntry, openTiff, TAG_EXIF_IFD, TAG_GPS_IFD, type Tiff } from "@/features/preview/imageEdit/lib/jpegMeta"

// What a photo's Exif says about how and where it was taken (CIPA DC-008 2.32), read from its TIFF block. Every
// value is bounds-checked against the block: a tag whose value lies outside it (a truncated head, a corrupt count
// or offset) reads as absent, never as a wrong value.

// IFD0
const TAG_MAKE = 0x010f
const TAG_MODEL = 0x0110
const TAG_DATE_TIME = 0x0132
// Exif IFD
const TAG_EXPOSURE_TIME = 0x829a
const TAG_F_NUMBER = 0x829d
const TAG_ISO = 0x8827
const TAG_DATE_TIME_ORIGINAL = 0x9003
const TAG_FLASH = 0x9209
const TAG_FOCAL_LENGTH = 0x920a
const TAG_FOCAL_LENGTH_35MM = 0xa405
const TAG_LENS_MAKE = 0xa433
const TAG_LENS_MODEL = 0xa434
// GPS IFD
const TAG_GPS_LATITUDE_REF = 0x0001
const TAG_GPS_LATITUDE = 0x0002
const TAG_GPS_LONGITUDE_REF = 0x0003
const TAG_GPS_LONGITUDE = 0x0004

const TYPE_ASCII = 2
const TYPE_SHORT = 3
const TYPE_LONG = 4
const TYPE_RATIONAL = 5
const TYPE_SRATIONAL = 10
// Longer is not a make, model, lens or date: a corrupt count.
const MAX_ASCII_BYTES = 256

export interface ExifSummary {
	// When the picture was taken (DateTimeOriginal, else IFD0 DateTime) as a local-time epoch in ms.
	takenMs: number | null
	make: string | null
	model: string | null
	// LensModel, else LensMake.
	lens: string | null
	fNumber: number | null
	// In seconds.
	exposureSeconds: number | null
	iso: number | null
	// In mm.
	focalLength: number | null
	focalLength35mm: number | null
	flashFired: boolean | null
	// Decimal degrees, south and west negative; both or neither.
	latitude: number | null
	longitude: number | null
}

// Where an entry's `bytes` of value lie: inline in the entry up to 4 bytes, else at its offset. -1 when outside.
function valueAt(t: Tiff, entry: number, bytes: number): number {
	const at = bytes <= 4 ? entry + 8 : t.view.getUint32(entry + 8, t.le)

	return at + bytes <= t.view.byteLength ? at : -1
}

function entryOf(t: Tiff, ifd: number, tag: number): number {
	return ifd > 0 ? findEntry(t, ifd, tag) : -1
}

// An ASCII value up to its NUL, trimmed; null when absent, empty or outside the block.
function ascii(t: Tiff, ifd: number, tag: number): string | null {
	const entry = entryOf(t, ifd, tag)

	if (entry < 0 || t.view.getUint16(entry + 2, t.le) !== TYPE_ASCII) {
		return null
	}

	const count = t.view.getUint32(entry + 4, t.le)
	const at = count === 0 || count > MAX_ASCII_BYTES ? -1 : valueAt(t, entry, count)

	if (at < 0) {
		return null
	}

	let text = ""

	for (let i = 0; i < count; i++) {
		const code = t.view.getUint8(at + i)

		if (code === 0) {
			break
		}

		text += String.fromCharCode(code)
	}

	const trimmed = text.trim()

	return trimmed.length > 0 ? trimmed : null
}

// The first SHORT or LONG of an entry (ISO may carry several), or null.
function firstInteger(t: Tiff, ifd: number, tag: number): number | null {
	const entry = entryOf(t, ifd, tag)

	if (entry < 0) {
		return null
	}

	const type = t.view.getUint16(entry + 2, t.le)
	const count = t.view.getUint32(entry + 4, t.le)
	const size = type === TYPE_SHORT ? 2 : type === TYPE_LONG ? 4 : 0
	// Bounded like an ASCII count: a sane entry never holds more.
	const at = size === 0 || count === 0 || count > MAX_ASCII_BYTES ? -1 : valueAt(t, entry, count * size)

	if (at < 0) {
		return null
	}

	return size === 2 ? t.view.getUint16(at, t.le) : t.view.getUint32(at, t.le)
}

// The `index`th RATIONAL or SRATIONAL of an entry holding at least `count`, or null (a zero denominator included).
function rational(t: Tiff, entry: number, index: number, count: number): number | null {
	const type = t.view.getUint16(entry + 2, t.le)

	if ((type !== TYPE_RATIONAL && type !== TYPE_SRATIONAL) || t.view.getUint32(entry + 4, t.le) < count) {
		return null
	}

	const at = valueAt(t, entry, count * 8)

	if (at < 0) {
		return null
	}

	const offset = at + index * 8
	const signed = type === TYPE_SRATIONAL
	const numerator = signed ? t.view.getInt32(offset, t.le) : t.view.getUint32(offset, t.le)
	const denominator = signed ? t.view.getInt32(offset + 4, t.le) : t.view.getUint32(offset + 4, t.le)

	return denominator === 0 ? null : numerator / denominator
}

function positiveRational(t: Tiff, ifd: number, tag: number): number | null {
	const entry = entryOf(t, ifd, tag)
	const value = entry < 0 ? null : rational(t, entry, 0, 1)

	return value !== null && value > 0 && Number.isFinite(value) ? value : null
}

// Degrees, minutes, seconds and a hemisphere ref as decimal degrees, or null when any part is missing or out of range.
function coordinate(t: Tiff, ifd: number, tag: number, refTag: number, limit: number, negative: string): number | null {
	const entry = entryOf(t, ifd, tag)
	const ref = ascii(t, ifd, refTag)

	if (entry < 0 || ref === null) {
		return null
	}

	const degrees = rational(t, entry, 0, 3)
	const minutes = rational(t, entry, 1, 3)
	const seconds = rational(t, entry, 2, 3)

	if (degrees === null || minutes === null || seconds === null || minutes < 0 || seconds < 0) {
		return null
	}

	const value = degrees + minutes / 60 + seconds / 3600

	if (value < 0 || value > limit) {
		return null
	}

	return ref.toUpperCase() === negative ? -value : value
}

// "YYYY:MM:DD HH:MM:SS" (no zone: the camera's local time) as a local-time epoch in ms; null for the blank or zero
// dates cameras write when unset.
function exifDateMs(text: string | null): number | null {
	const match = text === null ? null : /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text)

	if (match === null) {
		return null
	}

	const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number)

	if (year === 0 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
		return null
	}

	return new Date(year, month - 1, day, hour, minute, second).getTime()
}

// An IFD pointer's target, or -1.
function subIfd(t: Tiff, ifd0: number, tag: number): number {
	const entry = findEntry(t, ifd0, tag)

	return entry < 0 ? -1 : entryNumber(t, entry)
}

// The summary of a TIFF block (an Exif payload without its "Exif\0\0" prefix, or a TIFF-based file's own head,
// camera RAW magics included), or null when it is not TIFF.
export function readExifSummary(tiff: Uint8Array): ExifSummary | null {
	const t = openTiff(new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength), true)

	if (t === null) {
		return null
	}

	const ifd0 = t.view.getUint32(4, t.le)
	const exif = subIfd(t, ifd0, TAG_EXIF_IFD)
	const gps = subIfd(t, ifd0, TAG_GPS_IFD)
	const flash = firstInteger(t, exif, TAG_FLASH)
	const latitude = coordinate(t, gps, TAG_GPS_LATITUDE, TAG_GPS_LATITUDE_REF, 90, "S")
	const longitude = coordinate(t, gps, TAG_GPS_LONGITUDE, TAG_GPS_LONGITUDE_REF, 180, "W")
	const iso = firstInteger(t, exif, TAG_ISO)
	const focal35 = firstInteger(t, exif, TAG_FOCAL_LENGTH_35MM)

	return {
		takenMs: exifDateMs(ascii(t, exif, TAG_DATE_TIME_ORIGINAL)) ?? exifDateMs(ascii(t, ifd0, TAG_DATE_TIME)),
		make: ascii(t, ifd0, TAG_MAKE),
		model: ascii(t, ifd0, TAG_MODEL),
		lens: ascii(t, exif, TAG_LENS_MODEL) ?? ascii(t, exif, TAG_LENS_MAKE),
		fNumber: positiveRational(t, exif, TAG_F_NUMBER),
		exposureSeconds: positiveRational(t, exif, TAG_EXPOSURE_TIME),
		iso: iso !== null && iso > 0 ? iso : null,
		focalLength: positiveRational(t, exif, TAG_FOCAL_LENGTH),
		focalLength35mm: focal35 !== null && focal35 > 0 ? focal35 : null,
		// Bit 0: the flash fired.
		flashFired: flash === null ? null : (flash & 1) === 1,
		latitude: latitude !== null && longitude !== null ? latitude : null,
		longitude: latitude !== null && longitude !== null ? longitude : null
	}
}

// ── Display ──────────────────────────────────────────────────────────────────

function trimmedNumber(value: number, digits: number): string {
	return String(Number(value.toFixed(digits)))
}

export function cameraLabel(make: string | null, model: string | null): string | null {
	if (model === null) {
		return make
	}

	return make === null || model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`
}

// "f/1.8"
export function formatFNumber(value: number): string {
	return `f/${trimmedNumber(value, 1)}`
}

// "1/120 s" below a second, "2 s" or "2.5 s" from one up.
export function formatExposure(seconds: number): string {
	return seconds >= 1 ? `${trimmedNumber(seconds, 1)} s` : `1/${String(Math.round(1 / seconds))} s`
}

// "26 mm", or "4.2 mm (35 mm: 26 mm)" with a 35 mm equivalent that differs.
export function formatFocalLength(focalLength: number, equivalent: number | null): string {
	const actual = `${trimmedNumber(focalLength, 1)} mm`

	return equivalent === null || equivalent === Math.round(focalLength) ? actual : `${actual} (35 mm: ${String(equivalent)} mm)`
}

// "52.5200° N, 13.4050° E"
export function formatCoordinates(latitude: number, longitude: number): string {
	const lat = `${Math.abs(latitude).toFixed(4)}° ${latitude < 0 ? "S" : "N"}`
	const lon = `${Math.abs(longitude).toFixed(4)}° ${longitude < 0 ? "W" : "E"}`

	return `${lat}, ${lon}`
}

import type { Orientation } from "@/features/preview/imageEdit/types"
import { log } from "@/lib/log"

// JPEG segment surgery (ITU-T T.81 Annex B) and the Exif/TIFF reading and patching every format's metadata
// shares (CIPA DC-008, TIFF 6.0 §2). Inputs are never written to: callers may hold them in a cache.

// ── Exif / TIFF ──────────────────────────────────────────────────────────────

const TAG_ORIENTATION = 0x0112
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_INTEROP_IFD = 0xa005
const TAG_PIXEL_X = 0xa002
const TAG_PIXEL_Y = 0xa003
const TAG_THUMBNAIL_OFFSET = 0x0201
const TAG_THUMBNAIL_LENGTH = 0x0202
const TYPE_SHORT = 3
const TYPE_LONG = 4

// Bytes per value of each TIFF field type (TIFF 6.0 §2, Exif adds 9 SLONG, 10 SRATIONAL); unknown types count as 1.
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]

interface Tiff {
	view: DataView
	le: boolean
}

// A TIFF header ("II*\0" little endian, "MM\0*" big endian) at the start of `view`, or null.
function openTiff(view: DataView): Tiff | null {
	if (view.byteLength < 8) {
		return null
	}

	const order = view.getUint16(0)
	const le = order === 0x4949

	if ((!le && order !== 0x4d4d) || view.getUint16(2, le) !== 42) {
		return null
	}

	return { view, le }
}

function viewOf(bytes: Uint8Array, start = 0, end = bytes.length): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset + start, end - start)
}

// The entry count of the IFD at `offset` when its entries lie inside the block, else -1.
function ifdCount(t: Tiff, offset: number): number {
	if (offset < 8 || offset + 2 > t.view.byteLength) {
		return -1
	}

	const count = t.view.getUint16(offset, t.le)

	return offset + 2 + count * 12 <= t.view.byteLength ? count : -1
}

// The offset of `tag`'s 12-byte entry in the IFD at `ifd`, or -1.
function findEntry(t: Tiff, ifd: number, tag: number): number {
	const count = ifdCount(t, ifd)

	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12
		const entryTag = t.view.getUint16(entry, t.le)

		if (entryTag === tag) {
			return entry
		}

		// Entries are sorted by tag (TIFF 6.0 §2): past it means absent.
		if (entryTag > tag) {
			return -1
		}
	}

	return -1
}

// The offset of the IFD after the one at `ifd` (0 for none), or -1 when it cannot be read.
function nextIfdPointer(t: Tiff, ifd: number): number {
	const count = ifdCount(t, ifd)
	const at = ifd + 2 + count * 12

	return count < 0 || at + 4 > t.view.byteLength ? -1 : at
}

function entryValueBytes(t: Tiff, entry: number): number {
	const type = t.view.getUint16(entry + 2, t.le)

	return (TYPE_SIZES[type] ?? 1) * t.view.getUint32(entry + 4, t.le)
}

// A single SHORT or LONG value (for pointers and dimensions), or -1.
function entryNumber(t: Tiff, entry: number): number {
	const type = t.view.getUint16(entry + 2, t.le)

	if (t.view.getUint32(entry + 4, t.le) !== 1) {
		return -1
	}

	return type === TYPE_SHORT ? t.view.getUint16(entry + 8, t.le) : type === TYPE_LONG ? t.view.getUint32(entry + 8, t.le) : -1
}

function writeShort(t: Tiff, entry: number, value: number): void {
	t.view.setUint16(entry + 2, TYPE_SHORT, t.le)
	t.view.setUint32(entry + 4, 1, t.le)
	t.view.setUint16(entry + 8, value, t.le)
	t.view.setUint16(entry + 10, 0, t.le)
}

function writeDimension(t: Tiff, entry: number, value: number): void {
	if (value <= 0xffff && t.view.getUint16(entry + 2, t.le) === TYPE_SHORT) {
		writeShort(t, entry, value)

		return
	}

	t.view.setUint16(entry + 2, TYPE_LONG, t.le)
	t.view.setUint32(entry + 4, 1, t.le)
	t.view.setUint32(entry + 8, value, t.le)
}

function toOrientation(value: number): Orientation {
	return value >= 1 && value <= 8 ? (value as Orientation) : 1
}

function orientationIn(t: Tiff): Orientation {
	const entry = findEntry(t, t.view.getUint32(4, t.le), TAG_ORIENTATION)

	return entry < 0 ? 1 : toOrientation(t.view.getUint16(entry + 2, t.le) === TYPE_SHORT ? t.view.getUint16(entry + 8, t.le) : 0)
}

// The Orientation in IFD0 of a TIFF block (1 when absent or out of range).
export function readExifOrientation(tiff: Uint8Array): Orientation {
	const t = openTiff(viewOf(tiff))

	return t === null ? 1 : orientationIn(t)
}

// One past the last byte an IFD and its out-of-line values use, folding in its sub-IFDs.
function ifdExtent(t: Tiff, ifd: number, subIfdTags: readonly number[], depth: number): number {
	const count = ifdCount(t, ifd)

	if (count < 0 || depth > 2) {
		return 0
	}

	let end = Math.min(t.view.byteLength, ifd + 2 + count * 12 + 4)

	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12
		const size = entryValueBytes(t, entry)

		if (size > 4) {
			end = Math.max(end, Math.min(t.view.byteLength, t.view.getUint32(entry + 8, t.le) + size))
		}

		if (subIfdTags.includes(t.view.getUint16(entry, t.le))) {
			const sub = entryNumber(t, entry)

			if (sub > 0) {
				end = Math.max(end, ifdExtent(t, sub, [TAG_INTEROP_IFD], depth + 1))
			}
		}
	}

	return end
}

// Where the block can end once IFD1 goes: at IFD1 (or its thumbnail, if earlier) when IFD1 and the thumbnail
// make up the tail of the block and nothing IFD0, Exif, GPS or Interop use lies past that point. Otherwise the
// full length: the dead bytes stay rather than risk cutting data a maker note points into.
function lengthWithoutIfd1(t: Tiff, ifd0: number, ifd1: number): number {
	const length = t.view.byteLength

	if (ifd1 <= 0 || ifdCount(t, ifd1) < 0) {
		return length
	}

	let cutStart = ifd1
	let cutEnd = ifdExtent(t, ifd1, [], 0)
	const thumbEntry = findEntry(t, ifd1, TAG_THUMBNAIL_OFFSET)
	const thumbLengthEntry = findEntry(t, ifd1, TAG_THUMBNAIL_LENGTH)

	if (thumbEntry >= 0 && thumbLengthEntry >= 0) {
		const thumb = entryNumber(t, thumbEntry)
		const thumbLength = entryNumber(t, thumbLengthEntry)

		if (thumb > 0 && thumbLength > 0) {
			cutStart = Math.min(cutStart, thumb)
			cutEnd = Math.max(cutEnd, thumb + thumbLength)
		}
	}

	const liveEnd = ifdExtent(t, ifd0, [TAG_EXIF_IFD, TAG_GPS_IFD, TAG_INTEROP_IFD], 0)

	// Word alignment padding (TIFF 6.0 §2) may trail the thumbnail.
	return cutStart >= liveEnd && cutEnd >= length - 1 ? cutStart : length
}

// A copy of a TIFF block fit for a re-encoded image: Orientation set to 1 where present (the pixels are now
// upright), IFD1 and its thumbnail dropped (it shows the old picture), and Exif PixelX/YDimension rewritten to
// `size` where present. Null when the block is not TIFF.
export function normalizeExif(tiff: Uint8Array, size: { width: number; height: number } | null): Uint8Array | null {
	const source = openTiff(viewOf(tiff))

	if (source === null) {
		return null
	}

	const ifd0 = source.view.getUint32(4, source.le)
	const nextAt = nextIfdPointer(source, ifd0)

	if (nextAt < 0) {
		return null
	}

	const ifd1 = source.view.getUint32(nextAt, source.le)
	const out = tiff.slice(0, lengthWithoutIfd1(source, ifd0, ifd1))
	const t: Tiff = { view: viewOf(out), le: source.le }

	t.view.setUint32(nextAt, 0, t.le)

	const orientation = findEntry(t, ifd0, TAG_ORIENTATION)

	if (orientation >= 0) {
		writeShort(t, orientation, 1)
	}

	const exifEntry = findEntry(t, ifd0, TAG_EXIF_IFD)

	if (size !== null && exifEntry >= 0) {
		const exifIfd = entryNumber(t, exifEntry)
		const x = exifIfd > 0 ? findEntry(t, exifIfd, TAG_PIXEL_X) : -1
		const y = exifIfd > 0 ? findEntry(t, exifIfd, TAG_PIXEL_Y) : -1

		if (x >= 0) {
			writeDimension(t, x, size.width)
		}

		if (y >= 0) {
			writeDimension(t, y, size.height)
		}
	}

	return out
}

// A big-endian TIFF block holding only IFD0 with Orientation: 8 header + 2 count + 12 entry + 4 next.
function minimalExif(orientation: Orientation): Uint8Array {
	const out = new Uint8Array(26)
	const view = new DataView(out.buffer)

	view.setUint32(0, 0x4d4d002a)
	view.setUint32(4, 8)
	view.setUint16(8, 1)
	view.setUint16(10, TAG_ORIENTATION)
	view.setUint16(12, TYPE_SHORT)
	view.setUint32(14, 1)
	view.setUint16(18, orientation)

	return out
}

// ── JPEG segments ────────────────────────────────────────────────────────────

export const MARKER_SOS = 0xda
const MARKER_EOI = 0xd9
const MARKER_APP0 = 0xe0
const MARKER_APP1 = 0xe1
const MARKER_APP2 = 0xe2

// A segment's length field counts itself, so its payload is at most 65533 bytes (T.81 B.1.1.4).
const MAX_SEGMENT_LENGTH = 0xffff
const EXIF_HEADER_LENGTH = 6
// "ICC_PROFILE\0", sequence number, chunk count (ICC.1 Annex B.4).
const ICC_HEADER_LENGTH = 14
const MAX_ICC_CHUNK = MAX_SEGMENT_LENGTH - 2 - ICC_HEADER_LENGTH

export interface JpegSegment {
	marker: number
	// The 0xFF of the marker.
	start: number
	// Payload, after the length field; equal for markers without one.
	payloadStart: number
	end: number
}

// Standalone markers carry no length (T.81 B.1.1.3): TEM, RSTn, SOI, EOI.
function isStandalone(marker: number): boolean {
	return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
}

// Walks the segments after SOI up to SOS (which is reported, then the walk stops) or EOI. `visit` returning
// false stops early. Returns where the walk ended: the SOS marker's offset, the end of the last whole segment
// when the bytes run out, or -1 when they are not JPEG.
export function walkJpegSegments(bytes: Uint8Array, visit: (segment: JpegSegment) => boolean): number {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return -1
	}

	let pos = 2

	while (pos + 1 < bytes.length) {
		if (bytes[pos] !== 0xff) {
			return -1
		}

		// Fill bytes: any number of 0xFF may precede a marker (T.81 B.1.1.2).
		let markerAt = pos + 1

		while (markerAt < bytes.length && bytes[markerAt] === 0xff) {
			markerAt++
		}

		const marker = bytes[markerAt]

		if (marker === undefined) {
			return pos
		}

		if (isStandalone(marker)) {
			const segment = { marker, start: pos, payloadStart: markerAt + 1, end: markerAt + 1 }

			if (!visit(segment) || marker === MARKER_EOI) {
				return segment.end
			}

			pos = segment.end

			continue
		}

		if (markerAt + 3 > bytes.length) {
			return pos
		}

		const length = ((bytes[markerAt + 1] ?? 0) << 8) | (bytes[markerAt + 2] ?? 0)
		const end = markerAt + 1 + length

		if (length < 2 || (marker !== MARKER_SOS && end > bytes.length)) {
			return length < 2 ? -1 : pos
		}

		const segment = { marker, start: pos, payloadStart: markerAt + 3, end }

		if (!visit(segment) || marker === MARKER_SOS) {
			return marker === MARKER_SOS ? pos : end
		}

		pos = end
	}

	return pos
}

function startsWith(bytes: Uint8Array, at: number, ascii: string): boolean {
	if (at + ascii.length > bytes.length) {
		return false
	}

	for (let i = 0; i < ascii.length; i++) {
		if (bytes[at + i] !== ascii.charCodeAt(i)) {
			return false
		}
	}

	return true
}

// APP1 "Exif\0" then a pad byte, 0x00 per CIPA DC-008 §4.7.2 (some writers put 0xFF).
export function isExifPayload(bytes: Uint8Array, at: number): boolean {
	return startsWith(bytes, at, "Exif\0") && (bytes[at + 5] === 0x00 || bytes[at + 5] === 0xff)
}

export function isIccPayload(bytes: Uint8Array, at: number): boolean {
	return startsWith(bytes, at, "ICC_PROFILE\0")
}

const XMP_ID = "http://ns.adobe.com/xap/1.0/\0"

function writeSegmentHeader(out: Uint8Array, at: number, marker: number, payloadLength: number): number {
	out[at] = 0xff
	out[at + 1] = marker
	out[at + 2] = (payloadLength + 2) >> 8
	out[at + 3] = (payloadLength + 2) & 0xff

	return at + 4
}

// Re-wraps an encoder's JPEG with the original's metadata: SOI, APP1 Exif (normalised: Orientation 1, no IFD1,
// PixelX/YDimension = width/height), APP2 ICC chunks, then the encoder's own segments without its APP0/1/2.
export function buildJpeg(
	encoded: Uint8Array,
	meta: { exif: Uint8Array | null; icc: Uint8Array | null; width: number; height: number }
): Uint8Array {
	const kept: [number, number][] = []
	const stop = walkJpegSegments(encoded, segment => {
		if (segment.marker !== MARKER_APP0 && segment.marker !== MARKER_APP1 && segment.marker !== MARKER_APP2) {
			kept.push([segment.start, segment.marker === MARKER_SOS ? encoded.length : segment.end])
		}

		return true
	})

	if (stop < 0) {
		throw new Error("the encoder's output is not a JPEG")
	}

	let exif = meta.exif === null ? null : normalizeExif(meta.exif, { width: meta.width, height: meta.height })

	if (exif !== null && exif.length + EXIF_HEADER_LENGTH + 2 > MAX_SEGMENT_LENGTH) {
		log.warn("imageEdit", `Exif of ${String(exif.length)} bytes does not fit one APP1 segment; dropped`)

		exif = null
	}

	let icc = meta.icc !== null && meta.icc.length > 0 ? meta.icc : null
	const iccChunks = icc === null ? 0 : Math.ceil(icc.length / MAX_ICC_CHUNK)

	if (iccChunks > 255) {
		log.warn("imageEdit", `ICC profile of ${String(icc?.length ?? 0)} bytes exceeds 255 APP2 chunks; dropped`)

		icc = null
	}

	let total = 2 + (exif === null ? 0 : 4 + EXIF_HEADER_LENGTH + exif.length)

	if (icc !== null) {
		total += iccChunks * (4 + ICC_HEADER_LENGTH) + icc.length
	}

	for (const [start, end] of kept) {
		total += end - start
	}

	const out = new Uint8Array(total)
	let at = 2

	out[0] = 0xff
	out[1] = 0xd8

	if (exif !== null) {
		at = writeSegmentHeader(out, at, MARKER_APP1, EXIF_HEADER_LENGTH + exif.length)
		out.set([0x45, 0x78, 0x69, 0x66, 0, 0], at)
		out.set(exif, at + EXIF_HEADER_LENGTH)
		at += EXIF_HEADER_LENGTH + exif.length
	}

	if (icc !== null) {
		for (let chunk = 0; chunk < iccChunks; chunk++) {
			const piece = icc.subarray(chunk * MAX_ICC_CHUNK, (chunk + 1) * MAX_ICC_CHUNK)

			at = writeSegmentHeader(out, at, MARKER_APP2, ICC_HEADER_LENGTH + piece.length)

			for (let i = 0; i < 12; i++) {
				out[at + i] = "ICC_PROFILE\0".charCodeAt(i)
			}

			out[at + 12] = chunk + 1
			out[at + 13] = iccChunks
			out.set(piece, at + ICC_HEADER_LENGTH)
			at += ICC_HEADER_LENGTH + piece.length
		}
	}

	for (const [start, end] of kept) {
		out.set(encoded.subarray(start, end), at)
		at += end - start
	}

	return out
}

// ── Lossless orientation rewrite ─────────────────────────────────────────────

interface Splice {
	// Replaces bytes [start, end) of the head.
	start: number
	end: number
	bytes: Uint8Array
}

// The APP1 Exif segment with Orientation set: in place when IFD0 has the tag; otherwise IFD0 rebuilt with it at the
// end of the TIFF block (its old copy left unreferenced, every offset still valid). "unchanged" when the tag is
// absent and 1 is asked for (absent means 1); null when the block is unreadable or the segment cannot grow.
function exifSegmentWithOrientation(head: Uint8Array, segment: JpegSegment, orientation: Orientation): Uint8Array | "unchanged" | null {
	const tiffStart = segment.payloadStart + EXIF_HEADER_LENGTH
	const t = openTiff(viewOf(head, tiffStart, segment.end))

	if (t === null) {
		return null
	}

	const ifd0 = t.view.getUint32(4, t.le)
	const count = ifdCount(t, ifd0)
	const nextAt = nextIfdPointer(t, ifd0)

	if (count < 0 || nextAt < 0) {
		return null
	}

	const entry = findEntry(t, ifd0, TAG_ORIENTATION)

	if (entry >= 0) {
		const out = head.slice(segment.start, segment.end)

		writeShort({ view: viewOf(out, tiffStart - segment.start), le: t.le }, entry, orientation)

		return out
	}

	if (orientation === 1) {
		return "unchanged"
	}

	const tiffLength = segment.end - tiffStart
	// IFDs start on a word boundary (TIFF 6.0 §2).
	const newIfd = tiffLength + (tiffLength % 2)
	const newTiffLength = newIfd + 2 + (count + 1) * 12 + 4
	const payloadLength = EXIF_HEADER_LENGTH + newTiffLength

	if (payloadLength + 2 > MAX_SEGMENT_LENGTH) {
		return null
	}

	// Rebuilt from the payload: any fill bytes before the marker are dropped.
	const out = new Uint8Array(4 + payloadLength)

	writeSegmentHeader(out, 0, MARKER_APP1, payloadLength)
	out.set(head.subarray(segment.payloadStart, segment.end), 4)

	const newTiff = 4 + EXIF_HEADER_LENGTH
	const n: Tiff = { view: viewOf(out, newTiff), le: t.le }
	let written = 0
	let inserted = false

	n.view.setUint32(4, newIfd, n.le)
	n.view.setUint16(newIfd, count + 1, n.le)

	for (let i = 0; i <= count; i++) {
		const target = newIfd + 2 + written * 12
		const oldEntry = ifd0 + 2 + i * 12

		if (!inserted && (i === count || t.view.getUint16(oldEntry, t.le) > TAG_ORIENTATION)) {
			n.view.setUint16(target, TAG_ORIENTATION, n.le)
			writeShort(n, target, orientation)
			inserted = true
			written++
		}

		if (i < count) {
			out.set(head.subarray(tiffStart + oldEntry, tiffStart + oldEntry + 12), newTiff + newIfd + 2 + written * 12)
			written++
		}
	}

	n.view.setUint32(newIfd + 2 + (count + 1) * 12, t.view.getUint32(nextAt, t.le), n.le)

	return out
}

const XMP_TAG = "tiff:Orientation"

function isSpace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

function indexOfAscii(bytes: Uint8Array, ascii: string, from: number, to: number): number {
	for (let i = from; i + ascii.length <= to; i++) {
		if (startsWith(bytes, i, ascii)) {
			return i
		}
	}

	return -1
}

// Sets every tiff:Orientation in an XMP packet (written in place into `segment`, a copy): a one-digit value is
// overwritten; any other is blanked out with spaces, which XML allows between attributes and in element content.
// Returns whether anything changed.
function patchXmpOrientation(segment: Uint8Array, from: number, orientation: Orientation): boolean {
	let changed = false
	let at = indexOfAscii(segment, XMP_TAG, from, segment.length)

	while (at >= 0) {
		let next = at + XMP_TAG.length
		let cursor = next

		while (isSpace(segment[cursor])) {
			cursor++
		}

		let valueStart = -1
		let valueEnd = -1
		let blankStart = at
		let blankEnd = -1

		if (segment[cursor] === 0x3d && segment[at - 1] !== 0x2f && segment[at - 1] !== 0x3c) {
			// Attribute form: tiff:Orientation="6"
			cursor++

			while (isSpace(segment[cursor])) {
				cursor++
			}

			const quote = segment[cursor]

			if (quote === 0x22 || quote === 0x27) {
				valueStart = cursor + 1
				valueEnd = segment.indexOf(quote, valueStart)
				blankEnd = valueEnd + 1
			}
		} else if (segment[cursor] === 0x3e && segment[at - 1] === 0x3c) {
			// Element form: <tiff:Orientation>6</tiff:Orientation>
			valueStart = cursor + 1
			valueEnd = segment.indexOf(0x3c, valueStart)
			blankStart = at - 1

			const closing = `</${XMP_TAG}>`

			if (valueEnd >= 0 && startsWith(segment, valueEnd, closing)) {
				blankEnd = valueEnd + closing.length
			}
		}

		if (valueStart >= 0 && valueEnd >= valueStart && blankEnd > 0) {
			if (valueEnd - valueStart === 1) {
				segment[valueStart] = 0x30 + orientation
			} else {
				segment.fill(0x20, blankStart, blankEnd)
			}

			changed = true
			next = blankEnd
		}

		at = indexOfAscii(segment, XMP_TAG, next, segment.length)
	}

	return changed
}

// For a lossless turn/flip of a JPEG: `head` is the file's bytes up to (not including) SOS; anything from SOS on
// passes through untouched. Returns the head with Orientation set (Exif in place, or IFD0 rebuilt with the tag,
// or a minimal Exif APP1 inserted after SOI / the JFIF APP0s) and any XMP tiff:Orientation matched, plus the
// length change. Null when the head is not a JPEG, ends inside a segment, or the Exif segment cannot grow.
export function rewriteOrientationHead(head: Uint8Array, orientation: Orientation): { head: Uint8Array; delta: number } | null {
	const splices: Splice[] = []
	// Written by the walk's callback (an object, so the reads after it are not narrowed to the initial values).
	const walk = { exifSeen: false, sosSeen: false, failed: false, insertAt: 2, leadingApp0: true }
	const stop = walkJpegSegments(head, segment => {
		if (segment.marker === MARKER_SOS) {
			walk.sosSeen = true

			return false
		}

		if (walk.leadingApp0 && segment.marker === MARKER_APP0) {
			walk.insertAt = segment.end
		} else {
			walk.leadingApp0 = false
		}

		if (segment.marker !== MARKER_APP1) {
			return true
		}

		if (!walk.exifSeen && isExifPayload(head, segment.payloadStart)) {
			walk.exifSeen = true

			const rewritten = exifSegmentWithOrientation(head, segment, orientation)

			if (rewritten === null) {
				walk.failed = true

				return false
			}

			if (rewritten !== "unchanged") {
				splices.push({ start: segment.start, end: segment.end, bytes: rewritten })
			}
		} else if (startsWith(head, segment.payloadStart, XMP_ID)) {
			const copy = head.slice(segment.start, segment.end)

			if (patchXmpOrientation(copy, segment.payloadStart - segment.start + XMP_ID.length, orientation)) {
				splices.push({ start: segment.start, end: segment.end, bytes: copy })
			}
		}

		return true
	})

	// Not JPEG, an unusable Exif block, or a segment cut off by the end of the head (the bytes after it would be
	// misread as the scan).
	if (walk.failed || stop < 0 || (!walk.sosSeen && stop !== head.length)) {
		return null
	}

	if (!walk.exifSeen && orientation !== 1) {
		const tiff = minimalExif(orientation)
		const segment = new Uint8Array(4 + EXIF_HEADER_LENGTH + tiff.length)

		writeSegmentHeader(segment, 0, MARKER_APP1, EXIF_HEADER_LENGTH + tiff.length)
		segment.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4)
		segment.set(tiff, 4 + EXIF_HEADER_LENGTH)
		// Before any segment rewritten at the same offset.
		splices.unshift({ start: walk.insertAt, end: walk.insertAt, bytes: segment })
	}

	if (splices.length === 0) {
		return { head, delta: 0 }
	}

	let delta = 0

	for (const splice of splices) {
		delta += splice.bytes.length - (splice.end - splice.start)
	}

	const out = new Uint8Array(head.length + delta)
	let read = 0
	let write = 0

	for (const splice of splices) {
		out.set(head.subarray(read, splice.start), write)
		write += splice.start - read
		out.set(splice.bytes, write)
		write += splice.bytes.length
		read = splice.end
	}

	out.set(head.subarray(read), write)

	return { head: out, delta }
}

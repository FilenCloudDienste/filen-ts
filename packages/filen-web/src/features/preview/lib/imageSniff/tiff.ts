import { viewOf } from "@/features/preview/lib/imageSniff/bytes"

// TIFF 6.0 §2: byte order ("II" little, "MM" big endian), the version (42; 43 is BigTIFF, which the engine does not
// read), then the first IFD's offset. An IFD may sit anywhere in the file, so its dimensions are known only when it
// lies within the head; past it they stay unknown and the decode's own extent check decides.

export type TiffHeader =
	| { readonly kind: "bigTiff" }
	| {
			readonly kind: "tiff"
			// Page 1's pixels; null when its IFD lies past the head or lacks them.
			readonly size: { readonly width: number; readonly height: number } | null
			// The IFD chain's length; null when it leaves the head, goes back or exceeds MAX_TIFF_IFDS.
			readonly pages: number | null
	  }

export const MAX_TIFF_IFDS = 64

const TAG_IMAGE_WIDTH = 256
const TAG_IMAGE_LENGTH = 257
const TYPE_SHORT = 3
const TYPE_LONG = 4
const IFD_ENTRY_BYTES = 12

function byteOrder(head: Uint8Array): boolean | null {
	if (head[0] === 0x49 && head[1] === 0x49) {
		return true
	}

	if (head[0] === 0x4d && head[1] === 0x4d) {
		return false
	}

	return null
}

// The offset of the next IFD's pointer, or -1 when the IFD's entries leave the head.
function ifdEnd(view: DataView, at: number, little: boolean): number {
	if (at + 2 > view.byteLength) {
		return -1
	}

	const end = at + 2 + view.getUint16(at, little) * IFD_ENTRY_BYTES

	return end + 4 <= view.byteLength ? end : -1
}

function readDimensions(view: DataView, at: number, end: number, little: boolean): { width: number; height: number } | null {
	let width = 0
	let height = 0

	for (let entry = at + 2; entry < end; entry += IFD_ENTRY_BYTES) {
		const tag = view.getUint16(entry, little)

		if ((tag !== TAG_IMAGE_WIDTH && tag !== TAG_IMAGE_LENGTH) || view.getUint32(entry + 4, little) !== 1) {
			continue
		}

		const type = view.getUint16(entry + 2, little)
		const value = type === TYPE_SHORT ? view.getUint16(entry + 8, little) : type === TYPE_LONG ? view.getUint32(entry + 8, little) : 0

		if (tag === TAG_IMAGE_WIDTH) {
			width = value
		} else {
			height = value
		}
	}

	return width > 0 && height > 0 ? { width, height } : null
}

export function sniffTiff(head: Uint8Array, fileSize: number): TiffHeader | null {
	if (head.length < 8) {
		return null
	}

	const little = byteOrder(head)

	if (little === null) {
		return null
	}

	const view = viewOf(head)
	const version = view.getUint16(2, little)

	if (version === 43) {
		return { kind: "bigTiff" }
	}

	const first = view.getUint32(4, little)

	if (version !== 42 || first < 8 || first >= fileSize) {
		return null
	}

	let size: { width: number; height: number } | null = null
	let pages: number | null = null
	let at = first

	for (let count = 1; count <= MAX_TIFF_IFDS; count++) {
		const end = ifdEnd(view, at, little)

		if (end < 0) {
			break
		}

		if (count === 1) {
			size = readDimensions(view, at, end, little)
		}

		const next = view.getUint32(end, little)

		if (next === 0) {
			pages = count

			break
		}

		// A chain that points back (or at itself) is a loop or a broken file: its length stays unknown.
		if (next <= at || next >= fileSize) {
			break
		}

		at = next
	}

	return { kind: "tiff", size, pages }
}

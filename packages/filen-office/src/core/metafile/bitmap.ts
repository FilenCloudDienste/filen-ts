// Picture files rebuilt from the forms Word, RTF and OfficeArt store them in: a packed DIB as a .bmp, and a Windows
// metafile stored without its placeable header with that header back in front.

// [MS-WMF] §2.3.2.3 META_PLACEABLE: its key and size.
const PLACEABLE_KEY = 0x9ac6cdd7
export const PLACEABLE_HEADER = 22

export interface PlaceableFrame {
	// The picture's bounding box in logical units (int16 each) and the logical units per inch.
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
	readonly inch: number
}

export function hasPlaceableHeader(wmf: Uint8Array): boolean {
	return wmf.length >= 4 && new DataView(wmf.buffer, wmf.byteOffset, wmf.byteLength).getUint32(0, true) === PLACEABLE_KEY
}

// The metafile with a placeable header for `frame` in front; the caller decides the frame and bounds it to int16.
export function withPlaceableHeader(wmf: Uint8Array, frame: PlaceableFrame): Uint8Array {
	const out = new Uint8Array(PLACEABLE_HEADER + wmf.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, PLACEABLE_KEY, true)
	view.setInt16(6, frame.left, true)
	view.setInt16(8, frame.top, true)
	view.setInt16(10, frame.right, true)
	view.setInt16(12, frame.bottom, true)
	view.setUint16(14, frame.inch, true)

	let checksum = 0

	// The XOR of the ten words before it.
	for (let at = 0; at < 20; at += 2) checksum ^= view.getUint16(at, true)

	view.setUint16(20, checksum, true)
	out.set(wmf, PLACEABLE_HEADER)

	return out
}

// A packed DIB (BITMAPINFO, then the pixels) with a BITMAPFILEHEADER in front, its bfOffBits past the header, the
// BI_BITFIELDS masks and the palette (3 bytes an entry after a BITMAPCOREHEADER, 4 after the others) and never past
// the file's end, so a truncated palette still points into the file. Under 16 bytes there is no header to read and
// the bytes are returned as they are.
export function dibToBmp(dib: Uint8Array): Uint8Array {
	if (dib.length < 16) return dib

	const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength)
	const headerSize = view.getUint32(0, true)
	let palette = 0

	if (headerSize === 12) {
		const bits = view.getUint16(10, true)

		palette = bits <= 8 ? (1 << bits) * 3 : 0
	} else {
		const bits = view.getUint16(14, true)
		const compression = dib.length >= 20 ? view.getUint32(16, true) : 0
		const used = headerSize >= 36 && dib.length >= 36 ? view.getUint32(32, true) : 0

		palette = (used > 0 ? used : bits <= 8 ? 1 << bits : 0) * 4

		// BI_BITFIELDS masks follow a BITMAPINFOHEADER.
		if (headerSize === 40 && compression === 3) palette += 12
	}

	const out = new Uint8Array(14 + dib.length)
	const outView = new DataView(out.buffer)

	out[0] = 0x42
	out[1] = 0x4d
	outView.setUint32(2, out.length, true)
	outView.setUint32(10, Math.min(out.length, 14 + headerSize + palette), true)
	out.set(dib, 14)

	return out
}

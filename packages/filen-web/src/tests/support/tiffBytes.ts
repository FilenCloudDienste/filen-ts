// Baseline TIFF (TIFF 6.0, little endian): uncompressed 8-bit RGB pages, one strip each, chained IFDs, for fixtures.

export interface TiffPage {
	readonly width: number
	readonly height: number
	// RGB of the page's one colour.
	readonly rgb: readonly [number, number, number]
}

const SHORT = 3
const LONG = 4
const ENTRY_BYTES = 12

export function encodeTiff(pages: readonly TiffPage[]): Uint8Array {
	const parts: Uint8Array[] = []
	let length = 8
	const header = new Uint8Array(8)
	const headerView = new DataView(header.buffer)

	header.set([0x49, 0x49])
	headerView.setUint16(2, 42, true)
	parts.push(header)

	// Where each page's IFD lands, to chain them and point the header at the first.
	const ifdAt: number[] = []
	const nextFields: { view: DataView; at: number }[] = []

	for (const page of pages) {
		const pixels = new Uint8Array(page.width * page.height * 3)

		for (let i = 0; i < pixels.length; i += 3) {
			pixels.set(page.rgb, i)
		}

		const pixelsAt = length

		parts.push(pixels)
		length += pixels.length

		if (length % 2 === 1) {
			parts.push(new Uint8Array(1))
			length++
		}

		const bitsAt = length

		parts.push(Uint8Array.from([8, 0, 8, 0, 8, 0]))
		length += 6

		const entries: [tag: number, type: number, count: number, value: number][] = [
			[256, LONG, 1, page.width],
			[257, LONG, 1, page.height],
			[258, SHORT, 3, bitsAt],
			[259, SHORT, 1, 1],
			[262, SHORT, 1, 2],
			[273, LONG, 1, pixelsAt],
			[277, SHORT, 1, 3],
			[278, LONG, 1, page.height],
			[279, LONG, 1, pixels.length],
			[284, SHORT, 1, 1]
		]
		const ifd = new Uint8Array(2 + entries.length * ENTRY_BYTES + 4)
		const view = new DataView(ifd.buffer)

		view.setUint16(0, entries.length, true)
		entries.forEach(([tag, type, count, value], index) => {
			const at = 2 + index * ENTRY_BYTES

			view.setUint16(at, tag, true)
			view.setUint16(at + 2, type, true)
			view.setUint32(at + 4, count, true)

			if (type === SHORT && count === 1) {
				view.setUint16(at + 8, value, true)
			} else {
				view.setUint32(at + 8, value, true)
			}
		})

		ifdAt.push(length)
		nextFields.push({ view, at: 2 + entries.length * ENTRY_BYTES })
		parts.push(ifd)
		length += ifd.length
	}

	headerView.setUint32(4, ifdAt[0] ?? 0, true)
	nextFields.forEach(({ view, at }, index) => {
		view.setUint32(at, ifdAt[index + 1] ?? 0, true)
	})

	const out = new Uint8Array(length)
	let offset = 0

	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

// A BigTIFF's header (version 43, 8-byte offsets), which the engine does not read: what is past it never matters.
export function bigTiffHeader(): Uint8Array {
	const bytes = new Uint8Array(64)
	const view = new DataView(bytes.buffer)

	bytes.set([0x49, 0x49])
	view.setUint16(2, 43, true)
	view.setUint16(4, 8, true)
	view.setBigUint64(8, 16n, true)

	return bytes
}

// A classic TIFF header and a first IFD naming `width` × `height`, without the pixels: what a head read of a large
// file finds.
export function tiffHead(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(8 + 2 + 2 * 12 + 4)
	const view = new DataView(bytes.buffer)

	bytes.set([0x49, 0x49])
	view.setUint16(2, 42, true)
	view.setUint32(4, 8, true)
	view.setUint16(8, 2, true)
	;[
		[256, width],
		[257, height]
	].forEach(([tag = 0, value = 0], index) => {
		const at = 10 + index * 12

		view.setUint16(at, tag, true)
		view.setUint16(at + 2, 4, true)
		view.setUint32(at + 4, 1, true)
		view.setUint32(at + 8, value, true)
	})

	return bytes
}

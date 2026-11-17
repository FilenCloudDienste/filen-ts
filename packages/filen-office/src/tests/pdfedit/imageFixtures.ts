// Image files for the read role's tests, generated here: an uncompressed RGB TIFF of one or more pages (directories)
// at a given resolution, and a flattened RGB Photoshop file without layers. Their samples follow imageSample.

export function imageSample(page: number, x: number, y: number, channel: number): number {
	return (x * 3 + y * 5 + channel * 80 + page * 40) & 255
}

function fill(out: Uint8Array, at: number, page: number, width: number, height: number, planar: boolean): void {
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let channel = 0; channel < 3; channel++) {
				const index = planar ? channel * width * height + y * width + x : (y * width + x) * 3 + channel

				out[at + index] = imageSample(page, x, y, channel)
			}
		}
	}
}

// Little-endian baseline TIFF: per page its strip, its two resolutions (rationals), its bits per sample and its
// directory, chained.
export function makeTiff(pages: readonly (readonly [number, number])[], dpi = 72): Uint8Array {
	const ENTRIES = 12
	let size = 8
	const layouts = pages.map(([width, height]) => {
		const pixels = size

		size += width * height * 3

		const resolution = size

		size += 16

		const bits = size

		size += 6
		size += size % 2

		const directory = size

		size += 2 + ENTRIES * 12 + 4

		return { width, height, pixels, resolution, bits, directory }
	})
	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)

	out[0] = 0x49
	out[1] = 0x49
	view.setUint16(2, 42, true)
	view.setUint32(4, layouts[0]?.directory ?? 0, true)

	layouts.forEach((page, index) => {
		fill(out, page.pixels, index, page.width, page.height, false)
		view.setUint32(page.resolution, dpi, true)
		view.setUint32(page.resolution + 4, 1, true)
		view.setUint32(page.resolution + 8, dpi, true)
		view.setUint32(page.resolution + 12, 1, true)

		for (let channel = 0; channel < 3; channel++) view.setUint16(page.bits + channel * 2, 8, true)

		// [tag, type (3 short, 4 long, 5 rational), count, value or offset]
		const entries: readonly (readonly [number, number, number, number])[] = [
			[256, 4, 1, page.width],
			[257, 4, 1, page.height],
			[258, 3, 3, page.bits],
			[259, 3, 1, 1],
			[262, 3, 1, 2],
			[273, 4, 1, page.pixels],
			[277, 3, 1, 3],
			[278, 4, 1, page.height],
			[279, 4, 1, page.width * page.height * 3],
			[282, 5, 1, page.resolution],
			[283, 5, 1, page.resolution + 8],
			[296, 3, 1, 2]
		]

		view.setUint16(page.directory, entries.length, true)
		entries.forEach(([tag, type, count, value], entry) => {
			const at = page.directory + 2 + entry * 12

			view.setUint16(at, tag, true)
			view.setUint16(at + 2, type, true)
			view.setUint32(at + 4, count, true)

			if (type === 3 && count === 1) view.setUint16(at + 8, value, true)
			else view.setUint32(at + 8, value, true)
		})
		view.setUint32(page.directory + 2 + ENTRIES * 12, layouts[index + 1]?.directory ?? 0, true)
	})

	return out
}

// A flattened 8-bit RGB Photoshop file: header, empty colour mode, resources and layers, raw planar image data.
export function makePsd(width: number, height: number): Uint8Array {
	const out = new Uint8Array(26 + 4 + 4 + 4 + 2 + width * height * 3)
	const view = new DataView(out.buffer)

	out.set([0x38, 0x42, 0x50, 0x53], 0)
	view.setUint16(4, 1)
	view.setUint16(12, 3)
	view.setUint32(14, height)
	view.setUint32(18, width)
	view.setUint16(22, 8)
	view.setUint16(24, 3)
	fill(out, 26 + 4 + 4 + 4 + 2, 0, width, height, true)

	return out
}

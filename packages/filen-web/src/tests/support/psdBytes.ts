// Photoshop files for fixtures (Adobe Photoshop File Formats Specification): the 26-byte header, an empty colour mode
// section, the image resources (an optional JPEG thumbnail as resource 1036 or 1033), an empty layer section, and raw
// planar image data unless left out (an unflattened file has none).

export interface PsdOptions {
	readonly version?: 1 | 2
	readonly mode?: number
	readonly depth?: number
	readonly thumbnail?: { readonly id: 1033 | 1036; readonly jpeg: Uint8Array }
	// Raw composite data; false leaves it out, as a file saved without "Maximize compatibility" does.
	readonly composite?: boolean
	// Filler resource bytes before the thumbnail, to put it past a head read.
	readonly padding?: number
}

function u32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u16(value: number): number[] {
	return [(value >>> 8) & 0xff, value & 0xff]
}

function resource(id: number, data: Uint8Array): number[] {
	// "8BIM", the id, an empty Pascal name padded to 2 bytes, the size, the data padded to an even length.
	return [0x38, 0x42, 0x49, 0x4d, ...u16(id), 0, 0, ...u32(data.length), ...data, ...(data.length & 1 ? [0] : [])]
}

export function encodePsd(width: number, height: number, options: PsdOptions = {}): Uint8Array {
	const resources: number[] = []

	if (options.padding !== undefined) {
		resources.push(...resource(1000, new Uint8Array(options.padding)))
	}

	if (options.thumbnail !== undefined) {
		// The thumbnail resource's 28-byte header: format 1 (kJpegRGB), width, height, widthbytes, total size, compressed
		// size, 24 bits a pixel, one plane.
		const { jpeg } = options.thumbnail
		const header = [
			...u32(1),
			...u32(width),
			...u32(height),
			...u32(width * 3),
			...u32(width * height * 3),
			...u32(jpeg.length),
			...u16(24),
			...u16(1)
		]

		resources.push(...resource(options.thumbnail.id, Uint8Array.from([...header, ...jpeg])))
	}

	const header = [
		0x38,
		0x42,
		0x50,
		0x53,
		...u16(options.version ?? 1),
		0,
		0,
		0,
		0,
		0,
		0,
		...u16(3),
		...u32(height),
		...u32(width),
		...u16(options.depth ?? 8),
		...u16(options.mode ?? 3)
	]
	const composite = options.composite === false ? [] : [0, 0, ...new Array<number>(width * height * 3).fill(128)]

	return Uint8Array.from([...header, ...u32(0), ...u32(resources.length), ...resources, ...u32(0), ...composite])
}

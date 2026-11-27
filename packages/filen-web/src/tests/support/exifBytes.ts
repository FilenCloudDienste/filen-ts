import { crc32 } from "node:zlib"
import { concat, text, u16, u32 } from "@/tests/support/containerBytes"

// Exif TIFF blocks in either byte order with any field types and counts, and the picture formats that carry them.

export interface ExifField {
	tag: number
	type: number
	count: number
	// The value bytes, already in the block's byte order; inline when 4 or fewer.
	bytes: number[]
	// Overrides the value offset written for an out-of-line value (a corrupt pointer).
	offset?: number
}

function int(le: boolean, value: number, size: 2 | 4): number[] {
	const out: number[] = []

	for (let i = 0; i < size; i++) {
		out.push((value >>> (8 * i)) & 0xff)
	}

	return le ? out : out.reverse()
}

export const field = {
	ascii: (tag: number, value: string): ExifField => {
		const bytes = [...text(value), 0]

		return { tag, type: 2, count: bytes.length, bytes }
	},
	short: (le: boolean, tag: number, ...values: number[]): ExifField => ({
		tag,
		type: 3,
		count: values.length,
		bytes: values.flatMap(value => int(le, value, 2))
	}),
	long: (le: boolean, tag: number, ...values: number[]): ExifField => ({
		tag,
		type: 4,
		count: values.length,
		bytes: values.flatMap(value => int(le, value, 4))
	}),
	rational: (le: boolean, tag: number, ...values: [number, number][]): ExifField => ({
		tag,
		type: 5,
		count: values.length,
		bytes: values.flatMap(([n, d]) => [...int(le, n, 4), ...int(le, d, 4)])
	}),
	srational: (le: boolean, tag: number, ...values: [number, number][]): ExifField => ({
		tag,
		type: 10,
		count: values.length,
		bytes: values.flatMap(([n, d]) => [...int(le, n >>> 0, 4), ...int(le, d >>> 0, 4)])
	})
}

export interface ExifSpec {
	ifd0?: ExifField[]
	exif?: ExifField[]
	gps?: ExifField[]
	// 42 for TIFF; a RAW variant's otherwise.
	magic?: number
}

// Header, IFD0, the Exif and GPS IFDs, then every out-of-line value. Offsets from the header.
export function exifBlock(le: boolean, spec: ExifSpec): Uint8Array {
	const ifd0 = [...(spec.ifd0 ?? [])]

	if (spec.exif !== undefined) {
		ifd0.push({ tag: 0x8769, type: 4, count: 1, bytes: [] })
	}

	if (spec.gps !== undefined) {
		ifd0.push({ tag: 0x8825, type: 4, count: 1, bytes: [] })
	}

	const ifds = [ifd0, spec.exif, spec.gps].filter((ifd): ifd is ExifField[] => ifd !== undefined)
	const ifdAt: number[] = []
	let at = 8

	for (const ifd of ifds) {
		ifdAt.push(at)
		at += 2 + ifd.length * 12 + 4
	}

	const data: number[] = []
	const out: number[] = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...int(le, spec.magic ?? 42, 2), ...int(le, 8, 4)]

	ifds.forEach((ifd, index) => {
		out.push(...int(le, ifd.length, 2))

		for (const entry of [...ifd].sort((a, b) => a.tag - b.tag)) {
			out.push(...int(le, entry.tag, 2), ...int(le, entry.type, 2), ...int(le, entry.count, 4))

			if (entry.tag === 0x8769 && index === 0) {
				out.push(...int(le, ifdAt[1] ?? 0, 4))
			} else if (entry.tag === 0x8825 && index === 0) {
				out.push(...int(le, ifdAt[spec.exif === undefined ? 1 : 2] ?? 0, 4))
			} else if (entry.bytes.length <= 4) {
				out.push(...entry.bytes, ...new Array<number>(4 - entry.bytes.length).fill(0))
			} else {
				out.push(...int(le, entry.offset ?? at + data.length, 4))
				data.push(...entry.bytes)

				if (data.length % 2 === 1) {
					data.push(0)
				}
			}
		}

		out.push(0, 0, 0, 0)
	})

	return Uint8Array.from([...out, ...data])
}

// ── Carriers ──

export function jpegWithExif(tiff: Uint8Array): Uint8Array {
	const payload = concat(text("Exif\0\0"), tiff)
	const sof0 = [0xff, 0xc0, ...u16(11), 8, ...u16(600), ...u16(800), 1, 1, 0x11, 0]

	return concat([0xff, 0xd8, 0xff, 0xe1], u16(payload.length + 2), payload, sof0, [0xff, 0xda, ...u16(8), 1, 1, 0, 0, 63, 0, 0xff, 0xd9])
}

function pngChunk(type: string, data: Uint8Array | number[]): Uint8Array {
	const body = concat(text(type), data)

	return concat(u32(data.length), body, u32(crc32(body)))
}

export function pngWithExif(tiff: Uint8Array): Uint8Array {
	return concat(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		pngChunk("IHDR", [...u32(800), ...u32(600), 8, 2, 0, 0, 0]),
		pngChunk("eXIf", tiff),
		pngChunk("IDAT", [0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1]),
		pngChunk("IEND", [])
	)
}

function riffChunk(type: string, data: Uint8Array | number[]): Uint8Array {
	const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]

	return concat(text(type), le32(data.length), data, data.length % 2 === 1 ? [0] : [])
}

// VP8X (Exif flag), a VP8 frame header, then the EXIF chunk as libwebp writes it after the image.
export function webpWithExif(tiff: Uint8Array): Uint8Array {
	const w = 800 - 1
	const h = 600 - 1
	const body = concat(
		text("WEBP"),
		riffChunk("VP8X", [0x08, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, w >> 16, h & 0xff, (h >> 8) & 0xff, h >> 16]),
		riffChunk("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 800 & 0xff, 800 >> 8, 600 & 0xff, 600 >> 8, 0, 0, 0]),
		riffChunk("EXIF", tiff)
	)
	const size = body.length

	return concat(text("RIFF"), [size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff], body)
}

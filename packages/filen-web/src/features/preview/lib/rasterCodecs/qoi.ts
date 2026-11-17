import { sniffQoi } from "@/features/preview/lib/imageSniff/qoi"
import { RasterBudgetError, type DecodedRaster } from "@/features/preview/lib/rasterCodecs/raster"

// QOI (qoiformat.org, specification 1.0): after the 14-byte header, a stream of ops that each give one pixel or a run,
// against the previous pixel (starting opaque black) and a 64-entry table of recently seen pixels. The stream ends
// with seven 0x00 bytes and a 0x01, which is not needed to decode: a stream that runs out before the last pixel is
// refused, one whose end marker is damaged still gives every pixel.

const HEADER_BYTES = 14

const OP_RGB = 0xfe
const OP_RGBA = 0xff
const OP_MASK = 0xc0
const OP_INDEX = 0x00
const OP_DIFF = 0x40
const OP_LUMA = 0x80
const OP_RUN = 0xc0

function hash(r: number, g: number, b: number, a: number): number {
	return ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4
}

export class QoiDecodeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "QoiDecodeError"
	}
}

// The whole image as RGBA (straight alpha). `maxPixels` refuses a header naming more before anything is allocated.
export function decodeQoi(bytes: Uint8Array, maxPixels: number): DecodedRaster {
	const header = sniffQoi(bytes)

	if (header === null) {
		throw new QoiDecodeError("not a QOI image")
	}

	const { width, height } = header
	const pixels = width * height

	if (pixels > maxPixels) {
		throw new RasterBudgetError(`${String(width)}×${String(height)} is above the pixel budget`)
	}

	const data = new Uint8ClampedArray(pixels * 4)
	const index = new Uint8Array(64 * 4)
	const end = bytes.length
	let at = HEADER_BYTES
	let r = 0
	let g = 0
	let b = 0
	let a = 255
	let run = 0

	for (let out = 0; out < data.length; out += 4) {
		if (run > 0) {
			run--
		} else {
			if (at >= end) {
				throw new QoiDecodeError("the stream ends before its last pixel")
			}

			const op = bytes[at++] ?? 0

			if (op === OP_RGB || op === OP_RGBA) {
				const need = op === OP_RGB ? 3 : 4

				if (at + need > end) {
					throw new QoiDecodeError("the stream ends inside a pixel")
				}

				r = bytes[at] ?? 0
				g = bytes[at + 1] ?? 0
				b = bytes[at + 2] ?? 0

				if (op === OP_RGBA) {
					a = bytes[at + 3] ?? 0
				}

				at += need
			} else {
				switch (op & OP_MASK) {
					case OP_INDEX: {
						const slot = (op & 0x3f) * 4

						r = index[slot] ?? 0
						g = index[slot + 1] ?? 0
						b = index[slot + 2] ?? 0
						a = index[slot + 3] ?? 0
						break
					}
					case OP_DIFF:
						r = (r + ((op >> 4) & 0x03) - 2) & 0xff
						g = (g + ((op >> 2) & 0x03) - 2) & 0xff
						b = (b + (op & 0x03) - 2) & 0xff
						break
					case OP_LUMA: {
						if (at >= end) {
							throw new QoiDecodeError("the stream ends inside a pixel")
						}

						const next = bytes[at++] ?? 0
						const greenDiff = (op & 0x3f) - 32

						r = (r + greenDiff - 8 + ((next >> 4) & 0x0f)) & 0xff
						g = (g + greenDiff) & 0xff
						b = (b + greenDiff - 8 + (next & 0x0f)) & 0xff
						break
					}
					case OP_RUN:
						// 1..62 pixels: this one and `run` more.
						run = op & 0x3f
						break
				}
			}

			const slot = hash(r, g, b, a)

			index[slot] = r
			index[slot + 1] = g
			index[slot + 2] = b
			index[slot + 3] = a
		}

		data[out] = r
		data[out + 1] = g
		data[out + 2] = b
		data[out + 3] = a
	}

	return { width, height, data, hasAlpha: header.hasAlpha }
}

import { inflateSync } from "node:zlib"
import type { Locator } from "@playwright/test"

// What a canvas really shows, from a screenshot of it: a worker draws into a transferred OffscreenCanvas, which the
// page cannot read back, so its pixels are read from the composited frame. Decodes the 8-bit, non-interlaced RGB(A)
// PNG Playwright writes.

interface Pixels {
	readonly width: number
	readonly height: number
	readonly channels: number
	readonly data: Uint8Array
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c
	const pa = Math.abs(p - a)
	const pb = Math.abs(p - b)
	const pc = Math.abs(p - c)

	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePng(png: Buffer): Pixels {
	let offset = 8
	let width = 0
	let height = 0
	let channels = 0
	const idat: Buffer[] = []

	while (offset < png.length) {
		const length = png.readUInt32BE(offset)
		const type = png.toString("latin1", offset + 4, offset + 8)
		const body = png.subarray(offset + 8, offset + 8 + length)

		if (type === "IHDR") {
			width = body.readUInt32BE(0)
			height = body.readUInt32BE(4)

			const depth = body[8]
			const color = body[9]

			if (depth !== 8 || (color !== 2 && color !== 6) || body[12] !== 0) throw new Error("unsupported PNG")

			channels = color === 6 ? 4 : 3
		} else if (type === "IDAT") {
			idat.push(body)
		}

		offset += 12 + length
	}

	const raw = inflateSync(Buffer.concat(idat))
	const stride = width * channels
	const data = new Uint8Array(height * stride)

	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)] ?? 0

		for (let x = 0; x < stride; x++) {
			const value = raw[y * (stride + 1) + 1 + x] ?? 0
			const left = x >= channels ? (data[y * stride + x - channels] ?? 0) : 0
			const up = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0
			const corner = y > 0 && x >= channels ? (data[(y - 1) * stride + x - channels] ?? 0) : 0
			const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter] ?? 0

			data[y * stride + x] = (value + predicted) & 0xff
		}
	}

	return { width, height, channels, data }
}

// The pixels that differ from the canvas's top-left one (its background) by more than a rounding error.
export async function drawnPixels(canvas: Locator): Promise<number> {
	const { width, height, channels, data } = decodePng(await canvas.screenshot())
	let drawn = 0

	for (let i = 0; i < width * height; i++) {
		let difference = 0

		for (let c = 0; c < 3; c++) difference += Math.abs((data[i * channels + c] ?? 0) - (data[c] ?? 0))

		if (difference > 24) drawn++
	}

	return drawn
}

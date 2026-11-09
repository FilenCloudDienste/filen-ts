import { crc32 as zlibCrc32, inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { encodePng } from "@/features/preview/imageEdit/worker/pngEncoder"

interface Chunk {
	type: string
	data: Uint8Array
	crc: number
	crcInput: Uint8Array
}

function readChunks(png: Uint8Array): Chunk[] {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
	const chunks: Chunk[] = []
	let at = 8

	while (at < png.length) {
		const length = view.getUint32(at)
		const type = String.fromCharCode(...png.subarray(at + 4, at + 8))

		chunks.push({
			type,
			data: png.subarray(at + 8, at + 8 + length),
			crc: view.getUint32(at + 8 + length),
			crcInput: png.subarray(at + 4, at + 8 + length)
		})
		at += 12 + length
	}

	return chunks
}

// Reverses filter type 1 (Sub) row by row and returns the raw samples.
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
	const stride = width * channels
	const out = new Uint8Array(stride * height)

	for (let y = 0; y < height; y++) {
		const row = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1))

		expect(row[0]).toBe(1)

		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0

			out[y * stride + x] = ((row[x + 1] ?? 0) + left) & 0xff
		}
	}

	return out
}

function pattern(width: number, height: number): Uint8Array<ArrayBuffer> {
	const data = new Uint8Array(width * height * 4)
	let seed = 12345

	for (let i = 0; i < data.length; i++) {
		seed = (seed * 1103515245 + 12345) >>> 0
		data[i] = seed >>> 24
	}

	return data
}

// Index of the first differing byte, -1 when equal. toEqual walks a typed array element by element through its
// deep-equality machinery: over a megapixel that alone takes seconds on CI runners.
function firstMismatch(a: Uint8Array, b: Uint8Array): number {
	if (a.length !== b.length) {
		return Math.min(a.length, b.length)
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return i
		}
	}

	return -1
}

async function roundTrip(width: number, height: number, hasAlpha: boolean): Promise<void> {
	const rgba = pattern(width, height)
	const png = await encodePng(rgba, width, height, hasAlpha)

	expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

	const chunks = readChunks(png)

	expect(chunks.map(chunk => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"])

	for (const chunk of chunks) {
		expect(chunk.crc).toBe(zlibCrc32(chunk.crcInput))
	}

	const ihdr = chunks[0]?.data ?? new Uint8Array()
	const ihdrView = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)

	expect(ihdr.length).toBe(13)
	expect(ihdrView.getUint32(0)).toBe(width)
	expect(ihdrView.getUint32(4)).toBe(height)
	expect([...ihdr.subarray(8)]).toEqual([8, hasAlpha ? 6 : 2, 0, 0, 0])
	expect(chunks[2]?.data.length).toBe(0)

	const channels = hasAlpha ? 4 : 3
	// inflateSync takes the zlib wrapper (RFC 1950) only: it would throw on raw deflate.
	const samples = unfilter(inflateSync(chunks[1]?.data ?? new Uint8Array()), width, height, channels)

	if (hasAlpha) {
		expect(firstMismatch(samples, rgba)).toBe(-1)

		return
	}

	const rgb = new Uint8Array(width * height * 3)

	for (let p = 0; p < width * height; p++) {
		rgb.set(rgba.subarray(p * 4, p * 4 + 3), p * 3)
	}

	expect(firstMismatch(samples, rgb)).toBe(-1)
}

describe("encodePng", () => {
	it("round-trips RGBA through zlib and Sub filtering", async () => {
		await roundTrip(7, 5, true)
	})

	it("drops the alpha channel for colour type 2", async () => {
		await roundTrip(9, 4, false)
	})

	it("handles a single pixel", async () => {
		await roundTrip(1, 1, true)
		await roundTrip(1, 1, false)
	})

	it("streams images larger than one compressor batch", async () => {
		await roundTrip(700, 520, true)
		await roundTrip(700, 520, false)
	})

	it("rejects a buffer shorter than its size", async () => {
		await expect(encodePng(new Uint8Array(15), 2, 2, true)).rejects.toThrow()
	})
})

import { describe, expect, it } from "vitest"
import { decodeQoi, QoiDecodeError } from "@/features/preview/lib/rasterCodecs/qoi"
import { encodeQoi, qoiTestPixels } from "@/tests/support/qoiBytes"

describe("decodeQoi", () => {
	it("gives back every pixel the reference encoder wrote, through every op", () => {
		const width = 97
		const height = 23
		const pixels = qoiTestPixels(width, height)
		const bytes = encodeQoi(pixels, width, height)
		// The encoder's ops: a run, an index hit, a diff, a luma, an RGB and an RGBA.
		const ops = new Set(Array.from(bytes.subarray(14, -8), byte => (byte >= 0xfe ? byte : byte & 0xc0)))

		expect([...ops].sort()).toEqual(expect.arrayContaining([0x00, 0x40, 0x80, 0xc0, 0xfe, 0xff]))

		const decoded = decodeQoi(bytes, width * height)

		expect(decoded.width).toBe(width)
		expect(decoded.height).toBe(height)
		expect(decoded.hasAlpha).toBe(true)
		expect(Array.from(decoded.data)).toEqual(Array.from(pixels))
	})

	it("reads an RGB header as opaque", () => {
		const pixels = new Uint8Array(4 * 4).fill(255)

		expect(decodeQoi(encodeQoi(pixels, 2, 2, 3), 4).hasAlpha).toBe(false)
	})

	it("refuses a header naming more pixels than the budget before decoding", () => {
		const bytes = encodeQoi(qoiTestPixels(8, 8), 8, 8)

		expect(() => decodeQoi(bytes, 63)).toThrow(QoiDecodeError)
	})

	it("refuses a stream that ends before its last pixel", () => {
		const bytes = encodeQoi(qoiTestPixels(16, 16), 16, 16)

		expect(() => decodeQoi(bytes.subarray(0, 40), 256)).toThrow(QoiDecodeError)
	})

	it("decodes every pixel of a stream whose end marker is damaged", () => {
		const pixels = qoiTestPixels(16, 16)
		const bytes = encodeQoi(pixels, 16, 16)

		bytes[bytes.length - 1] = 0x7f

		expect(Array.from(decodeQoi(bytes, 256).data)).toEqual(Array.from(pixels))
	})

	it("refuses what is not QOI", () => {
		expect(() => decodeQoi(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1)).toThrow(QoiDecodeError)
	})
})

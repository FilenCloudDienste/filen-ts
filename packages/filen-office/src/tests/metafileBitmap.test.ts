import { describe, expect, it } from "vitest"
import { dibToBmp, hasPlaceableHeader, withPlaceableHeader } from "../core/metafile/bitmap"

// The .bmp a packed DIB becomes and the placeable header a bare WMF gets back, shared by the RTF and Word readers.

function dib(header: number, length: number, words: readonly (readonly [number, number, 2 | 4])[]): Uint8Array {
	const out = new Uint8Array(length)
	const view = new DataView(out.buffer)

	view.setUint32(0, header, true)

	for (const [at, value, size] of words) {
		if (size === 2) view.setUint16(at, value, true)
		else view.setUint32(at, value, true)
	}

	return out
}

function offBits(bmp: Uint8Array): number {
	return new DataView(bmp.buffer, bmp.byteOffset).getUint32(10, true)
}

describe("dibToBmp", () => {
	it("puts the pixels past a BITMAPCOREHEADER's 3-byte palette entries", () => {
		// 12-byte header, 4 bits per pixel at offset 10: 16 entries of 3 bytes.
		const bmp = dibToBmp(dib(12, 12 + 48 + 8, [[10, 4, 2]]))

		expect([bmp[0], bmp[1]]).toEqual([0x42, 0x4d])
		expect(new DataView(bmp.buffer).getUint32(2, true)).toBe(14 + 12 + 48 + 8)
		expect(offBits(bmp)).toBe(14 + 12 + 48)
	})

	it("counts the BI_BITFIELDS masks after a BITMAPINFOHEADER", () => {
		const bmp = dibToBmp(
			dib(40, 40 + 12 + 8, [
				[14, 16, 2],
				[16, 3, 4]
			])
		)

		expect(offBits(bmp)).toBe(14 + 40 + 12)
	})

	it("reads biClrUsed and keeps the pixel offset inside a truncated file", () => {
		expect(
			offBits(
				dibToBmp(
					dib(40, 40 + 8 * 4 + 4, [
						[14, 8, 2],
						[32, 8, 4]
					])
				)
			)
		).toBe(14 + 40 + 32)

		// 256 colours declared, 10 bytes of them present.
		const truncated = dibToBmp(
			dib(40, 50, [
				[14, 8, 2],
				[32, 256, 4]
			])
		)

		expect(offBits(truncated)).toBe(truncated.length)
	})

	it("returns input under 16 bytes as it is", () => {
		const short = Uint8Array.of(40, 0, 0, 0, 1, 2)

		expect(dibToBmp(short)).toBe(short)
	})
})

describe("withPlaceableHeader", () => {
	it("writes the key, the frame and the XOR checksum of the ten words before it", () => {
		const wmf = Uint8Array.of(1, 0, 9, 0)
		const out = withPlaceableHeader(wmf, { left: -10, top: 20, right: 1000, bottom: 500, inch: 1440 })
		const view = new DataView(out.buffer)
		let checksum = 0

		for (let at = 0; at < 20; at += 2) checksum ^= view.getUint16(at, true)

		expect(hasPlaceableHeader(out)).toBe(true)
		expect(hasPlaceableHeader(wmf)).toBe(false)
		expect([view.getInt16(6, true), view.getInt16(8, true), view.getInt16(10, true), view.getInt16(12, true)]).toEqual([
			-10, 20, 1000, 500
		])
		expect(view.getUint16(14, true)).toBe(1440)
		expect(view.getUint16(20, true)).toBe(checksum)
		expect(checksum).not.toBe(0)
		expect(out.subarray(22)).toEqual(wmf)
	})
})

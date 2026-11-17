import { describe, expect, it } from "vitest"
import { epsPreview, type EpsRangeReader } from "@/features/preview/lib/epsPreview"
import { decodeEpsi } from "@/features/preview/lib/rasterCodecs/epsi"
import { RasterBudgetError } from "@/features/preview/lib/rasterCodecs/raster"
import { dosEps, epsiEps, plainEps } from "@/tests/support/epsBytes"
import { encodeTiff } from "@/tests/support/tiffBytes"

function readerOf(bytes: Uint8Array): EpsRangeReader & { reads: [number, number][] } {
	const reads: [number, number][] = []

	return {
		size: bytes.length,
		reads,
		read: (offset, length) => {
			reads.push([offset, length])

			return Promise.resolve(bytes.slice(offset, offset + length))
		}
	}
}

const live = new AbortController().signal

describe("epsPreview", () => {
	it("reads a DOS EPS's TIFF section by range, never its PostScript", async () => {
		const tiff = encodeTiff([{ width: 4, height: 2, rgb: [1, 2, 3] }])
		const reader = readerOf(dosEps(tiff))

		await expect(epsPreview(reader, live)).resolves.toEqual({ kind: "tiff", bytes: tiff })
		expect(reader.reads[1]).toEqual([30 + plainEps().length, tiff.length])
	})

	it("refuses a TIFF section larger than the reader holds, and says a DOS EPS without one has none", async () => {
		await expect(epsPreview(readerOf(dosEps(new Uint8Array(100))), live, 99)).resolves.toEqual({ kind: "tooLarge" })
		await expect(epsPreview(readerOf(dosEps(null)), live)).resolves.toEqual({ kind: "none" })
	})

	it("hands an EPSI preview's hex on with its declaration, and says plain PostScript has none", async () => {
		const preview = await epsPreview(readerOf(epsiEps(8, 1, ["F0", "0F"])), live)

		expect(preview.kind).toBe("epsi")

		if (preview.kind === "epsi") {
			expect(new TextDecoder().decode(preview.bytes)).toMatch(/^%%BeginPreview: 8 2 1 2\n%F0\n%0F/u)
		}

		await expect(epsPreview(readerOf(plainEps()), live)).resolves.toEqual({ kind: "none" })
		await expect(epsPreview(readerOf(new Uint8Array(64)), live)).resolves.toEqual({ kind: "unreadable" })
	})
})

describe("decodeEpsi", () => {
	function section(width: number, depth: 1 | 2 | 4 | 8, rows: readonly string[]): Uint8Array {
		return new TextEncoder().encode(
			`%%BeginPreview: ${String(width)} ${String(rows.length)} ${String(depth)} ${String(rows.length)}\n${rows.map(row => `%${row}`).join("\n")}\n%%EndPreview\n`
		)
	}

	function greys(data: Uint8ClampedArray): number[] {
		return Array.from(data.filter((_, index) => index % 4 === 0))
	}

	it("reads 1-bit rows padded to a byte, 0 black and 1 white, top row first", () => {
		const decoded = decodeEpsi(section(4, 1, ["A0", "50"]), 100)

		expect(decoded).toMatchObject({ width: 4, height: 2, hasAlpha: false })
		expect(greys(decoded.data)).toEqual([255, 0, 255, 0, 0, 255, 0, 255])
	})

	it("scales deeper samples to grey", () => {
		expect(greys(decodeEpsi(section(2, 8, ["0080"]), 100).data)).toEqual([0, 128])
		expect(greys(decodeEpsi(section(2, 4, ["F0"]), 100).data)).toEqual([255, 0])
	})

	it("refuses a size over the budget before decoding, and hex that ends before the image", () => {
		expect(() => decodeEpsi(section(4, 1, ["A0", "50"]), 7)).toThrow(RasterBudgetError)
		expect(() => decodeEpsi(section(16, 8, ["00"]), 100)).toThrow(/ends before/u)
	})
})

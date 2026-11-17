import { describe, expect, it } from "vitest"
import { epsPreview, type EpsRangeReader } from "@/features/preview/lib/epsPreview"
import { decodeEpsi, epsiSize, packEpsi } from "@/features/preview/lib/rasterCodecs/epsi"
import { RasterBudgetError } from "@/features/preview/lib/rasterCodecs/raster"
import { dosEps, epsiEps, plainEps } from "@/tests/support/epsBytes"
import { encodeTiff } from "@/tests/support/tiffBytes"

function readerOf(bytes: Uint8Array): EpsRangeReader & { reads: [number, number][]; returned: Uint8Array[] } {
	const reads: [number, number][] = []
	const returned: Uint8Array[] = []

	return {
		size: bytes.length,
		reads,
		returned,
		read: (offset, length) => {
			const read = bytes.slice(offset, offset + length)

			reads.push([offset, length])
			returned.push(read)

			return Promise.resolve(read)
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

	it("hands the TIFF section on as read, without a copy", async () => {
		const reader = readerOf(dosEps(encodeTiff([{ width: 4, height: 2, rgb: [1, 2, 3] }])))
		const preview = await epsPreview(reader, live)

		expect(preview.kind === "tiff" ? preview.bytes : null).toBe(reader.returned[1])
	})

	it("refuses a TIFF section larger than the reader holds, and says a DOS EPS without one has none", async () => {
		await expect(epsPreview(readerOf(dosEps(new Uint8Array(100))), live, 99)).resolves.toEqual({ kind: "tooLarge" })
		await expect(epsPreview(readerOf(dosEps(null)), live)).resolves.toEqual({ kind: "none" })
	})

	it("hands an EPSI preview's lines on with its declared size, and says plain PostScript has none", async () => {
		const preview = await epsPreview(readerOf(epsiEps(8, 1, ["F0", "0F"])), live)

		expect(preview.kind).toBe("epsi")

		if (preview.kind === "epsi") {
			expect(epsiSize(preview.bytes)).toEqual({ width: 8, height: 2, depth: 1 })
			expect(new TextDecoder().decode(preview.bytes.subarray(9))).toMatch(/^%F0\n%0F/u)
		}

		await expect(epsPreview(readerOf(plainEps()), live)).resolves.toEqual({ kind: "none" })
		await expect(epsPreview(readerOf(new Uint8Array(64)), live)).resolves.toEqual({ kind: "unreadable" })
	})

	it("reads only what the preview's hex needs, never the PostScript after it", async () => {
		const eps = epsiEps(
			16,
			1,
			Array.from({ length: 24 }, () => "FFFF")
		)
		const program = new TextEncoder().encode("0 0 moveto 1 1 lineto stroke\n".repeat(1000))
		const file = new Uint8Array(eps.length + program.length)

		file.set(eps)
		file.set(program, eps.length)

		const reader = readerOf(file)

		await epsPreview(reader, live)

		// 24 rows of 4 hex digits, and 4 bytes a line for "%" and its line end.
		expect(reader.reads[1]?.[1]).toBe(24 * 4 + 24 * 4)
	})

	it("refuses a preview declaring more hex than one may hold", async () => {
		const head = new TextEncoder().encode("%!PS-Adobe-3.0 EPSF-3.0\n%%BeginPreview: 8200 8200 1 24\n%FF\n")

		await expect(epsPreview(readerOf(head), live)).resolves.toEqual({ kind: "tooLarge" })
	})
})

describe("decodeEpsi", () => {
	function section(
		width: number,
		depth: 1 | 2 | 4 | 8,
		rows: readonly string[],
		height = rows.length,
		after = "%%EndPreview\n"
	): Uint8Array {
		return packEpsi({ width, height, depth }, new TextEncoder().encode(`${rows.map(row => `%${row}`).join("\n")}\n${after}`))
	}

	function greys(data: Uint8ClampedArray): number[] {
		return Array.from(data.filter((_, index) => index % 4 === 0))
	}

	it("reads 1-bit rows padded to a byte, 0 white and 1 black (EPSF 3.0 §6.1), top row first", () => {
		const decoded = decodeEpsi(section(4, 1, ["A0", "50"]), 100)

		expect(decoded).toMatchObject({ width: 4, height: 2, hasAlpha: false })
		expect(greys(decoded.data)).toEqual([0, 255, 0, 255, 255, 0, 255, 0])
	})

	it("scales deeper samples to grey, the depth's maximum black", () => {
		expect(greys(decodeEpsi(section(2, 8, ["00FF"]), 100).data)).toEqual([255, 0])
		expect(greys(decodeEpsi(section(2, 4, ["F0"]), 100).data)).toEqual([0, 255])
	})

	it("refuses a size over the budget before decoding, and hex that ends before the image", () => {
		expect(() => decodeEpsi(section(4, 1, ["A0", "50"]), 7)).toThrow(RasterBudgetError)
		expect(() => decodeEpsi(section(16, 8, ["00"]), 100)).toThrow(/ends before/u)
	})

	it("ends the hex at %%EndPreview, never reading the PostScript after it as pixels", () => {
		const short = section(8, 8, ["00"], 1, "%%EndPreview\n%%EndComments\n0 0 add def 1 1 add def DEAD BEEF CAFE FACE\n")

		expect(() => decodeEpsi(short, 100)).toThrow(/ends before/u)
	})

	it("refuses a size its bytes cannot hold before allocating for it", () => {
		expect(() => decodeEpsi(section(0xffff_ffff, 8, ["00"], 0xffff_ffff), Number.POSITIVE_INFINITY)).toThrow(/ends before/u)
	})
})

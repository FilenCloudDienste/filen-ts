// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { LinkedFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { dosEps, epsiEps, plainEps } from "@/tests/support/epsBytes"
import { encodeTiff } from "@/tests/support/tiffBytes"
import "@/lib/i18n"

// An EPS file is shown by the preview picture it carries, read by range: a DOS EPS's TIFF section in the MuPDF read
// role, an EPSI preview in the raster decode pool, and a card for one with neither.

const { openMupdfReader, displayRaster, file, shellSizes } = vi.hoisted(() => {
	// The EPS file the byte reader serves.
	const file: { bytes: Uint8Array } = { bytes: new Uint8Array(0) }

	return { openMupdfReader: vi.fn(), displayRaster: vi.fn(), file, shellSizes: [] as number[] }
})

vi.mock("@/lib/mupdf/reader", () => ({ openMupdfReader, mupdfImagePixels: () => 30_000_000 }))
vi.mock("@/features/preview/lib/rasterDecode", () => ({
	displayRaster,
	RASTER_BYTES_PER_PIXEL: { qoi: 8, jxl: 70, epsi: 8 },
	transformHeicBytes: vi.fn(),
	transformHeicBytesOwned: vi.fn()
}))
vi.mock("@/features/preview/components/pdfReaderShell", () => ({
	PdfReaderShell: (props: { size: number }) => {
		shellSizes.push(props.size)

		return null
	}
}))
vi.mock("@/features/preview/lib/origin/byteReader", () => ({
	openByteReader: (origin: { kind: string; blob?: Blob }) =>
		Promise.resolve({
			size: origin.kind === "bytes" ? (origin.blob?.size ?? 0) : file.bytes.length,
			read: async (offset: number, length: number) =>
				origin.kind === "bytes" && origin.blob !== undefined
					? new Uint8Array(await origin.blob.slice(offset, offset + length).arrayBuffer())
					: file.bytes.slice(offset, offset + length),
			close: vi.fn()
		})
}))

const { ImageViewer } = await import("@/features/preview/components/imageViewer")

function eps(uuid: LinkedFile["uuid"]): DriveItem {
	return linkedFileItem("figure.eps", { uuid, size: BigInt(file.bytes.length), mime: { Decrypted: "application/postscript" } })
}

beforeEach(() => {
	vi.clearAllMocks()
	shellSizes.length = 0
	cleanup()
	HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
})

describe("ImageViewer on an EPS file", () => {
	it("opens a DOS EPS's TIFF section in the read role as a TIFF", async () => {
		const tiff = encodeTiff([{ width: 4, height: 2, rgb: [1, 2, 3] }])

		file.bytes = dosEps(tiff)
		openMupdfReader.mockReturnValue(new Promise(() => undefined))
		render(createElement(ImageViewer, { item: eps("eeeeeeee-0000-0000-0000-000000000041"), alt: "figure" }))

		await waitFor(() => {
			expect(openMupdfReader).toHaveBeenCalledOnce()
		})

		const options = openMupdfReader.mock.calls[0]?.[0] as { format: string; origin: { kind: string; blob: Blob } }

		expect(options.format).toBe("tiff")
		expect(options.origin.kind).toBe("bytes")
		expect(new Uint8Array(await options.origin.blob.arrayBuffer())).toEqual(tiff)
	})

	it("gives a multi-page TIFF section's page column the section's size, not the EPS file's", async () => {
		const tiff = encodeTiff([
			{ width: 4, height: 2, rgb: [1, 2, 3] },
			{ width: 4, height: 2, rgb: [3, 2, 1] }
		])

		file.bytes = dosEps(tiff)
		openMupdfReader.mockResolvedValue({ pageCount: 2, document: {}, close: vi.fn(() => Promise.resolve()) })
		render(createElement(ImageViewer, { item: eps("eeeeeeee-0000-0000-0000-000000000044"), alt: "figure" }))

		await waitFor(() => {
			expect(shellSizes.at(-1)).toBe(tiff.length)
		})
		expect(file.bytes.length).toBeGreaterThan(tiff.length)
	})

	it("decodes an EPSI preview in the pool", async () => {
		file.bytes = epsiEps(8, 1, ["F0", "0F"])
		displayRaster.mockResolvedValue({ bitmap: { width: 8, height: 2, close: vi.fn() }, width: 8, height: 2 })
		render(createElement(ImageViewer, { item: eps("eeeeeeee-0000-0000-0000-000000000042"), alt: "figure" }))

		await waitFor(() => {
			expect(screen.getByRole("img", { name: "figure" }).getAttribute("width")).toBe("8")
		})
		expect(displayRaster.mock.calls[0]?.[0]).toBe("epsi")
		expect(openMupdfReader).not.toHaveBeenCalled()
	})

	it("says one without a preview picture has none, running nothing", async () => {
		file.bytes = plainEps()
		render(createElement(ImageViewer, { item: eps("eeeeeeee-0000-0000-0000-000000000043"), alt: "figure" }))

		await screen.findByText("This EPS file has no preview to show.")
		expect(openMupdfReader).not.toHaveBeenCalled()
		expect(displayRaster).not.toHaveBeenCalled()
	})
})

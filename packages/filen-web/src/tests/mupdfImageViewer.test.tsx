// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LinkedFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ImagePageSlot } from "@/features/preview/lib/imagePageSource"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { bigTiffHeader, encodeTiff, tiffHead } from "@/tests/support/tiffBytes"
import { encodePsd } from "@/tests/support/psdBytes"
import "@/lib/i18n"

// A TIFF: its header read first (a BigTIFF or a first page past the engine's pixel budget refused before any engine
// starts), then the MuPDF read role, its one page drawn as a bitmap at the display long side with the chip that draws
// it whole, and handed to the editor as the page shown.

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
const { openMupdfReader, head } = vi.hoisted(() => {
	// The head the reader gives.
	const head: { bytes: Uint8Array } = { bytes: new Uint8Array(0) }

	return { openMupdfReader: vi.fn(), head }
})

vi.mock("sonner", () => ({ toast: { error: toastError } }))
vi.mock("@/lib/mupdf/reader", () => ({ openMupdfReader, mupdfImagePixels: () => 30_000_000 }))
vi.mock("@/features/preview/lib/origin/byteReader", () => ({
	openByteReader: () => Promise.resolve({ size: head.bytes.length, read: () => Promise.resolve(head.bytes), close: vi.fn() })
}))

const { ImageViewer } = await import("@/features/preview/components/imageViewer")

// Sized as the file whose head the reader gives.
function tiff(uuid: LinkedFile["uuid"]): DriveItem {
	return linkedFileItem("scan.tif", { uuid, size: BigInt(Math.max(head.bytes.length, 1024)), mime: { Decrypted: "image/tiff" } })
}

function bitmap(width: number, height: number): ImageBitmap {
	return { width, height, close: vi.fn() }
}

function onePage(natural: { width: number; height: number }) {
	return {
		pageCount: 1,
		imageExtent: vi.fn(() => Promise.resolve(natural)),
		renderPage: vi.fn((_page: number, options: { maxPixels: number; output: string }) =>
			Promise.resolve(
				options.output === "rgba"
					? { rgba: new Uint8ClampedArray(4), width: 1, height: 1 }
					: bitmap(Math.min(natural.width, Math.round(Math.sqrt(options.maxPixels * (natural.width / natural.height)))), 2)
			)
		),
		close: vi.fn(() => Promise.resolve())
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
	head.bytes = encodeTiff([{ width: 5000, height: 2, rgb: [1, 2, 3] }])
})

afterEach(() => {
	cleanup()
})

describe("ImageViewer on a TIFF", () => {
	it("draws its one page at the display long side, offers it whole, and hands the editor the page shown", async () => {
		const reader = onePage({ width: 5000, height: 2 })
		const pageSource: { current: ImagePageSlot | null } = { current: null }

		openMupdfReader.mockResolvedValue(reader)
		render(createElement(ImageViewer, { item: tiff("eeeeeeee-0000-0000-0000-000000000021"), alt: "scan", pageSourceRef: pageSource }))

		await screen.findByText("Reduced · 5000×2")
		expect(openMupdfReader.mock.calls[0]?.[0]).toMatchObject({ format: "tiff", maxImagePixels: 30_000_000 })
		// 4096 × 2 at most: the long side fitted, never above the page's own pixels.
		expect(reader.renderPage.mock.calls[0]?.[1]).toMatchObject({ maxPixels: 4096 * 2, output: "bitmap" })
		expect(pageSource.current).toMatchObject({ page: 0, pageCount: 1 })

		fireEvent.click(screen.getByRole("button", { name: "Full res ▸" }))

		await waitFor(() => {
			expect(reader.renderPage.mock.calls.at(-1)?.[1]).toMatchObject({ maxPixels: 5000 * 2 })
		})
		await waitFor(() => {
			expect(screen.queryByText("Reduced · 5000×2")).toBeNull()
		})
	})

	it("draws it whole no larger than a canvas of the device holds, and keeps the reduced page when that fails", async () => {
		const natural = { width: 20_000, height: 1000 }
		const reader = onePage(natural)

		head.bytes = encodeTiff([{ width: 8, height: 8, rgb: [0, 0, 0] }])
		reader.renderPage.mockImplementation((_page: number, options: { maxPixels: number; output: string }) =>
			options.maxPixels > 4096 * 205 ? Promise.reject(new Error("too large")) : Promise.resolve(bitmap(4096, 204))
		)
		openMupdfReader.mockResolvedValue(reader)
		render(createElement(ImageViewer, { item: tiff("eeeeeeee-0000-0000-0000-000000000025"), alt: "scan" }))

		fireEvent.click(await screen.findByRole("button", { name: "Full res ▸" }))

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("The image couldn't be shown at full resolution.")
		})

		// The desktop canvas area (16 777 216 px), not the page's own 20 MP.
		const asked = reader.renderPage.mock.calls.at(-1)?.[1].maxPixels ?? 0

		expect(asked).toBeLessThanOrEqual(16_777_216)
		expect(asked).toBeGreaterThan(16_000_000)
		expect(screen.getByRole("img", { name: "scan" }).getAttribute("width")).toBe("4096")
		expect(screen.queryByRole("button", { name: "Full res ▸" })).toBeNull()
	})

	it("tells the editor to wait for its engine while it opens, then gives it the first page", async () => {
		const reader = onePage({ width: 8, height: 8 })
		let open: (value: unknown) => void = () => undefined

		head.bytes = encodeTiff([{ width: 8, height: 8, rgb: [0, 0, 0] }])
		openMupdfReader.mockImplementation(() => new Promise(resolve => (open = resolve)))

		const pageSourceRef: { current: ImagePageSlot | null } = { current: null }

		render(createElement(ImageViewer, { item: tiff("eeeeeeee-0000-0000-0000-000000000026"), alt: "scan", pageSourceRef }))

		await waitFor(() => {
			expect(openMupdfReader).toHaveBeenCalledOnce()
		})

		const slot = pageSourceRef.current

		if (slot === null || !("opening" in slot)) throw new Error("no engine opening")

		open(reader)

		expect((await slot.opening)?.page).toBe(0)
	})

	it("refuses a BigTIFF from its header, starting no engine", async () => {
		head.bytes = bigTiffHeader()
		render(createElement(ImageViewer, { item: tiff("eeeeeeee-0000-0000-0000-000000000022"), alt: "scan" }))

		await screen.findByText("BigTIFF images can't be previewed.")
		expect(openMupdfReader).not.toHaveBeenCalled()
	})

	it("refuses a first page larger than the engine's pixel budget from its header, starting no engine", async () => {
		head.bytes = tiffHead(6000, 6000)
		render(createElement(ImageViewer, { item: tiff("eeeeeeee-0000-0000-0000-000000000023"), alt: "scan" }))

		await screen.findByText("This image is too large to display on this device.")
		expect(openMupdfReader).not.toHaveBeenCalled()
	})

	it("refuses one the engine does not read", async () => {
		const { PdfEngineError } = await import("@filen/office/dom/pdfedit")

		openMupdfReader.mockRejectedValue(new PdfEngineError("notSupported", "damaged"))
		render(createElement(ImageViewer, { item: tiff("eeeeeeee-0000-0000-0000-000000000024"), alt: "scan" }))

		await screen.findByText("This image can't be displayed in this browser.")
	})
})

describe("ImageViewer on a Photoshop file", () => {
	function psd(uuid: LinkedFile["uuid"], name = "art.psd"): DriveItem {
		return linkedFileItem(name, {
			uuid,
			size: BigInt(Math.max(head.bytes.length, 1024)),
			mime: { Decrypted: "image/vnd.adobe.photoshop" }
		})
	}

	it("draws its composite through the read role's Photoshop format", async () => {
		head.bytes = encodePsd(40, 30)
		openMupdfReader.mockResolvedValue(onePage({ width: 40, height: 30 }))
		render(createElement(ImageViewer, { item: psd("eeeeeeee-0000-0000-0000-000000000031"), alt: "art" }))

		await waitFor(() => {
			expect(screen.getByRole("img", { name: "art" })).toBeTruthy()
		})
		expect(openMupdfReader.mock.calls[0]?.[0]).toMatchObject({ format: "psd" })
	})

	it("refuses a Large Document Format file and a depth the engine has no decoder for from the header, starting no engine", async () => {
		head.bytes = encodePsd(40, 30, { version: 2 })
		const large = render(createElement(ImageViewer, { item: psd("eeeeeeee-0000-0000-0000-000000000032", "art.psb"), alt: "art" }))

		await screen.findByText("Large Document Format (.psb) files can't be previewed.")
		large.unmount()

		head.bytes = encodePsd(40, 30, { depth: 32 })
		render(createElement(ImageViewer, { item: psd("eeeeeeee-0000-0000-0000-000000000033"), alt: "art" }))

		await screen.findByText("This image can't be displayed in this browser.")
		expect(openMupdfReader).not.toHaveBeenCalled()
	})

	it("says a file saved without its flattened image has none to show", async () => {
		const { PdfEngineError } = await import("@filen/office/dom/pdfedit")

		head.bytes = encodePsd(40, 30, { composite: false })
		openMupdfReader.mockRejectedValue(new PdfEngineError("notSupported", "Unflattened PSD not supported"))
		render(createElement(ImageViewer, { item: psd("eeeeeeee-0000-0000-0000-000000000034"), alt: "art" }))

		await screen.findByText("This Photoshop file has no flattened image to show.")
	})
})

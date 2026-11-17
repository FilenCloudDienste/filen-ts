// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AnyFile, LinkedFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import "@/lib/i18n"

// An image only our own code decodes (QOI): its whole bytes, decoded in the raster decode pool into a bitmap drawn at
// the display long side with a chip that draws it whole, or a card when its header names more than the device decodes.

const { downloadFileBytes, displayRaster, gunzipSvg, toastError } = vi.hoisted(() => ({
	toastError: vi.fn(),
	gunzipSvg: vi.fn<(bytes: Uint8Array, maxBytes: number) => Promise<Blob | null>>(),
	downloadFileBytes: vi.fn<(file: AnyFile, token: string) => Promise<Uint8Array>>(),
	displayRaster:
		vi.fn<
			(
				format: string,
				bytes: Uint8Array,
				options: { maxPixels: number; maxLongSide: number | null }
			) => Promise<{ bitmap: ImageBitmap; width: number; height: number }>
		>()
}))

vi.mock("@/lib/sdk/client", async () => {
	const { originShims } = await import("@/tests/support/originShims")

	return {
		sdkApi: { downloadFileBytes, cancelPreviewDownload: vi.fn(), ...originShims({ downloadFileBytes }) },
		threadCount: () => 1
	}
})
vi.mock("@/features/preview/lib/svgz", () => ({ gunzipSvg }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))
vi.mock("@/features/preview/lib/rasterDecode", () => ({
	displayRaster,
	RASTER_BYTES_PER_PIXEL: { qoi: 8, jxl: 70 },
	transformHeicBytes: vi.fn(),
	transformHeicBytesOwned: vi.fn()
}))

const { ImageViewer } = await import("@/features/preview/components/imageViewer")
const { clearPreviewCache } = await import("@/features/preview/lib/previewCache")
const { refineDeviceProfile } = await import("@/lib/deviceProfile")

function qoiHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(22)
	const view = new DataView(bytes.buffer)

	bytes.set([0x71, 0x6f, 0x69, 0x66])
	view.setUint32(4, width)
	view.setUint32(8, height)
	bytes[12] = 4
	bytes[20] = 0
	bytes[21] = 1

	return bytes
}

function qoi(uuid: LinkedFile["uuid"], size: number): DriveItem {
	return linkedFileItem("render.qoi", { uuid, size: BigInt(size), mime: { Decrypted: "image/x-qoi" } })
}

function bitmap(width: number, height: number): ImageBitmap {
	return { width, height, close: vi.fn() }
}

beforeEach(() => {
	clearPreviewCache()
	vi.clearAllMocks()
	HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
	displayRaster.mockImplementation((_format, _bytes, options) =>
		Promise.resolve({ bitmap: bitmap(options.maxLongSide ?? 5000, 2), width: 5000, height: 2 })
	)
})

afterEach(() => {
	cleanup()
	refineDeviceProfile({ jxlNative: "unknown" })
})

describe("ImageViewer on a QOI", () => {
	it("draws it at the display long side with a chip naming its own size, and draws it whole when asked", async () => {
		downloadFileBytes.mockResolvedValue(qoiHeader(5000, 2))
		render(createElement(ImageViewer, { item: qoi("eeeeeeee-0000-0000-0000-000000000011", 22), alt: "render" }))

		await waitFor(() => {
			expect(screen.getByRole("img", { name: "render" }).getAttribute("width")).toBe("4096")
		})
		expect(displayRaster.mock.calls[0]?.[0]).toBe("qoi")
		expect(displayRaster.mock.calls[0]?.[2].maxLongSide).toBe(4096)
		expect(screen.getByText("Reduced · 5000×2")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Full res ▸" }))

		await waitFor(() => {
			expect(screen.getByRole("img", { name: "render" }).getAttribute("width")).toBe("5000")
		})
		expect(displayRaster.mock.calls.at(-1)?.[2].maxLongSide).toBe(5000)
		expect(screen.queryByText("Reduced · 5000×2")).toBeNull()
	})

	it("draws it whole no larger than a canvas of the device holds", async () => {
		// 20 MP: within the worker's budget, past the desktop canvas area (64 MiB, 16 777 216 px).
		downloadFileBytes.mockResolvedValue(qoiHeader(20_000, 1000))
		displayRaster.mockImplementation((_format, _bytes, options) =>
			Promise.resolve({ bitmap: bitmap(options.maxLongSide ?? 20_000, 2), width: 20_000, height: 1000 })
		)
		render(createElement(ImageViewer, { item: qoi("eeeeeeee-0000-0000-0000-000000000018", 22), alt: "render" }))

		fireEvent.click(await screen.findByRole("button", { name: "Full res ▸" }))

		await waitFor(() => {
			expect(displayRaster.mock.calls.at(-1)?.[2].maxLongSide).toBe(Math.floor(20_000 * Math.sqrt(16_777_216 / 20_000_000)))
		})
	})

	it("keeps the reduced picture when drawing it whole fails", async () => {
		downloadFileBytes.mockResolvedValue(qoiHeader(5000, 2))
		displayRaster.mockImplementation((_format, _bytes, options) =>
			options.maxLongSide === 4096
				? Promise.resolve({ bitmap: bitmap(4096, 2), width: 5000, height: 2 })
				: Promise.reject(new Error("the canvas is too large"))
		)
		render(createElement(ImageViewer, { item: qoi("eeeeeeee-0000-0000-0000-000000000019", 22), alt: "render" }))

		fireEvent.click(await screen.findByRole("button", { name: "Full res ▸" }))

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("The image couldn't be shown at full resolution.")
		})
		expect(screen.getByRole("img", { name: "render" }).getAttribute("width")).toBe("4096")
		expect(screen.queryByRole("button", { name: "Full res ▸" })).toBeNull()
		expect(screen.queryByText("This image couldn't be read.")).toBeNull()
	})

	it("shows the too-large card for a header naming more pixels than the device decodes, decoding nothing", async () => {
		downloadFileBytes.mockResolvedValue(qoiHeader(20_000, 20_000))
		render(createElement(ImageViewer, { item: qoi("eeeeeeee-0000-0000-0000-000000000012", 22), alt: "render" }))

		await screen.findByText("This image is too large to display on this device.")
		expect(displayRaster).not.toHaveBeenCalled()
	})

	it("shows a card for bytes the decoder refuses", async () => {
		downloadFileBytes.mockResolvedValue(qoiHeader(10, 10))
		displayRaster.mockRejectedValue(new Error("the stream ends before its last pixel"))
		render(createElement(ImageViewer, { item: qoi("eeeeeeee-0000-0000-0000-000000000013", 22), alt: "render" }))

		await screen.findByText("This image couldn't be read.")
	})

	it("decodes a JPEG XL in the pool where the browser has no decoder for it", async () => {
		refineDeviceProfile({ jxlNative: "no" })
		// A bare codestream of 1000 × 750 (13-bit height, 4:3).
		downloadFileBytes.mockResolvedValue(Uint8Array.from([0xff, 0x0a, 0x6a, 0x17, 0x03, 0x00]))
		displayRaster.mockResolvedValue({ bitmap: bitmap(1000, 750), width: 1000, height: 750 })
		render(
			createElement(ImageViewer, {
				item: linkedFileItem("photo.jxl", {
					uuid: "eeeeeeee-0000-0000-0000-000000000015",
					size: 6n,
					mime: { Decrypted: "image/jxl" }
				}),
				alt: "photo"
			})
		)

		await waitFor(() => {
			expect(screen.getByRole("img", { name: "photo" }).getAttribute("width")).toBe("1000")
		})
		expect(displayRaster.mock.calls[0]?.[0]).toBe("jxl")
		expect(displayRaster.mock.calls[0]?.[2].maxPixels).toBe(Math.floor((1024 * 1024 * 1024 - 6) / 70))
	})

	it("shows a gzipped SVG inflated, through a blob <img>, and a card for one that inflates past its cap", async () => {
		URL.createObjectURL = vi.fn(() => "blob:svg")
		URL.revokeObjectURL = vi.fn()
		downloadFileBytes.mockResolvedValue(new Uint8Array([0x1f, 0x8b]))
		gunzipSvg.mockResolvedValueOnce(new Blob(["<svg/>"], { type: "image/svg+xml" }))

		const svgz = (uuid: LinkedFile["uuid"]): DriveItem =>
			linkedFileItem("logo.svgz", { uuid, size: 2n, mime: { Decrypted: "image/svg+xml" } })
		const view = render(createElement(ImageViewer, { item: svgz("eeeeeeee-0000-0000-0000-000000000016"), alt: "logo" }))

		await waitFor(() => {
			expect(screen.getByRole("img", { name: "logo" }).getAttribute("src")).toBe("blob:svg")
		})
		expect(gunzipSvg.mock.calls[0]?.[1]).toBe(32 * 1024 * 1024)
		view.unmount()

		gunzipSvg.mockResolvedValueOnce(null)
		render(createElement(ImageViewer, { item: svgz("eeeeeeee-0000-0000-0000-000000000017"), alt: "logo" }))

		await screen.findByText("This image is too large to show once uncompressed.")
	})

	it("refuses a file above the held cap before downloading it", async () => {
		render(createElement(ImageViewer, { item: qoi("eeeeeeee-0000-0000-0000-000000000014", 300 * 1024 * 1024), alt: "render" }))

		await screen.findByText("This file is too large to show here.")
		expect(downloadFileBytes).not.toHaveBeenCalled()
	})
})

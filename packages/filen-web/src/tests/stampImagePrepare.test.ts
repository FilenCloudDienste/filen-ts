// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"

// A stamp from a picture our own decoders read is scaled to the stamp's size in the worker: the page gets that bitmap,
// never the full-resolution RGBA.

const { displayRaster, decodeRasterRgba } = vi.hoisted(() => ({
	displayRaster: vi.fn(),
	decodeRasterRgba: vi.fn()
}))

vi.mock("@/features/preview/lib/rasterDecode", () => ({ displayRaster, decodeRasterRgba, RASTER_BYTES_PER_PIXEL: { qoi: 8, jxl: 70 } }))

const { prepareStampImage, STAMP_MAX_SIDE } = await import("@/features/pdf/annotations/stampImage")

beforeEach(() => {
	vi.clearAllMocks()
	HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement["getContext"]
	HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
		callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]))
	}
})

describe("prepareStampImage", () => {
	it.each(["render.qoi", "photo.jxl"])("scales %s to the stamp in the worker", async name => {
		const close = vi.fn()

		displayRaster.mockResolvedValue({ bitmap: { width: STAMP_MAX_SIDE, height: 1024, close }, width: 8000, height: 4000 })

		const image = await prepareStampImage(new Uint8Array(16), name)

		expect(displayRaster.mock.calls[0]?.[2]).toMatchObject({ maxLongSide: STAMP_MAX_SIDE })
		expect(decodeRasterRgba).not.toHaveBeenCalled()
		expect(image).toMatchObject({ width: STAMP_MAX_SIDE, height: 1024 })
		expect(close).toHaveBeenCalledOnce()
	})
})

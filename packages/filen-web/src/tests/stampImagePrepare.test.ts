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

	// The page's side of a HEIC: the frame wrapped as ImageData, and a bitmap of whatever size was asked for.
	function stubHeic(width: number, height: number) {
		const close = vi.fn()
		const createImageBitmap = vi.fn((_frame: unknown, options?: ImageBitmapOptions) =>
			Promise.resolve({ width: options?.resizeWidth ?? width, height: options?.resizeHeight ?? height, close })
		)

		vi.stubGlobal("createImageBitmap", createImageBitmap)
		vi.stubGlobal("ImageData", vi.fn())
		decodeRasterRgba.mockResolvedValue({ data: new Uint8ClampedArray(4), width, height })

		return { createImageBitmap, close }
	}

	it("makes a HEIC's bitmap at the stamp's size, never full size", async () => {
		const { createImageBitmap, close } = stubHeic(8064, 6048)

		try {
			const image = await prepareStampImage(new Uint8Array(16), "photo.heic")
			const options = createImageBitmap.mock.calls[0]?.[1]

			expect(createImageBitmap).toHaveBeenCalledOnce()
			expect(options).toMatchObject({ resizeWidth: STAMP_MAX_SIDE, resizeHeight: 1536 })
			expect(Math.max(options?.resizeWidth ?? Infinity, options?.resizeHeight ?? Infinity)).toBeLessThanOrEqual(STAMP_MAX_SIDE)
			expect(image).toMatchObject({ width: STAMP_MAX_SIDE, height: 1536 })
			expect(close).toHaveBeenCalledOnce()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("never scales a small HEIC up", async () => {
		const { createImageBitmap } = stubHeic(640, 480)

		try {
			const image = await prepareStampImage(new Uint8Array(16), "photo.heic")

			expect(createImageBitmap.mock.calls[0]?.[1]).toBeUndefined()
			expect(image).toMatchObject({ width: 640, height: 480 })
		} finally {
			vi.unstubAllGlobals()
		}
	})
})

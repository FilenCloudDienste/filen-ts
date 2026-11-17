import { describe, expect, it, vi } from "vitest"

// The raster thumbnail worker draws one thumbnail at a time; a generation stopped while it waited its turn is not drawn.

const { use } = vi.hoisted(() => ({ use: vi.fn() }))

vi.mock("@/features/drive/workers/thumbRaster.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/lib/workers/ownedWorker", () => ({ statelessWorker: () => ({ use }) }))

const { thumbnailRaster } = await import("@/features/drive/lib/thumbRaster")

describe("thumbnailRaster", () => {
	it("skips a thumbnail whose generation stopped while another held the worker", async () => {
		let finish: (bytes: Uint8Array) => void = () => undefined

		use.mockImplementationOnce(() => new Promise<Uint8Array>(resolve => (finish = resolve)))

		const first = thumbnailRaster(new Uint8Array(4), "image/jxl", { width: 1, height: 1 }, 384)
		const stop = new AbortController()
		const second = thumbnailRaster(new Uint8Array(4), "image/jxl", { width: 1, height: 1 }, 384, stop.signal)

		await vi.waitFor(() => {
			expect(use).toHaveBeenCalledOnce()
		})
		stop.abort()
		finish(new Uint8Array([1]))

		await expect(first).resolves.toEqual(new Uint8Array([1]))
		await expect(second).rejects.toThrow()
		expect(use).toHaveBeenCalledOnce()
	})
})

import { beforeEach, describe, expect, it, vi } from "vitest"

// libjxl through @jsquash/jxl: a header over the budget is refused before the decoder loads, and a decode that failed
// (an out-of-memory abort kills the module) makes the next decode start a fresh instance.

const { decode, init } = vi.hoisted(() => ({ decode: vi.fn(), init: vi.fn() }))

vi.mock("@jsquash/jxl/decode", () => ({ default: decode, init }))
vi.mock("@jsquash/jxl/codec/dec/jxl_dec.wasm?url", () => ({ default: "/jxl_dec.wasm" }))

const { decodeJxl } = await import("@/features/preview/lib/rasterCodecs/jxl")
const { RasterBudgetError } = await import("@/features/preview/lib/rasterCodecs/raster")

// A bare codestream of 1000 × 750.
const JXL = Uint8Array.from([0xff, 0x0a, 0x6a, 0x17, 0x03, 0x00])

beforeEach(() => {
	vi.clearAllMocks()
	init.mockResolvedValue({})
})

describe("decodeJxl", () => {
	it("refuses a header over the budget before loading the decoder", async () => {
		await expect(decodeJxl(JXL, 1000 * 750 - 1)).rejects.toBeInstanceOf(RasterBudgetError)
		expect(init).not.toHaveBeenCalled()
	})

	it("starts a fresh decoder after a decode that failed", async () => {
		decode.mockRejectedValueOnce(new Error("RuntimeError: Aborted(OOM)"))

		await expect(decodeJxl(JXL, 1000 * 750)).rejects.toThrow("Aborted(OOM)")

		decode.mockResolvedValue({ width: 1000, height: 750, data: new Uint8ClampedArray(1000 * 750 * 4).fill(255) })

		await expect(decodeJxl(JXL, 1000 * 750)).resolves.toMatchObject({ width: 1000, hasAlpha: false })
		expect(init).toHaveBeenCalledTimes(2)
	})
})

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The boot probe (nativeImageSupport.ts): one tiny decode per format, its answer written into the device profile.
// jsdom decodes nothing, so HTMLImageElement.decode and naturalWidth are stubbed per test; each test loads fresh
// modules, as the probe and the profile are module state.

const decode = vi.fn<(this: HTMLImageElement) => Promise<void>>()
let naturalWidth = 0

beforeEach(() => {
	vi.resetModules()
	decode.mockReset()
	naturalWidth = 0
	URL.createObjectURL = vi.fn(() => "blob:probe")
	URL.revokeObjectURL = vi.fn()
	Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, writable: true, value: decode })
	Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => naturalWidth })
})

afterEach(() => {
	vi.useRealTimers()
})

async function load() {
	const probe = await import("@/lib/nativeImageSupport")
	const profile = await import("@/lib/deviceProfile")

	return { ...probe, ...profile }
}

describe("nativeImageSupport", () => {
	it("writes a decoded format as yes and a refused one as no", async () => {
		const { probeNativeImage, deviceProfile } = await load()

		naturalWidth = 64
		decode.mockImplementationOnce(() => Promise.resolve())
		decode.mockImplementationOnce(() => Promise.reject(new DOMException("unsupported", "EncodingError")))

		expect(await probeNativeImage("heic")).toBe(true)
		expect(await probeNativeImage("jxl")).toBe(false)
		expect(deviceProfile()).toMatchObject({ heicNative: "yes", jxlNative: "no" })
	})

	it("decodes each format once per tab, however many ask", async () => {
		const { probeNativeImage, supportsNativeImage } = await load()

		naturalWidth = 1
		decode.mockResolvedValue(undefined)

		await Promise.all([probeNativeImage("jxl"), supportsNativeImage("jxl"), probeNativeImage("jxl")])

		expect(decode).toHaveBeenCalledTimes(1)
	})

	it("counts a decode with no pixels as none", async () => {
		const { supportsNativeImage } = await load()

		decode.mockResolvedValue(undefined)

		expect(await supportsNativeImage("heic")).toBe(false)
	})

	it("counts a decode that never answers as none", async () => {
		vi.useFakeTimers()

		const { supportsNativeImage } = await load()

		decode.mockReturnValue(new Promise<void>(() => undefined))

		const result = supportsNativeImage("heic")

		await vi.advanceTimersByTimeAsync(3_000)

		expect(await result).toBe(false)
	})

	it("says no where the browser cannot decode an image on request", async () => {
		const { supportsNativeImage } = await load()

		Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, writable: true, value: undefined })

		expect(await supportsNativeImage("jxl")).toBe(false)
	})

	it("re-writes an unknown profile from the cached answer, and never overrides a set one", async () => {
		const { probeNativeImage, deviceProfile, refineDeviceProfile } = await load()

		naturalWidth = 1
		decode.mockResolvedValue(undefined)

		await probeNativeImage("heic")
		refineDeviceProfile({ heicNative: "unknown" })
		await probeNativeImage("heic")

		expect(deviceProfile().heicNative).toBe("yes")

		refineDeviceProfile({ heicNative: "no" })
		await probeNativeImage("heic")

		expect(deviceProfile().heicNative).toBe("no")
		expect(decode).toHaveBeenCalledTimes(1)
	})
})

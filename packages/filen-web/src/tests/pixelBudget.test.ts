import { describe, expect, it } from "vitest"
import { MUPDF_BYTES_PER_PIXEL, PDF_DESKTOP_MEMORY, PDF_HEAP_BASELINE, PDF_MOBILE_MEMORY } from "@filen/office/core/pdfedit"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { edit, mupdf, nativeViewCrash, thumbnail, workerDecodeBytes, workerDecodePixels } from "@/lib/pixelBudget"

const MIB = 1024 * 1024

function profile(overrides: Partial<DeviceProfile>): DeviceProfile {
	return {
		heicNative: "unknown",
		jxlNative: "unknown",
		appleMobile: false,
		mobile: false,
		phone: false,
		pdfRangedMax: null,
		...overrides
	}
}

const DESKTOP = profile({})
const ANDROID = profile({ mobile: true })
const IOS = profile({ mobile: true, appleMobile: true })

describe("pixelBudget", () => {
	it("caps a native <img> at 50 MP on a phone only; tablets and desktops have no cap", () => {
		expect(nativeViewCrash(profile({ mobile: true, phone: true }))).toBe(50_000_000)
		expect(nativeViewCrash(profile({ mobile: true, phone: true, appleMobile: true }))).toBe(50_000_000)
		expect(nativeViewCrash(ANDROID)).toBeNull()
		expect(nativeViewCrash(IOS)).toBeNull()
		expect(nativeViewCrash(DESKTOP)).toBeNull()
	})

	it("gives the image editor the values it always had: 50 MP, 16 MP on iOS and iPadOS only", () => {
		expect(edit(DESKTOP)).toBe(50_000_000)
		expect(edit(ANDROID)).toBe(50_000_000)
		expect(edit(IOS)).toBe(16_000_000)
	})

	it("budgets a worker decode at 1 GiB on desktop and 384 MiB on a phone", () => {
		expect(workerDecodeBytes(DESKTOP)).toBe(1024 * MIB)
		expect(workerDecodeBytes(ANDROID)).toBe(384 * MIB)
		expect(workerDecodeBytes(IOS)).toBe(384 * MIB)
	})

	it("takes the held file off a worker decode's pixels, at the consumer's bytes per pixel", () => {
		expect(workerDecodePixels(DESKTOP, 0, 8)).toBe((1024 * MIB) / 8)
		expect(workerDecodePixels(DESKTOP, 24 * MIB, 8)).toBe((1000 * MIB) / 8)
		expect(workerDecodePixels(ANDROID, 0, 20)).toBe(Math.floor((384 * MIB) / 20))
		expect(workerDecodePixels(ANDROID, 512 * MIB, 4)).toBe(0)
	})

	it("prices a MuPDF image page from the PDF heap budget, less the baseline and the file it holds", () => {
		expect(MUPDF_BYTES_PER_PIXEL).toBe(17)
		expect(mupdf(DESKTOP, 0)).toBe(Math.floor((PDF_DESKTOP_MEMORY.heapBudget - PDF_HEAP_BASELINE) / 17))
		expect(mupdf(ANDROID, 0)).toBe(Math.floor((PDF_MOBILE_MEMORY.heapBudget - PDF_HEAP_BASELINE) / 17))
		expect(mupdf(DESKTOP, 64 * MIB)).toBeLessThan(mupdf(DESKTOP, 0))
		expect(mupdf(DESKTOP, 63 * MIB + MUPDF_BYTES_PER_PIXEL)).toBeLessThan(mupdf(DESKTOP, 63 * MIB))
		expect(mupdf(ANDROID, 1024 * MIB)).toBe(0)
	})

	it("prices a thumbnail decode at 4 bytes a pixel of the SDK's 64 MiB", () => {
		expect(thumbnail()).toBe(16_777_216)
	})
})

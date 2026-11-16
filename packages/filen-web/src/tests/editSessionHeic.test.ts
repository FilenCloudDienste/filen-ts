// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { HEIC_PROBE_BASE64 } from "@/lib/imageProbeFixtures"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// Entering the editor on a HEIC keeps the libheif decode (with its Exif and ICC) on every browser: where the viewer
// streams the picture natively, the editor still reads the file's bytes and decodes them itself.

const { decodeHeicRgba, close } = vi.hoisted(() => ({
	decodeHeicRgba: vi.fn(() => Promise.resolve({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4), hasAlpha: false })),
	close: vi.fn()
}))

const HEIC = Uint8Array.from(atob(HEIC_PROBE_BASE64), character => character.charCodeAt(0))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/preview/lib/rasterDecode", () => ({ decodeHeicRgba, transformHeicBytesOwned: vi.fn() }))
vi.mock("@/features/preview/lib/previewCache", () => ({
	getPreviewBytes: () => undefined,
	loadPreviewBytes: () => Promise.resolve(HEIC)
}))
vi.mock("@/features/preview/imageEdit/renderClient", () => ({
	openEditSession: () =>
		Promise.resolve({
			session: { close },
			capabilities: { webgl2: true, maxTextureSize: 4096, maxPixels: 50_000_000, canEncodeWebp: true }
		})
}))

const { enterImageEdit } = await import("@/features/preview/imageEdit/editSession")
const { refineDeviceProfile } = await import("@/lib/deviceProfile")

describe("enterImageEdit on a HEIC", () => {
	it("decodes the file's bytes with libheif where the browser shows HEIC by itself", async () => {
		refineDeviceProfile({ heicNative: "yes" })

		const item = linkedFileItem("photo.heic", { size: BigInt(HEIC.length) })
		const image = document.createElement("img")
		const outcome = await enterImageEdit({
			item,
			frozenUuid: item.data.uuid,
			cacheScope: null,
			image,
			signal: new AbortController().signal
		})

		expect(outcome.status).toBe("ready")
		expect(decodeHeicRgba).toHaveBeenCalledOnce()

		if (outcome.status === "ready") {
			expect(outcome.state.source.kind).toBe("rgba")
			expect(outcome.state.buffered).toBe(true)
			expect(outcome.state.info.mime).toBe("image/heic")
			outcome.state.release()
		}
	})
})

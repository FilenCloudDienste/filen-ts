// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ImagePageSource } from "@/features/preview/lib/imagePageSource"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { tiffHead } from "@/tests/support/tiffBytes"

// Entering the editor on a TIFF: the page the viewer shows is drawn whole by the engine that holds the file (nothing
// is downloaded here), refused when it is larger than the editor takes, and a page of several is saved alone.

const { close, readFileBytesRange } = vi.hoisted(() => ({
	close: vi.fn(),
	readFileBytesRange: vi.fn()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { readFileBytesRange, cancelPreviewDownload: vi.fn() } }))
vi.mock("@/features/preview/lib/previewCache", () => ({ getPreviewBytes: () => undefined, loadPreviewBytes: vi.fn() }))
vi.mock("@/features/preview/imageEdit/renderClient", () => ({
	openEditSession: () =>
		Promise.resolve({
			session: { close },
			capabilities: { webgl2: true, maxTextureSize: 4096, maxPixels: 50_000_000, canEncodeWebp: true }
		})
}))

const { enterImageEdit } = await import("@/features/preview/imageEdit/editSession")

function shownPage(
	extent: { width: number; height: number },
	pageCount: number
): { page: ImagePageSource; renderRgba: ReturnType<typeof vi.fn> } {
	const renderRgba = vi.fn(() => Promise.resolve({ rgba: new Uint8ClampedArray(extent.width * extent.height * 4).fill(255), ...extent }))

	return { page: { page: 1, pageCount, extent: () => Promise.resolve(extent), renderRgba }, renderRgba }
}

describe("enterImageEdit on a TIFF", () => {
	it("draws the page shown through the viewer's engine, as a copy of that page alone", async () => {
		readFileBytesRange.mockResolvedValue(tiffHead(8, 4))

		const item = linkedFileItem("scan.tif", { size: 4096n })
		const { page, renderRgba } = shownPage({ width: 6, height: 3 }, 3)
		const outcome = await enterImageEdit({
			item,
			frozenUuid: item.data.uuid,
			cacheScope: null,
			image: null,
			page,
			signal: new AbortController().signal
		})

		expect(outcome.status).toBe("ready")

		if (outcome.status === "ready") {
			expect(outcome.state.source.kind).toBe("rgba")
			expect(outcome.state.info).toMatchObject({ mime: "image/tiff", width: 6, height: 3, hasAlpha: false })
			expect(outcome.state.pageOnly).toBe(true)
			expect(outcome.state.buffered).toBe(false)
			expect(outcome.state.targets.primary).toEqual({ kind: "copy", mime: "image/jpeg", extension: "jpg" })
			outcome.state.release()
		}

		expect(renderRgba).toHaveBeenCalledWith(50_000_000, expect.any(AbortSignal))
	})

	it("refuses a page larger than the editor takes without drawing it", async () => {
		readFileBytesRange.mockResolvedValue(tiffHead(8, 4))

		const item = linkedFileItem("scan.tiff", { size: 4096n })
		const { page, renderRgba } = shownPage({ width: 10_000, height: 10_000 }, 1)
		const outcome = await enterImageEdit({
			item,
			frozenUuid: item.data.uuid,
			cacheScope: null,
			image: null,
			page,
			signal: new AbortController().signal
		})

		expect(outcome).toEqual({ status: "refused", messageKey: "previewImageSaveRefusedTooLarge" })
		expect(renderRgba).not.toHaveBeenCalled()
	})
})

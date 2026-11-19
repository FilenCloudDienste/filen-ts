// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { SourceInfo } from "@/features/preview/imageEdit/types"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// Entering the editor refuses through isEditableSource, the one predicate its own tests cover: a format the name does
// not claim and an animation each get their own message.

const { sniffImage, isEditableSource, openEditSession } = vi.hoisted(() => ({
	sniffImage: vi.fn(),
	isEditableSource: vi.fn(),
	openEditSession: vi.fn()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { readFileBytesRange: () => Promise.resolve(new Uint8Array(16)), cancelPreviewDownload: vi.fn() }
}))
vi.mock("@/features/preview/lib/previewCache", () => ({ getPreviewBytes: () => undefined, loadPreviewBytes: vi.fn() }))
vi.mock("@/features/preview/lib/imageSniff/sniffImage", () => ({ sniffImage }))
vi.mock("@/features/preview/imageEdit/renderClient", () => ({ openEditSession }))
vi.mock("@/features/preview/imageEdit/lib/targets", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/imageEdit/lib/targets")>()

	isEditableSource.mockImplementation(actual.isEditableSource)

	return { ...actual, isEditableSource }
})

const { enterImageEdit } = await import("@/features/preview/imageEdit/editSession")

function info(overrides: Partial<SourceInfo>): SourceInfo {
	return {
		mime: "image/jpeg",
		width: 8,
		height: 4,
		orientation: 1,
		hasAlpha: false,
		animated: false,
		pngTruecolor8: false,
		webpLossless: false,
		jpegQuality: null,
		icc: null,
		exif: null,
		needsTail: false,
		...overrides
	}
}

async function enter(name: string, sniffed: SourceInfo) {
	sniffImage.mockReturnValue(sniffed)
	isEditableSource.mockClear()

	const item = linkedFileItem(name, { size: 4096n })

	return await enterImageEdit({ item, frozenUuid: item.data.uuid, cacheScope: null, image: null, signal: new AbortController().signal })
}

describe("enterImageEdit's gate", () => {
	it("refuses bytes that are not the format the name claims as unsupported", async () => {
		const sniffed = info({ mime: "image/png" })

		expect(await enter("photo.jpg", sniffed)).toEqual({ status: "refused", messageKey: "previewImageSaveRefusedUnsupported" })
		expect(isEditableSource).toHaveBeenCalledWith(sniffed, "photo.jpg")
		expect(openEditSession).not.toHaveBeenCalled()
	})

	it("refuses an animation as animated", async () => {
		const sniffed = info({ mime: "image/gif", animated: true })

		expect(await enter("loop.gif", sniffed)).toEqual({ status: "refused", messageKey: "previewImageSaveRefusedAnimated" })
		expect(isEditableSource).toHaveBeenCalledWith(sniffed, "loop.gif")
		expect(openEditSession).not.toHaveBeenCalled()
	})

	it("lets a TIFF of unknown (0 × 0) sniffed size through to the session", async () => {
		const close = vi.fn()

		openEditSession.mockResolvedValueOnce({ session: { close }, capabilities: { webgl2: false, maxPixels: 1 } })

		const sniffed = info({ mime: "image/tiff", width: 0, height: 0 })

		// The fake session has no graphics, so the refusal comes from past the gate.
		expect(await enter("scan.tif", sniffed)).toEqual({ status: "refused", messageKey: "previewImageSaveRefusedNoGraphics" })
		expect(isEditableSource).toHaveBeenCalledWith(sniffed, "scan.tif")
		expect(openEditSession).toHaveBeenCalledOnce()
		expect(close).toHaveBeenCalledOnce()
	})
})

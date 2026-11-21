import { describe, expect, it, vi } from "vitest"
import { mockFileItem } from "@/tests/fixtures/sdk"

// A closed document's read for the assistant (cache: false): served from the preview cache when there, otherwise
// neither kept there nor evicting what a viewer holds.

const { downloadFileBytes } = vi.hoisted(() => ({ downloadFileBytes: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))) }))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadFileBytes, cancelPreviewDownload: vi.fn() },
	threadCount: () => 1
}))

const { loadDriveFileBytes } = await import("@/features/preview/lib/fileBytes")
const { getPreviewBytes } = await import("@/features/preview/lib/previewCache")

describe("loadDriveFileBytes", () => {
	it("keeps a read in the preview cache by default, and not with cache: false", async () => {
		const kept = mockFileItem({ uuid: "kept-0-0-0", size: 3n })
		const passing = mockFileItem({ uuid: "pass-0-0-0", size: 3n })

		await loadDriveFileBytes(kept)
		expect(getPreviewBytes("authed", "kept-0-0-0")).toBeDefined()

		await loadDriveFileBytes(passing, undefined, { cache: false })
		expect(getPreviewBytes("authed", "pass-0-0-0")).toBeUndefined()
		expect(getPreviewBytes("authed", "kept-0-0-0")).toBeDefined()
	})

	it("serves a closed read from the cache when a viewer holds the file", async () => {
		const item = mockFileItem({ uuid: "held-0-0-0", size: 3n })
		const held = await loadDriveFileBytes(item)

		downloadFileBytes.mockClear()

		expect(await loadDriveFileBytes(item, undefined, { cache: false })).toBe(held)
		expect(downloadFileBytes).not.toHaveBeenCalled()
	})
})

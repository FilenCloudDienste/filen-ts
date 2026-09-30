import { vi, describe, it, expect, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
	storeFile: vi.fn(),
	storeDirectory: vi.fn(),
	appendOfflineSyncErrors: vi.fn()
}))

vi.mock("@/features/offline/offline", () => ({ default: { storeFile: h.storeFile, storeDirectory: h.storeDirectory } }))
vi.mock("@/features/offline/store/useOffline.store", () => ({ appendOfflineSyncErrors: h.appendOfflineSyncErrors }))
vi.mock("@/features/drive/driveSelectors", () => ({
	isFileItem: (item: { type: string }) => item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
}))

import { storeItemOffline } from "@/features/offline/storeItem"
import type { DriveItem } from "@/types"
import type { OfflineParent } from "@/features/offline/offlineHelpers"

const parent = { tag: "parent" } as unknown as OfflineParent

describe("storeItemOffline", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("stores a file without touching the offline error list", async () => {
		const item = { type: "file", data: { uuid: "f" } } as unknown as DriveItem

		await storeItemOffline({ item, parent })

		expect(h.storeFile).toHaveBeenCalledWith({ file: item, parent })
		expect(h.storeDirectory).not.toHaveBeenCalled()
		expect(h.appendOfflineSyncErrors).not.toHaveBeenCalled()
	})

	it("stores a directory and surfaces only its degraded warnings", async () => {
		const item = { type: "directory", data: { uuid: "d" } } as unknown as DriveItem
		const degraded = { uuid: "a", degraded: true }

		h.storeDirectory.mockResolvedValue([degraded, { uuid: "b" }, { uuid: "c", degraded: false }])

		await storeItemOffline({ item, parent })

		expect(h.storeDirectory).toHaveBeenCalledWith({ directory: item, parent })
		expect(h.appendOfflineSyncErrors).toHaveBeenCalledWith([degraded])
	})

	it("propagates a store failure", async () => {
		const item = { type: "directory", data: { uuid: "d" } } as unknown as DriveItem

		h.storeDirectory.mockRejectedValue(new Error("boom"))

		await expect(storeItemOffline({ item, parent })).rejects.toThrow("boom")
		expect(h.appendOfflineSyncErrors).not.toHaveBeenCalled()
	})
})

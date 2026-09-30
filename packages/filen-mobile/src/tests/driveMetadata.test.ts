import { vi, describe, it, expect } from "vitest"

// ─── Module boundary mocks ───────────────────────────────────────────────────
//
// Importing driveMetadata.ts pulls in the SDK + auth/cache/query chain at module
// load. Stub those boundaries so the test stays a fast, isolated unit test.

vi.mock("@filen/sdk-rs", () => ({
	CreatedTime: {},
	DirColor: {},
	NonRootNormalItem: {},
	NonRootNormalItem_Tags: {}
}))

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: vi.fn() }
}))

vi.mock("@/lib/cache", () => ({
	default: { cacheNewNormalDir: vi.fn(), cacheNewFile: vi.fn() }
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapDirMeta: vi.fn(),
	unwrapFileMeta: vi.fn(),
	unwrapParentUuid: vi.fn(),
	unwrappedDirIntoDriveItem: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn()
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdateRoot: vi.fn(),
	driveItemsQueryUpdateGlobal: vi.fn()
}))

// ─── Actual imports ──────────────────────────────────────────────────────────

import { setDirColor } from "@/features/drive/driveMetadata"
import auth from "@/lib/auth"
import { unwrappedDirIntoDriveItem, unwrapParentUuid } from "@/lib/sdkUnwrap"
import events from "@/lib/events"
import type { DirColor } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"

// ─── setDirColor — search/preview self-heal ──────────────────────────────────

describe("setDirColor", () => {
	it("emits driveItemUpdated with the pre-change uuid and the recolored item", async () => {
		const updatedItem = {
			type: "directory",
			data: {
				uuid: "dir-new",
				parent: null
			}
		} as unknown as DriveItem

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				setDirColor: vi.fn(async () => ({}))
			}
		} as never)
		vi.mocked(unwrappedDirIntoDriveItem).mockReturnValue(updatedItem)
		vi.mocked(unwrapParentUuid).mockReturnValue(null)

		const updates: { previousUuid: string; item: DriveItem }[] = []
		const sub = events.subscribe("driveItemUpdated", payload => updates.push(payload))

		const original = {
			type: "directory",
			data: {
				uuid: "dir-old"
			}
		} as unknown as DriveItem

		await setDirColor({ item: original, color: "blue" as unknown as DirColor })

		sub.remove()

		expect(updates).toHaveLength(1)
		expect(updates[0]?.previousUuid).toBe("dir-old")
		expect(updates[0]?.item).toBe(updatedItem)
	})
})

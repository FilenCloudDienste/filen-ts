import { vi, describe, it, expect } from "vitest"

// ─── Module boundary mocks ───────────────────────────────────────────────────
//
// favoritesListingUpdater is a pure helper, but importing driveMetadata.ts pulls
// in the SDK + auth/cache/query chain at module load. Stub those boundaries so
// the test stays a fast, isolated unit test of the updater logic only.

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

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
	driveItemsQueryUpdate: vi.fn(),
	driveItemsQueryUpdateGlobal: vi.fn()
}))

vi.mock("@/lib/signals", () => ({
	toSignalOpts: vi.fn()
}))

// ─── Actual imports ──────────────────────────────────────────────────────────

import { favoritesListingUpdater } from "@/features/drive/driveMetadata"
import type { DriveItem } from "@/types"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function item(uuid: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid
		}
	} as unknown as DriveItem
}

// ─── favoritesListingUpdater ─────────────────────────────────────────────────

describe("favoritesListingUpdater", () => {
	describe("favorited === true (add)", () => {
		it("adds a newly-favorited item to an empty listing", () => {
			const a = item("a")
			const result = favoritesListingUpdater([], a, true)

			expect(result).toHaveLength(1)
			expect(result[0]).toBe(a)
		})

		it("appends a newly-favorited item to a non-empty listing", () => {
			const a = item("a")
			const b = item("b")
			const result = favoritesListingUpdater([a], b, true)

			expect(result).toHaveLength(2)
			expect(result.map(i => i.data.uuid)).toEqual(["a", "b"])
		})

		it("does not duplicate an already-present item (refreshes in place)", () => {
			const aOld = item("a")
			const aNew = item("a")
			const result = favoritesListingUpdater([aOld], aNew, true)

			expect(result).toHaveLength(1)
			expect(result[0]).toBe(aNew)
		})

		it("keeps the rest of the listing intact when refreshing one item", () => {
			const a = item("a")
			const bOld = item("b")
			const bNew = item("b")
			const c = item("c")
			const result = favoritesListingUpdater([a, bOld, c], bNew, true)

			expect(result.map(i => i.data.uuid)).toEqual(["a", "c", "b"])
			expect(result).toContain(bNew)
			expect(result).not.toContain(bOld)
		})
	})

	describe("favorited === false (remove)", () => {
		it("removes the unfavorited item from the listing", () => {
			const a = item("a")
			const b = item("b")
			const result = favoritesListingUpdater([a, b], a, false)

			expect(result).toHaveLength(1)
			expect(result[0]).toBe(b)
		})

		it("returns the listing unchanged when the item is not present", () => {
			const a = item("a")
			const b = item("b")
			const result = favoritesListingUpdater([a], b, false)

			expect(result.map(i => i.data.uuid)).toEqual(["a"])
		})

		it("yields an empty listing when removing the only item", () => {
			const a = item("a")
			const result = favoritesListingUpdater([a], a, false)

			expect(result).toHaveLength(0)
		})
	})

	it("does not mutate the input array", () => {
		const a = item("a")
		const b = item("b")
		const prev = [a]

		favoritesListingUpdater(prev, b, true)
		favoritesListingUpdater(prev, a, false)

		expect(prev).toEqual([a])
	})
})

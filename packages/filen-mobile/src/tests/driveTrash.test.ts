import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted state
// ---------------------------------------------------------------------------

const {
	mockGetSdkClients,
	mockRestoreFile,
	mockRestoreFileVersion,
	mockDeleteFileVersion,
	mockDeleteFilePermanently,
	mockDeleteDirPermanently,
	mockDriveItemsQueryUpdateForNormalParent,
	mockDriveItemsQueryUpdate,
	mockDriveItemVersionsQueryUpdate,
	mockCacheNewFile,
	mockCacheForgetItem,
	mockUnwrapParentUuid,
	mockUnwrapFileMeta,
	mockUnwrappedFileIntoDriveItem
} = vi.hoisted(() => ({
	mockGetSdkClients: vi.fn(),
	mockRestoreFile: vi.fn(),
	mockRestoreFileVersion: vi.fn(),
	mockDeleteFileVersion: vi.fn(),
	mockDeleteFilePermanently: vi.fn().mockResolvedValue(undefined),
	mockDeleteDirPermanently: vi.fn().mockResolvedValue(undefined),
	mockDriveItemsQueryUpdateForNormalParent: vi.fn(),
	mockDriveItemsQueryUpdate: vi.fn(),
	mockDriveItemVersionsQueryUpdate: vi.fn(),
	mockCacheNewFile: vi.fn(),
	mockCacheForgetItem: vi.fn(),
	// null → restoreFileVersion / deletePermanently skips the global parent-listing
	// branch, keeping these tests focused on the trash-listing update.
	mockUnwrapParentUuid: vi.fn().mockReturnValue(null),
	mockUnwrapFileMeta: vi.fn((x: unknown) => x),
	// Build a minimal DriveItem-shaped object so the post-restore type guard passes.
	mockUnwrappedFileIntoDriveItem: vi.fn((x: { uuid: string }) => ({
		type: "file",
		data: {
			uuid: x.uuid,
			parent: null,
			decryptedMeta: null
		}
	}))
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// driveTrash now imports driveSelectors → serializer → logger, which pulls in expo-file-system
// (crashes under vitest with "__DEV__ is not defined"). Mock the logger to break that chain.
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: mockUnwrapParentUuid,
	unwrapFileMeta: mockUnwrapFileMeta,
	unwrappedFileIntoDriveItem: mockUnwrappedFileIntoDriveItem,
	unwrapDirMeta: vi.fn((x: unknown) => x),
	unwrappedDirIntoDriveItem: vi.fn((x: unknown) => x)
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdateGlobal: vi.fn(),
	driveItemsQueryUpdate: mockDriveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent: mockDriveItemsQueryUpdateForNormalParent,
	driveItemsQueryGet: vi.fn()
}))

vi.mock("@/features/drive/queries/useDriveItemVersions.query", () => ({
	driveItemVersionsQueryUpdate: mockDriveItemVersionsQueryUpdate
}))

vi.mock("@/lib/cache", () => ({
	default: {
		cacheNewFile: mockCacheNewFile,
		cacheNewNormalDir: vi.fn(),
		forgetItem: mockCacheForgetItem
	}
}))

vi.mock("@filen/sdk-rs", () => ({}))

import { restoreFileVersion, deleteVersion, deletePermanently, restore } from "@/features/drive/driveTrash"
import events from "@/lib/events"
import useFileVersionsStore from "@/features/drive/store/useFileVersions.store"
import type { DriveItem } from "@/types"
import type { FileVersion } from "@filen/sdk-rs"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fileItem = {
	type: "file",
	data: {
		uuid: "file-1",
		parent: null,
		decryptedMeta: null
	}
} as unknown as DriveItem

const makeVersion = (uuid: string): FileVersion => ({ uuid }) as unknown as FileVersion

beforeEach(() => {
	vi.clearAllMocks()

	useFileVersionsStore.getState().clearSelectedVersions()

	mockGetSdkClients.mockResolvedValue({
		authedSdkClient: {
			restoreFile: mockRestoreFile,
			restoreFileVersion: mockRestoreFileVersion,
			deleteFileVersion: mockDeleteFileVersion,
			deleteFilePermanently: mockDeleteFilePermanently,
			deleteDirPermanently: mockDeleteDirPermanently
		}
	})

	// The SDK returns the modified file; the unwrap mock turns it into a DriveItem.
	// `region` present so restore() takes the file branch.
	mockRestoreFile.mockResolvedValue({ uuid: "file-1", region: "us" })
	mockRestoreFileVersion.mockResolvedValue({ uuid: "file-1" })
	mockDeleteFileVersion.mockResolvedValue(undefined)
	mockDeleteFilePermanently.mockResolvedValue(undefined)
	mockDeleteDirPermanently.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Bug #11 — restoreFileVersion must refresh the versions list cache
// ---------------------------------------------------------------------------

describe("restoreFileVersion — versions list cache update (bug #11)", () => {
	it("calls driveItemVersionsQueryUpdate keyed on the file uuid after a restore", async () => {
		await restoreFileVersion({ item: fileItem, version: makeVersion("ver-old") })

		expect(mockDriveItemVersionsQueryUpdate).toHaveBeenCalledTimes(1)
		expect(mockDriveItemVersionsQueryUpdate.mock.calls[0]?.[0]?.params).toEqual({ uuid: "file-1" })
	})

	it("the updater drops the restored version from the cached list", async () => {
		await restoreFileVersion({ item: fileItem, version: makeVersion("ver-old") })

		const updater = mockDriveItemVersionsQueryUpdate.mock.calls[0]?.[0]?.updater as (prev: FileVersion[]) => FileVersion[]
		const next = updater([makeVersion("ver-old"), makeVersion("ver-keep")])

		expect(next.map(v => v.uuid)).toEqual(["ver-keep"])
	})
})

// ---------------------------------------------------------------------------
// Bug #10 — deleteVersion must purge the version from the selection store
// ---------------------------------------------------------------------------

describe("deleteVersion — selection purge (bug #10)", () => {
	it("removes the deleted version from selectedVersions, leaving others intact", async () => {
		useFileVersionsStore.getState().setSelectedVersions([makeVersion("ver-del"), makeVersion("ver-other")])

		await deleteVersion({ item: fileItem, version: makeVersion("ver-del") })

		expect(useFileVersionsStore.getState().selectedVersions.map(v => v.uuid)).toEqual(["ver-other"])
	})

	it("is a no-op on the selection when the deleted version was not selected", async () => {
		useFileVersionsStore.getState().setSelectedVersions([makeVersion("ver-other")])

		await deleteVersion({ item: fileItem, version: makeVersion("ver-del") })

		expect(useFileVersionsStore.getState().selectedVersions.map(v => v.uuid)).toEqual(["ver-other"])
	})

	it("still updates the versions list cache when deleting", async () => {
		await deleteVersion({ item: fileItem, version: makeVersion("ver-del") })

		expect(mockDriveItemVersionsQueryUpdate).toHaveBeenCalledTimes(1)
		expect(mockDriveItemVersionsQueryUpdate.mock.calls[0]?.[0]?.params).toEqual({ uuid: "file-1" })
	})
})

// ---------------------------------------------------------------------------
// Bug #34 — deletePermanently must remove item from the trash listing
// ---------------------------------------------------------------------------

const trashFileItem = {
	type: "file",
	data: {
		uuid: "trash-file-1",
		parent: null,
		decryptedMeta: null
	}
} as unknown as DriveItem

const trashDirItem = {
	type: "directory",
	data: {
		uuid: "trash-dir-1",
		parent: null,
		decryptedMeta: null
	}
} as unknown as DriveItem

describe("deletePermanently — trash listing removal (bug #34)", () => {
	it("calls driveItemsQueryUpdate for the trash path after deleting a file", async () => {
		await deletePermanently({ item: trashFileItem })

		expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()
		const call = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
			params: { path: { type: string; uuid: unknown } }
		}
		expect(call.params.path.type).toBe("trash")
		expect(call.params.path.uuid).toBeNull()
	})

	it("the trash updater filters out the permanently-deleted file uuid", async () => {
		await deletePermanently({ item: trashFileItem })

		const updater = mockDriveItemsQueryUpdate.mock.calls[0]?.[0]?.updater as (
			prev: Array<{ data: { uuid: string } }>
		) => Array<{ data: { uuid: string } }>

		const prev = [{ data: { uuid: "trash-file-1" } }, { data: { uuid: "other-file" } }]
		const result = updater(prev)

		expect(result).toHaveLength(1)
		expect(result[0]?.data.uuid).toBe("other-file")
	})

	it("calls driveItemsQueryUpdate for the trash path after deleting a directory", async () => {
		await deletePermanently({ item: trashDirItem })

		expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()
		const call = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
			params: { path: { type: string } }
		}
		expect(call.params.path.type).toBe("trash")
	})

	it("the trash updater filters out the permanently-deleted directory uuid", async () => {
		await deletePermanently({ item: trashDirItem })

		const updater = mockDriveItemsQueryUpdate.mock.calls[0]?.[0]?.updater as (
			prev: Array<{ data: { uuid: string } }>
		) => Array<{ data: { uuid: string } }>

		const prev = [{ data: { uuid: "trash-dir-1" } }, { data: { uuid: "other-dir" } }]
		const result = updater(prev)

		expect(result).toHaveLength(1)
		expect(result[0]?.data.uuid).toBe("other-dir")
	})

	it("fires the trash removal even when unwrapParentUuid returns null (the normal trash-item case)", async () => {
		mockUnwrapParentUuid.mockReturnValue(null)

		await deletePermanently({ item: trashFileItem })

		// driveItemsQueryUpdate (trash removal) must fire
		expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()
	})

	it("also calls cache.forgetItem with the deleted item uuid", async () => {
		await deletePermanently({ item: trashFileItem })

		expect(mockCacheForgetItem).toHaveBeenCalledWith("trash-file-1")
	})
})

// ---------------------------------------------------------------------------
// restore — search self-heal: emits driveItemRemoved (drop from trash views)
// AND driveItemUpdated (un-suppress an active /drive subtree cache-search whose
// Effect D tombstoned the item when it was trashed).
// ---------------------------------------------------------------------------

describe("restore — search self-heal events", () => {
	it("emits driveItemRemoved then driveItemUpdated carrying the PRE-restore uuid", async () => {
		// The mock rotates the uuid on restore (trash-file-1 -> file-1), proving the
		// driveItemUpdated carries the pre-restore uuid as previousUuid (what Effect D
		// tombstoned) and the restored uuid on the item.
		const removed: { uuid: string }[] = []
		const updated: { previousUuid: string; item: DriveItem }[] = []

		const subRemoved = events.subscribe("driveItemRemoved", payload => removed.push(payload))
		const subUpdated = events.subscribe("driveItemUpdated", payload => updated.push(payload))

		await restore({ item: trashFileItem })

		subRemoved.remove()
		subUpdated.remove()

		// Drops the restored item out of the trash list / preview (post-restore uuid).
		expect(removed).toEqual([{ uuid: "file-1" }])

		// Clears the drive-search tombstone keyed on the PRE-restore uuid so the next
		// snapshot re-includes it; carries the restored item for any in-place replace.
		expect(updated).toHaveLength(1)
		expect(updated[0]?.previousUuid).toBe("trash-file-1")
		expect(updated[0]?.item.data.uuid).toBe("file-1")
	})
})

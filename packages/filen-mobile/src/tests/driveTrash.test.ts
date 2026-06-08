import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted state
// ---------------------------------------------------------------------------

const {
	mockGetSdkClients,
	mockRestoreFileVersion,
	mockDeleteFileVersion,
	mockDriveItemsQueryUpdateForNormalParent,
	mockDriveItemVersionsQueryUpdate,
	mockCacheNewFile,
	mockUnwrapParentUuid,
	mockUnwrapFileMeta,
	mockUnwrappedFileIntoDriveItem
} = vi.hoisted(() => ({
	mockGetSdkClients: vi.fn(),
	mockRestoreFileVersion: vi.fn(),
	mockDeleteFileVersion: vi.fn(),
	mockDriveItemsQueryUpdateForNormalParent: vi.fn(),
	mockDriveItemVersionsQueryUpdate: vi.fn(),
	mockCacheNewFile: vi.fn(),
	// null → restoreFileVersion skips the parent-listing branch, keeping these
	// tests focused on the versions-list cache + selection purge.
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
	driveItemsQueryUpdate: vi.fn(),
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
		forgetItem: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => ({}))

import { restoreFileVersion, deleteVersion } from "@/features/drive/driveTrash"
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
			restoreFileVersion: mockRestoreFileVersion,
			deleteFileVersion: mockDeleteFileVersion
		}
	})

	// The SDK returns the modified file; the unwrap mock turns it into a DriveItem.
	mockRestoreFileVersion.mockResolvedValue({ uuid: "file-1" })
	mockDeleteFileVersion.mockResolvedValue(undefined)
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

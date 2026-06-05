import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted state
// ---------------------------------------------------------------------------

const {
	mockDriveItemsQueryUpdateGlobal,
	mockDriveItemsQueryUpdate,
	mockDriveItemsQueryUpdateForNormalParent,
	mockCacheForgetItem,
	mockCacheDirectoryUuidToAnyNormalDirGet,
	mockCacheFileUuidToNormalFileGet,
	mockUnwrapParentUuid
} = vi.hoisted(() => ({
	mockDriveItemsQueryUpdateGlobal: vi.fn(),
	mockDriveItemsQueryUpdate: vi.fn(),
	mockDriveItemsQueryUpdateForNormalParent: vi.fn(),
	mockCacheForgetItem: vi.fn(),
	mockCacheDirectoryUuidToAnyNormalDirGet: vi.fn(),
	mockCacheFileUuidToNormalFileGet: vi.fn(),
	mockUnwrapParentUuid: vi.fn().mockReturnValue("parent-1")
}))

// ---------------------------------------------------------------------------
// Module mocks — must be before any imports that load the mocked modules
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdateGlobal: mockDriveItemsQueryUpdateGlobal,
	driveItemsQueryUpdate: mockDriveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent: mockDriveItemsQueryUpdateForNormalParent
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnyNormalDir: { get: mockCacheDirectoryUuidToAnyNormalDirGet },
		fileUuidToNormalFile: { get: mockCacheFileUuidToNormalFileGet },
		forgetItem: mockCacheForgetItem,
		cacheNewFile: vi.fn(),
		cacheNewNormalDir: vi.fn()
	}
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: mockUnwrapParentUuid,
	unwrapDirMeta: vi.fn(x => x),
	unwrappedDirIntoDriveItem: vi.fn(x => x),
	unwrapFileMeta: vi.fn(x => x),
	unwrappedFileIntoDriveItem: vi.fn(x => x)
}))

vi.mock("@filen/sdk-rs", () => ({
	DriveEvent_Tags: {
		FileArchiveRestored: "FileArchiveRestored",
		FileRestore: "FileRestore",
		FileNew: "FileNew",
		FileArchived: "FileArchived",
		FileDeletedPermanent: "FileDeletedPermanent",
		FolderDeletedPermanent: "FolderDeletedPermanent",
		FileMetadataChanged: "FileMetadataChanged",
		FileMove: "FileMove",
		FolderMove: "FolderMove",
		FolderMetadataChanged: "FolderMetadataChanged",
		FileTrash: "FileTrash",
		FolderTrash: "FolderTrash",
		FolderColorChanged: "FolderColorChanged",
		FolderRestore: "FolderRestore",
		FolderSubCreated: "FolderSubCreated",
		ItemFavorite: "ItemFavorite",
		TrashEmpty: "TrashEmpty"
	},
	AnyNormalDir_Tags: {
		Dir: "Dir",
		Root: "Root"
	},
	NonRootItem_Tags: {
		File: "File",
		NormalDir: "NormalDir"
	},
	SocketEvent_Tags: {
		Drive: "Drive",
		Note: "Note"
	}
}))

// ---------------------------------------------------------------------------
// Import the unit under test AFTER all vi.mock declarations
// ---------------------------------------------------------------------------

import { handleDriveEvent, type DriveSocketEvent } from "@/features/drive/socketHandlers"
import { DriveEvent_Tags, AnyNormalDir_Tags, SocketEvent_Tags } from "@filen/sdk-rs"

// ---------------------------------------------------------------------------
// Helpers — build minimal socket-event shapes matching the handler's destructure:
//   const [eventInner] = event.inner
//   eventInner.inner.tag  → DriveEvent_Tags.*
//   const [inner] = eventInner.inner.inner
//   inner.uuid            → item uuid string
// ---------------------------------------------------------------------------

function makeFolderDeletedPermanentEvent(folderUuid: string): DriveSocketEvent {
	return {
		tag: SocketEvent_Tags.Drive,
		inner: [
			{
				inner: {
					tag: DriveEvent_Tags.FolderDeletedPermanent,
					inner: [{ uuid: folderUuid }]
				}
			}
		]
	} as unknown as DriveSocketEvent
}

function makeFileDeletedPermanentEvent(fileUuid: string): DriveSocketEvent {
	return {
		tag: SocketEvent_Tags.Drive,
		inner: [
			{
				inner: {
					tag: DriveEvent_Tags.FileDeletedPermanent,
					inner: [{ uuid: fileUuid }]
				}
			}
		]
	} as unknown as DriveSocketEvent
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleDriveEvent — drive socket handler", () => {
	beforeEach(() => {
		mockDriveItemsQueryUpdateGlobal.mockClear()
		mockDriveItemsQueryUpdate.mockClear()
		mockDriveItemsQueryUpdateForNormalParent.mockClear()
		mockCacheForgetItem.mockClear()
		mockCacheDirectoryUuidToAnyNormalDirGet.mockReset()
		mockCacheFileUuidToNormalFileGet.mockReset()
		mockUnwrapParentUuid.mockReturnValue("parent-1")
	})

	describe("DriveEvent_Tags.FolderDeletedPermanent", () => {
		it("calls driveItemsQueryUpdateGlobal with the folder's parent uuid when folder is in directory cache", async () => {
			// The folder is found in directoryUuidToAnyNormalDir with tag === AnyNormalDir_Tags.Dir
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [{ uuid: "folder-1", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(
				expect.objectContaining({ parentUuid: "parent-1" })
			)
		})

		it("the updater removes only the folder's uuid from the parent listing", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [{ uuid: "folder-1", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]![0] as {
				updater: (prev: Array<{ data: { uuid: string } }>) => Array<{ data: { uuid: string } }>
			}

			const prev = [{ data: { uuid: "folder-1" } }, { data: { uuid: "other" } }]
			const result = updater(prev)

			expect(result).toHaveLength(1)
			expect(result[0]!.data.uuid).toBe("other")
		})

		it("always calls cache.forgetItem with the folder uuid (permanent delete)", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [{ uuid: "folder-1", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockCacheForgetItem).toHaveBeenCalledWith("folder-1")
		})

		it("still calls cache.forgetItem even when the folder is NOT in the directory cache", async () => {
			// Folder not cached — no global update should fire, but forgetItem must still run
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockCacheForgetItem).toHaveBeenCalledWith("folder-1")
		})

		it("does NOT consult fileUuidToNormalFile for folder events (regression: old code missed folders)", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [{ uuid: "folder-1", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockCacheFileUuidToNormalFileGet).not.toHaveBeenCalled()
		})

		it("skips the global update when unwrapParentUuid returns null", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [{ uuid: "folder-1", parent: {} }]
			})
			mockUnwrapParentUuid.mockReturnValue(null)

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			// forgetItem must still be called even without a parent uuid
			expect(mockCacheForgetItem).toHaveBeenCalledWith("folder-1")
		})

		it("skips the global update when cached entry has tag !== Dir", async () => {
			// Root-tagged entries should be ignored by the guard
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Root,
				inner: [{ uuid: "folder-1", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockCacheForgetItem).toHaveBeenCalledWith("folder-1")
		})
	})

	describe("DriveEvent_Tags.FileDeletedPermanent (existing behaviour preserved)", () => {
		it("consults fileUuidToNormalFile and calls forgetItem for file events", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue({
				uuid: "file-1",
				parent: {}
			})

			await handleDriveEvent({ event: makeFileDeletedPermanentEvent("file-1") })

			expect(mockCacheFileUuidToNormalFileGet).toHaveBeenCalledWith("file-1")
			expect(mockCacheForgetItem).toHaveBeenCalledWith("file-1")
		})

		it("does NOT call directoryUuidToAnyNormalDir for file events", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue({
				uuid: "file-1",
				parent: {}
			})

			await handleDriveEvent({ event: makeFileDeletedPermanentEvent("file-1") })

			expect(mockCacheDirectoryUuidToAnyNormalDirGet).not.toHaveBeenCalled()
		})
	})
})

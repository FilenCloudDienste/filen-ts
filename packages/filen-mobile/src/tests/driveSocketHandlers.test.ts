import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { mockMarkDirectorySizesStale, mockEnqueue, mockFlushNow, mockRemoveDirectoryFromPhotos, callOrder } = vi.hoisted(() => {
	const callOrder: string[] = []

	return {
		mockMarkDirectorySizesStale: vi.fn(),
		mockEnqueue: vi.fn(),
		mockFlushNow: vi.fn(() => {
			callOrder.push("flush")
		}),
		mockRemoveDirectoryFromPhotos: vi.fn(),
		callOrder
	}
})

vi.mock("@/features/drive/socketCreateBatcher", () => ({
	default: {
		enqueue: mockEnqueue,
		flushNow: mockFlushNow
	}
}))

vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({
	markDirectorySizesStale: mockMarkDirectorySizesStale
}))

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
	mockCacheNewFile,
	mockCacheNewNormalDir,
	mockUnwrapParentUuid,
	mockUnwrapFileMeta,
	mockUnwrappedFileIntoDriveItem,
	mockUnwrapDirMeta,
	mockUnwrappedDirIntoDriveItem,
	mockRemoveFromSelection
} = vi.hoisted(() => ({
	mockDriveItemsQueryUpdateGlobal: vi.fn(),
	mockDriveItemsQueryUpdate: vi.fn(),
	mockDriveItemsQueryUpdateForNormalParent: vi.fn(),
	mockCacheForgetItem: vi.fn(),
	mockCacheDirectoryUuidToAnyNormalDirGet: vi.fn(),
	mockCacheFileUuidToNormalFileGet: vi.fn(),
	mockCacheNewFile: vi.fn(),
	mockCacheNewNormalDir: vi.fn(),
	mockUnwrapParentUuid: vi.fn().mockReturnValue("parent-1"),
	mockUnwrapFileMeta: vi.fn((x: unknown) => x),
	mockUnwrappedFileIntoDriveItem: vi.fn((x: unknown) => x),
	mockUnwrapDirMeta: vi.fn((x: unknown) => x),
	mockUnwrappedDirIntoDriveItem: vi.fn((x: unknown) => x),
	mockRemoveFromSelection: vi.fn()
}))

// ---------------------------------------------------------------------------
// Module mocks — must be before any imports that load the mocked modules
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdateGlobal: mockDriveItemsQueryUpdateGlobal,
	driveItemsQueryUpdate: mockDriveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent: mockDriveItemsQueryUpdateForNormalParent,
	driveItemsQueryUpdateForPhotos: vi.fn(),
	driveItemsQueryRemoveDirectoryFromPhotos: mockRemoveDirectoryFromPhotos
}))

// Faithful mirror of driveMetadata's pure favoritesListingUpdater (the real module pulls
// auth/query chains unloadable here; the real function is unit-tested in driveMetadata.test.ts).
vi.mock("@/features/drive/driveMetadata", () => ({
	favoritesListingUpdater: (prev: Array<{ data: { uuid: string } }>, item: { data: { uuid: string } }, favorited: boolean) => {
		const withoutItem = prev.filter(i => i.data.uuid !== item.data.uuid)

		return favorited ? [...withoutItem, item] : withoutItem
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnyNormalDir: { get: mockCacheDirectoryUuidToAnyNormalDirGet },
		fileUuidToNormalFile: { get: mockCacheFileUuidToNormalFileGet },
		forgetItem: mockCacheForgetItem,
		cacheNewFile: mockCacheNewFile,
		cacheNewNormalDir: mockCacheNewNormalDir
	}
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: mockUnwrapParentUuid,
	unwrapDirMeta: mockUnwrapDirMeta,
	unwrappedDirIntoDriveItem: mockUnwrappedDirIntoDriveItem,
	unwrapFileMeta: mockUnwrapFileMeta,
	unwrappedFileIntoDriveItem: mockUnwrappedFileIntoDriveItem
}))

vi.mock("@/features/drive/store/useDrive.store", () => ({
	default: {
		getState: () => ({ removeFromSelection: mockRemoveFromSelection })
	}
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
		TrashEmpty: "TrashEmpty",
		DeleteAll: "DeleteAll",
		DeleteVersioned: "DeleteVersioned"
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
import { DriveEvent_Tags, AnyNormalDir_Tags, NonRootItem_Tags, SocketEvent_Tags } from "@filen/sdk-rs"
import logger from "@/lib/logger"

// ---------------------------------------------------------------------------
// Helpers — build minimal socket-event shapes matching the handler's destructure:
//   const [eventInner] = event.inner
//   eventInner.inner.tag  → DriveEvent_Tags.*
//   const [inner] = eventInner.inner.inner
//   inner.uuid            → item uuid string
// ---------------------------------------------------------------------------

function makeEvent(tag: string, inner: unknown): DriveSocketEvent {
	return {
		tag: SocketEvent_Tags.Drive,
		inner: [{ inner: { tag, inner: [inner] } }]
	} as unknown as DriveSocketEvent
}

function makeFolderDeletedPermanentEvent(folderUuid: string): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FolderDeletedPermanent, { uuid: folderUuid })
}

function makeFileDeletedPermanentEvent(fileUuid: string): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FileDeletedPermanent, { uuid: fileUuid })
}

// fileNew / fileRestore / fileArchiveRestored — inner.file is the raw file object
function makeFileWithParentEvent(tag: string, fileObj: Record<string, unknown>): DriveSocketEvent {
	return makeEvent(tag, { file: fileObj })
}

// fileMetadataChanged — inner.uuid + inner.metadata
function makeFileMetadataChangedEvent(uuid: string, metadata: unknown): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FileMetadataChanged, { uuid, metadata })
}

// fileMove — inner.file is the updated file object (with new parent)
function makeFileMoveEvent(fileObj: Record<string, unknown>): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FileMove, { file: fileObj })
}

// folderMove — inner.dir is the updated dir object (with new parent)
function makeFolderMoveEvent(dirObj: Record<string, unknown>): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FolderMove, { dir: dirObj })
}

// folderMetadataChanged — inner.uuid + inner.meta
function makeFolderMetadataChangedEvent(uuid: string, meta: unknown): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FolderMetadataChanged, { uuid, meta })
}

// fileTrash / folderTrash — inner.uuid. `newUuid` (SDK 0.4.37+) marks the payload as an edit that
// superseded `uuid` on a versioning-disabled account rather than a user trash action.
function makeFileTrashEvent(uuid: string, newUuid?: string): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FileTrash, { uuid, newUuid })
}

// folderTrash — inner.parent (old parent uuid) + inner.uuid; the SDK payload carries the full pair.
function makeFolderTrashEvent(uuid: string, parent: string = "parent-1"): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FolderTrash, { parent, uuid })
}

// folderColorChanged — inner.uuid + inner.color
function makeFolderColorChangedEvent(uuid: string, color: string): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FolderColorChanged, { uuid, color })
}

// folderRestore / folderSubCreated — inner.dir is the raw dir object
function makeDirWithParentEvent(tag: string, dirObj: Record<string, unknown>): DriveSocketEvent {
	return makeEvent(tag, { dir: dirObj })
}

// itemFavorite — inner.item is a NonRootItem tagged union
function makeItemFavoriteFileEvent(fileObj: Record<string, unknown>): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.ItemFavorite, {
		item: {
			tag: NonRootItem_Tags.File,
			inner: [fileObj]
		}
	})
}

function makeItemFavoriteDirEvent(dirObj: Record<string, unknown>): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.ItemFavorite, {
		item: {
			tag: NonRootItem_Tags.NormalDir,
			inner: [dirObj]
		}
	})
}

// trashEmpty — no inner needed; use an empty inner object
function makeTrashEmptyEvent(): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.TrashEmpty, {})
}

// unknown/default event — triggers the throw
function makeUnknownTagEvent(): DriveSocketEvent {
	return {
		tag: SocketEvent_Tags.Drive,
		inner: [{ inner: { tag: "UnknownEventTag_xyz", inner: [{}] } }]
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
		mockCacheNewFile.mockClear()
		mockCacheNewNormalDir.mockClear()
		mockRemoveFromSelection.mockClear()
		mockEnqueue.mockClear()
		mockFlushNow.mockClear()
		mockRemoveDirectoryFromPhotos.mockClear()
		callOrder.length = 0
		mockCacheDirectoryUuidToAnyNormalDirGet.mockReset()
		mockCacheFileUuidToNormalFileGet.mockReset()
		mockUnwrapParentUuid.mockReturnValue("parent-1")
		// Default sdkUnwrap passthrough behaviour
		mockUnwrapFileMeta.mockImplementation((x: unknown) => x)
		mockUnwrappedFileIntoDriveItem.mockImplementation((x: unknown) => x)
		mockUnwrapDirMeta.mockImplementation((x: unknown) => x)
		mockUnwrappedDirIntoDriveItem.mockImplementation((x: unknown) => x)
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
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "parent-1" }))
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

		it("purges the removed folder uuid from the drive selection", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [{ uuid: "folder-1", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["folder-1"])
		})

		it("purges the selection even when the folder is NOT in the directory cache", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("folder-1") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["folder-1"])
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

		it("calls forgetItem even when file is NOT in the file cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFileDeletedPermanentEvent("file-not-cached") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockCacheForgetItem).toHaveBeenCalledWith("file-not-cached")
		})

		it("purges the removed file uuid from the drive selection", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue({ uuid: "file-1", parent: {} })

			await handleDriveEvent({ event: makeFileDeletedPermanentEvent("file-1") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["file-1"])
		})

		it("purges the selection even when the file is NOT in the file cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFileDeletedPermanentEvent("file-not-cached") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["file-not-cached"])
		})
	})

	describe("DriveEvent_Tags.FileNew / FileRestore / FileArchiveRestored", () => {
		const rawFile = { uuid: "file-new", parent: {}, meta: { name: "test.txt" } }
		const driveItemFile = { type: "file", data: { uuid: "file-new", decryptedMeta: { name: "test.txt" } } }

		it("FileNew: queues the item for its parent's batch, as a recent, and writes no listing now", async () => {
			mockUnwrapFileMeta.mockReturnValue({
				file: { uuid: "file-new", meta: { name: "test.txt" } },
				meta: { name: "test.txt" }
			})
			mockUnwrappedFileIntoDriveItem.mockReturnValue(driveItemFile)

			await handleDriveEvent({ event: makeFileWithParentEvent(DriveEvent_Tags.FileNew, rawFile) })

			expect(mockEnqueue).toHaveBeenCalledExactlyOnceWith({ parentUuid: "parent-1", item: driveItemFile, recent: true })
			expect(mockFlushNow).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("FileNew: with no parent, only caches the file", async () => {
			mockUnwrapParentUuid.mockReturnValue(null)
			mockUnwrapFileMeta.mockReturnValue({ file: { uuid: "file-new" }, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-new" } })

			await handleDriveEvent({ event: makeFileWithParentEvent(DriveEvent_Tags.FileNew, rawFile) })

			expect(mockEnqueue).not.toHaveBeenCalled()
			expect(mockCacheNewFile).toHaveBeenCalledOnce()
		})

		it("FileRestore: adds item to parent listing AND removes from trash query", async () => {
			mockUnwrapFileMeta.mockReturnValue({
				file: { uuid: "file-restore", meta: { name: "file.txt" } },
				meta: { name: "file.txt" }
			})
			mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-restore" } })

			await handleDriveEvent({
				event: makeFileWithParentEvent(DriveEvent_Tags.FileRestore, {
					uuid: "file-restore",
					parent: {},
					meta: {}
				})
			})

			// Should update parent listing
			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()

			// Should also remove from trash
			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()
			const trashCall = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
				params: { path: { type: string } }
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}
			expect(trashCall.params.path.type).toBe("trash")

			// Verify the trash updater filters out the restored item
			const prev = [{ data: { uuid: "file-restore" } }, { data: { uuid: "other" } }]
			const result = trashCall.updater(prev) as typeof prev
			expect(result).toHaveLength(1)
			expect(result[0]?.data.uuid).toBe("other")
		})

		it("FileArchiveRestored: adds item to parent but does NOT touch trash query", async () => {
			mockUnwrapFileMeta.mockReturnValue({
				file: { uuid: "file-archived", meta: null },
				meta: null
			})
			mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-archived" } })

			await handleDriveEvent({
				event: makeFileWithParentEvent(DriveEvent_Tags.FileArchiveRestored, {
					uuid: "file-archived",
					parent: {},
					meta: {}
				})
			})

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})
	})

	describe("DriveEvent_Tags.FileArchived", () => {
		it("calls driveItemsQueryUpdateGlobal to remove from parent when file is in cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue({ uuid: "file-archived", parent: {} })

			await handleDriveEvent({ event: makeEvent(DriveEvent_Tags.FileArchived, { uuid: "file-archived" }) })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "parent-1" }))
		})

		it("does NOT call forgetItem (FileArchived is not a permanent delete)", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue({ uuid: "file-archived", parent: {} })

			await handleDriveEvent({ event: makeEvent(DriveEvent_Tags.FileArchived, { uuid: "file-archived" }) })

			expect(mockCacheForgetItem).not.toHaveBeenCalled()
		})

		it("purges the archived file uuid from the drive selection", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue({ uuid: "file-archived", parent: {} })

			await handleDriveEvent({ event: makeEvent(DriveEvent_Tags.FileArchived, { uuid: "file-archived" }) })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["file-archived"])
		})

		it("no-op when file is not in cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeEvent(DriveEvent_Tags.FileArchived, { uuid: "file-not-cached" }) })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockCacheForgetItem).not.toHaveBeenCalled()
		})
	})

	describe("DriveEvent_Tags.FileMetadataChanged", () => {
		it("splices the updated item into the parent listing using a map updater", async () => {
			const rawFile = { uuid: "file-meta", parent: {}, meta: { name: "original.txt" } }
			const updatedDriveItem = { type: "file", data: { uuid: "file-meta", decryptedMeta: { name: "renamed.txt" } } }

			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFile)
			mockUnwrapFileMeta.mockReturnValue({
				file: { uuid: "file-meta", meta: { name: "renamed.txt" } },
				meta: { name: "renamed.txt" }
			})
			mockUnwrappedFileIntoDriveItem.mockReturnValue(updatedDriveItem)

			await handleDriveEvent({ event: makeFileMetadataChangedEvent("file-meta", { name: "renamed.txt" }) })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}

			const oldItem = { data: { uuid: "file-meta" }, type: "file" }
			const otherItem = { data: { uuid: "other" }, type: "file" }
			const result = updater([oldItem, otherItem]) as unknown[]

			// The matching item should be replaced with updatedDriveItem
			expect(result[0]).toBe(updatedDriveItem)
			// Non-matching item preserved
			expect(result[1]).toBe(otherItem)
		})

		it("no-op when file is not in cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFileMetadataChangedEvent("file-not-cached", {}) })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
		})
	})

	describe("DriveEvent_Tags.FileMove", () => {
		const rawFileOld = { uuid: "file-move", parent: {} }
		const rawFileNew = { uuid: "file-move", parent: {} }
		const movedDriveItem = { type: "file", data: { uuid: "file-move", decryptedMeta: { name: "moved.txt" } } }

		it("removes from old parent and inserts in new parent", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFileOld)
			mockUnwrapParentUuid.mockReturnValueOnce("old-parent").mockReturnValueOnce("new-parent")
			mockUnwrapFileMeta.mockReturnValue({
				file: { uuid: "file-move", meta: { name: "moved.txt" } },
				meta: { name: "moved.txt" }
			})
			mockUnwrappedFileIntoDriveItem.mockReturnValue(movedDriveItem)

			await handleDriveEvent({ event: makeFileMoveEvent(rawFileNew) })

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledTimes(2)

			const firstCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]?.[0] as { parentUuid: string }
			const secondCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[1]?.[0] as { parentUuid: string }
			expect(firstCall.parentUuid).toBe("old-parent")
			expect(secondCall.parentUuid).toBe("new-parent")
		})

		it("updater for old parent removes only the moved file", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFileOld)
			mockUnwrapParentUuid.mockReturnValueOnce("old-parent").mockReturnValueOnce("new-parent")
			mockUnwrapFileMeta.mockReturnValue({
				file: { uuid: "file-move", meta: { name: "moved.txt" } },
				meta: { name: "moved.txt" }
			})
			mockUnwrappedFileIntoDriveItem.mockReturnValue(movedDriveItem)

			await handleDriveEvent({ event: makeFileMoveEvent(rawFileNew) })

			const { updater } = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}

			const prev = [{ data: { uuid: "file-move" } }, { data: { uuid: "other" } }]
			const result = updater(prev) as typeof prev
			expect(result).toHaveLength(1)
			expect(result[0]?.data.uuid).toBe("other")
		})

		it("still inserts at the destination when the file is not cached (payload-first)", async () => {
			// Payload-first: the destination insert fires from the payload even on a cold cache; only the
			// old-parent removal is skipped, so exactly one ForNormalParent call (the new parent) happens.
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)
			mockUnwrapParentUuid.mockReturnValue("new-parent")
			mockUnwrapFileMeta.mockReturnValue({ file: { uuid: "file-not-cached", meta: null }, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-not-cached" } })

			await handleDriveEvent({ event: makeFileMoveEvent({ uuid: "file-not-cached", parent: {} }) })

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "new-parent" }))
			// Write-through to the caches is unconditional on the payload.
			expect(mockCacheNewFile).toHaveBeenCalledOnce()
		})

		it("downgrades the cold-cache miss to logger.debug (not warn)", async () => {
			vi.mocked(logger.debug).mockClear()
			vi.mocked(logger.warn).mockClear()

			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)
			mockUnwrapParentUuid.mockReturnValue("new-parent")
			mockUnwrapFileMeta.mockReturnValue({ file: { uuid: "file-not-cached", meta: null }, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-not-cached" } })

			await handleDriveEvent({ event: makeFileMoveEvent({ uuid: "file-not-cached", parent: {} }) })

			expect(logger.warn).not.toHaveBeenCalled()
			expect(logger.debug).toHaveBeenCalledOnce()
		})
	})

	describe("DriveEvent_Tags.FolderMove", () => {
		const rawDirOld = { uuid: "dir-move", parent: {} }
		const rawDirNew = { uuid: "dir-move", parent: {} }
		const movedDriveItem = { type: "directory", data: { uuid: "dir-move", decryptedMeta: { name: "moved-dir" } } }

		it("removes from old parent and inserts in new parent", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [rawDirOld]
			})
			mockUnwrapParentUuid.mockReturnValueOnce("old-parent").mockReturnValueOnce("new-parent")
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-move", meta: { name: "moved-dir" } })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(movedDriveItem)

			await handleDriveEvent({ event: makeFolderMoveEvent(rawDirNew) })

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledTimes(2)
			const firstCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]?.[0] as { parentUuid: string }
			const secondCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[1]?.[0] as { parentUuid: string }
			expect(firstCall.parentUuid).toBe("old-parent")
			expect(secondCall.parentUuid).toBe("new-parent")
		})

		it("still inserts at the destination when the folder is not cached (payload-first)", async () => {
			// Payload-first: the destination insert fires from the payload even on a cold cache; only the
			// old-parent removal is skipped, so exactly one ForNormalParent call (the new parent) happens.
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)
			mockUnwrapParentUuid.mockReturnValue("new-parent")
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-not-cached", meta: { name: "d" } })
			mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "dir-not-cached" } })

			await handleDriveEvent({ event: makeFolderMoveEvent({ uuid: "dir-not-cached", parent: {} }) })

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "new-parent" }))
			expect(mockCacheNewNormalDir).toHaveBeenCalledOnce()
		})

		it("still inserts at the destination but skips the removal when the cached entry has tag !== Dir", async () => {
			// A Root-tagged cache entry can't locate the previous listing, so the old-parent removal is
			// skipped — but the payload still drives the destination insert.
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Root,
				inner: [rawDirOld]
			})
			mockUnwrapParentUuid.mockReturnValue("new-parent")
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-move", meta: { name: "d" } })
			mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "dir-move" } })

			await handleDriveEvent({ event: makeFolderMoveEvent(rawDirNew) })

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "new-parent" }))
		})
	})

	describe("DriveEvent_Tags.FolderMetadataChanged", () => {
		it("splices the updated item into the parent listing using a map updater", async () => {
			const rawDir = { uuid: "dir-meta", parent: {}, meta: { name: "original-dir" } }
			const updatedDriveItem = { type: "directory", data: { uuid: "dir-meta", decryptedMeta: { name: "renamed-dir" } } }

			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [rawDir]
			})
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-meta", meta: { name: "renamed-dir" } })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(updatedDriveItem)

			await handleDriveEvent({ event: makeFolderMetadataChangedEvent("dir-meta", { name: "renamed-dir" }) })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}

			const oldItem = { data: { uuid: "dir-meta" }, type: "directory" }
			const otherItem = { data: { uuid: "other" }, type: "directory" }
			const result = updater([oldItem, otherItem]) as unknown[]

			expect(result[0]).toBe(updatedDriveItem)
			expect(result[1]).toBe(otherItem)
		})

		it("no-op when folder is not in directory cache", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderMetadataChangedEvent("dir-not-cached", {}) })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
		})
	})

	describe("DriveEvent_Tags.FileTrash", () => {
		it("removes from parent (global update) and adds to trash only — NOT to recents (bug #35)", async () => {
			const rawFile = { uuid: "file-trash", parent: {} }
			const trashedDriveItem = { type: "file", data: { uuid: "file-trash" } }

			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFile)
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue(trashedDriveItem)

			await handleDriveEvent({ event: makeFileTrashEvent("file-trash") })

			// Remove from parent
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "parent-1" }))

			// Only one driveItemsQueryUpdate call: for trash. NOT for recents.
			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()

			const trashCall = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
				params: { path: { type: string; uuid: unknown } }
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}
			expect(trashCall.params.path.type).toBe("trash")

			// Trash updater deduplicates then appends the trashed item
			const prev = [{ data: { uuid: "file-trash" } }, { data: { uuid: "other" } }]
			const trashResult = trashCall.updater(prev) as typeof prev
			expect(trashResult[trashResult.length - 1]).toBe(trashedDriveItem)
		})

		it("does NOT add the trashed file to recents (bug #35 regression guard)", async () => {
			const rawFile = { uuid: "file-trash", parent: {} }
			const trashedDriveItem = { type: "file", data: { uuid: "file-trash" } }

			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFile)
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue(trashedDriveItem)

			await handleDriveEvent({ event: makeFileTrashEvent("file-trash") })

			const recentsCall = mockDriveItemsQueryUpdate.mock.calls.find(
				c => (c[0] as { params: { path: { type: string } } }).params.path.type === "recents"
			)
			expect(recentsCall).toBeUndefined()
		})

		it("no-op when file is not in cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFileTrashEvent("file-not-cached") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("purges the trashed file uuid from the drive selection", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue({ uuid: "file-trash", parent: {} })

			await handleDriveEvent({ event: makeFileTrashEvent("file-trash") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["file-trash"])
		})

		it("purges the selection even when the trashed file is NOT in the cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFileTrashEvent("file-not-cached") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["file-not-cached"])
		})

		it("does NOT add to trash when the payload carries newUuid — that is an edit, not a trash", async () => {
			// A versioning-disabled account retires the superseded version through this same event, so
			// every save (the text/pdf editors re-upload) would otherwise drop the old copy into Trash
			// and make the user's own edit look like a deletion.
			const rawFile = { uuid: "file-edited", parent: {} }

			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFile)
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-edited" } })

			await handleDriveEvent({ event: makeFileTrashEvent("file-edited", "file-edited-v2") })

			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("still drops the superseded uuid from its parent listing when newUuid is set", async () => {
			// The old uuid genuinely stopped being the live file, so its row must go — only the trash
			// half is wrong for an edit.
			const rawFile = { uuid: "file-edited", parent: {} }

			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFile)
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })

			await handleDriveEvent({ event: makeFileTrashEvent("file-edited", "file-edited-v2") })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "parent-1" }))
			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["file-edited"])
		})
	})

	describe("DriveEvent_Tags.FolderTrash", () => {
		it("removes from parent (global update) and adds to trash only — NOT to recents (bug #35)", async () => {
			const rawDir = { uuid: "dir-trash", parent: {} }
			const trashedDriveItem = { type: "directory", data: { uuid: "dir-trash" } }

			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [rawDir]
			})
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-trash", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(trashedDriveItem)

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-trash") })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()

			// Only one driveItemsQueryUpdate call: for trash. NOT for recents.
			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()

			const trashCall = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
				params: { path: { type: string; uuid: unknown } }
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}
			expect(trashCall.params.path.type).toBe("trash")

			// Trash updater deduplicates then appends the trashed item.
			const prev = [{ data: { uuid: "dir-trash" } }, { data: { uuid: "other" } }]
			const trashResult = trashCall.updater(prev) as typeof prev
			expect(trashResult).toHaveLength(2)
			expect(trashResult[trashResult.length - 1]).toBe(trashedDriveItem)
		})

		it("does NOT add the trashed folder to recents (bug #35 regression guard)", async () => {
			const rawDir = { uuid: "dir-trash", parent: {} }
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [rawDir]
			})
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-trash", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "dir-trash" } })

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-trash") })

			const recentsCall = mockDriveItemsQueryUpdate.mock.calls.find(
				c => (c[0] as { params: { path: { type: string } } }).params.path.type === "recents"
			)
			expect(recentsCall).toBeUndefined()
		})

		it("removes from the old parent via the payload even with an empty cache; skips the trash-row add", async () => {
			// Payload-first: `inner.parent` drives the old-listing removal without the cache. The trash
			// row needs the full Dir, so on a cold cache that half is skipped (the row reappears on refetch).
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-not-cached", "old-parent") })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "old-parent" }))

			// No cached Dir → no optimistic trash-row insert this session.
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("removes from the old parent via the payload but skips the trash-row when the cache entry has tag !== Dir", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Root,
				inner: [{ uuid: "dir-trash", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-root", "old-parent") })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("purges the trashed folder uuid from the drive selection", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [{ uuid: "dir-trash", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-trash") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["dir-trash"])
		})

		it("purges the selection even when the trashed folder is NOT in the cache", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-not-cached") })

			expect(mockRemoveFromSelection).toHaveBeenCalledWith(["dir-not-cached"])
		})
	})

	describe("DriveEvent_Tags.FolderColorChanged", () => {
		it("patches only the color field on the matching directory item", async () => {
			const rawDir = { uuid: "dir-color", parent: {} }

			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [rawDir]
			})

			await handleDriveEvent({ event: makeFolderColorChangedEvent("dir-color", "blue") })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ type: string; data: { uuid: string; color?: string }; other?: string }>) => unknown[]
			}

			const dirItem = { type: "directory", data: { uuid: "dir-color", color: "red", name: "myDir" }, other: "kept" }
			const otherItem = { type: "directory", data: { uuid: "other-dir", color: "green" } }
			const result = updater([dirItem, otherItem]) as Array<typeof dirItem>

			// Matching item gets color patched (spread-with-override), other preserved
			expect(result[0]?.data.color).toBe("blue")
			expect(result[0]?.data.uuid).toBe("dir-color")
			expect(result[1]).toBe(otherItem)
		})

		it("does not patch non-directory items even if uuid matches", async () => {
			const rawDir = { uuid: "shared-uuid", parent: {} }
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [rawDir]
			})

			await handleDriveEvent({ event: makeFolderColorChangedEvent("shared-uuid", "purple") })

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ type: string; data: { uuid: string; color?: string } }>) => unknown[]
			}

			// A "file" item with the same uuid should NOT be color-patched
			const fileItem = { type: "file", data: { uuid: "shared-uuid", color: "red" } }
			const result = updater([fileItem]) as Array<typeof fileItem>

			expect(result[0]).toBe(fileItem)
		})

		it("no-op when folder is not in directory cache", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderColorChangedEvent("dir-not-cached", "blue") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
		})
	})

	describe("DriveEvent_Tags.FolderRestore / FolderSubCreated", () => {
		const rawDir = { uuid: "dir-restore", parent: {}, meta: { name: "restored-dir" } }
		const dirDriveItem = { type: "directory", data: { uuid: "dir-restore", decryptedMeta: { name: "restored-dir" } } }

		it("FolderRestore: adds item to parent listing AND removes from trash query", async () => {
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-restore", meta: { name: "restored-dir" } })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(dirDriveItem)

			await handleDriveEvent({ event: makeDirWithParentEvent(DriveEvent_Tags.FolderRestore, rawDir) })

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()

			// Should also remove from trash
			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()
			const trashCall = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
				params: { path: { type: string } }
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}
			expect(trashCall.params.path.type).toBe("trash")

			// Updater removes the restored dir from trash
			const prev = [{ data: { uuid: "dir-restore" } }, { data: { uuid: "other" } }]
			const result = trashCall.updater(prev) as typeof prev
			expect(result).toHaveLength(1)
			expect(result[0]?.data.uuid).toBe("other")
		})

		it("FolderSubCreated: queues the directory for its parent's batch, not as a recent", async () => {
			const created = { type: "directory", data: { uuid: "dir-new" } }

			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-new", meta: { name: "new-dir" } })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(created)

			await handleDriveEvent({
				event: makeDirWithParentEvent(DriveEvent_Tags.FolderSubCreated, {
					uuid: "dir-new",
					parent: {},
					meta: {}
				})
			})

			expect(mockEnqueue).toHaveBeenCalledExactlyOnceWith({ parentUuid: "parent-1", item: created, recent: false })
			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("does NOT update parent when parentUuid is null, but still removes from trash", async () => {
			mockUnwrapParentUuid.mockReturnValue(null)
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-restore", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "dir-restore" } })

			await handleDriveEvent({ event: makeDirWithParentEvent(DriveEvent_Tags.FolderRestore, rawDir) })

			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()

			// The trash-removal update sits OUTSIDE the parentUuid guard, so it must still fire.
			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()
			const trashCall = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
				params: { path: { type: string } }
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}
			expect(trashCall.params.path.type).toBe("trash")
			const prev = [{ data: { uuid: "dir-restore" } }, { data: { uuid: "other" } }]
			const result = trashCall.updater(prev) as typeof prev
			expect(result).toHaveLength(1)
			expect(result[0]?.data.uuid).toBe("other")
		})
	})

	describe("DriveEvent_Tags.ItemFavorite", () => {
		it("File sub-tag: updates the file item in its parent listing", async () => {
			const rawFile = { uuid: "fav-file", parent: {} }
			const updatedDriveItem = { type: "file", data: { uuid: "fav-file", favorite: true } }

			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFile)
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue(updatedDriveItem)

			await handleDriveEvent({ event: makeItemFavoriteFileEvent(rawFile) })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}

			// The listing row is the SAME type as the payload rebuild, so the same-type guard replaces it.
			const oldItem = { type: "file", data: { uuid: "fav-file" } }
			const otherItem = { type: "file", data: { uuid: "other" } }
			const result = updater([oldItem, otherItem]) as unknown[]

			// Matching item replaced by updatedDriveItem
			expect(result[0]).toBe(updatedDriveItem)
			expect(result[1]).toBe(otherItem)
		})

		it("File sub-tag: patches via the payload parent even when the file is not cached", async () => {
			// Payload-first: the favorite patch routes via the payload item's own parent; the cache is
			// never consulted for this branch, so a cold cache still updates any listing holding the item.
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)
			mockUnwrapParentUuid.mockReturnValue("payload-parent")
			mockUnwrapFileMeta.mockReturnValue({ file: { uuid: "fav-file-not-cached" }, meta: null })

			await handleDriveEvent({
				event: makeItemFavoriteFileEvent({ uuid: "fav-file-not-cached", parent: {} })
			})

			expect(mockCacheFileUuidToNormalFileGet).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "payload-parent" }))
		})

		it("NormalDir sub-tag: updates the directory item in its parent listing", async () => {
			const rawDir = { uuid: "fav-dir", parent: {} }
			const updatedDriveItem = { type: "directory", data: { uuid: "fav-dir", favorite: true } }

			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Dir,
				inner: [rawDir]
			})
			mockUnwrapDirMeta.mockReturnValue({ uuid: "fav-dir", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(updatedDriveItem)

			await handleDriveEvent({ event: makeItemFavoriteDirEvent(rawDir) })

			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ data: { uuid: string } }>) => unknown[]
			}

			// The listing row is the SAME type as the payload rebuild, so the same-type guard replaces it.
			const oldItem = { type: "directory", data: { uuid: "fav-dir" } }
			const otherItem = { type: "directory", data: { uuid: "other" } }
			const result = updater([oldItem, otherItem]) as unknown[]

			expect(result[0]).toBe(updatedDriveItem)
			expect(result[1]).toBe(otherItem)
		})

		it("NormalDir sub-tag: patches via the payload parent even when the dir is not cached", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)
			mockUnwrapParentUuid.mockReturnValue("payload-parent")
			mockUnwrapDirMeta.mockReturnValue({ uuid: "fav-dir-not-cached", meta: null })

			await handleDriveEvent({
				event: makeItemFavoriteDirEvent({ uuid: "fav-dir-not-cached", parent: {} })
			})

			expect(mockCacheDirectoryUuidToAnyNormalDirGet).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "payload-parent" }))
		})

		it("NormalDir sub-tag: does not consult the cache (patches via payload parent regardless of any cached entry)", async () => {
			// A Root-tagged entry used to gate this branch out; the payload-first patch ignores the cache
			// entirely, so it still fires.
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Root,
				inner: [{ uuid: "fav-dir", parent: {} }]
			})
			mockUnwrapParentUuid.mockReturnValue("payload-parent")
			mockUnwrapDirMeta.mockReturnValue({ uuid: "fav-dir", meta: null })

			await handleDriveEvent({
				event: makeItemFavoriteDirEvent({ uuid: "fav-dir", parent: {} })
			})

			expect(mockCacheDirectoryUuidToAnyNormalDirGet).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
		})

		it("File sub-tag: same-type guard replaces a normal-file row but leaves a role-stamped shared row untouched", async () => {
			const rawFile = { uuid: "fav-U", parent: {} }
			const rebuiltFile = { type: "file", data: { uuid: "fav-U", favorite: true } }

			mockUnwrapParentUuid.mockReturnValue("payload-parent")
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue(rebuiltFile)

			await handleDriveEvent({ event: makeItemFavoriteFileEvent(rawFile) })

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ type: string; data: { uuid: string } }>) => unknown[]
			}

			// A role-stamped SHARED row for uuid U must NOT be swapped for the normal-typed rebuild;
			// a same-type (file) row for the same uuid IS replaced (the favorite flows through).
			const sharedRow = { type: "sharedFile", data: { uuid: "fav-U" }, sharingRole: { tag: "Receiver" } }
			const normalRow = { type: "file", data: { uuid: "fav-U" } }
			const result = updater([sharedRow, normalRow]) as unknown[]

			expect(result[0]).toBe(sharedRow)
			expect(result[1]).toBe(rebuiltFile)
		})

		it("NormalDir sub-tag: same-type guard replaces a normal-dir row but leaves a role-stamped shared row untouched", async () => {
			const rawDir = { uuid: "fav-U", parent: {} }
			const rebuiltDir = { type: "directory", data: { uuid: "fav-U", favorite: true } }

			mockUnwrapParentUuid.mockReturnValue("payload-parent")
			mockUnwrapDirMeta.mockReturnValue({ uuid: "fav-U", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(rebuiltDir)

			await handleDriveEvent({ event: makeItemFavoriteDirEvent(rawDir) })

			const { updater } = mockDriveItemsQueryUpdateGlobal.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ type: string; data: { uuid: string } }>) => unknown[]
			}

			const sharedRow = { type: "sharedDirectory", data: { uuid: "fav-U" }, sharingRole: { tag: "Receiver" } }
			const normalRow = { type: "directory", data: { uuid: "fav-U" } }
			const result = updater([sharedRow, normalRow]) as unknown[]

			expect(result[0]).toBe(sharedRow)
			expect(result[1]).toBe(rebuiltDir)
		})

		it("File sub-tag: ADDS a newly-favorited file to the Favorites virtual root and writes the caches through", async () => {
			const rawFile = { uuid: "fav-add", parent: {}, favorited: true }
			const rebuiltFile = { type: "file", data: { uuid: "fav-add", favorited: true } }

			mockUnwrapParentUuid.mockReturnValue("payload-parent")
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue(rebuiltFile)

			await handleDriveEvent({ event: makeItemFavoriteFileEvent(rawFile) })

			// The session caches got the toggled state (mirrors the local favorite() path).
			expect(mockCacheNewFile).toHaveBeenCalledWith(rawFile, rebuiltFile)

			// The Favorites root got an INSERT — the replace-only global patch can't add a row
			// the listing doesn't hold yet, which left cross-device favorites missing until refetch.
			const favoritesCall = mockDriveItemsQueryUpdate.mock.calls.find(
				call => (call[0] as { params: { path: { type: string } } }).params.path.type === "favorites"
			)?.[0] as { params: { path: { type: string; uuid: unknown } }; updater: (prev: unknown[]) => unknown[] }

			expect(favoritesCall).toBeDefined()
			expect(favoritesCall.params.path.uuid).toBeNull()
			expect(favoritesCall.updater([])).toEqual([rebuiltFile])
		})

		it("NormalDir sub-tag: REMOVES an unfavorited directory from the Favorites virtual root", async () => {
			const rawDir = { uuid: "fav-drop", parent: {}, favorited: false }
			const rebuiltDir = { type: "directory", data: { uuid: "fav-drop", favorited: false } }

			mockUnwrapParentUuid.mockReturnValue("payload-parent")
			mockUnwrapDirMeta.mockReturnValue({ uuid: "fav-drop", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue(rebuiltDir)

			await handleDriveEvent({ event: makeItemFavoriteDirEvent(rawDir) })

			expect(mockCacheNewNormalDir).toHaveBeenCalledWith(rawDir, rebuiltDir)

			const favoritesCall = mockDriveItemsQueryUpdate.mock.calls.find(
				call => (call[0] as { params: { path: { type: string } } }).params.path.type === "favorites"
			)?.[0] as { params: { path: { type: string; uuid: unknown } }; updater: (prev: unknown[]) => unknown[] }

			expect(favoritesCall).toBeDefined()

			// The stale ghost row leaves; other rows stay.
			const otherRow = { type: "file", data: { uuid: "other" } }

			expect(favoritesCall.updater([{ type: "directory", data: { uuid: "fav-drop" } }, otherRow])).toEqual([otherRow])
		})
	})

	describe("DriveEvent_Tags.TrashEmpty", () => {
		it("calls driveItemsQueryUpdate for trash path with an updater that returns []", async () => {
			await handleDriveEvent({ event: makeTrashEmptyEvent() })

			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledOnce()
			const call = mockDriveItemsQueryUpdate.mock.calls[0]?.[0] as {
				params: { path: { type: string; uuid: unknown } }
				updater: () => unknown[]
			}
			expect(call.params.path.type).toBe("trash")
			expect(call.params.path.uuid).toBeNull()

			// The updater always returns an empty array
			const result = call.updater()
			expect(result).toEqual([])
		})
	})

	describe("DriveEvent_Tags.DeleteAll / DeleteVersioned — ignored no-ops", () => {
		it("DeleteAll: resolves without throwing and touches no query updater", async () => {
			await expect(handleDriveEvent({ event: makeEvent(DriveEvent_Tags.DeleteAll, {}) })).resolves.toBeUndefined()

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
		})

		it("DeleteVersioned: resolves without throwing and touches no query updater", async () => {
			await expect(handleDriveEvent({ event: makeEvent(DriveEvent_Tags.DeleteVersioned, {}) })).resolves.toBeUndefined()

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
		})
	})

	describe("directory sizes", () => {
		beforeEach(() => {
			mockMarkDirectorySizesStale.mockClear()
		})

		it.each([DriveEvent_Tags.FileNew, DriveEvent_Tags.FolderSubCreated])("%s leaves the size mark to its batch", async tag => {
			await handleDriveEvent({ event: makeEvent(tag, { uuid: "x", file: { uuid: "x" }, dir: { uuid: "x" } }) })

			expect(mockMarkDirectorySizesStale).not.toHaveBeenCalled()
		})

		it.each([
			DriveEvent_Tags.FileRestore,
			DriveEvent_Tags.FileArchived,
			DriveEvent_Tags.FileDeletedPermanent,
			DriveEvent_Tags.FolderDeletedPermanent,
			DriveEvent_Tags.FileTrash,
			DriveEvent_Tags.FolderTrash,
			DriveEvent_Tags.TrashEmpty,
			DriveEvent_Tags.DeleteAll
		])("%s marks every directory size stale exactly once", async tag => {
			await handleDriveEvent({ event: makeEvent(tag, { uuid: "x", file: { uuid: "x" }, dir: { uuid: "x" } }) }).catch(() => undefined)

			expect(mockMarkDirectorySizesStale).toHaveBeenCalledTimes(1)
		})

		it.each([
			DriveEvent_Tags.FileMetadataChanged,
			DriveEvent_Tags.FolderMetadataChanged,
			DriveEvent_Tags.FolderColorChanged,
			DriveEvent_Tags.ItemFavorite
		])("%s leaves directory sizes alone", async tag => {
			await handleDriveEvent({ event: makeEvent(tag, { uuid: "x", item: { tag: "File", inner: [{ uuid: "x" }] } }) }).catch(
				() => undefined
			)

			expect(mockMarkDirectorySizesStale).not.toHaveBeenCalled()
		})
	})

	describe("create batching", () => {
		it.each([
			DriveEvent_Tags.FileRestore,
			DriveEvent_Tags.FileArchived,
			DriveEvent_Tags.FileDeletedPermanent,
			DriveEvent_Tags.FolderDeletedPermanent,
			DriveEvent_Tags.FileMetadataChanged,
			DriveEvent_Tags.FileMove,
			DriveEvent_Tags.FolderMove,
			DriveEvent_Tags.FolderMetadataChanged,
			DriveEvent_Tags.FileTrash,
			DriveEvent_Tags.FolderTrash,
			DriveEvent_Tags.FolderColorChanged,
			DriveEvent_Tags.FolderRestore,
			DriveEvent_Tags.TrashEmpty
		])("%s applies queued creates before its own change", async tag => {
			mockDriveItemsQueryUpdateGlobal.mockImplementation(() => callOrder.push("update"))
			mockDriveItemsQueryUpdate.mockImplementation(() => callOrder.push("update"))
			mockDriveItemsQueryUpdateForNormalParent.mockImplementation(() => callOrder.push("update"))
			mockCacheFileUuidToNormalFileGet.mockReturnValue({ uuid: "x", parent: {} })
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({ tag: AnyNormalDir_Tags.Dir, inner: [{ uuid: "x", parent: {} }] })

			await handleDriveEvent({
				event: makeEvent(tag, { uuid: "x", parent: "parent-1", file: { uuid: "x", parent: {} }, dir: { uuid: "x", parent: {} }, metadata: {}, meta: {}, color: "blue" })
			})

			expect(mockFlushNow).toHaveBeenCalledOnce()
			expect(callOrder[0]).toBe("flush")

			mockDriveItemsQueryUpdateGlobal.mockReset()
			mockDriveItemsQueryUpdate.mockReset()
			mockDriveItemsQueryUpdateForNormalParent.mockReset()
		})
	})

	describe("Photos: a directory leaving the camera-upload tree", () => {
		it("FolderTrash drops the directory's descendants from Photos", async () => {
			await handleDriveEvent({ event: makeFolderTrashEvent("trashed-dir") })

			expect(mockRemoveDirectoryFromPhotos).toHaveBeenCalledExactlyOnceWith({ dirUuid: "trashed-dir" })
		})

		it("FolderDeletedPermanent drops the directory's descendants from Photos", async () => {
			await handleDriveEvent({ event: makeFolderDeletedPermanentEvent("deleted-dir") })

			expect(mockRemoveDirectoryFromPhotos).toHaveBeenCalledExactlyOnceWith({ dirUuid: "deleted-dir" })
		})

		it("FolderMove asks Photos to drop them only if the destination is outside the tree", async () => {
			mockUnwrapDirMeta.mockReturnValue({ uuid: "moved-dir", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "moved-dir" } })

			await handleDriveEvent({ event: makeFolderMoveEvent({ uuid: "moved-dir", parent: {} }) })

			expect(mockRemoveDirectoryFromPhotos).toHaveBeenCalledExactlyOnceWith({ dirUuid: "moved-dir", newParentUuid: "parent-1" })
		})
	})

	describe("default — unhandled event tag", () => {
		it("throws 'Unhandled drive event' for an unknown tag", async () => {
			await expect(handleDriveEvent({ event: makeUnknownTagEvent() })).rejects.toThrow("Unhandled drive event")
		})
	})
})

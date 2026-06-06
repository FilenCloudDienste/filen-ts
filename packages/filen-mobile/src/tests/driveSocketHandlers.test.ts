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
	mockCacheNewFile,
	mockCacheNewNormalDir,
	mockUnwrapParentUuid,
	mockUnwrapFileMeta,
	mockUnwrappedFileIntoDriveItem,
	mockUnwrapDirMeta,
	mockUnwrappedDirIntoDriveItem
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
	mockUnwrappedDirIntoDriveItem: vi.fn((x: unknown) => x)
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
import { DriveEvent_Tags, AnyNormalDir_Tags, NonRootItem_Tags, SocketEvent_Tags } from "@filen/sdk-rs"

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

// fileTrash / folderTrash — inner.uuid
function makeFileTrashEvent(uuid: string): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FileTrash, { uuid })
}

function makeFolderTrashEvent(uuid: string): DriveSocketEvent {
	return makeEvent(DriveEvent_Tags.FolderTrash, { uuid })
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
	})

	describe("DriveEvent_Tags.FileNew / FileRestore / FileArchiveRestored", () => {
		const rawFile = { uuid: "file-new", parent: {}, meta: { name: "test.txt" } }
		const driveItemFile = { type: "file", data: { uuid: "file-new", decryptedMeta: { name: "test.txt" } } }

		it("FileNew: adds item to parent listing via driveItemsQueryUpdateForNormalParent", async () => {
			mockUnwrapFileMeta.mockReturnValue({
				file: { uuid: "file-new", meta: { name: "test.txt" } },
				meta: { name: "test.txt" }
			})
			mockUnwrappedFileIntoDriveItem.mockReturnValue(driveItemFile)

			await handleDriveEvent({ event: makeFileWithParentEvent(DriveEvent_Tags.FileNew, rawFile) })

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "parent-1" }))
		})

		it("FileNew: updater deduplicates by uuid and name, then appends new item", async () => {
			const fileMeta = { file: { uuid: "file-new", meta: { name: "test.txt" } }, meta: { name: "test.txt" } }
			mockUnwrapFileMeta.mockReturnValue(fileMeta)
			mockUnwrappedFileIntoDriveItem.mockReturnValue(driveItemFile)

			await handleDriveEvent({ event: makeFileWithParentEvent(DriveEvent_Tags.FileNew, rawFile) })

			const { updater } = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]?.[0] as {
				updater: (prev: Array<{ data: { uuid: string; decryptedMeta?: { name: string } } }>) => unknown[]
			}

			const prev = [
				{ data: { uuid: "file-new", decryptedMeta: { name: "OLD" } } },
				{ data: { uuid: "other-file", decryptedMeta: { name: "Other" } } }
			]
			const result = updater(prev) as typeof prev

			// Duplicate uuid removed, "other-file" preserved, new driveItemFile appended
			expect(result.find(i => i.data.uuid === "file-new")).toBe(driveItemFile)
			expect(result.find(i => i.data.uuid === "other-file")).toBeDefined()
		})

		it("FileNew: does NOT call driveItemsQueryUpdate when parentUuid is null", async () => {
			mockUnwrapParentUuid.mockReturnValue(null)
			mockUnwrapFileMeta.mockReturnValue({ file: { uuid: "file-new" }, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-new" } })

			await handleDriveEvent({ event: makeFileWithParentEvent(DriveEvent_Tags.FileNew, rawFile) })

			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
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

		it("no-op when file is not in cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFileMoveEvent({ uuid: "file-not-cached", parent: {} }) })

			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
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

		it("no-op when folder is not in directory cache", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderMoveEvent({ uuid: "dir-not-cached", parent: {} }) })

			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
		})

		it("no-op when cached entry has tag !== Dir", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Root,
				inner: [rawDirOld]
			})

			await handleDriveEvent({ event: makeFolderMoveEvent(rawDirNew) })

			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
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
		it("removes from parent (global update) and adds to both recents and trash", async () => {
			const rawFile = { uuid: "file-trash", parent: {} }
			const trashedDriveItem = { type: "file", data: { uuid: "file-trash" } }

			mockCacheFileUuidToNormalFileGet.mockReturnValue(rawFile)
			mockUnwrapFileMeta.mockReturnValue({ file: rawFile, meta: null })
			mockUnwrappedFileIntoDriveItem.mockReturnValue(trashedDriveItem)

			await handleDriveEvent({ event: makeFileTrashEvent("file-trash") })

			// Remove from parent
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdateGlobal).toHaveBeenCalledWith(expect.objectContaining({ parentUuid: "parent-1" }))

			// Add to recents and trash
			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledTimes(2)

			const recentCall = mockDriveItemsQueryUpdate.mock.calls.find(
				c => (c[0] as { params: { path: { type: string } } }).params.path.type === "recents"
			)?.[0] as { updater: (prev: Array<{ data: { uuid: string } }>) => unknown[] }
			const trashCall = mockDriveItemsQueryUpdate.mock.calls.find(
				c => (c[0] as { params: { path: { type: string } } }).params.path.type === "trash"
			)?.[0] as { updater: (prev: Array<{ data: { uuid: string } }>) => unknown[] }

			expect(recentCall).toBeDefined()
			expect(trashCall).toBeDefined()

			// Each updater deduplicates then appends the trashed item
			const prev = [{ data: { uuid: "file-trash" } }, { data: { uuid: "other" } }]
			const recentResult = recentCall?.updater(prev) as typeof prev
			expect(recentResult[recentResult.length - 1]).toBe(trashedDriveItem)
		})

		it("no-op when file is not in cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFileTrashEvent("file-not-cached") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})
	})

	describe("DriveEvent_Tags.FolderTrash", () => {
		it("removes from parent (global update) and adds to both recents and trash", async () => {
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
			expect(mockDriveItemsQueryUpdate).toHaveBeenCalledTimes(2)

			const recentsPath = mockDriveItemsQueryUpdate.mock.calls.find(
				c => (c[0] as { params: { path: { type: string } } }).params.path.type === "recents"
			)
			const trashPath = mockDriveItemsQueryUpdate.mock.calls.find(
				c => (c[0] as { params: { path: { type: string } } }).params.path.type === "trash"
			)

			expect(recentsPath).toBeDefined()
			expect(trashPath).toBeDefined()
		})

		it("no-op when folder is not in cache", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-not-cached") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("no-op when folder cache entry has tag !== Dir", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Root,
				inner: [{ uuid: "dir-trash", parent: {} }]
			})

			await handleDriveEvent({ event: makeFolderTrashEvent("dir-root") })

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
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

		it("FolderSubCreated: adds item to parent listing but does NOT touch trash query", async () => {
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-new", meta: { name: "new-dir" } })
			mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "dir-new" } })

			await handleDriveEvent({
				event: makeDirWithParentEvent(DriveEvent_Tags.FolderSubCreated, {
					uuid: "dir-new",
					parent: {},
					meta: {}
				})
			})

			expect(mockDriveItemsQueryUpdateForNormalParent).toHaveBeenCalledOnce()
			expect(mockDriveItemsQueryUpdate).not.toHaveBeenCalled()
		})

		it("does NOT update parent when parentUuid is null", async () => {
			mockUnwrapParentUuid.mockReturnValue(null)
			mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-restore", meta: null })
			mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "dir-restore" } })

			await handleDriveEvent({ event: makeDirWithParentEvent(DriveEvent_Tags.FolderRestore, rawDir) })

			expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
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

			const oldItem = { data: { uuid: "fav-file" } }
			const otherItem = { data: { uuid: "other" } }
			const result = updater([oldItem, otherItem]) as unknown[]

			// Matching item replaced by updatedDriveItem
			expect(result[0]).toBe(updatedDriveItem)
			expect(result[1]).toBe(otherItem)
		})

		it("File sub-tag: no-op when file is not in cache", async () => {
			mockCacheFileUuidToNormalFileGet.mockReturnValue(undefined)

			await handleDriveEvent({
				event: makeItemFavoriteFileEvent({ uuid: "fav-file-not-cached", parent: {} })
			})

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
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

			const oldItem = { data: { uuid: "fav-dir" } }
			const otherItem = { data: { uuid: "other" } }
			const result = updater([oldItem, otherItem]) as unknown[]

			expect(result[0]).toBe(updatedDriveItem)
			expect(result[1]).toBe(otherItem)
		})

		it("NormalDir sub-tag: no-op when dir is not in cache", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue(undefined)

			await handleDriveEvent({
				event: makeItemFavoriteDirEvent({ uuid: "fav-dir-not-cached", parent: {} })
			})

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
		})

		it("NormalDir sub-tag: no-op when cached entry has tag !== Dir", async () => {
			mockCacheDirectoryUuidToAnyNormalDirGet.mockReturnValue({
				tag: AnyNormalDir_Tags.Root,
				inner: [{ uuid: "fav-dir", parent: {} }]
			})

			await handleDriveEvent({
				event: makeItemFavoriteDirEvent({ uuid: "fav-dir", parent: {} })
			})

			expect(mockDriveItemsQueryUpdateGlobal).not.toHaveBeenCalled()
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

	describe("default — unhandled event tag", () => {
		it("throws 'Unhandled drive event' for an unknown tag", async () => {
			await expect(handleDriveEvent({ event: makeUnknownTagEvent() })).rejects.toThrow("Unhandled drive event")
		})
	})
})

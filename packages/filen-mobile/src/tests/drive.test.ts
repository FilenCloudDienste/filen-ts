import { vi, describe, it, expect, beforeEach } from "vitest"

// --- hoisted mocks -----------------------------------------------------------

const {
	mockGetSdkClients,
	mockAuthedSdkClient,
	mockDriveItemsQueryUpdate,
	mockDriveItemsQueryUpdateGlobal,
	mockDriveItemsQueryUpdateForNormalParent,
	mockDriveItemsQueryGet,
	mockCacheForgetItem,
	mockCacheDirectoryUuidToAnyNormalDir,
	mockUnwrapParentUuid,
	mockUnwrappedDirIntoDriveItem,
	mockUnwrappedFileIntoDriveItem,
	mockNormalizeFilePathForSdk,
	mockUnwrapDirMeta,
	mockUnwrapFileMeta,
	MockAnyNormalDirDir,
	MockCreatedTimeSet,
	MockCreatedTimeKeep,
	mockSdkModule
} = vi.hoisted(() => {
	const mockAuthedSdkClient = {
		setFavorite: vi.fn(),
		updateDirMetadata: vi.fn(),
		updateFileMetadata: vi.fn(),
		trashDir: vi.fn(),
		trashFile: vi.fn(),
		restoreDir: vi.fn(),
		restoreFile: vi.fn(),
		moveDir: vi.fn(),
		moveFile: vi.fn(),
		createDir: vi.fn(),
		findItemMatchesForName: vi.fn(),
		emptyTrash: vi.fn(),
		removeSharedItem: vi.fn(),
		restoreFileVersion: vi.fn(),
		root: vi.fn().mockReturnValue({ uuid: "root-uuid-0001" }),
		cacheNewFile: vi.fn(),
		cacheNewNormalDir: vi.fn()
	}

	const mockCacheDirectoryUuidToAnyNormalDir = new Map<string, unknown>()

	class HoistedAnyNormalDirRoot {
		tag = "Root"
		inner: unknown[]

		constructor(v: unknown) {
			this.inner = [v]
		}
	}

	class HoistedAnyNormalDirDir {
		tag = "Dir"
		inner: unknown[]

		constructor(v: unknown) {
			this.inner = [v]
		}
	}

	class HoistedCreatedTimeSet {
		tag = "Set"
		inner: bigint[]

		constructor(v: bigint) {
			this.inner = [v]
		}

		static new(v: bigint) {
			return new HoistedCreatedTimeSet(v)
		}
	}

	class HoistedCreatedTimeKeep {
		tag = "Keep"

		static new() {
			return new HoistedCreatedTimeKeep()
		}
	}

	const mockAnyNormalDir = {
		Root: HoistedAnyNormalDirRoot,
		Dir: HoistedAnyNormalDirDir,
		instanceOf: (x: unknown) => x instanceof HoistedAnyNormalDirRoot || x instanceof HoistedAnyNormalDirDir
	}

	const mockSdkModule = {
		AnyNormalDir: mockAnyNormalDir,
		NonRootNormalItem: {
			Dir: class {
				tag = "Dir"
				inner: unknown[]

				constructor(v: unknown) {
					this.inner = [v]
				}
			},
			File: class {
				tag = "File"
				inner: unknown[]

				constructor(v: unknown) {
					this.inner = [v]
				}
			}
		},
		NonRootNormalItem_Tags: { Dir: "Dir", File: "File" },
		NonRootItem_Tags: { NormalDir: "NormalDir", File: "File" },
		SharedRootItem: {
			Dir: class {
				tag = "Dir"
				inner: unknown[]

				constructor(v: unknown) {
					this.inner = [v]
				}
			},
			File: class {
				tag = "File"
				inner: unknown[]

				constructor(v: unknown) {
					this.inner = [v]
				}
			}
		},
		CreatedTime: {
			Set: HoistedCreatedTimeSet,
			Keep: HoistedCreatedTimeKeep
		},
		DirColor: {},
		ErrorKind: {},
		DirMeta_Tags: { Decoded: "Decoded" },
		FileMeta: {},
		ParentUuid: {},
		MaybeEncryptedUniffi_Tags: {},
		AnyLinkedDir: {}
	}

	return {
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockAuthedSdkClient }),
		mockAuthedSdkClient,
		mockDriveItemsQueryUpdate: vi.fn(),
		mockDriveItemsQueryUpdateGlobal: vi.fn(),
		mockDriveItemsQueryUpdateForNormalParent: vi.fn(),
		mockDriveItemsQueryGet: vi.fn().mockReturnValue(null),
		mockCacheForgetItem: vi.fn(),
		mockCacheDirectoryUuidToAnyNormalDir,
		mockUnwrapParentUuid: vi.fn().mockReturnValue("parent-uuid-0001"),
		mockUnwrappedDirIntoDriveItem: vi.fn(),
		mockUnwrappedFileIntoDriveItem: vi.fn(),
		mockNormalizeFilePathForSdk: vi.fn((p: string) => p.replace(/^file:\/+/, "/")),
		mockUnwrapDirMeta: vi.fn(x => x),
		mockUnwrapFileMeta: vi.fn(x => x),
		MockAnyNormalDirDir: HoistedAnyNormalDirDir,
		MockCreatedTimeSet: HoistedCreatedTimeSet,
		MockCreatedTimeKeep: HoistedCreatedTimeKeep,
		mockSdkModule
	}
})

// --- module mocks ------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: mockGetSdkClients }
}))

vi.mock("@/lib/cache", () => ({
	default: {
		forgetItem: mockCacheForgetItem,
		cacheNewFile: vi.fn(),
		cacheNewNormalDir: vi.fn(),
		directoryUuidToAnyNormalDir: mockCacheDirectoryUuidToAnyNormalDir
	}
}))

vi.mock("@/lib/utils", () => ({
	unwrapParentUuid: mockUnwrapParentUuid,
	unwrappedDirIntoDriveItem: mockUnwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem: mockUnwrappedFileIntoDriveItem,
	normalizeFilePathForSdk: mockNormalizeFilePathForSdk,
	unwrapDirMeta: mockUnwrapDirMeta,
	unwrapFileMeta: mockUnwrapFileMeta,
	unwrapSdkError: vi.fn().mockReturnValue(null)
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdate: mockDriveItemsQueryUpdate,
	driveItemsQueryUpdateGlobal: mockDriveItemsQueryUpdateGlobal,
	driveItemsQueryUpdateForNormalParent: mockDriveItemsQueryUpdateForNormalParent,
	driveItemsQueryGet: mockDriveItemsQueryGet
}))

vi.mock("@/features/drive/queries/useDriveItemVersions.query", () => ({
	driveItemVersionsQueryUpdate: vi.fn()
}))

vi.mock("@/features/drive/queries/useDriveItemPublicLinkStatus.query", () => ({
	driveItemPublicLinkStatusQueryUpdate: vi.fn()
}))

vi.mock("@/lib/prompts", () => ({ default: { confirm: vi.fn() } }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }))
vi.mock("@/lib/serializer", () => ({ serialize: vi.fn().mockReturnValue("serialized") }))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({ runWithLoading: vi.fn(fn => fn()) }))
vi.mock("expo-router", () => ({ router: { push: vi.fn(), back: vi.fn() } }))

vi.mock("@filen/sdk-rs", () => mockSdkModule)

// --- import real unit under test AFTER all vi.mock calls ----------------------
import drive from "@/features/drive/drive"
import type { DriveItem } from "@/types"

// --- factory helpers ----------------------------------------------------------

function makeDirItem(overrides: Partial<{
	uuid: string
	name: string
	favorited: boolean
	parentUuid: string | null
}> = {}): DriveItem {
	return {
		type: "directory",
		data: {
			uuid: overrides.uuid ?? "dir-uuid-0001",
			favorited: overrides.favorited ?? false,
			parent: { tag: "Uuid", inner: [overrides.parentUuid ?? "parent-uuid-0001"] } as any,
			size: 0n,
			undecryptable: false,
			decryptedMeta: {
				name: overrides.name ?? "My Folder",
				created: 1000
			} as any,
			trash: false,
			color: null
		} as any
	}
}

function makeFileItem(overrides: Partial<{
	uuid: string
	name: string
	favorited: boolean
	parentUuid: string | null
}> = {}): DriveItem {
	return {
		type: "file",
		data: {
			uuid: overrides.uuid ?? "file-uuid-0001",
			favorited: overrides.favorited ?? false,
			parent: { tag: "Uuid", inner: [overrides.parentUuid ?? "parent-uuid-0001"] } as any,
			size: 100n,
			undecryptable: false,
			decryptedMeta: {
				name: overrides.name ?? "report.txt",
				mime: "text/plain",
				modified: 1000,
				created: 1000
			} as any,
			region: "us-east-1",
			bucket: "filen",
			chunks: 1,
			key: "key",
			hash: undefined,
			version: 2,
			timestamp: 1000,
			canMakeThumbnail: false,
			trash: false
		} as any
	}
}

function makeSharedRootDirItem(): DriveItem {
	return {
		type: "sharedRootDirectory",
		data: {
			uuid: "sharedroot-uuid-0001",
			size: 0n,
			undecryptable: false,
			decryptedMeta: { name: "Shared Root" } as any
		} as any
	}
}

function makeSharedFileItem(): DriveItem {
	return {
		type: "sharedFile",
		data: {
			uuid: "sharedfile-uuid-0001",
			size: 100n,
			undecryptable: false,
			decryptedMeta: { name: "shared.txt" } as any
		} as any
	}
}

function makeSharedRootFileItem(): DriveItem {
	return {
		type: "sharedRootFile",
		data: {
			uuid: "sharedrootfile-uuid-0001",
			size: 100n,
			undecryptable: false,
			decryptedMeta: { name: "shared-root.txt" } as any
		} as any
	}
}

// ============================================================================
// Drive.rename
// ============================================================================

describe("drive.rename", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
	})

	it("returns original item without SDK call when newName equals existing name", async () => {
		const item = makeDirItem({ name: "Reports" })

		const result = await drive.rename({ item, newName: "Reports" })

		expect(result).toBe(item)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns original item without SDK call when newName is empty string", async () => {
		const item = makeDirItem({ name: "Reports" })

		const result = await drive.rename({ item, newName: "" })

		expect(result).toBe(item)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns original item without SDK call when newName is whitespace only", async () => {
		const item = makeDirItem({ name: "Reports" })

		const result = await drive.rename({ item, newName: "   " })

		expect(result).toBe(item)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns original item without SDK call when newName is a single space", async () => {
		const item = makeDirItem({ name: "Reports" })

		const result = await drive.rename({ item, newName: " " })

		expect(result).toBe(item)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK updateDirMetadata when newName differs (directory)", async () => {
		const item = makeDirItem({ name: "Reports" })
		const renamedData = { ...item.data }
		const returned = { ...item.data } // no "region" → dir branch
		mockAuthedSdkClient.updateDirMetadata.mockResolvedValue(returned)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: renamedData })

		await drive.rename({ item, newName: "NewName" })

		expect(mockAuthedSdkClient.updateDirMetadata).toHaveBeenCalledWith(
			item.data,
			{ name: "NewName", created: undefined },
			undefined
		)
	})

	it("calls SDK updateFileMetadata when newName differs (file)", async () => {
		const item = makeFileItem({ name: "report.txt" })
		const renamedData = { ...item.data }
		const returned = { region: "us-east-1", ...item.data }
		mockAuthedSdkClient.updateFileMetadata.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: renamedData })

		await drive.rename({ item, newName: "summary.txt" })

		expect(mockAuthedSdkClient.updateFileMetadata).toHaveBeenCalledWith(
			item.data,
			expect.objectContaining({ name: "summary.txt" }),
			undefined
		)
	})

	it("proceeds with SDK call when decryptedMeta is null and newName is non-empty (dir)", async () => {
		const item: DriveItem = {
			type: "directory",
			data: {
				uuid: "dir-uuid-null",
				favorited: false,
				parent: { tag: "Uuid", inner: ["parent-uuid-0001"] } as any,
				size: 0n,
				undecryptable: false,
				decryptedMeta: null,
				trash: false,
				color: null
			} as any
		}
		const returned = { ...item.data }
		mockAuthedSdkClient.updateDirMetadata.mockResolvedValue(returned)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: item.data })

		await drive.rename({ item, newName: "FreshName" })

		expect(mockAuthedSdkClient.updateDirMetadata).toHaveBeenCalledWith(
			item.data,
			{ name: "FreshName", created: undefined },
			undefined
		)
	})

	it("throws 'Invalid item type' for sharedRootDirectory", async () => {
		const item = makeSharedRootDirItem()

		await expect(drive.rename({ item, newName: "NewName" })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

// ============================================================================
// Drive.favorite
// ============================================================================

describe("drive.favorite", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")
	})

	it("returns original item without SDK call when favorited state already matches (true)", async () => {
		const item = makeDirItem({ favorited: true })

		const result = await drive.favorite({ item, favorited: true })

		expect(result).toBe(item)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns original item without SDK call when favorited state already matches (false)", async () => {
		const item = makeDirItem({ favorited: false })

		const result = await drive.favorite({ item, favorited: false })

		expect(result).toBe(item)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK setFavorite with correct arguments when toggling false→true (file)", async () => {
		const item = makeFileItem({ favorited: false })
		const modifiedData = { ...item.data, favorited: true }
		mockAuthedSdkClient.setFavorite.mockResolvedValue({ tag: "File", inner: [modifiedData] })
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: modifiedData })

		await drive.favorite({ item, favorited: true })

		expect(mockAuthedSdkClient.setFavorite).toHaveBeenCalledWith(
			expect.objectContaining({ tag: "File" }),
			true,
			undefined
		)
	})

	it("calls SDK setFavorite when toggling true→false (directory)", async () => {
		const item = makeDirItem({ favorited: true })
		const modifiedData = { ...item.data, favorited: false }
		mockAuthedSdkClient.setFavorite.mockResolvedValue({ tag: "Dir", inner: [modifiedData] })
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: modifiedData })

		await drive.favorite({ item, favorited: false })

		expect(mockAuthedSdkClient.setFavorite).toHaveBeenCalledWith(
			expect.objectContaining({ tag: "Dir" }),
			false,
			undefined
		)
	})

	it("favorites query updater removes item by uuid (filter predicate)", async () => {
		const item = makeFileItem({ favorited: false })
		const modifiedData = { ...item.data, favorited: true }
		mockAuthedSdkClient.setFavorite.mockResolvedValue({ tag: "File", inner: [modifiedData] })
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: modifiedData })

		await drive.favorite({ item, favorited: true })

		// driveItemsQueryUpdate is called for favorites with a filter predicate
		const updateCall = mockDriveItemsQueryUpdate.mock.calls.find(
			call => call[0]?.params?.path?.type === "favorites"
		)

		expect(updateCall).toBeDefined()

		// Verify the updater removes the item by uuid
		const updater = updateCall![0].updater as (prev: DriveItem[]) => DriveItem[]
		const prev = [item, makeFileItem({ uuid: "other-file" })]
		const after = updater(prev)

		expect(after.some(i => i.data.uuid === item.data.uuid)).toBe(false)
		expect(after.some(i => i.data.uuid === "other-file")).toBe(true)
	})

	it("global parent query updater replaces item by uuid (map predicate)", async () => {
		const item = makeFileItem({ favorited: false })
		const modifiedData = { ...item.data, favorited: true }
		const modifiedItem: DriveItem = { type: "file", data: modifiedData as any }
		mockAuthedSdkClient.setFavorite.mockResolvedValue({ tag: "File", inner: [modifiedData] })
		mockUnwrappedFileIntoDriveItem.mockReturnValue(modifiedItem)
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")

		await drive.favorite({ item, favorited: true })

		const globalUpdateCall = mockDriveItemsQueryUpdateGlobal.mock.calls[0]

		expect(globalUpdateCall).toBeDefined()

		const updater = globalUpdateCall![0].updater as (prev: DriveItem[]) => DriveItem[]
		const other = makeFileItem({ uuid: "other-file" })
		const after = updater([item, other])

		// The modified item replaces the original
		expect(after.find(i => i.data.uuid === item.data.uuid)).toBe(modifiedItem)
		// Other items are preserved
		expect(after.find(i => i.data.uuid === "other-file")).toBe(other)
	})

	it("throws 'Invalid item type' for sharedFile", async () => {
		const item = makeSharedFileItem()

		await expect(drive.favorite({ item, favorited: true })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

// ============================================================================
// Drive.updateTimestamps (including BUGFIX: created=0 / modified=0)
// ============================================================================

describe("drive.updateTimestamps", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")
	})

	it("sends BigInt(0) for created=0 on a directory (BUGFIX: epoch-0 not falsy)", async () => {
		const item = makeDirItem()
		const returned = { ...item.data }
		mockAuthedSdkClient.updateDirMetadata.mockResolvedValue(returned)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: item.data })

		await drive.updateTimestamps({ item, created: 0 })

		expect(mockAuthedSdkClient.updateDirMetadata).toHaveBeenCalledWith(
			item.data,
			{ name: undefined, created: BigInt(0) },
			undefined
		)
	})

	it("sends BigInt(0) for modified=0 on a file (BUGFIX: epoch-0 not falsy)", async () => {
		const item = makeFileItem()
		const returned = { region: "us-east-1", ...item.data }
		mockAuthedSdkClient.updateFileMetadata.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: item.data })

		await drive.updateTimestamps({ item, modified: 0 })

		expect(mockAuthedSdkClient.updateFileMetadata).toHaveBeenCalledWith(
			item.data,
			expect.objectContaining({ lastModified: BigInt(0) }),
			undefined
		)
	})

	it("sends CreatedTime.Set for created=0 on a file (BUGFIX: uses Set not Keep)", async () => {
		const item = makeFileItem()
		const returned = { region: "us-east-1", ...item.data }
		mockAuthedSdkClient.updateFileMetadata.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: item.data })

		await drive.updateTimestamps({ item, created: 0 })

		const callArgs = mockAuthedSdkClient.updateFileMetadata.mock.calls[0]![1] as {
			created: InstanceType<typeof MockCreatedTimeSet> | InstanceType<typeof MockCreatedTimeKeep>
		}

		expect(callArgs.created).toBeInstanceOf(MockCreatedTimeSet)
		expect((callArgs.created as InstanceType<typeof MockCreatedTimeSet>).inner[0]).toBe(BigInt(0))
	})

	it("sends BigInt(1700000000000) for created=1700000000000", async () => {
		const item = makeDirItem()
		const returned = { ...item.data }
		mockAuthedSdkClient.updateDirMetadata.mockResolvedValue(returned)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: item.data })

		await drive.updateTimestamps({ item, created: 1700000000000 })

		expect(mockAuthedSdkClient.updateDirMetadata).toHaveBeenCalledWith(
			item.data,
			{ name: undefined, created: BigInt(1700000000000) },
			undefined
		)
	})

	it("sends undefined for created when created is not provided (directory)", async () => {
		const item = makeDirItem()
		const returned = { ...item.data }
		mockAuthedSdkClient.updateDirMetadata.mockResolvedValue(returned)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: item.data })

		await drive.updateTimestamps({ item })

		expect(mockAuthedSdkClient.updateDirMetadata).toHaveBeenCalledWith(
			item.data,
			{ name: undefined, created: undefined },
			undefined
		)
	})

	it("uses CreatedTime.Keep when both created and modified are undefined (file)", async () => {
		const item = makeFileItem()
		const returned = { region: "us-east-1", ...item.data }
		mockAuthedSdkClient.updateFileMetadata.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: item.data })

		await drive.updateTimestamps({ item })

		const callArgs = mockAuthedSdkClient.updateFileMetadata.mock.calls[0]![1] as {
			created: InstanceType<typeof MockCreatedTimeSet> | InstanceType<typeof MockCreatedTimeKeep>
			lastModified: bigint | undefined
		}

		expect(callArgs.created).toBeInstanceOf(MockCreatedTimeKeep)
		expect(callArgs.lastModified).toBeUndefined()
	})
})

// ============================================================================
// Drive.move
// ============================================================================

describe("drive.move", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")
	})

	it("returns original item without SDK call when source parent equals destination (same-parent short-circuit)", async () => {
		const item = makeDirItem({ parentUuid: "parent-uuid-0001" })
		const newParentDir = new MockAnyNormalDirDir({ uuid: "parent-uuid-0001" })

		// unwrapParentUuid returns the current parent uuid
		mockUnwrapParentUuid.mockReturnValueOnce("parent-uuid-0001")

		const result = await drive.move({ item, newParent: newParentDir as any })

		expect(result).toBe(item)
		expect(mockAuthedSdkClient.moveDir).not.toHaveBeenCalled()
		expect(mockAuthedSdkClient.moveFile).not.toHaveBeenCalled()
	})

	it("removes old item uuid from old parent query after successful move", async () => {
		const item = makeDirItem({ uuid: "dir-move-0001", parentUuid: "old-parent-uuid" })
		const newParentDir = new MockAnyNormalDirDir({ uuid: "new-parent-uuid" })
		const movedData = { ...item.data }

		mockUnwrapParentUuid
			.mockReturnValueOnce("old-parent-uuid") // for same-parent check (before SDK call)
			.mockReturnValueOnce("new-parent-uuid") // for new parent after move

		const returned = { ...item.data }
		mockAuthedSdkClient.moveDir.mockResolvedValue(returned)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: movedData })

		await drive.move({ item, newParent: newParentDir as any })

		const oldParentUpdate = mockDriveItemsQueryUpdateForNormalParent.mock.calls.find(
			call => call[0]?.parentUuid === "old-parent-uuid"
		)

		expect(oldParentUpdate).toBeDefined()

		const updater = oldParentUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		const withItem = [item, makeDirItem({ uuid: "other-dir" })]
		const after = updater(withItem)

		// Old item removed by uuid
		expect(after.some(i => i.data.uuid === "dir-move-0001")).toBe(false)
		expect(after.some(i => i.data.uuid === "other-dir")).toBe(true)
	})

	it("destination updater removes uuid-match and name-match (case-insensitive dedup)", async () => {
		const item = makeDirItem({ uuid: "dir-0001", name: "report.txt" })
		const duplicate = makeDirItem({ uuid: "dir-dup-0001", name: "Report.txt" })
		const other = makeDirItem({ uuid: "dir-other-0001", name: "notes.txt" })
		const newParentDir = new MockAnyNormalDirDir({ uuid: "new-parent-uuid" })

		mockUnwrapParentUuid
			.mockReturnValueOnce("old-parent-uuid")
			.mockReturnValueOnce("new-parent-uuid")

		const movedData = { ...item.data }
		mockAuthedSdkClient.moveDir.mockResolvedValue({ ...item.data })
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: movedData })

		await drive.move({ item, newParent: newParentDir as any })

		const destUpdate = mockDriveItemsQueryUpdateForNormalParent.mock.calls.find(
			call => call[0]?.parentUuid === "new-parent-uuid"
		)

		expect(destUpdate).toBeDefined()

		const updater = destUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		const after = updater([duplicate, other])

		// duplicate removed by name (case-insensitive)
		expect(after.some(i => i.data.uuid === "dir-dup-0001")).toBe(false)
		// other retained
		expect(after.some(i => i.data.uuid === "dir-other-0001")).toBe(true)
		// moved item appended
		expect(after[after.length - 1]!.data.uuid).toBe("dir-0001")
	})

	it("destination updater trims whitespace in names before dedup comparison", async () => {
		const item = makeDirItem({ uuid: "dir-trim-0001", name: "  notes  " })
		const existing = makeDirItem({ uuid: "dir-existing-0001", name: "notes" })
		const newParentDir = new MockAnyNormalDirDir({ uuid: "new-parent-uuid" })

		mockUnwrapParentUuid
			.mockReturnValueOnce("old-parent-uuid")
			.mockReturnValueOnce("new-parent-uuid")

		const movedData = { ...item.data }
		mockAuthedSdkClient.moveDir.mockResolvedValue({ ...item.data })
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: movedData })

		await drive.move({ item, newParent: newParentDir as any })

		const destUpdate = mockDriveItemsQueryUpdateForNormalParent.mock.calls.find(
			call => call[0]?.parentUuid === "new-parent-uuid"
		)

		const updater = destUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		const after = updater([existing])

		// 'notes' matches trimmed '  notes  ' → removed
		expect(after.some(i => i.data.uuid === "dir-existing-0001")).toBe(false)
	})

	it("throws 'Invalid item type' for sharedFile", async () => {
		const item = makeSharedFileItem()
		const newParentDir = new MockAnyNormalDirDir({ uuid: "new-parent-uuid" })

		await expect(drive.move({ item, newParent: newParentDir as any })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("throws 'Invalid parent type' for sharedRootDirectory parent", async () => {
		const item = makeDirItem()
		const invalidParent = makeSharedRootDirItem()

		await expect(drive.move({ item, newParent: invalidParent })).rejects.toThrow("Invalid parent type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

// ============================================================================
// Drive.restore
// ============================================================================

describe("drive.restore", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")
	})

	it("removes item from trash query after restore", async () => {
		const item = makeFileItem({ uuid: "restore-file-uuid" })
		const restoredData = { ...item.data }
		const returned = { region: "us-east-1", ...item.data }

		mockAuthedSdkClient.restoreFile.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: restoredData })

		await drive.restore({ item })

		const trashUpdate = mockDriveItemsQueryUpdate.mock.calls.find(
			call => call[0]?.params?.path?.type === "trash"
		)

		expect(trashUpdate).toBeDefined()

		const updater = trashUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		const other = makeFileItem({ uuid: "other-trash-uuid" })
		const after = updater([item, other])

		expect(after.some(i => i.data.uuid === "restore-file-uuid")).toBe(false)
		expect(after.some(i => i.data.uuid === "other-trash-uuid")).toBe(true)
	})

	it("parent updater removes uuid-match and name-match before appending restored item", async () => {
		const item = makeFileItem({ uuid: "restore-file-uuid", name: "report.pdf" })
		const duplicate = makeFileItem({ uuid: "dup-uuid", name: "Report.pdf" })
		const restoredData = { ...item.data }
		const returned = { region: "us-east-1", ...item.data }

		mockAuthedSdkClient.restoreFile.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: restoredData })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")

		await drive.restore({ item })

		const parentUpdate = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]

		expect(parentUpdate).toBeDefined()

		const updater = parentUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		const after = updater([duplicate])

		// duplicate removed by name (case-insensitive)
		expect(after.some(i => i.data.uuid === "dup-uuid")).toBe(false)
		// restored item appended
		expect(after[after.length - 1]!.data.uuid).toBe("restore-file-uuid")
	})

	it("does NOT call driveItemsQueryUpdateForNormalParent when parent uuid is null", async () => {
		const item = makeFileItem()
		const returned = { region: "us-east-1", ...item.data }

		mockAuthedSdkClient.restoreFile.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: item.data })
		mockUnwrapParentUuid.mockReturnValue(null)

		await drive.restore({ item })

		expect(mockDriveItemsQueryUpdateForNormalParent).not.toHaveBeenCalled()
	})

	it("throws 'Invalid item type' for sharedFile", async () => {
		const item = makeSharedFileItem()

		await expect(drive.restore({ item })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

// ============================================================================
// Drive.trash
// ============================================================================

describe("drive.trash", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")
	})

	it("global updater removes item from parent by uuid", async () => {
		const item = makeDirItem({ uuid: "trash-dir-uuid" })
		const returned = { ...item.data }

		mockAuthedSdkClient.trashDir.mockResolvedValue(returned)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: item.data })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")

		await drive.trash({ item })

		const globalUpdate = mockDriveItemsQueryUpdateGlobal.mock.calls[0]

		expect(globalUpdate).toBeDefined()

		const updater = globalUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		const other = makeDirItem({ uuid: "other-dir-uuid" })
		const after = updater([item, other])

		expect(after.some(i => i.data.uuid === "trash-dir-uuid")).toBe(false)
		expect(after.some(i => i.data.uuid === "other-dir-uuid")).toBe(true)
	})

	it("does not optimistically touch the recents listing (relies on refetch-on-focus)", async () => {
		const item = makeFileItem({ uuid: "trash-file-uuid" })
		const trashed: DriveItem = { type: "file", data: { ...item.data, trash: true } as any }
		const returned = { region: "us-east-1", ...item.data, trash: true }

		mockAuthedSdkClient.trashFile.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue(trashed)

		await drive.trash({ item })

		const recentsUpdate = mockDriveItemsQueryUpdate.mock.calls.find(
			call => call[0]?.params?.path?.type === "recents"
		)

		expect(recentsUpdate).toBeUndefined()
	})

	it("trash query updater appends item at end (idempotency on re-trash)", async () => {
		const item = makeFileItem({ uuid: "trash-file-uuid" })
		const returned = { region: "us-east-1", ...item.data, trash: true }
		const trashed: DriveItem = { type: "file", data: { ...item.data, trash: true } as any }

		mockAuthedSdkClient.trashFile.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue(trashed)

		await drive.trash({ item })

		const trashUpdate = mockDriveItemsQueryUpdate.mock.calls.find(
			call => call[0]?.params?.path?.type === "trash"
		)

		expect(trashUpdate).toBeDefined()

		const updater = trashUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		// Already in trash once → re-trash should still produce exactly one entry
		const after = updater([item])

		expect(after.filter(i => i.data.uuid === "trash-file-uuid")).toHaveLength(1)
		expect(after[after.length - 1]!.data.uuid).toBe("trash-file-uuid")
	})

	it("throws 'Invalid item type' for sharedRootDirectory", async () => {
		const item = makeSharedRootDirItem()

		await expect(drive.trash({ item })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

// ============================================================================
// Drive.findItemMatchesForName
// ============================================================================

describe("drive.findItemMatchesForName", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
	})

	it("trims and lowercases search query before SDK call", async () => {
		mockAuthedSdkClient.findItemMatchesForName.mockResolvedValue([])

		await drive.findItemMatchesForName({ name: "  REPORT  " })

		expect(mockAuthedSdkClient.findItemMatchesForName).toHaveBeenCalledWith("report", undefined)
	})

	it("returns empty array when SDK returns no results", async () => {
		mockAuthedSdkClient.findItemMatchesForName.mockResolvedValue([])

		const result = await drive.findItemMatchesForName({ name: "anything" })

		expect(result).toEqual([])
	})

	it("filters out non-NormalDir and non-File tagged results", async () => {
		const sdkResults = [
			{ item: { tag: "LinkedDir", inner: [{}] }, path: "/some/path" },
			{ item: { tag: "NormalDir", inner: [{ uuid: "dir-0001" }] }, path: "/dir/path" },
			{ item: { tag: "File", inner: [{ uuid: "file-0001", region: "us-east-1" }] }, path: "/file/path" }
		]

		mockAuthedSdkClient.findItemMatchesForName.mockResolvedValue(sdkResults)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: { uuid: "dir-0001" } } as any)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-0001" } } as any)
		mockUnwrapDirMeta.mockReturnValue({ uuid: "dir-0001" })
		mockUnwrapFileMeta.mockReturnValue({ uuid: "file-0001" })

		const result = await drive.findItemMatchesForName({ name: "report" })

		// LinkedDir filtered out → only 2 results
		expect(result).toHaveLength(2)
	})

	it("normalizes paths in results via normalizeFilePathForSdk", async () => {
		const sdkResults = [
			{ item: { tag: "File", inner: [{ uuid: "file-0001", region: "us-east-1" }] }, path: "file:///foo/bar" }
		]

		mockAuthedSdkClient.findItemMatchesForName.mockResolvedValue(sdkResults)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: { uuid: "file-0001" } } as any)
		mockUnwrapFileMeta.mockReturnValue({ uuid: "file-0001" })
		mockNormalizeFilePathForSdk.mockReturnValueOnce("/foo/bar")

		const result = await drive.findItemMatchesForName({ name: "bar" })

		expect(result[0]!.path).toBe("/foo/bar")
		expect(mockNormalizeFilePathForSdk).toHaveBeenCalledWith("file:///foo/bar")
	})
})

// ============================================================================
// Drive.createDirectory
// ============================================================================

describe("drive.createDirectory", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockAuthedSdkClient.root.mockReturnValue({ uuid: "root-uuid-0001" })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockUnwrapParentUuid.mockReturnValue("root-uuid-0001")
		mockCacheDirectoryUuidToAnyNormalDir.clear()
	})

	it("uses AnyNormalDir.Root when parent is the string 'root'", async () => {
		const createdData = { uuid: "new-dir-uuid", size: 0n, decryptedMeta: { name: "NewDir" } }
		const createdDir = { ...createdData }
		mockAuthedSdkClient.createDir.mockResolvedValue(createdDir)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: createdData } as any)
		mockUnwrapDirMeta.mockReturnValue({ uuid: "new-dir-uuid" })

		await drive.createDirectory({ parent: "root", name: "NewDir" })

		expect(mockAuthedSdkClient.createDir).toHaveBeenCalledWith(
			expect.objectContaining({ tag: "Root" }),
			"NewDir",
			undefined
		)
	})

	it("uses AnyNormalDir.Root when parent uuid matches root uuid", async () => {
		const rootDir = makeDirItem({ uuid: "root-uuid-0001" })
		const createdData = { uuid: "new-dir-uuid", size: 0n, decryptedMeta: { name: "AnotherDir" } }
		const createdDir = { ...createdData }

		mockAuthedSdkClient.createDir.mockResolvedValue(createdDir)
		mockUnwrappedDirIntoDriveItem.mockReturnValue({ type: "directory", data: createdData } as any)
		mockUnwrapDirMeta.mockReturnValue({ uuid: "new-dir-uuid" })

		await drive.createDirectory({ parent: rootDir, name: "AnotherDir" })

		expect(mockAuthedSdkClient.createDir).toHaveBeenCalledWith(
			expect.objectContaining({ tag: "Root" }),
			"AnotherDir",
			undefined
		)
	})

	it("throws 'Parent not found in cache' when parent uuid is not in cache and not root", async () => {
		const unknownParent = makeDirItem({ uuid: "unknown-dir-uuid" })
		// directoryUuidToAnyNormalDir is empty

		await expect(drive.createDirectory({ parent: unknownParent, name: "Child" })).rejects.toThrow(
			"Parent not found in cache"
		)
	})

	it("post-create updater removes uuid-match and name-match before appending (dedup)", async () => {
		const createdData = {
			uuid: "new-dir-uuid",
			size: 0n,
			decryptedMeta: { name: "Report" },
			undecryptable: false
		}
		const existing = makeDirItem({ uuid: "old-dir-uuid", name: "report" }) // same name, lowercase
		const other = makeDirItem({ uuid: "other-dir-uuid", name: "notes" })

		mockAuthedSdkClient.createDir.mockResolvedValue({ ...createdData })
		const createdItem: DriveItem = { type: "directory", data: createdData as any }
		mockUnwrappedDirIntoDriveItem.mockReturnValue(createdItem)
		mockUnwrapDirMeta.mockReturnValue({ uuid: "new-dir-uuid" })

		await drive.createDirectory({ parent: "root", name: "Report" })

		const updateCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]

		expect(updateCall).toBeDefined()

		const updater = updateCall![0].updater as (prev: DriveItem[]) => DriveItem[]
		const after = updater([existing, other])

		// 'report' clashes with 'Report' (case-insensitive trim) → removed
		expect(after.some(i => i.data.uuid === "old-dir-uuid")).toBe(false)
		// other retained
		expect(after.some(i => i.data.uuid === "other-dir-uuid")).toBe(true)
		// new item appended
		expect(after[after.length - 1]).toBe(createdItem)
	})

	it("throws 'Invalid parent type' for sharedRootDirectory parent", async () => {
		const invalidParent = makeSharedRootDirItem()

		await expect(drive.createDirectory({ parent: invalidParent, name: "Child" })).rejects.toThrow(
			"Invalid parent type"
		)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

// ============================================================================
// Drive.restoreFileVersion
// ============================================================================

describe("drive.restoreFileVersion", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockUnwrapParentUuid.mockReturnValue("parent-uuid-0001")
	})

	it("dedup updater removes items with same uuid", async () => {
		const version = { uuid: "version-uuid-0001", timestamp: 1000 } as any
		const item = makeFileItem({ uuid: "file-uuid-restore", name: "plan.docx" })
		const returned = { region: "us-east-1", ...item.data }
		const restoredData = { ...item.data }

		mockAuthedSdkClient.restoreFileVersion.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: restoredData })

		await drive.restoreFileVersion({ item, version })

		const updateCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]

		expect(updateCall).toBeDefined()

		const updater = updateCall![0].updater as (prev: DriveItem[]) => DriveItem[]
		const dupByUuid = makeFileItem({ uuid: "file-uuid-restore", name: "plan.docx" })
		const other = makeFileItem({ uuid: "other-file-uuid", name: "readme.txt" })
		const after = updater([dupByUuid, other])

		// Duplicate by uuid removed
		expect(after.filter(i => i.data.uuid === "file-uuid-restore")).toHaveLength(1)
		expect(after[after.length - 1]!.data.uuid).toBe("file-uuid-restore")
		expect(after.some(i => i.data.uuid === "other-file-uuid")).toBe(true)
	})

	it("dedup updater removes items with same lowercased-trimmed name", async () => {
		const version = { uuid: "version-uuid-0001", timestamp: 1000 } as any
		const item = makeFileItem({ uuid: "file-uuid-restore", name: "Plan.docx" })
		const returned = { region: "us-east-1", ...item.data }
		const restoredData = { ...item.data }

		mockAuthedSdkClient.restoreFileVersion.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue({ type: "file", data: restoredData })

		await drive.restoreFileVersion({ item, version })

		const updateCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]
		const updater = updateCall![0].updater as (prev: DriveItem[]) => DriveItem[]

		// Different uuid but same name (different case) → dedup
		const nameCollision = makeFileItem({ uuid: "collision-uuid", name: "plan.docx" })
		const after = updater([nameCollision])

		expect(after.some(i => i.data.uuid === "collision-uuid")).toBe(false)
		expect(after[after.length - 1]!.data.uuid).toBe("file-uuid-restore")
	})

	it("restored item is appended at the end of the filtered list", async () => {
		const version = { uuid: "version-uuid-0001", timestamp: 1000 } as any
		const item = makeFileItem({ uuid: "file-uuid-restore", name: "plan.docx" })
		const returned = { region: "us-east-1", ...item.data }
		const restoredItem: DriveItem = { type: "file", data: { ...item.data } as any }

		mockAuthedSdkClient.restoreFileVersion.mockResolvedValue(returned)
		mockUnwrappedFileIntoDriveItem.mockReturnValue(restoredItem)

		await drive.restoreFileVersion({ item, version })

		const updateCall = mockDriveItemsQueryUpdateForNormalParent.mock.calls[0]
		const updater = updateCall![0].updater as (prev: DriveItem[]) => DriveItem[]

		const other = makeFileItem({ uuid: "other-file-uuid", name: "readme.txt" })
		const after = updater([other])

		expect(after[after.length - 1]).toBe(restoredItem)
	})

	it("throws 'Invalid item type' for directory", async () => {
		const item = makeDirItem()
		const version = { uuid: "version-uuid-0001", timestamp: 1000 } as any

		await expect(drive.restoreFileVersion({ item, version })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

// ============================================================================
// Drive.emptyTrash
// ============================================================================

describe("drive.emptyTrash", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockAuthedSdkClient.emptyTrash.mockResolvedValue(undefined)
	})

	it("does NOT call cache.forgetItem when trash query is null/undefined", async () => {
		mockDriveItemsQueryGet.mockReturnValue(null)

		await drive.emptyTrash({})

		expect(mockCacheForgetItem).not.toHaveBeenCalled()
	})

	it("calls cache.forgetItem once per item uuid when trash query has items", async () => {
		const item1 = makeFileItem({ uuid: "trashed-uuid-1" })
		const item2 = makeFileItem({ uuid: "trashed-uuid-2" })
		const item3 = makeDirItem({ uuid: "trashed-uuid-3" })

		mockDriveItemsQueryGet.mockReturnValue([item1, item2, item3])

		await drive.emptyTrash({})

		expect(mockCacheForgetItem).toHaveBeenCalledTimes(3)
		expect(mockCacheForgetItem).toHaveBeenCalledWith("trashed-uuid-1")
		expect(mockCacheForgetItem).toHaveBeenCalledWith("trashed-uuid-2")
		expect(mockCacheForgetItem).toHaveBeenCalledWith("trashed-uuid-3")
	})

	it("trash query updater returns empty array after emptyTrash", async () => {
		mockDriveItemsQueryGet.mockReturnValue([makeFileItem({ uuid: "trashed-uuid-1" })])

		await drive.emptyTrash({})

		const trashUpdate = mockDriveItemsQueryUpdate.mock.calls.find(
			call => call[0]?.params?.path?.type === "trash"
		)

		expect(trashUpdate).toBeDefined()

		const updater = trashUpdate![0].updater as () => DriveItem[]
		const result = updater()

		expect(result).toEqual([])
	})
})

// ============================================================================
// Drive.removeShare
// ============================================================================

describe("drive.removeShare", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: mockAuthedSdkClient })
		mockAuthedSdkClient.removeSharedItem.mockResolvedValue(undefined)
	})

	it("throws 'Invalid item type' for directory type", async () => {
		const item = makeDirItem()

		await expect(drive.removeShare({ item })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("throws 'Invalid item type' for file type", async () => {
		const item = makeFileItem()

		await expect(drive.removeShare({ item })).rejects.toThrow("Invalid item type")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("updates sharedOut and sharedIn for specific parentUuid (two calls with uuid)", async () => {
		const item = makeSharedRootFileItem()

		await drive.removeShare({ item, parentUuid: "parent-share-uuid" })

		const sharedOutWithParent = mockDriveItemsQueryUpdate.mock.calls.filter(
			call => call[0]?.params?.path?.type === "sharedOut" && call[0]?.params?.path?.uuid === "parent-share-uuid"
		)
		const sharedInWithParent = mockDriveItemsQueryUpdate.mock.calls.filter(
			call => call[0]?.params?.path?.type === "sharedIn" && call[0]?.params?.path?.uuid === "parent-share-uuid"
		)

		expect(sharedOutWithParent).toHaveLength(1)
		expect(sharedInWithParent).toHaveLength(1)
	})

	it("updates root-level sharedOut and sharedIn (uuid null) when no parentUuid", async () => {
		const item = makeSharedRootFileItem()

		await drive.removeShare({ item })

		const sharedOutRoot = mockDriveItemsQueryUpdate.mock.calls.filter(
			call => call[0]?.params?.path?.type === "sharedOut" && call[0]?.params?.path?.uuid === null
		)
		const sharedInRoot = mockDriveItemsQueryUpdate.mock.calls.filter(
			call => call[0]?.params?.path?.type === "sharedIn" && call[0]?.params?.path?.uuid === null
		)

		expect(sharedOutRoot).toHaveLength(1)
		expect(sharedInRoot).toHaveLength(1)
	})

	it("updaters filter by item.data.uuid", async () => {
		const item = makeSharedRootDirItem()

		await drive.removeShare({ item })

		// Pick any updater call
		const anyUpdate = mockDriveItemsQueryUpdate.mock.calls[0]

		expect(anyUpdate).toBeDefined()

		const updater = anyUpdate![0].updater as (prev: DriveItem[]) => DriveItem[]
		const other = makeSharedRootDirItem()
		;(other.data as any).uuid = "other-shared-uuid"

		const after = updater([item, other])

		expect(after.some(i => i.data.uuid === "sharedroot-uuid-0001")).toBe(false)
		expect(after.some(i => i.data.uuid === "other-shared-uuid")).toBe(true)
	})

	it("with parentUuid: updates both sharedOut/sharedIn for parentUuid AND root-level (4 total calls)", async () => {
		const item = makeSharedRootDirItem()

		await drive.removeShare({ item, parentUuid: "parent-share-uuid" })

		// With parentUuid: 2 calls for parentUuid + 2 calls for root (null) = 4
		expect(mockDriveItemsQueryUpdate).toHaveBeenCalledTimes(4)
	})
})

import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before vi.mock factories.
// We mirror the tag-based enum class pattern from drive.test.ts so that
// getRealDriveItemParent's `new AnyDirWithContext.Normal(...)` calls produce
// inspectable objects.
// ---------------------------------------------------------------------------

const {
	MockAnyNormalDirRoot,
	MockAnyNormalDirDir,
	MockAnyDirWithContextNormal,
	MockAnyDirWithContextShared,
	mockParentUuidTags,
	mockAnyNormalDirTags,
	mockAnyDirWithContextTags,
	mockCacheDirectoryUuidToAnyNormalDir,
	mockCacheDirectoryUuidToAnySharedDirWithContext,
	mockCacheFileUuidToNormalFile
} = vi.hoisted(() => {
	// ---- AnyNormalDir mock classes ----

	class HoistedAnyNormalDirRoot {
		readonly tag = "Root"
		readonly inner: unknown[]

		constructor(v: unknown) {
			this.inner = [v]
		}
	}

	class HoistedAnyNormalDirDir {
		readonly tag = "Dir"
		readonly inner: unknown[]
		readonly parent: unknown

		constructor(v: { uuid?: string; parent?: unknown }) {
			this.inner = [v]
			this.parent = v?.parent
		}
	}

	// ---- AnyDirWithContext mock classes ----

	class HoistedAnyDirWithContextNormal {
		readonly tag = "Normal"
		readonly inner: unknown[]

		constructor(v: unknown) {
			this.inner = [v]
		}
	}

	class HoistedAnyDirWithContextShared {
		readonly tag = "Shared"
		readonly inner: unknown[]

		constructor(v: unknown) {
			this.inner = [v]
		}
	}

	const mockParentUuidTags = {
		Uuid: "Uuid",
		Trash: "Trash",
		Recents: "Recents",
		Favorites: "Favorites",
		Links: "Links"
	} as const

	const mockAnyNormalDirTags = {
		Dir: "Dir",
		Root: "Root"
	} as const

	const mockAnyDirWithContextTags = {
		Normal: "Normal",
		Shared: "Shared",
		Linked: "Linked"
	} as const

	const mockCacheDirectoryUuidToAnyNormalDir = new Map<string, unknown>()
	const mockCacheDirectoryUuidToAnySharedDirWithContext = new Map<string, unknown>()
	const mockCacheFileUuidToNormalFile = new Map<string, unknown>()

	return {
		MockAnyNormalDirRoot: HoistedAnyNormalDirRoot,
		MockAnyNormalDirDir: HoistedAnyNormalDirDir,
		MockAnyDirWithContextNormal: HoistedAnyDirWithContextNormal,
		MockAnyDirWithContextShared: HoistedAnyDirWithContextShared,
		mockParentUuidTags,
		mockAnyNormalDirTags,
		mockAnyDirWithContextTags,
		mockCacheDirectoryUuidToAnyNormalDir,
		mockCacheDirectoryUuidToAnySharedDirWithContext,
		mockCacheFileUuidToNormalFile
	}
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/sdk-rs", () => ({
	ParentUuid_Tags: mockParentUuidTags,
	AnyNormalDir_Tags: mockAnyNormalDirTags,
	AnyDirWithContext_Tags: mockAnyDirWithContextTags,
	// AnyNormalDir: used as `new AnyNormalDir.Root(...)` and `new AnyNormalDir.Dir(...)`
	AnyNormalDir: {
		Root: MockAnyNormalDirRoot,
		Dir: MockAnyNormalDirDir,
		instanceOf: (x: unknown) => x instanceof MockAnyNormalDirRoot || x instanceof MockAnyNormalDirDir
	},
	// AnyDirWithContext: used as `new AnyDirWithContext.Normal(...)` and `new AnyDirWithContext.Shared(...)`
	AnyDirWithContext: {
		Normal: MockAnyDirWithContextNormal,
		Shared: MockAnyDirWithContextShared,
		instanceOf: (x: unknown) => x instanceof MockAnyDirWithContextNormal || x instanceof MockAnyDirWithContextShared
	},
	// AnyFile, AnySharedDir, etc. — not used by getRealDriveItemParent, stub enough to avoid import errors
	AnyFile: { instanceOf: () => false },
	AnySharedDir: { instanceOf: () => false },
	AnyFile_Tags: {},
	AnySharedDir_Tags: {},
	AnyLinkedDir_Tags: {},
	AnyLinkedDir: {},
	DirMeta_Tags: { Decoded: "Decoded" },
	FileMeta_Tags: { Decoded: "Decoded" },
	FileMeta: {},
	ParentUuid: {
		Uuid: class {
			readonly tag = "Uuid"
			readonly inner: string[]

			constructor(v: string) {
				this.inner = [v]
			}
		}
	},
	MaybeEncryptedUniffi_Tags: {},
	SharingRole: {}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		// in-memory only, no SQLite
		rootUuid: null as string | null,
		directoryUuidToAnyNormalDir: mockCacheDirectoryUuidToAnyNormalDir,
		directoryUuidToAnySharedDirWithContext: mockCacheDirectoryUuidToAnySharedDirWithContext,
		fileUuidToNormalFile: mockCacheFileUuidToNormalFile
	}
}))

vi.mock("@/constants", () => ({
	FILE_PUBLIC_LINK_URL_PREFIX: "https://app.filen.io/#/d/",
	DIRECTORY_PUBLIC_LINK_URL_PREFIX: "https://app.filen.io/#/f/"
}))

// ---------------------------------------------------------------------------
// Import the module under test AFTER all vi.mock calls.
// ---------------------------------------------------------------------------
import { getRealDriveItemParent } from "@/lib/sdkUnwrap"
import cache from "@/lib/cache"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Build a ParentUuid-like tagged union for the Uuid variant */
function parentUuid(uuid: string) {
	return { tag: mockParentUuidTags.Uuid, inner: [uuid] }
}

/** Build a ParentUuid-like tagged union for the Trash sentinel */
function parentTrash() {
	return { tag: mockParentUuidTags.Trash, inner: [] }
}

function drivePath(type: DrivePath["type"]): DrivePath {
	return { type, uuid: null } as DrivePath
}

function fileItem(uuid: string, parentUuidStr: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			parent: parentUuid(parentUuidStr),
			size: 0n,
			undecryptable: false,
			decryptedMeta: null
		}
	} as unknown as DriveItem
}

function directoryItem(uuid: string, parentUuidStr: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			parent: parentUuid(parentUuidStr),
			size: 0n,
			undecryptable: false,
			decryptedMeta: null
		}
	} as unknown as DriveItem
}

function sharedFileItem(uuid: string, parentUuidStr: string): DriveItem {
	return {
		type: "sharedFile",
		data: {
			uuid,
			parent: parentUuid(parentUuidStr),
			size: 0n,
			undecryptable: false,
			decryptedMeta: null
		}
	} as unknown as DriveItem
}

function sharedDirectoryItem(uuid: string, parentUuidStr: string): DriveItem {
	return {
		type: "sharedDirectory",
		data: {
			uuid,
			inner: {
				uuid,
				parent: parentUuid(parentUuidStr)
			},
			size: 0n,
			undecryptable: false,
			decryptedMeta: null
		}
	} as unknown as DriveItem
}

function sharedRootDirectoryItem(uuid: string): DriveItem {
	return {
		type: "sharedRootDirectory",
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta: null
		}
	} as unknown as DriveItem
}

function sharedRootFileItem(uuid: string): DriveItem {
	return {
		type: "sharedRootFile",
		data: {
			uuid,
			size: 0n,
			undecryptable: false,
			decryptedMeta: null
		}
	} as unknown as DriveItem
}

// ---------------------------------------------------------------------------
// Tests — finding #5
// ---------------------------------------------------------------------------

describe("getRealDriveItemParent", () => {
	const ROOT_UUID = "root-uuid-0001"
	const PARENT_UUID = "parent-dir-uuid-0001"
	const ITEM_UUID = "item-uuid-0001"

	// Use a cast to access the mutable rootUuid on the mock cache
	const mutableCache = cache as unknown as { rootUuid: string | null }

	beforeEach(() => {
		mutableCache.rootUuid = null
		mockCacheDirectoryUuidToAnyNormalDir.clear()
		mockCacheDirectoryUuidToAnySharedDirWithContext.clear()
		mockCacheFileUuidToNormalFile.clear()
	})

	// -----------------------------------------------------------------------
	// type === 'file' | 'directory'
	// -----------------------------------------------------------------------

	describe("file / directory items (normal drive path)", () => {
		it("returns null when parent UUID is null (non-uuid parent like 'trash')", () => {
			const item = {
				type: "file",
				data: {
					uuid: ITEM_UUID,
					parent: parentTrash(),
					size: 0n,
					undecryptable: false,
					decryptedMeta: null
				}
			} as unknown as DriveItem

			const result = getRealDriveItemParent({ item, drivePath: drivePath("drive") })

			expect(result).toBeNull()
		})

		it("returns AnyDirWithContext.Normal(Root) when parent UUID matches cache.rootUuid", () => {
			mutableCache.rootUuid = ROOT_UUID
			const item = fileItem(ITEM_UUID, ROOT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("drive") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
			const normal = result as unknown as InstanceType<typeof MockAnyDirWithContextNormal>
			expect(normal.inner[0]).toBeInstanceOf(MockAnyNormalDirRoot)
			const root = normal.inner[0] as InstanceType<typeof MockAnyNormalDirRoot>
			expect((root.inner as [{ uuid: string }])[0].uuid).toBe(ROOT_UUID)
		})

		it("returns AnyDirWithContext.Normal(cached) when parent UUID is in directoryUuidToAnyNormalDir", () => {
			const cachedDir = new MockAnyNormalDirDir({ uuid: PARENT_UUID, parent: parentTrash() })
			mockCacheDirectoryUuidToAnyNormalDir.set(PARENT_UUID, cachedDir)

			const item = fileItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("drive") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
			const normal = result as unknown as InstanceType<typeof MockAnyDirWithContextNormal>
			expect(normal.inner[0]).toBe(cachedDir)
		})

		it("returns null when parent UUID is unknown (not rootUuid, not in cache)", () => {
			mutableCache.rootUuid = ROOT_UUID
			// PARENT_UUID is different from ROOT_UUID and not in cache
			const item = fileItem(ITEM_UUID, "unknown-parent-uuid")

			const result = getRealDriveItemParent({ item, drivePath: drivePath("drive") })

			expect(result).toBeNull()
		})

		it("directory item: returns Normal(Root) when parent matches rootUuid", () => {
			mutableCache.rootUuid = ROOT_UUID
			const item = directoryItem(ITEM_UUID, ROOT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("drive") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
			const normal = result as unknown as InstanceType<typeof MockAnyDirWithContextNormal>
			expect(normal.inner[0]).toBeInstanceOf(MockAnyNormalDirRoot)
		})

		it("directory item: returns Normal(cached) when parent UUID is in cache", () => {
			const cachedDir = new MockAnyNormalDirDir({ uuid: PARENT_UUID, parent: parentTrash() })
			mockCacheDirectoryUuidToAnyNormalDir.set(PARENT_UUID, cachedDir)

			const item = directoryItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("drive") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
		})
	})

	// -----------------------------------------------------------------------
	// type === 'sharedDirectory'
	// -----------------------------------------------------------------------

	describe("sharedDirectory items", () => {
		it("sharedIn: returns AnyDirWithContext.Shared when parent is in directoryUuidToAnySharedDirWithContext", () => {
			const sharedContext = { dir: { tag: "Dir" }, shareInfo: {} }
			mockCacheDirectoryUuidToAnySharedDirWithContext.set(PARENT_UUID, sharedContext)

			const item = sharedDirectoryItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedIn") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextShared)
			const shared = result as unknown as InstanceType<typeof MockAnyDirWithContextShared>
			expect(shared.inner[0]).toBe(sharedContext)
		})

		it("sharedIn: returns null when parent UUID is not in sharedDirWithContext cache", () => {
			// Cache is empty
			const item = sharedDirectoryItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedIn") })

			expect(result).toBeNull()
		})

		it("sharedOut: returns Normal(Root) when parent matches rootUuid", () => {
			mutableCache.rootUuid = ROOT_UUID
			const item = sharedDirectoryItem(ITEM_UUID, ROOT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
			const normal = result as unknown as InstanceType<typeof MockAnyDirWithContextNormal>
			expect(normal.inner[0]).toBeInstanceOf(MockAnyNormalDirRoot)
		})

		it("sharedOut: returns Normal(cached) when parent is in directoryUuidToAnyNormalDir", () => {
			const cachedDir = new MockAnyNormalDirDir({ uuid: PARENT_UUID, parent: parentTrash() })
			mockCacheDirectoryUuidToAnyNormalDir.set(PARENT_UUID, cachedDir)

			const item = sharedDirectoryItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
		})

		it("sharedOut: returns null when parent is unknown and rootUuid does not match", () => {
			mutableCache.rootUuid = ROOT_UUID
			const item = sharedDirectoryItem(ITEM_UUID, "some-other-parent")

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeNull()
		})

		it("returns null when parent UUID is non-uuid sentinel (trash)", () => {
			const item = {
				type: "sharedDirectory",
				data: {
					uuid: ITEM_UUID,
					inner: { uuid: ITEM_UUID, parent: parentTrash() },
					size: 0n,
					undecryptable: false,
					decryptedMeta: null
				}
			} as unknown as DriveItem

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedIn") })

			expect(result).toBeNull()
		})
	})

	// -----------------------------------------------------------------------
	// type === 'sharedFile'
	// -----------------------------------------------------------------------

	describe("sharedFile items", () => {
		it("sharedIn: returns Shared when parent is in directoryUuidToAnySharedDirWithContext", () => {
			const sharedContext = { dir: { tag: "Dir" }, shareInfo: {} }
			mockCacheDirectoryUuidToAnySharedDirWithContext.set(PARENT_UUID, sharedContext)

			const item = sharedFileItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedIn") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextShared)
		})

		it("sharedIn: returns null when parent not in sharedDirWithContext cache", () => {
			const item = sharedFileItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedIn") })

			expect(result).toBeNull()
		})

		it("sharedOut: returns Normal(Root) when parent matches rootUuid", () => {
			mutableCache.rootUuid = ROOT_UUID
			const item = sharedFileItem(ITEM_UUID, ROOT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
			const normal = result as unknown as InstanceType<typeof MockAnyDirWithContextNormal>
			expect(normal.inner[0]).toBeInstanceOf(MockAnyNormalDirRoot)
		})

		it("sharedOut: returns Normal(cached) when parent is in directoryUuidToAnyNormalDir", () => {
			const cachedDir = new MockAnyNormalDirDir({ uuid: PARENT_UUID, parent: parentTrash() })
			mockCacheDirectoryUuidToAnyNormalDir.set(PARENT_UUID, cachedDir)

			const item = sharedFileItem(ITEM_UUID, PARENT_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
		})

		it("sharedOut: returns null when parent is unknown", () => {
			mutableCache.rootUuid = ROOT_UUID
			const item = sharedFileItem(ITEM_UUID, "unknown-uuid")

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeNull()
		})
	})

	// -----------------------------------------------------------------------
	// type === 'sharedRootDirectory'
	// -----------------------------------------------------------------------

	describe("sharedRootDirectory items", () => {
		it("sharedIn: returns the literal 'sharedInRoot'", () => {
			const item = sharedRootDirectoryItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedIn") })

			expect(result).toBe("sharedInRoot")
		})

		it("sharedOut: returns Normal(Root) when the item's own UUID maps to a Dir entry and that dir's parent matches rootUuid", () => {
			mutableCache.rootUuid = ROOT_UUID

			// The sharedRootDirectory's own uuid is used to look up in directoryUuidToAnyNormalDir
			// The found dir's parent is then checked against rootUuid
			const innerDir = { uuid: ITEM_UUID, parent: parentUuid(ROOT_UUID) }
			const cachedDir = new MockAnyNormalDirDir(innerDir)
			;(cachedDir as unknown as { tag: string }).tag = mockAnyNormalDirTags.Dir
			mockCacheDirectoryUuidToAnyNormalDir.set(ITEM_UUID, cachedDir)

			const item = sharedRootDirectoryItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
			const normal = result as unknown as InstanceType<typeof MockAnyDirWithContextNormal>
			expect(normal.inner[0]).toBeInstanceOf(MockAnyNormalDirRoot)
		})

		it("sharedOut: returns Normal(parentDir) when the item's dir is found and its parent is in the normal dir cache", () => {
			mutableCache.rootUuid = ROOT_UUID

			const parentCachedDir = new MockAnyNormalDirDir({ uuid: PARENT_UUID, parent: parentTrash() })
			;(parentCachedDir as unknown as { tag: string }).tag = mockAnyNormalDirTags.Dir

			// The dir entry for ITEM_UUID has parent = PARENT_UUID (not rootUuid)
			const innerDir = { uuid: ITEM_UUID, parent: parentUuid(PARENT_UUID) }
			const cachedDir = new MockAnyNormalDirDir(innerDir)
			;(cachedDir as unknown as { tag: string }).tag = mockAnyNormalDirTags.Dir
			mockCacheDirectoryUuidToAnyNormalDir.set(ITEM_UUID, cachedDir)
			mockCacheDirectoryUuidToAnyNormalDir.set(PARENT_UUID, parentCachedDir)

			const item = sharedRootDirectoryItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
		})

		it("sharedOut: returns null when the item's own UUID is not in the normal dir cache", () => {
			mutableCache.rootUuid = ROOT_UUID
			// Nothing in cache for ITEM_UUID

			const item = sharedRootDirectoryItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeNull()
		})
	})

	// -----------------------------------------------------------------------
	// type === 'sharedRootFile'
	// -----------------------------------------------------------------------

	describe("sharedRootFile items", () => {
		it("sharedIn: returns the literal 'sharedInRoot'", () => {
			const item = sharedRootFileItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedIn") })

			expect(result).toBe("sharedInRoot")
		})

		it("sharedOut: returns Normal(Root) when the normal file's parent matches rootUuid", () => {
			mutableCache.rootUuid = ROOT_UUID

			// fileUuidToNormalFile maps item.data.uuid to a File object
			const normalFile = { uuid: ITEM_UUID, parent: parentUuid(ROOT_UUID) }
			mockCacheFileUuidToNormalFile.set(ITEM_UUID, normalFile)

			const item = sharedRootFileItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
			const normal = result as unknown as InstanceType<typeof MockAnyDirWithContextNormal>
			expect(normal.inner[0]).toBeInstanceOf(MockAnyNormalDirRoot)
		})

		it("sharedOut: returns Normal(parentDir) when parent is in directoryUuidToAnyNormalDir", () => {
			mutableCache.rootUuid = ROOT_UUID

			const parentCachedDir = new MockAnyNormalDirDir({ uuid: PARENT_UUID, parent: parentTrash() })
			mockCacheDirectoryUuidToAnyNormalDir.set(PARENT_UUID, parentCachedDir)

			const normalFile = { uuid: ITEM_UUID, parent: parentUuid(PARENT_UUID) }
			mockCacheFileUuidToNormalFile.set(ITEM_UUID, normalFile)

			const item = sharedRootFileItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeInstanceOf(MockAnyDirWithContextNormal)
		})

		it("sharedOut: returns null when the item's own UUID is not in fileUuidToNormalFile", () => {
			mutableCache.rootUuid = ROOT_UUID
			// Nothing in fileUuidToNormalFile

			const item = sharedRootFileItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeNull()
		})

		it("sharedOut: returns null when parent UUID is found but unknown (not rootUuid, not in normalDir cache)", () => {
			mutableCache.rootUuid = ROOT_UUID

			const normalFile = { uuid: ITEM_UUID, parent: parentUuid("totally-unknown-parent") }
			mockCacheFileUuidToNormalFile.set(ITEM_UUID, normalFile)

			const item = sharedRootFileItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeNull()
		})

		it("sharedOut: returns null when the cached normal file's parent is a trash sentinel (non-uuid)", () => {
			mutableCache.rootUuid = ROOT_UUID

			// parent is trash, not a uuid → unwrapParentUuid returns null
			const normalFile = { uuid: ITEM_UUID, parent: parentTrash() }
			mockCacheFileUuidToNormalFile.set(ITEM_UUID, normalFile)

			const item = sharedRootFileItem(ITEM_UUID)

			const result = getRealDriveItemParent({ item, drivePath: drivePath("sharedOut") })

			expect(result).toBeNull()
		})
	})
})

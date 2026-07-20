import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockGetSdkClients,
	mockGetDirSize,
	mockOfflineItemSize,
	cacheDirectoryUuidToAnyNormalDir,
	cacheDirectoryUuidToAnySharedDirWithContext,
	cacheDirectoryUuidToAnyLinkedDirWithMeta,
	cacheUuidToAnyDriveItem
} = vi.hoisted(() => {
	const cacheDirectoryUuidToAnyNormalDir = new Map<string, unknown>()
	const cacheDirectoryUuidToAnySharedDirWithContext = new Map<string, unknown>()
	const cacheDirectoryUuidToAnyLinkedDirWithMeta = new Map<string, unknown>()
	const cacheUuidToAnyDriveItem = new Map<string, unknown>()
	const mockGetDirSize = vi.fn()
	const mockOfflineItemSize = vi.fn().mockResolvedValue({ size: 0, files: 0, dirs: 0 })

	return {
		mockGetSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				getDirSize: mockGetDirSize
			}
		}),
		mockGetDirSize,
		mockOfflineItemSize,
		cacheDirectoryUuidToAnyNormalDir,
		cacheDirectoryUuidToAnySharedDirWithContext,
		cacheDirectoryUuidToAnyLinkedDirWithMeta,
		cacheUuidToAnyDriveItem
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => {
	const real = await import("@/tests/mocks/filenUtils")
	const { sortParams } = await import("@filen/utils")

	return {
		...real,
		sortParams
	}
})

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnyNormalDir: cacheDirectoryUuidToAnyNormalDir,
		directoryUuidToAnySharedDirWithContext: cacheDirectoryUuidToAnySharedDirWithContext,
		directoryUuidToAnyLinkedDirWithMeta: cacheDirectoryUuidToAnyLinkedDirWithMeta,
		uuidToAnyDriveItem: cacheUuidToAnyDriveItem
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		itemSize: mockOfflineItemSize
	}
}))

// Pure discriminant guard — mirrors the real DIRECTORY_TYPES membership without pulling the module's
// value deps (constants, serializer) into the node test env.
vi.mock("@/features/drive/driveSelectors", () => ({
	isDirectoryItem: (item: { type?: string }) =>
		item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapDirMeta: vi.fn().mockImplementation((dir: unknown) => ({
		uuid: (dir as Record<string, unknown>)?.["uuid"] ?? "dir-uuid",
		meta: { name: "Dir" },
		shared: false,
		linked: false,
		root: false,
		dir
	})),
	unwrappedDirIntoDriveItem: vi.fn().mockImplementation((unwrapped: unknown) => ({
		type: "directory",
		data: {
			uuid: (unwrapped as Record<string, unknown>)?.["uuid"] ?? "dir-uuid",
			size: 0n,
			undecryptable: false,
			decryptedMeta: null
		}
	}))
}))

vi.mock("@filen/sdk-rs", () => {
	// Each tagged wrapper stores its ordinal-1 payload at inner[0], matching the real UniffiEnum shape
	// the trash hack + assertions read. The *WithContext factories are identity (`new(v) => v`).
	class Wrapper {
		public inner: unknown[]

		public constructor(v: unknown) {
			this.inner = [v]
		}
	}

	return {
		AnyDirWithContext_Tags: {
			Normal: "Normal",
			Shared: "Shared",
			Linked: "Linked"
		},
		AnyNormalDir_Tags: {
			Dir: "Dir",
			Root: "Root"
		},
		AnyDirWithContext: {
			Normal: class extends Wrapper {
				tag = "Normal"
			},
			Shared: class extends Wrapper {
				tag = "Shared"
			},
			Linked: class extends Wrapper {
				tag = "Linked"
			}
		},
		AnyNormalDir: {
			Dir: class extends Wrapper {
				tag = "Dir"
			}
		},
		AnySharedDir: {
			Dir: class extends Wrapper {
				tag = "Dir"
			},
			Root: class extends Wrapper {
				tag = "Root"
			}
		},
		AnySharedDirWithContext: {
			new: (v: unknown) => v
		},
		ParentUuid: {
			Trash: class {
				tag = "Trash"
			}
		},
		AnyLinkedDirWithContext: {
			new: (v: unknown) => v
		}
	}
})

import { fetchData, directorySizeQueryKey, DirectorySizeUnresolvedError } from "@/features/drive/queries/useDirectorySize.query"

type FetchParams = Parameters<typeof fetchData>[0]

// Fixtures are minimal DriveItem-shaped stand-ins carrying only the fields fetchData reads
// (type + data.uuid + data.sharingRole); cast through unknown so the tests don't build full SDK records.
function callFetch(params: {
	uuid: string
	type: "offline" | "trash" | "sharedIn" | "sharedOut" | "normal" | "linked"
	item?: unknown
}): ReturnType<typeof fetchData> {
	return fetchData(params as unknown as FetchParams)
}

beforeEach(() => {
	mockGetSdkClients.mockReset()
	mockGetDirSize.mockReset()
	mockGetDirSize.mockResolvedValue({ size: 0n, files: 0n, dirs: 0n })
	mockGetSdkClients.mockResolvedValue({
		authedSdkClient: {
			getDirSize: mockGetDirSize
		}
	})
	mockOfflineItemSize.mockReset()
	mockOfflineItemSize.mockResolvedValue({ size: 0, files: 0, dirs: 0 })
	cacheDirectoryUuidToAnyNormalDir.clear()
	cacheDirectoryUuidToAnySharedDirWithContext.clear()
	cacheDirectoryUuidToAnyLinkedDirWithMeta.clear()
	cacheUuidToAnyDriveItem.clear()
})

// ─── offline arm: resolves via by-value item / uuidToAnyDriveItem → offline.itemSize ─────────

describe("fetchData — offline arm", () => {
	it("passes the cached DriveItem to offline.itemSize and returns its size", async () => {
		const dirItem = { type: "directory", data: { uuid: "offline-dir" } }

		cacheUuidToAnyDriveItem.set("offline-dir", dirItem)
		mockOfflineItemSize.mockResolvedValue({ size: 4096, files: 3, dirs: 1 })

		const result = await callFetch({ uuid: "offline-dir", type: "offline" })

		expect(mockOfflineItemSize).toHaveBeenCalledTimes(1)
		expect(mockOfflineItemSize).toHaveBeenCalledWith(dirItem)
		expect(result).toEqual({ size: 4096, files: 3, dirs: 1 })
		expect(mockGetDirSize).not.toHaveBeenCalled()
	})

	it("resolves a by-value offline directory item without any cache entry", async () => {
		const dirItem = { type: "directory", data: { uuid: "off-byvalue" } }

		mockOfflineItemSize.mockResolvedValue({ size: 2048, files: 2, dirs: 0 })

		const result = await callFetch({ uuid: "off-byvalue", type: "offline", item: dirItem })

		expect(mockOfflineItemSize).toHaveBeenCalledTimes(1)
		expect(mockOfflineItemSize).toHaveBeenCalledWith(dirItem)
		expect(result).toEqual({ size: 2048, files: 2, dirs: 0 })
	})

	it("throws DirectorySizeUnresolvedError and skips itemSize when the uuid resolves to nothing", async () => {
		await expect(callFetch({ uuid: "missing-offline-uuid", type: "offline" })).rejects.toBeInstanceOf(
			DirectorySizeUnresolvedError
		)

		expect(mockOfflineItemSize).not.toHaveBeenCalled()
	})

	it("throws and skips itemSize when the resolved item is not a directory", async () => {
		cacheUuidToAnyDriveItem.set("offline-file", { type: "file", data: { uuid: "offline-file" } })

		await expect(callFetch({ uuid: "offline-file", type: "offline" })).rejects.toBeInstanceOf(DirectorySizeUnresolvedError)

		expect(mockOfflineItemSize).not.toHaveBeenCalled()
	})
})

// ─── by-value resolution: item preferred over the (session-scoped) uuid caches ──────────────

describe("fetchData — by-value resolution", () => {
	it("resolves a normal directory item by value with no cache entry", async () => {
		const item = { type: "directory", data: { uuid: "ndir", parent: { tag: "Drive" } } }

		mockGetDirSize.mockResolvedValue({ size: 3n, files: 1n, dirs: 0n })

		await callFetch({ uuid: "ndir", type: "normal", item })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		const calledWith = mockGetDirSize.mock.calls[0]![0]

		expect(calledWith.tag).toBe("Normal")
		expect(calledWith.inner[0].tag).toBe("Dir")
		// The wrapper wraps the item's own data — not a cache read.
		expect(calledWith.inner[0].inner[0]).toBe(item.data)
	})

	it("applies the trash hack to a by-value directory item (type=trash)", async () => {
		const item = { type: "directory", data: { uuid: "tdir", parent: { tag: "Drive" }, meta: {} } }

		mockGetDirSize.mockResolvedValue({ size: 1n, files: 0n, dirs: 0n })

		await callFetch({ uuid: "tdir", type: "trash", item })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		const calledWith = mockGetDirSize.mock.calls[0]![0]

		expect(calledWith.tag).toBe("Normal")
		expect(calledWith.inner[0].tag).toBe("Dir")
		// The by-value normal wrapper still enters the trash re-parent hack.
		expect(calledWith.inner[0].inner[0].parent.tag).toBe("Trash")
	})

	it("resolves a sharedRootDirectory item by value (AnySharedDir.Root + stamped role)", async () => {
		const item = { type: "sharedRootDirectory", data: { uuid: "sroot", sharingRole: "owner" } }

		mockGetDirSize.mockResolvedValue({ size: 9n, files: 2n, dirs: 1n })

		await callFetch({ uuid: "sroot", type: "sharedIn", item })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		const calledWith = mockGetDirSize.mock.calls[0]![0]

		expect(calledWith.tag).toBe("Shared")

		// AnySharedDirWithContext.new is identity, so inner[0] is the { dir, shareInfo } record.
		const ctx = calledWith.inner[0]

		expect(ctx.shareInfo).toBe("owner")
		expect(ctx.dir.tag).toBe("Root")
		expect(ctx.dir.inner[0]).toBe(item.data)
	})

	it("resolves a sharedDirectory item with a stamped role by value (AnySharedDir.Dir)", async () => {
		const item = { type: "sharedDirectory", data: { uuid: "sdir", sharingRole: "owner" } }

		mockGetDirSize.mockResolvedValue({ size: 5n, files: 1n, dirs: 0n })

		await callFetch({ uuid: "sdir", type: "sharedOut", item })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		const calledWith = mockGetDirSize.mock.calls[0]![0]

		expect(calledWith.tag).toBe("Shared")

		const ctx = calledWith.inner[0]

		expect(ctx.shareInfo).toBe("owner")
		expect(ctx.dir.tag).toBe("Dir")
		expect(ctx.dir.inner[0]).toBe(item.data)
	})

	it("falls back to the share-context cache when a sharedDirectory item carries no role", async () => {
		const cachedShared = { dir: { tag: "Dir" }, shareInfo: "owner" }

		cacheDirectoryUuidToAnySharedDirWithContext.set("sdir-norole", cachedShared)

		// by-value item lacks sharingRole → must NOT build a context by value, must use the cache.
		const item = { type: "sharedDirectory", data: { uuid: "sdir-norole" } }

		mockGetDirSize.mockResolvedValue({ size: 7n, files: 1n, dirs: 0n })

		await callFetch({ uuid: "sdir-norole", type: "sharedIn", item })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		const calledWith = mockGetDirSize.mock.calls[0]![0]

		expect(calledWith.tag).toBe("Shared")
		// Wraps the cached context object directly (the by-value path was skipped).
		expect(calledWith.inner[0]).toBe(cachedShared)
	})
})

// ─── unresolved misses throw (never a silent zero) ──────────────────────────────────────────

describe("fetchData — unresolved misses throw", () => {
	it("throws for type=normal when the uuid has no item and no cache entry", async () => {
		await expect(callFetch({ uuid: "missing-uuid", type: "normal" })).rejects.toBeInstanceOf(DirectorySizeUnresolvedError)

		expect(mockGetDirSize).not.toHaveBeenCalled()
	})

	it("throws for type=trash when the uuid has no item and no cache entry", async () => {
		await expect(callFetch({ uuid: "non-existent-uuid", type: "trash" })).rejects.toBeInstanceOf(DirectorySizeUnresolvedError)

		expect(mockGetDirSize).not.toHaveBeenCalled()
	})

	it("throws for type=sharedIn when there is no item and no cached share context", async () => {
		await expect(callFetch({ uuid: "missing-shared", type: "sharedIn" })).rejects.toBeInstanceOf(DirectorySizeUnresolvedError)

		expect(mockGetDirSize).not.toHaveBeenCalled()
	})

	it("throws for type=linked when there is no cached linked context", async () => {
		await expect(callFetch({ uuid: "missing-linked", type: "linked" })).rejects.toBeInstanceOf(DirectorySizeUnresolvedError)

		expect(mockGetDirSize).not.toHaveBeenCalled()
	})

	it("includes the uuid in the thrown error message", async () => {
		await expect(callFetch({ uuid: "abc-123", type: "normal" })).rejects.toThrow("abc-123")
	})
})

// ─── trash hack: ParentUuid.Trash substitution (cache path) ─────────────────────────────────

describe("fetchData — trash hack", () => {
	it("applies trash hack: reconstructs context with ParentUuid.Trash when type=trash and dir tag is Dir", async () => {
		// Build a cached AnyNormalDir with tag=Dir to satisfy the trash hack condition
		const innerDirData = { uuid: "trashed-dir", parent: { tag: "Drive" }, color: "default", timestamp: 0n, favorited: false, meta: {} }
		const normalDir = { tag: "Dir", inner: [innerDirData] }

		// directoryUuidToAnyNormalDir stores AnyNormalDir; the cache is looked up by type normal/trash
		cacheDirectoryUuidToAnyNormalDir.set("trashed-dir", normalDir)

		mockGetDirSize.mockResolvedValue({ size: 100n, files: 5n, dirs: 2n })

		await callFetch({ uuid: "trashed-dir", type: "trash" })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		// The first argument should be an AnyDirWithContext.Normal wrapping a reconstructed dir
		const calledWith = mockGetDirSize.mock.calls[0]![0]

		// tag must be Normal (AnyDirWithContext.Normal was constructed)
		expect(calledWith.tag).toBe("Normal")

		// Inner must be a Dir-tagged AnyNormalDir
		const innerNormalDir = calledWith.inner[0]

		expect(innerNormalDir.tag).toBe("Dir")

		// Parent must be a ParentUuid.Trash instance
		const reconstructedDir = innerNormalDir.inner[0]

		expect(reconstructedDir.parent.tag).toBe("Trash")
	})

	it("forwards context unchanged for type=normal (no trash hack applied)", async () => {
		const innerDirData = { uuid: "normal-dir", parent: { tag: "Drive" }, color: "default", timestamp: 0n, favorited: false, meta: {} }
		const normalDir = { tag: "Dir", inner: [innerDirData] }

		cacheDirectoryUuidToAnyNormalDir.set("normal-dir", normalDir)

		mockGetDirSize.mockResolvedValue({ size: 50n, files: 2n, dirs: 1n })

		await callFetch({ uuid: "normal-dir", type: "normal" })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		const calledWith = mockGetDirSize.mock.calls[0]![0]

		// For normal type, the AnyDirWithContext.Normal wraps the original normalDir unchanged
		const innerNormalDir = calledWith.inner[0]

		expect(innerNormalDir.tag).toBe("Dir")

		// Parent should be the ORIGINAL Drive parent, not Trash
		expect(innerNormalDir.inner[0].parent.tag).toBe("Drive")
	})

	it("does NOT apply trash hack when dir tag is Root (not Dir)", async () => {
		// AnyNormalDir.Root does NOT trigger the hack
		const rootDirData = { uuid: "root-dir", parent: { tag: "Drive" } }
		const normalDirRoot = { tag: "Root", inner: [rootDirData] }

		cacheDirectoryUuidToAnyNormalDir.set("root-dir", normalDirRoot)

		mockGetDirSize.mockResolvedValue({ size: 10n, files: 1n, dirs: 0n })

		await callFetch({ uuid: "root-dir", type: "trash" })

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)

		// Context should be passed as-is (Normal wrapping Root), without replacing parent
		const calledWith = mockGetDirSize.mock.calls[0]![0]
		const innerNormalDir = calledWith.inner[0]

		// Root tag – no inner[0] parent replacement
		expect(innerNormalDir.tag).toBe("Root")
	})
})

// ─── BigInt → Number conversion ─────────────────────────────────────────────

describe("fetchData — BigInt → Number conversion", () => {
	it("converts BigInt size/files/dirs to plain numbers", async () => {
		const dirData = { uuid: "bigint-dir", parent: { tag: "Drive" }, color: "default", timestamp: 0n, favorited: false, meta: {} }
		const normalDir = { tag: "Dir", inner: [dirData] }

		cacheDirectoryUuidToAnyNormalDir.set("bigint-dir", normalDir)

		mockGetDirSize.mockResolvedValue({ size: 1234567890123n, files: 42n, dirs: 7n })

		const result = await callFetch({ uuid: "bigint-dir", type: "normal" })

		expect(result.size).toBe(1234567890123)
		expect(result.files).toBe(42)
		expect(result.dirs).toBe(7)
		expect(typeof result.size).toBe("number")
		expect(typeof result.files).toBe("number")
		expect(typeof result.dirs).toBe("number")
	})

	it("returns 0 for zero BigInt values", async () => {
		const dirData = { uuid: "zero-dir", parent: { tag: "Drive" }, color: "default", timestamp: 0n, favorited: false, meta: {} }
		const normalDir = { tag: "Dir", inner: [dirData] }

		cacheDirectoryUuidToAnyNormalDir.set("zero-dir", normalDir)

		mockGetDirSize.mockResolvedValue({ size: 0n, files: 0n, dirs: 0n })

		const result = await callFetch({ uuid: "zero-dir", type: "normal" })

		expect(result.size).toBe(0)
		expect(result.files).toBe(0)
		expect(result.dirs).toBe(0)
	})

	it("preserves MAX_SAFE_INTEGER exactly via Number(BigInt(MAX_SAFE_INTEGER))", async () => {
		const dirData = { uuid: "maxsafe-dir", parent: { tag: "Drive" }, color: "default", timestamp: 0n, favorited: false, meta: {} }
		const normalDir = { tag: "Dir", inner: [dirData] }

		cacheDirectoryUuidToAnyNormalDir.set("maxsafe-dir", normalDir)

		const bigIntMaxSafe = BigInt(Number.MAX_SAFE_INTEGER)

		mockGetDirSize.mockResolvedValue({ size: bigIntMaxSafe, files: 0n, dirs: 0n })

		const result = await callFetch({ uuid: "maxsafe-dir", type: "normal" })

		expect(result.size).toBe(Number.MAX_SAFE_INTEGER)
	})
})

// ─── directorySizeQueryKey: strips the by-value item ────────────────────────────────────────

describe("directorySizeQueryKey", () => {
	it("strips the by-value item — {uuid,type,item} keys identically to {uuid,type}", () => {
		const item = { type: "directory", data: { uuid: "u" } }

		const withItem = directorySizeQueryKey({ uuid: "u", type: "normal", item } as unknown as FetchParams)
		const without = directorySizeQueryKey({ uuid: "u", type: "normal" })

		expect(withItem).toEqual(without)
		expect(withItem).toEqual({ uuid: "u", type: "normal" })
		expect(Object.keys(withItem)).not.toContain("item")
	})
})

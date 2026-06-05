import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockGetSdkClients,
	mockGetDirSize,
	cacheDirectoryUuidToAnyNormalDir
} = vi.hoisted(() => {
	const cacheDirectoryUuidToAnyNormalDir = new Map<string, unknown>()
	const mockGetDirSize = vi.fn()

	return {
		mockGetSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				getDirSize: mockGetDirSize
			}
		}),
		mockGetDirSize,
		cacheDirectoryUuidToAnyNormalDir
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
		directoryUuidToAnySharedDirWithContext: new Map(),
		directoryUuidToAnyLinkedDirWithMeta: new Map(),
		directoryUuidToAnyDirWithContext: new Map()
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		itemSize: vi.fn().mockResolvedValue({ size: 0, files: 0, dirs: 0 })
	}
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
	// AnyDirWithContext_Tags and AnyNormalDir_Tags are string enums used in the trash hack
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
			Normal: class {
				tag = "Normal"
				inner: unknown[]
				constructor(v: unknown) {
					this.inner = [v]
				}
			}
		},
		AnyNormalDir: {
			Dir: class {
				tag = "Dir"
				inner: unknown[]
				constructor(v: unknown) {
					this.inner = [v]
				}
			}
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

import { fetchData } from "@/features/drive/queries/useDirectorySize.query"

beforeEach(() => {
	mockGetSdkClients.mockReset()
	mockGetDirSize.mockReset()
	mockGetDirSize.mockResolvedValue({ size: 0n, files: 0n, dirs: 0n })
	mockGetSdkClients.mockResolvedValue({
		authedSdkClient: {
			getDirSize: mockGetDirSize
		}
	})
	cacheDirectoryUuidToAnyNormalDir.clear()
})

// ─── trash hack: ParentUuid.Trash substitution ─────────────────────────────

describe("fetchData — trash hack", () => {
	it("returns zero sizes immediately when uuid has no cache entry", async () => {
		const result = await fetchData({ uuid: "non-existent-uuid", type: "trash" })

		expect(result).toEqual({ size: 0, files: 0, dirs: 0 })
		expect(mockGetDirSize).not.toHaveBeenCalled()
	})

	it("returns zero sizes immediately for type=normal when uuid has no cache entry", async () => {
		const result = await fetchData({ uuid: "missing-uuid", type: "normal" })

		expect(result).toEqual({ size: 0, files: 0, dirs: 0 })
		expect(mockGetDirSize).not.toHaveBeenCalled()
	})

	it("applies trash hack: reconstructs context with ParentUuid.Trash when type=trash and dir tag is Dir", async () => {
		// Build a cached AnyNormalDir with tag=Dir to satisfy the trash hack condition
		const innerDirData = { uuid: "trashed-dir", parent: { tag: "Drive" }, color: "default", timestamp: 0n, favorited: false, meta: {} }
		const normalDir = { tag: "Dir", inner: [innerDirData] }

		// directoryUuidToAnyNormalDir stores AnyNormalDir; the cache is looked up by type normal/trash
		cacheDirectoryUuidToAnyNormalDir.set("trashed-dir", normalDir)

		mockGetDirSize.mockResolvedValue({ size: 100n, files: 5n, dirs: 2n })

		await fetchData({ uuid: "trashed-dir", type: "trash" })

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

		await fetchData({ uuid: "normal-dir", type: "normal" })

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

		await fetchData({ uuid: "root-dir", type: "trash" })

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

		const result = await fetchData({ uuid: "bigint-dir", type: "normal" })

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

		const result = await fetchData({ uuid: "zero-dir", type: "normal" })

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

		const result = await fetchData({ uuid: "maxsafe-dir", type: "normal" })

		expect(result.size).toBe(Number.MAX_SAFE_INTEGER)
	})
})

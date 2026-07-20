import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const {
	mockQueryUpdaterSet,
	mockQueryUpdaterGet,
	mockGetSdkClients,
	mockOfflineListFiles,
	mockOfflineListDirectories,
	mockCameraUploadGetConfig,
	mockCacheRootUuid,
	cacheDirectoryUuidToAnyDirWithContext,
	cacheDirectoryUuidToAnyNormalDir,
	cacheDirectoryUuidToAnySharedDirWithContext,
	cacheUuidToAnyDriveItem,
	cacheFileUuidToNormalFile,
	cacheDirectoryUuidToName
} = vi.hoisted(() => {
	const cacheDirectoryUuidToAnyDirWithContext = new Map<string, unknown>()
	const cacheDirectoryUuidToAnyNormalDir = new Map<string, unknown>()
	const cacheDirectoryUuidToAnySharedDirWithContext = new Map<string, unknown>()
	const cacheUuidToAnyDriveItem = new Map<string, unknown>()
	const cacheFileUuidToNormalFile = new Map<string, unknown>()
	const cacheDirectoryUuidToName = new Map<string, string>()

	return {
		mockQueryUpdaterSet: vi.fn(),
		mockQueryUpdaterGet: vi.fn().mockReturnValue(undefined),
		mockGetSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				root: vi.fn().mockReturnValue({ uuid: "root-uuid" }),
				listDir: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listDirRecursive: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listFavorites: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listRecents: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listInSharedRoot: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listOutShared: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listSharedDir: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listTrash: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listLinkedItems: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				listLinkedDir: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
				getDirPublicLinkInfo: vi.fn().mockResolvedValue({
					link: {
						linkUuid: "l-uuid",
						linkKey: "key",
						linkKeyVersion: 1,
						salt: "salt",
						enableDownload: true,
						password: undefined
					},
					root: { inner: { uuid: "root-u" }, linkedTag: true }
				})
			}
		}),
		mockOfflineListFiles: vi.fn().mockResolvedValue([]),
		mockOfflineListDirectories: vi.fn().mockResolvedValue({ directories: [], files: [] }),
		mockCameraUploadGetConfig: vi.fn().mockResolvedValue({ enabled: false, remoteDir: null }),
		mockCacheRootUuid: { value: null as string | null },
		cacheDirectoryUuidToAnyDirWithContext,
		cacheDirectoryUuidToAnyNormalDir,
		cacheDirectoryUuidToAnySharedDirWithContext,
		cacheUuidToAnyDriveItem,
		cacheFileUuidToNormalFile,
		cacheDirectoryUuidToName
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-router", () => ({
	useLocalSearchParams: vi.fn().mockReturnValue({}),
	useNavigation: vi.fn().mockReturnValue({})
}))

vi.mock("@filen/utils", async () => {
	const real = await import("@/tests/mocks/filenUtils")
	const { sortParams } = await import("@filen/utils")

	return {
		...real,
		sortParams
	}
})

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		set: mockQueryUpdaterSet,
		get: mockQueryUpdaterGet
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		get rootUuid() {
			return mockCacheRootUuid.value
		},
		directoryUuidToAnyDirWithContext: cacheDirectoryUuidToAnyDirWithContext,
		directoryUuidToAnyNormalDir: cacheDirectoryUuidToAnyNormalDir,
		directoryUuidToAnySharedDirWithContext: cacheDirectoryUuidToAnySharedDirWithContext,
		directoryUuidToAnyLinkedDirWithMeta: new Map(),
		uuidToAnyDriveItem: cacheUuidToAnyDriveItem,
		fileUuidToNormalFile: cacheFileUuidToNormalFile,
		directoryUuidToName: cacheDirectoryUuidToName,
		// The real cache.ts helpers reconstruct AnyX values via the SDK; here we only replicate WHICH
		// maps/keys each seeds (what these fetchData tests assert), with the DriveItem as a placeholder
		// value. The real helpers' value construction is unit-tested in cache.test.ts.
		cacheNewFile: (file: { uuid: string }, driveItem: unknown) => {
			cacheUuidToAnyDriveItem.set(file.uuid, driveItem)
			cacheFileUuidToNormalFile.set(file.uuid, file)
		},
		cacheNewNormalDir: (dir: { uuid: string }, driveItem: { data: { decryptedMeta?: { name?: string } | null } }) => {
			cacheUuidToAnyDriveItem.set(dir.uuid, driveItem)

			if (driveItem.data.decryptedMeta?.name) {
				cacheDirectoryUuidToName.set(dir.uuid, driveItem.data.decryptedMeta.name)
			}

			cacheDirectoryUuidToAnyNormalDir.set(dir.uuid, driveItem)
			cacheDirectoryUuidToAnyDirWithContext.set(dir.uuid, driveItem)
		},
		cacheNewSharedDir: (
			_dir: unknown,
			driveItem: { data: { uuid: string; decryptedMeta?: { name?: string } | null } },
			opts: { sharedOut: boolean }
		) => {
			const uuid = driveItem.data.uuid

			cacheUuidToAnyDriveItem.set(uuid, driveItem)

			if (driveItem.data.decryptedMeta?.name) {
				cacheDirectoryUuidToName.set(uuid, driveItem.data.decryptedMeta.name)
			}

			cacheDirectoryUuidToAnySharedDirWithContext.set(uuid, driveItem)
			cacheDirectoryUuidToAnyDirWithContext.set(uuid, driveItem)

			if (opts.sharedOut) {
				cacheDirectoryUuidToAnyNormalDir.set(uuid, driveItem)
			}
		},
		cacheNewSharedRootDir: (
			_dir: unknown,
			driveItem: { data: { uuid: string; decryptedMeta?: { name?: string } | null } }
		) => {
			const uuid = driveItem.data.uuid

			cacheUuidToAnyDriveItem.set(uuid, driveItem)

			if (driveItem.data.decryptedMeta?.name) {
				cacheDirectoryUuidToName.set(uuid, driveItem.data.decryptedMeta.name)
			}

			cacheDirectoryUuidToAnySharedDirWithContext.set(uuid, driveItem)
			cacheDirectoryUuidToAnyDirWithContext.set(uuid, driveItem)
		},
		cacheNewSharedFile: (file: unknown, driveItem: { data: { uuid: string } }, opts: { sharedOut: boolean }) => {
			const uuid = driveItem.data.uuid

			cacheUuidToAnyDriveItem.set(uuid, driveItem)

			if (opts.sharedOut) {
				cacheFileUuidToNormalFile.set(uuid, file)
			}
		},
		cacheNewLinkedDir: (
			_dir: unknown,
			driveItem: { data: { uuid: string; decryptedMeta?: { name?: string } | null } },
			meta: unknown
		) => {
			const uuid = driveItem.data.uuid

			cacheUuidToAnyDriveItem.set(uuid, driveItem)

			if (driveItem.data.decryptedMeta?.name) {
				cacheDirectoryUuidToName.set(uuid, driveItem.data.decryptedMeta.name)
			}

			if (meta) {
				cacheDirectoryUuidToAnyDirWithContext.set(uuid, driveItem)
			}
		},
		cacheDriveItemReference: (driveItem: { data: { uuid: string } }) => {
			cacheUuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)
		}
	}
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		listFiles: mockOfflineListFiles,
		listDirectories: mockOfflineListDirectories
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/cameraUpload/cameraUpload", () => ({
	default: {
		getConfig: mockCameraUploadGetConfig
	}
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapDirMeta: vi.fn().mockImplementation((dir: unknown) => ({
		uuid: ((dir as Record<string, unknown>)?.["uuid"] as string) ?? "dir-uuid",
		meta: { name: "Dir" },
		shared: false,
		linked: false,
		root: false,
		dir
	})),
	unwrapFileMeta: vi.fn().mockImplementation((file: unknown) => ({
		file: { uuid: ((file as Record<string, unknown>)?.["uuid"] as string) ?? "file-uuid", ...(file as object) },
		meta: { name: "File" },
		shared: false,
		linked: false,
		root: false
	})),
	unwrappedDirIntoDriveItem: vi.fn().mockImplementation((unwrapped: unknown) => ({
		type: "directory",
		data: {
			uuid: ((unwrapped as Record<string, unknown>)?.["uuid"] as string) ?? "dir-uuid",
			size: 0n,
			undecryptable: false,
			// Faithful to the real builder: the unwrapped meta becomes the item's decryptedMeta, which is
			// where the cache helpers read the directory name from.
			decryptedMeta: ((unwrapped as Record<string, unknown>)?.["meta"] as { name?: string } | null) ?? null
		}
	})),
	unwrappedFileIntoDriveItem: vi.fn().mockImplementation((unwrapped: unknown) => {
		const file = (unwrapped as Record<string, unknown>)?.["file"] as Record<string, unknown>

		return {
			type: "file",
			data: {
				uuid: (file?.["uuid"] as string) ?? "file-uuid",
				size: 0n,
				undecryptable: false,
				decryptedMeta: null
			}
		}
	})
}))

vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: vi.fn().mockReturnValue(null)
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		},
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		}
	},
	AnyDirWithContext: {
		Normal: class {
			tag = "Normal"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		},
		Shared: class {
			tag = "Shared"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		},
		Linked: class {
			tag = "Linked"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		}
	},
	AnySharedDir: {
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		},
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		}
	},
	AnySharedDirWithContext: {
		new: (v: unknown) => v
	},
	AnyLinkedDir: {
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		},
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		}
	},
	AnyLinkedDirWithContext: {
		new: (v: unknown) => v
	},
	SharingRole: {},
	NonRootDir_Tags: {
		Normal: "Normal"
	},
	ErrorKind: {
		WrongPassword: "WrongPassword"
	}
}))

import {
	driveItemsQueryUpdateForNormalParent,
	fetchData,
	driveItemsQueryGet,
	BASE_QUERY_KEY,
	DriveDirectoryNotFoundError
} from "@/features/drive/queries/useDriveItems.query"
import { unwrapDirMeta, unwrapFileMeta, type UnwrapDirMetaResult, type UnwrapFileMetaResult } from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import { type DriveItem } from "@/types"

beforeEach(() => {
	mockQueryUpdaterSet.mockClear()
	mockQueryUpdaterGet.mockReset()
	mockQueryUpdaterGet.mockReturnValue(undefined)
	mockOfflineListFiles.mockReset()
	mockOfflineListFiles.mockResolvedValue([])
	mockOfflineListDirectories.mockReset()
	mockOfflineListDirectories.mockResolvedValue({ directories: [], files: [] })
	mockCameraUploadGetConfig.mockReset()
	mockCameraUploadGetConfig.mockResolvedValue({ enabled: false, remoteDir: null })
	mockGetSdkClients.mockReset()
	mockGetSdkClients.mockResolvedValue({
		authedSdkClient: {
			root: vi.fn().mockReturnValue({ uuid: "root-uuid" }),
			listDir: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listDirRecursive: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listFavorites: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listRecents: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listInSharedRoot: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listOutShared: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listSharedDir: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listTrash: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listLinkedItems: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			listLinkedDir: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
			getDirPublicLinkInfo: vi.fn().mockResolvedValue({
				link: { linkUuid: "l-uuid", linkKey: "key", linkKeyVersion: 1, salt: "salt", enableDownload: true, password: undefined },
				root: { inner: { uuid: "root-u" }, linkedTag: true }
			})
		}
	})
	mockCacheRootUuid.value = null
	vi.mocked(unwrapSdkError).mockReturnValue(null)
	vi.mocked(unwrapDirMeta).mockImplementation(
		(dir: unknown) =>
			({
				uuid: ((dir as Record<string, unknown>)?.["uuid"] as string) ?? "dir-uuid",
				meta: { name: "Dir" },
				shared: false,
				linked: false,
				root: false,
				dir
			}) as unknown as UnwrapDirMetaResult
	)
	vi.mocked(unwrapFileMeta).mockImplementation(
		(file: unknown) =>
			({
				file: { uuid: ((file as Record<string, unknown>)?.["uuid"] as string) ?? "file-uuid", ...(file as object) },
				meta: { name: "File" },
				shared: false,
				linked: false,
				root: false
			}) as unknown as UnwrapFileMetaResult
	)
	cacheDirectoryUuidToAnyDirWithContext.clear()
	cacheDirectoryUuidToAnyNormalDir.clear()
	cacheDirectoryUuidToAnySharedDirWithContext.clear()
	cacheUuidToAnyDriveItem.clear()
	cacheFileUuidToNormalFile.clear()
	cacheDirectoryUuidToName.clear()
})

// ─── removeSelectOptionsFromParams (indirectly, via driveItemsQueryGet key) ────

describe("removeSelectOptionsFromParams (via driveItemsQueryGet)", () => {
	it("strips selectOptions from path before building the query key", () => {
		const paramsWithOptions = {
			path: {
				type: "drive" as const,
				uuid: "abc-123",
				selectOptions: { someOption: true }
			}
		}

		driveItemsQueryGet(paramsWithOptions as Parameters<typeof driveItemsQueryGet>[0])

		const call = mockQueryUpdaterGet.mock.calls.at(-1)!
		const key = call[0] as unknown[]
		const params = key[1] as Record<string, unknown>
		const path = params["path"] as Record<string, unknown>

		expect(path).not.toHaveProperty("selectOptions")
		expect(path["uuid"]).toBe("abc-123")
		expect(path["type"]).toBe("drive")
	})

	it("returns original object when no selectOptions present (structural equivalence)", () => {
		const params = {
			path: { type: "drive" as const, uuid: "abc-123" }
		}

		driveItemsQueryGet(params)

		const call = mockQueryUpdaterGet.mock.calls.at(-1)!
		const key = call[0] as unknown[]
		const capturedPath = (key[1] as Record<string, unknown>)["path"] as Record<string, unknown>

		expect(capturedPath["uuid"]).toBe("abc-123")
		expect(capturedPath["type"]).toBe("drive")
		expect(capturedPath).not.toHaveProperty("selectOptions")
	})

	it("stripped result query key matches params without selectOptions", () => {
		const withOptions = {
			path: { type: "drive" as const, uuid: "xyz-456", selectOptions: { foo: "bar" } }
		}
		const withoutOptions = {
			path: { type: "drive" as const, uuid: "xyz-456" }
		}

		driveItemsQueryGet(withOptions as Parameters<typeof driveItemsQueryGet>[0])
		const keyWith = mockQueryUpdaterGet.mock.calls.at(-1)![0]

		driveItemsQueryGet(withoutOptions)
		const keyWithout = mockQueryUpdaterGet.mock.calls.at(-1)![0]

		expect(keyWith).toEqual(keyWithout)
	})
})

// ─── driveItemsQueryUpdateForNormalParent ───────────────────────────────────

describe("driveItemsQueryUpdateForNormalParent", () => {
	it("calls driveItemsQueryUpdate once when parentUuid does not match cache.rootUuid", () => {
		mockCacheRootUuid.value = "root-uuid-999"

		driveItemsQueryUpdateForNormalParent({ parentUuid: "other-uuid", updater: [] })

		const calls = mockQueryUpdaterSet.mock.calls.filter(c => (c[0] as unknown[])[0] === BASE_QUERY_KEY)

		expect(calls).toHaveLength(1)
	})

	it("calls driveItemsQueryUpdate twice when parentUuid matches cache.rootUuid", () => {
		mockCacheRootUuid.value = "root-uuid-abc"

		driveItemsQueryUpdateForNormalParent({ parentUuid: "root-uuid-abc", updater: [] })

		const calls = mockQueryUpdaterSet.mock.calls.filter(c => (c[0] as unknown[])[0] === BASE_QUERY_KEY)

		expect(calls).toHaveLength(2)

		const paths = calls.map(c => ((c[0] as unknown[])[1] as Record<string, unknown>)?.["path"])
		const uuids = paths.map(p => (p as Record<string, unknown>)?.["uuid"])

		expect(uuids).toContain("root-uuid-abc")
		expect(uuids).toContain(null)
	})

	it("calls driveItemsQueryUpdate once when cache.rootUuid is null", () => {
		mockCacheRootUuid.value = null

		driveItemsQueryUpdateForNormalParent({ parentUuid: "some-parent", updater: [] })

		const calls = mockQueryUpdaterSet.mock.calls.filter(c => (c[0] as unknown[])[0] === BASE_QUERY_KEY)

		expect(calls).toHaveLength(1)
	})

	it("forwards the functional updater to both update calls when root match occurs", () => {
		mockCacheRootUuid.value = "root-uuid-xyz"

		const updater = (prev: unknown[]) => [...prev, { data: { uuid: "1" } }]

		driveItemsQueryUpdateForNormalParent({
			parentUuid: "root-uuid-xyz",
			updater: updater as unknown as (prev: DriveItem[]) => DriveItem[]
		})

		const calls = mockQueryUpdaterSet.mock.calls.filter(c => (c[0] as unknown[])[0] === BASE_QUERY_KEY)

		expect(calls).toHaveLength(2)

		// Each call should have received a function wrapper that calls through to updater
		const updaterArg0 = calls[0]![1] as (v: unknown[]) => unknown[]
		const updaterArg1 = calls[1]![1] as (v: unknown[]) => unknown[]

		expect(typeof updaterArg0).toBe("function")
		expect(typeof updaterArg1).toBe("function")
		expect(updaterArg0([])).toEqual([{ data: { uuid: "1" } }])
		expect(updaterArg1([])).toEqual([{ data: { uuid: "1" } }])
	})

	it("seeds cache.uuidToAnyDriveItem for each item in the optimistic update (notes/chats analog)", () => {
		mockCacheRootUuid.value = null

		const item = { data: { uuid: "opt-seed-1" } } as unknown as DriveItem

		driveItemsQueryUpdateForNormalParent({ parentUuid: "some-parent", updater: [item] })

		const calls = mockQueryUpdaterSet.mock.calls.filter(c => (c[0] as unknown[])[0] === BASE_QUERY_KEY)
		const inner = calls[0]![1] as (prev: unknown[]) => unknown[]

		// Running the wrapper (what queryUpdater.set invokes) is what seeds the cache.
		inner([])

		expect(cacheUuidToAnyDriveItem.get("opt-seed-1")).toBe(item)
	})
})

// ─── fetchData offline branch ───────────────────────────────────────────────

describe("fetchData — offline branch", () => {
	it("calls listFiles and listDirectories(undefined) when parent is null (uuid absent)", async () => {
		await fetchData({ path: { type: "offline", uuid: "" } })

		expect(mockOfflineListFiles).toHaveBeenCalledWith()
		expect(mockOfflineListDirectories).toHaveBeenCalledWith(undefined)
	})

	it("returns empty array when both listFiles and listDirectories return nothing", async () => {
		const result = await fetchData({ path: { type: "offline", uuid: "" } })

		expect(result).toEqual([])
	})

	it("returns dirs from listDirectories and files from listFiles when parent is null", async () => {
		const fileItem = { type: "file", data: { uuid: "f-1", size: 0n, undecryptable: false, decryptedMeta: null } }
		const dirItem = { type: "directory", data: { uuid: "d-1", size: 0n, undecryptable: false, decryptedMeta: null } }

		mockOfflineListFiles.mockResolvedValue([{ item: fileItem }])
		mockOfflineListDirectories.mockResolvedValue({ directories: [{ item: dirItem }], files: [] })

		const result = await fetchData({ path: { type: "offline", uuid: "" } })

		expect(result).toHaveLength(2)
		expect(result.some(i => (i as typeof dirItem).data.uuid === "d-1")).toBe(true)
		expect(result.some(i => (i as typeof fileItem).data.uuid === "f-1")).toBe(true)
	})

	it("does NOT call listFiles when parent uuid is found in cache", async () => {
		const fakeContext = { tag: "Normal" }

		cacheDirectoryUuidToAnyDirWithContext.set("parent-uuid", fakeContext)

		const fileItem = { type: "file", data: { uuid: "f-2", size: 0n, undecryptable: false, decryptedMeta: null } }
		const dirItem = { type: "directory", data: { uuid: "d-2", size: 0n, undecryptable: false, decryptedMeta: null } }

		mockOfflineListDirectories.mockResolvedValue({ directories: [{ item: dirItem }], files: [{ item: fileItem }] })

		await fetchData({ path: { type: "offline", uuid: "parent-uuid" } })

		expect(mockOfflineListFiles).not.toHaveBeenCalled()
		expect(mockOfflineListDirectories).toHaveBeenCalledWith(fakeContext)
	})

	it("returns files from offlineDirectories.files (not listFiles) when parent is non-null", async () => {
		const fakeContext = { tag: "Normal" }

		cacheDirectoryUuidToAnyDirWithContext.set("parent-uuid-2", fakeContext)

		const fileItem = { type: "file", data: { uuid: "f-3", size: 0n, undecryptable: false, decryptedMeta: null } }

		mockOfflineListDirectories.mockResolvedValue({ directories: [], files: [{ item: fileItem }] })

		const result = await fetchData({ path: { type: "offline", uuid: "parent-uuid-2" } })

		expect(result).toHaveLength(1)
		expect((result[0] as typeof fileItem).data.uuid).toBe("f-3")
	})

	it("populates cache.uuidToAnyDriveItem for each returned item", async () => {
		const fileItem = { type: "file", data: { uuid: "f-cache", size: 0n, undecryptable: false, decryptedMeta: null } }

		mockOfflineListFiles.mockResolvedValue([{ item: fileItem }])

		await fetchData({ path: { type: "offline", uuid: "" } })

		expect(cacheUuidToAnyDriveItem.get("f-cache")).toBeDefined()
	})

	it("mixed dirs and files are all pushed into the items array", async () => {
		const dirs = [
			{ item: { type: "directory", data: { uuid: "dir-a", size: 0n, undecryptable: false, decryptedMeta: null } } },
			{ item: { type: "directory", data: { uuid: "dir-b", size: 0n, undecryptable: false, decryptedMeta: null } } }
		]
		const files = [{ item: { type: "file", data: { uuid: "file-a", size: 0n, undecryptable: false, decryptedMeta: null } } }]

		mockOfflineListDirectories.mockResolvedValue({ directories: dirs, files: [] })
		mockOfflineListFiles.mockResolvedValue(files)

		const result = await fetchData({ path: { type: "offline", uuid: "" } })

		expect(result).toHaveLength(3)
	})

	it("throws DriveDirectoryNotFoundError when uuid is non-empty but absent from cache (no silent root fallback)", async () => {
		// Finding #22: a provided non-root uuid that misses the offline index must NOT
		// silently list the offline root — it must surface as not-found.
		mockOfflineListFiles.mockResolvedValue([])
		mockOfflineListDirectories.mockResolvedValue({ directories: [], files: [] })

		// ensure no cache entry exists for this uuid
		expect(cacheDirectoryUuidToAnyDirWithContext.has("non-existent-uuid")).toBe(false)

		await expect(fetchData({ path: { type: "offline", uuid: "non-existent-uuid" } })).rejects.toBeInstanceOf(
			DriveDirectoryNotFoundError
		)

		// The root listing must never run for a missed non-root uuid.
		expect(mockOfflineListFiles).not.toHaveBeenCalled()
	})

	it("cache-hit lists the cached subdir; cache-miss throws not-found (paths are distinct)", async () => {
		const fakeContext = { tag: "Normal" }

		cacheDirectoryUuidToAnyDirWithContext.set("cached-uuid", fakeContext)

		// With uuid in cache — lists the subdir, listFiles (root files) must NOT be called
		await fetchData({ path: { type: "offline", uuid: "cached-uuid" } })

		expect(mockOfflineListFiles).not.toHaveBeenCalled()
		expect(mockOfflineListDirectories).toHaveBeenCalledWith(fakeContext)

		// Reset for the cache-miss check
		mockOfflineListFiles.mockClear()
		mockOfflineListDirectories.mockClear()
		mockOfflineListFiles.mockResolvedValue([])
		mockOfflineListDirectories.mockResolvedValue({ directories: [], files: [] })

		// Same uuid but removed from cache — now throws not-found (no root fallback)
		cacheDirectoryUuidToAnyDirWithContext.delete("cached-uuid")

		await expect(fetchData({ path: { type: "offline", uuid: "cached-uuid" } })).rejects.toBeInstanceOf(
			DriveDirectoryNotFoundError
		)

		expect(mockOfflineListFiles).not.toHaveBeenCalled()
	})
})

// ─── fetchData drive branch — non-root uuid cache miss resolves by-uuid (Finding #22) ───

describe("fetchData — drive branch non-root uuid cache miss", () => {
	it("resolves a provided non-root uuid via getDirOptional and lists THAT dir (not root)", async () => {
		const resolvedDir = { uuid: "missed-uuid" }
		const mockRoot = vi.fn().mockReturnValue({ uuid: "root-uuid" })
		const mockGetDirOptional = vi.fn().mockResolvedValue(resolvedDir)
		const mockListDir = vi.fn().mockResolvedValue({ dirs: [], files: [] })

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				root: mockRoot,
				getDirOptional: mockGetDirOptional,
				listDir: mockListDir
			}
		})

		// uuid is provided, not the root uuid, and absent from the cache
		mockCacheRootUuid.value = "root-uuid"
		expect(cacheDirectoryUuidToAnyNormalDir.has("missed-uuid")).toBe(false)

		await fetchData({ path: { type: "drive", uuid: "missed-uuid" } })

		// Resolved by uuid…
		expect(mockGetDirOptional).toHaveBeenCalledWith("missed-uuid", undefined)

		// …and listed THAT dir, never the root. AnyNormalDir.Dir wraps the resolved
		// dir as { inner: [resolvedDir] }; the root would wrap root() instead.
		expect(mockListDir).toHaveBeenCalledTimes(1)
		const listedParent = mockListDir.mock.calls[0]![0] as { tag: string; inner: unknown[] }
		expect(listedParent.tag).toBe("Dir")
		expect(listedParent.inner[0]).toBe(resolvedDir)
		expect(mockRoot).not.toHaveBeenCalled()
	})

	it("throws DriveDirectoryNotFoundError when getDirOptional returns undefined (no silent root fallback)", async () => {
		const mockRoot = vi.fn().mockReturnValue({ uuid: "root-uuid" })
		const mockGetDirOptional = vi.fn().mockResolvedValue(undefined)
		const mockListDir = vi.fn().mockResolvedValue({ dirs: [], files: [] })

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				root: mockRoot,
				getDirOptional: mockGetDirOptional,
				listDir: mockListDir
			}
		})

		mockCacheRootUuid.value = "root-uuid"

		await expect(fetchData({ path: { type: "drive", uuid: "ghost-uuid" } })).rejects.toBeInstanceOf(DriveDirectoryNotFoundError)

		// Must NOT fall back to listing the root.
		expect(mockListDir).not.toHaveBeenCalled()
	})

	it("lists the root (no by-uuid lookup) when uuid equals cache.rootUuid", async () => {
		const mockRoot = vi.fn().mockReturnValue({ uuid: "root-uuid" })
		const mockGetDirOptional = vi.fn()
		const mockListDir = vi.fn().mockResolvedValue({ dirs: [], files: [] })

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				root: mockRoot,
				getDirOptional: mockGetDirOptional,
				listDir: mockListDir
			}
		})

		mockCacheRootUuid.value = "root-uuid"

		await fetchData({ path: { type: "drive", uuid: "root-uuid" } })

		expect(mockGetDirOptional).not.toHaveBeenCalled()
		expect(mockRoot).toHaveBeenCalled()

		const listedParent = mockListDir.mock.calls[0]![0] as { tag: string }
		expect(listedParent.tag).toBe("Root")
	})

	it("uses the cached dir without calling getDirOptional when the uuid is cached", async () => {
		const cachedNormalDir = { tag: "Dir", inner: ["cached"] }

		cacheDirectoryUuidToAnyNormalDir.set("cached-drive-uuid", cachedNormalDir)

		const mockRoot = vi.fn().mockReturnValue({ uuid: "root-uuid" })
		const mockGetDirOptional = vi.fn()
		const mockListDir = vi.fn().mockResolvedValue({ dirs: [], files: [] })

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				root: mockRoot,
				getDirOptional: mockGetDirOptional,
				listDir: mockListDir
			}
		})

		mockCacheRootUuid.value = "root-uuid"

		await fetchData({ path: { type: "drive", uuid: "cached-drive-uuid" } })

		expect(mockGetDirOptional).not.toHaveBeenCalled()
		expect(mockListDir).toHaveBeenCalledWith(cachedNormalDir, undefined)
	})
})

// ─── fetchData photos branch — dir filtering ───────────────────────────────

describe("fetchData — photos branch dir filtering", () => {
	it("returns empty when camera upload is disabled", async () => {
		mockCameraUploadGetConfig.mockResolvedValue({ enabled: false, remoteDir: null })

		const result = await fetchData({ path: { type: "photos", uuid: null } })

		expect(result).toEqual([])
	})

	it("returns empty when camera upload is enabled but remoteDir is null", async () => {
		mockCameraUploadGetConfig.mockResolvedValue({ enabled: true, remoteDir: null })

		const result = await fetchData({ path: { type: "photos", uuid: null } })

		expect(result).toEqual([])
	})

	it("filters out dirs with tag other than NonRootDir_Tags.Normal", async () => {
		const remoteDir = { inner: [{ uuid: "remote-dir-uuid-2" }] }

		mockCameraUploadGetConfig.mockResolvedValue({ enabled: true, remoteDir })

		const nonNormalDir1 = { tag: "OtherTag1", inner: [{ uuid: "other-1" }] }
		const nonNormalDir2 = { tag: "OtherTag2", inner: [{ uuid: "other-2" }] }

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listDirRecursive: vi.fn().mockResolvedValue({
					dirs: [nonNormalDir1, nonNormalDir2],
					files: []
				})
			}
		})

		vi.mocked(unwrapDirMeta).mockClear()

		await fetchData({ path: { type: "photos", uuid: null } })

		// Non-Normal dirs must be skipped so unwrapDirMeta is never called
		expect(vi.mocked(unwrapDirMeta)).not.toHaveBeenCalled()
	})

	it("includes files from photos listing regardless of dir filtering", async () => {
		const remoteDir = { inner: [{ uuid: "remote-dir-uuid-3" }] }

		mockCameraUploadGetConfig.mockResolvedValue({ enabled: true, remoteDir })

		const fileItem = { uuid: "photo-file-1", size: 100n, region: "", bucket: "", chunks: 1n, timestamp: 0n, meta: {} }

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listDirRecursive: vi.fn().mockResolvedValue({
					dirs: [],
					files: [fileItem]
				})
			}
		})

		// photos type skips dirs in post-processing so only files end up in result
		const result = await fetchData({ path: { type: "photos", uuid: null } })

		// The file should produce a DriveItem in the output
		expect(result).toHaveLength(1)
	})
})

// ─── fetchData post-processing switch: photos/recents CACHE dirs but don't DISPLAY them ───
// Finding #47: photos/recents hide directories from the rendered list, but their
// subdirectories must still be cached (so consumers like photo bulk "make available
// offline" can resolve a parent by uuid). So unwrap + cache always run; only the
// display push is suppressed.

describe("fetchData — post-processing: photos and recents cache dirs but exclude them from the list", () => {
	it("caches a dir for 'photos' (unwrap + cache populated) but does NOT push it into the items list", async () => {
		const remoteDir = { inner: [{ uuid: "remote-dir-uuid-skip" }] }

		mockCameraUploadGetConfig.mockResolvedValue({ enabled: true, remoteDir })

		// A Normal-tagged dir passes the photos fetch filter; its inner[0] reaches post-processing.
		const normalDir = {
			tag: "Normal",
			inner: [{ uuid: "dir-skip", parent: null, color: "default", timestamp: 0n, favorited: false, meta: {} }]
		}

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listDirRecursive: vi.fn().mockResolvedValue({ dirs: [normalDir], files: [] })
			}
		})

		vi.mocked(unwrapDirMeta).mockClear()

		const result = await fetchData({ path: { type: "photos", uuid: null } })

		// Dir is CACHED (unwrapped + parent-resolution maps populated)…
		expect(vi.mocked(unwrapDirMeta)).toHaveBeenCalledWith(normalDir.inner[0])
		expect(cacheDirectoryUuidToAnyNormalDir.has("dir-skip")).toBe(true)
		expect(cacheDirectoryUuidToAnyDirWithContext.has("dir-skip")).toBe(true)

		// …but NOT displayed (no directory item in the returned list).
		expect(result.some(i => (i as DriveItem).data.uuid === "dir-skip")).toBe(false)
	})

	it("caches a dir for 'recents' (unwrap + cache populated) but does NOT push it into the items list", async () => {
		const dirResult = {
			uuid: "recents-dir",
			parent: null,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { name: "Some Dir" }
		}

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listRecents: vi.fn().mockResolvedValue({ dirs: [dirResult], files: [] })
			}
		})

		vi.mocked(unwrapDirMeta).mockClear()

		const result = await fetchData({ path: { type: "recents", uuid: null } })

		// Dir is CACHED…
		expect(vi.mocked(unwrapDirMeta)).toHaveBeenCalledWith(dirResult)
		expect(cacheDirectoryUuidToAnyNormalDir.has("recents-dir")).toBe(true)
		expect(cacheDirectoryUuidToName.get("recents-dir")).toBe("Dir")

		// …but NOT displayed.
		expect(result.some(i => (i as DriveItem).data.uuid === "recents-dir")).toBe(false)
	})

	it("calls unwrapDirMeta for dirs when path type is 'drive'", async () => {
		const dirResult = {
			uuid: "drive-dir-1",
			parent: null,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: {}
		}

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listDir: vi.fn().mockResolvedValue({ dirs: [dirResult], files: [] }),
				root: vi.fn().mockReturnValue({ uuid: "root-uuid" })
			}
		})

		vi.mocked(unwrapDirMeta).mockClear()

		await fetchData({ path: { type: "drive", uuid: "" } })

		expect(vi.mocked(unwrapDirMeta)).toHaveBeenCalledWith(dirResult)
	})

	it("calls unwrapDirMeta for dirs when path type is 'trash'", async () => {
		const dirResult = {
			uuid: "trash-dir-1",
			parent: null,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: {}
		}

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listTrash: vi.fn().mockResolvedValue({ dirs: [dirResult], files: [] })
			}
		})

		vi.mocked(unwrapDirMeta).mockClear()

		await fetchData({ path: { type: "trash", uuid: null } })

		expect(vi.mocked(unwrapDirMeta)).toHaveBeenCalledWith(dirResult)
	})
})

// ─── fetchData linked WrongPassword error handling ─────────────────────────

describe("fetchData — linked WrongPassword error handling", () => {
	it("returns empty DriveItem[] when WrongPassword is thrown (does not re-throw)", async () => {
		const wrongPasswordError = new Error("wrong password")
		const mockFilenError = {
			kind: vi.fn().mockReturnValue("WrongPassword")
		}

		vi.mocked(unwrapSdkError).mockReturnValue(mockFilenError as unknown as ReturnType<typeof unwrapSdkError>)

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				getDirPublicLinkInfo: vi.fn().mockResolvedValue({
					link: {
						linkUuid: "l-uuid",
						linkKey: "key",
						linkKeyVersion: 1,
						salt: "salt",
						enableDownload: true,
						password: undefined
					},
					root: { inner: { uuid: "root-u" }, linkedTag: true }
				}),
				listLinkedDir: vi.fn().mockRejectedValue(wrongPasswordError)
			}
		})

		const result = await fetchData({
			path: {
				type: "linked",
				uuid: "",
				linked: { uuid: "link-uuid", key: "link-key", rootName: "", password: undefined }
			}
		})

		expect(result).toEqual([])
	})

	it("re-throws when run returns failure and error is not WrongPassword", async () => {
		const networkError = new Error("network error")
		const mockFilenError = {
			kind: vi.fn().mockReturnValue("Server")
		}

		vi.mocked(unwrapSdkError).mockReturnValue(mockFilenError as unknown as ReturnType<typeof unwrapSdkError>)

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				getDirPublicLinkInfo: vi.fn().mockResolvedValue({
					link: {
						linkUuid: "l-uuid",
						linkKey: "key",
						linkKeyVersion: 1,
						salt: "salt",
						enableDownload: true,
						password: undefined
					},
					root: { inner: { uuid: "root-u" }, linkedTag: true }
				}),
				listLinkedDir: vi.fn().mockRejectedValue(networkError)
			}
		})

		await expect(
			fetchData({
				path: {
					type: "linked",
					uuid: "",
					linked: { uuid: "link-uuid", key: "link-key", rootName: "", password: undefined }
				}
			})
		).rejects.toThrow("network error")
	})

	it("re-throws when unwrapSdkError returns null (non-SDK error)", async () => {
		const rawError = new Error("raw non-sdk error")

		vi.mocked(unwrapSdkError).mockReturnValue(null)

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				getDirPublicLinkInfo: vi.fn().mockResolvedValue({
					link: {
						linkUuid: "l-uuid",
						linkKey: "key",
						linkKeyVersion: 1,
						salt: "salt",
						enableDownload: true,
						password: undefined
					},
					root: { inner: { uuid: "root-u" }, linkedTag: true }
				}),
				listLinkedDir: vi.fn().mockRejectedValue(rawError)
			}
		})

		await expect(
			fetchData({
				path: {
					type: "linked",
					uuid: "",
					linked: { uuid: "link-uuid", key: "link-key", rootName: "", password: undefined }
				}
			})
		).rejects.toThrow("raw non-sdk error")
	})

	it("returns DriveItem[] when linked run succeeds", async () => {
		vi.mocked(unwrapSdkError).mockReturnValue(null)

		const fileItem = { uuid: "linked-file-1", size: 100n, region: "", bucket: "", chunks: 1n, timestamp: 0n, meta: {} }

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				getDirPublicLinkInfo: vi.fn().mockResolvedValue({
					link: {
						linkUuid: "l-uuid",
						linkKey: "key",
						linkKeyVersion: 1,
						salt: "salt",
						enableDownload: true,
						password: undefined
					},
					root: { inner: { uuid: "root-u" }, linkedTag: true }
				}),
				listLinkedDir: vi.fn().mockResolvedValue({ dirs: [], files: [fileItem] })
			}
		})

		const result = await fetchData({
			path: {
				type: "linked",
				uuid: "",
				linked: { uuid: "link-uuid", key: "link-key", rootName: "", password: undefined }
			}
		})

		expect(result).toHaveLength(1)
		// Assert the concrete item identity — the mocked unwrappedFileIntoDriveItem propagates
		// the uuid from unwrapFileMeta's file.uuid, which originates from fileItem.uuid.
		expect((result[0] as { type: string; data: { uuid: string } }).data.uuid).toBe("linked-file-1")
	})

	it("returns empty array without calling SDK when linked is undefined", async () => {
		const result = await fetchData({
			path: {
				type: "linked",
				uuid: "",
				linked: undefined
			}
		})

		expect(result).toEqual([])
	})
})

// ─── fetchData sharedIn/sharedOut sharingRole propagation ───────────────────

describe("fetchData — sharedIn/sharedOut sharingRole propagation", () => {
	it("propagates sharingRole from parent.shareInfo to each dir in sharedIn result", async () => {
		const shareInfo = { Receiver: { email: "a@b.com", id: 1 } }
		const fakeParent = { dir: { uuid: "shared-dir" }, shareInfo }

		cacheDirectoryUuidToAnySharedDirWithContext.set("shared-dir-parent", fakeParent)

		const innerDir = { uuid: "inner-dir-1" }

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listSharedDir: vi.fn().mockResolvedValue({
					dirs: [innerDir],
					files: []
				})
			}
		})

		vi.mocked(unwrapDirMeta).mockClear()

		await fetchData({ path: { type: "sharedIn", uuid: "shared-dir-parent" } })

		// unwrapDirMeta must be called with the dir that has sharingRole spread in
		expect(vi.mocked(unwrapDirMeta)).toHaveBeenCalledWith(expect.objectContaining({ uuid: "inner-dir-1", sharingRole: shareInfo }))
	})

	it("propagates sharingRole from parent.shareInfo to each file in sharedIn result", async () => {
		const shareInfo = { Sharer: { email: "owner@b.com", id: 2 } }
		const fakeParent = { dir: { uuid: "shared-dir-2" }, shareInfo }

		cacheDirectoryUuidToAnySharedDirWithContext.set("shared-file-parent", fakeParent)

		const innerFile = { uuid: "inner-file-1", size: 100n, region: "", bucket: "", chunks: 1n, timestamp: 0n, meta: {} }

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listSharedDir: vi.fn().mockResolvedValue({
					dirs: [],
					files: [innerFile]
				})
			}
		})

		await fetchData({ path: { type: "sharedIn", uuid: "shared-file-parent" } })

		expect(vi.mocked(unwrapFileMeta)).toHaveBeenCalledWith(expect.objectContaining({ uuid: "inner-file-1", sharingRole: shareInfo }))
	})

	it("calls listInSharedRoot when parent is undefined (empty uuid)", async () => {
		const mockListInSharedRoot = vi.fn().mockResolvedValue({ dirs: [], files: [] })

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listInSharedRoot: mockListInSharedRoot
			}
		})

		await fetchData({ path: { type: "sharedIn", uuid: "" } })

		expect(mockListInSharedRoot).toHaveBeenCalled()
	})

	it("populates directoryUuidToAnyNormalDir for sharedOut dirs (extra cache write)", async () => {
		const shareInfo = { Sharer: { email: "owner@c.com", id: 3 } }
		const fakeParent = { dir: { uuid: "shared-out-dir" }, shareInfo }

		cacheDirectoryUuidToAnySharedDirWithContext.set("sharedout-parent", fakeParent)

		const innerDir = { uuid: "inner-sharedout-dir", inner: { uuid: "inner-sharedout-dir" } }

		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				listSharedDir: vi.fn().mockResolvedValue({ dirs: [innerDir], files: [] })
			}
		})

		vi.mocked(unwrapDirMeta).mockImplementation(
			(dir: unknown) =>
				({
					uuid: "inner-sharedout-dir",
					meta: { name: "SharedOutDir" },
					shared: true,
					linked: false,
					root: false,
					dir
				}) as unknown as UnwrapDirMetaResult
		)

		await fetchData({ path: { type: "sharedOut", uuid: "sharedout-parent" } })

		expect(cacheDirectoryUuidToAnyNormalDir.has("inner-sharedout-dir")).toBe(true)
	})
})

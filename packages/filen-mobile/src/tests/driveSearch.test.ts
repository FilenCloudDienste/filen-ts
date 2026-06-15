import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => {
	const configureCache = vi.fn()
	const getSdkClients = vi.fn(async () => ({
		authedSdkClient: { configureCache, root: () => ({ uuid: "root-uuid" }) }
	}))
	const createFn = vi.fn()

	return {
		configureCache,
		getSdkClients,
		createFn,
		listHolder: { items: [] as { name: string; delete: () => void }[] },
		errorHolder: { inner: null as { kind: () => string } | null }
	}
})

vi.mock("@filen/sdk-rs", () => ({
	CacheStatusMessage_Tags: { Errors: "Errors", SyncRootsDeleted: "SyncRootsDeleted", ResyncProgress: "ResyncProgress" },
	ResyncProgressMessage_Tags: { Started: "Started", Listing: "Listing", Applying: "Applying", Finished: "Finished" },
	ErrorKind: { InvalidState: "InvalidState" },
	FilenSdkError: {
		hasInner: () => mocks.errorHolder.inner !== null,
		getInner: () => mocks.errorHolder.inner
	}
}))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: mocks.getSdkClients } }))
vi.mock("@/lib/paths", () => ({ normalizeFilePathForSdk: (p: string) => p }))
vi.mock("@/lib/storageRoots", () => ({
	SDK_CACHE_DIRECTORY: { exists: false, create: mocks.createFn },
	SDK_CACHE_PARENT_DIRECTORY: { exists: true, list: () => mocks.listHolder.items },
	SDK_CACHE_DB_FILE: { uri: "file:///sdkCache/v1/cache.db" },
	SDK_CACHE_VERSION: 1
}))

import { DriveSearch } from "@/features/drive/driveSearch"
import { useDriveSearchStore } from "@/features/drive/store/useDriveSearch.store"

describe("driveSearch.init", () => {
	beforeEach(() => {
		mocks.configureCache.mockReset()
		mocks.getSdkClients.mockClear()
		mocks.createFn.mockReset()
		mocks.listHolder.items = []
		mocks.errorHolder.inner = null
		useDriveSearchStore.setState({ resyncing: false, rootDeleted: false, cacheUnavailable: false })
	})

	it("configures the cache once across repeated init", async () => {
		const ds = new DriveSearch()

		await ds.init()
		await ds.init()

		expect(mocks.configureCache).toHaveBeenCalledTimes(1)
		expect(mocks.configureCache).toHaveBeenCalledWith("file:///sdkCache/v1/cache.db", expect.anything())
	})

	it("creates the cache directory when missing", async () => {
		const ds = new DriveSearch()

		await ds.init()

		expect(mocks.createFn).toHaveBeenCalledWith({ idempotent: true, intermediates: true })
	})

	it("swallows InvalidState (a worker is already live)", async () => {
		mocks.configureCache.mockRejectedValueOnce(new Error("boom"))
		mocks.errorHolder.inner = { kind: () => "InvalidState" }

		const ds = new DriveSearch()

		await expect(ds.init()).resolves.toBeUndefined()
		expect(useDriveSearchStore.getState().cacheUnavailable).toBe(false)
	})

	it("marks the cache unavailable on a non-InvalidState failure", async () => {
		mocks.configureCache.mockRejectedValueOnce(new Error("io"))
		mocks.errorHolder.inner = { kind: () => "Io" }

		const ds = new DriveSearch()

		await ds.init()

		expect(useDriveSearchStore.getState().cacheUnavailable).toBe(true)
	})

	it("sweeps stale cache versions, keeping the current one", async () => {
		const staleDelete = vi.fn()
		const currentDelete = vi.fn()
		mocks.listHolder.items = [
			{ name: "v0", delete: staleDelete },
			{ name: "v1", delete: currentDelete }
		]

		const ds = new DriveSearch()

		await ds.init()

		expect(staleDelete).toHaveBeenCalledTimes(1)
		expect(currentDelete).not.toHaveBeenCalled()
	})
})

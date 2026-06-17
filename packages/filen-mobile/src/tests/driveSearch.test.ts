import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const mocks = vi.hoisted(() => {
	const configureCache = vi.fn()
	const createSearch = vi.fn()
	const getSdkClients = vi.fn(async () => ({
		authedSdkClient: { configureCache, createSearch, root: () => ({ uuid: "root-uuid" }) }
	}))
	const createFn = vi.fn()

	return {
		configureCache,
		createSearch,
		getSdkClients,
		createFn,
		deleteDirFn: vi.fn(),
		dirHolder: { exists: false },
		listHolder: { items: [] as { name: string; delete: () => void }[] },
		errorHolder: { inner: null as { kind: () => string } | null }
	}
})

vi.mock("@filen/sdk-rs", () => ({
	CacheStatusMessage_Tags: { Errors: "Errors", SyncRootsDeleted: "SyncRootsDeleted", ResyncProgress: "ResyncProgress" },
	ResyncProgressMessage_Tags: { Started: "Started", Listing: "Listing", Applying: "Applying", Finished: "Finished" },
	CacheSearchItemType: { All: 0, File: 1, Dir: 2 },
	ErrorKind: { InvalidState: "InvalidState" },
	FilenSdkError: {
		hasInner: () => mocks.errorHolder.inner !== null,
		getInner: () => mocks.errorHolder.inner
	}
}))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: mocks.getSdkClients } }))
vi.mock("@/lib/paths", () => ({ normalizeFilePathForSdk: (p: string) => p }))
vi.mock("@/lib/storageRoots", () => ({
	SDK_CACHE_DIRECTORY: {
		get exists() {
			return mocks.dirHolder.exists
		},
		create: mocks.createFn,
		delete: mocks.deleteDirFn
	},
	SDK_CACHE_PARENT_DIRECTORY: { exists: true, list: () => mocks.listHolder.items },
	SDK_CACHE_DB_FILE: { uri: "file:///sdkCache/v1/cache.db" },
	SDK_CACHE_VERSION: 1
}))

import { DriveSearch } from "@/features/drive/driveSearch"
import { useDriveSearchStore } from "@/features/drive/store/useDriveSearch.store"

function makeFakeSearch() {
	const uniffiDestroy = vi.fn()
	const snapshot = { results: [], total: 0n, live: true }
	const close = vi.fn(async () => {})
	const setConfig = vi.fn(async () => {})
	const getRange = vi.fn(async () => ({ snapshot, handle: { uniffiDestroy } }))

	return {
		search: { close, setConfig, getRange, isLive: vi.fn(async () => true), rootUuid: () => "x", total: vi.fn(async () => 0n) },
		close,
		setConfig,
		getRange,
		uniffiDestroy,
		snapshot
	}
}

const signal = () => new AbortController().signal

beforeEach(() => {
	mocks.configureCache.mockReset()
	mocks.createSearch.mockReset()
	mocks.getSdkClients.mockClear()
	mocks.createFn.mockReset()
	mocks.deleteDirFn.mockReset()
	mocks.dirHolder.exists = false
	mocks.listHolder.items = []
	mocks.errorHolder.inner = null
	useDriveSearchStore.setState({ resyncing: false, rootDeleted: false, cacheUnavailable: false, resyncProgress: 0 })
})

describe("driveSearch.init", () => {
	it("configures the cache once across repeated init", async () => {
		const ds = new DriveSearch()

		await ds.init()
		await ds.init()

		expect(mocks.configureCache).toHaveBeenCalledTimes(1)
		expect(mocks.configureCache).toHaveBeenCalledWith("file:///sdkCache/v1/cache.db", expect.anything())
	})

	it("creates the cache directory when missing", async () => {
		await new DriveSearch().init()

		expect(mocks.createFn).toHaveBeenCalledWith({ idempotent: true, intermediates: true })
	})

	it("swallows InvalidState (a worker is already live)", async () => {
		mocks.configureCache.mockRejectedValueOnce(new Error("boom"))
		mocks.errorHolder.inner = { kind: () => "InvalidState" }

		await expect(new DriveSearch().init()).resolves.toBeUndefined()
		expect(useDriveSearchStore.getState().cacheUnavailable).toBe(false)
	})

	it("marks the cache unavailable on a non-InvalidState failure", async () => {
		mocks.configureCache.mockRejectedValueOnce(new Error("io"))
		mocks.errorHolder.inner = { kind: () => "Io" }

		await new DriveSearch().init()

		expect(useDriveSearchStore.getState().cacheUnavailable).toBe(true)
	})

	it("sweeps stale cache versions, keeping the current one", async () => {
		const staleDelete = vi.fn()
		const currentDelete = vi.fn()
		mocks.listHolder.items = [
			{ name: "v0", delete: staleDelete },
			{ name: "v1", delete: currentDelete }
		]

		await new DriveSearch().init()

		expect(staleDelete).toHaveBeenCalledTimes(1)
		expect(currentDelete).not.toHaveBeenCalled()
	})
})

describe("driveSearch lifecycle", () => {
	it("opens a search and delivers the initial snapshot via one getRange(0, CEILING)", async () => {
		const fake = makeFakeSearch()
		mocks.createSearch.mockResolvedValueOnce(fake.search)
		const onSnapshot = vi.fn()

		await new DriveSearch().open({ rootUuid: "dir-uuid", name: "report", onSnapshot, signal: signal() })

		expect(mocks.createSearch).toHaveBeenCalledWith(
			"dir-uuid",
			{ name: "report", itemType: 0, recursive: true, caseSensitive: false },
			{ signal: expect.anything() }
		)
		expect(fake.getRange).toHaveBeenCalledWith(0n, 1000n, expect.anything(), { signal: expect.anything() })
		expect(onSnapshot).toHaveBeenCalledWith(fake.snapshot)
	})

	it("resolves the account root when rootUuid is null", async () => {
		const fake = makeFakeSearch()
		mocks.createSearch.mockResolvedValueOnce(fake.search)

		await new DriveSearch().open({ rootUuid: null, name: "x", onSnapshot: vi.fn(), signal: signal() })

		expect(mocks.createSearch).toHaveBeenCalledWith("root-uuid", expect.anything(), expect.anything())
	})

	it("forwards Listing/Applying resync progress as a liveness heartbeat while a search is active", async () => {
		const fake = makeFakeSearch()
		mocks.createSearch.mockResolvedValueOnce(fake.search)
		const ds = new DriveSearch()

		// open() triggers init() -> configureCache(dbPath, statusListener); grab the listener.
		await ds.open({ rootUuid: "dir", name: "x", onSnapshot: vi.fn(), signal: signal() })

		const status = mocks.configureCache.mock.calls[0]?.[1] as { onMessages: (m: unknown[]) => void }
		const before = useDriveSearchStore.getState().resyncProgress

		status.onMessages([{ tag: "ResyncProgress", inner: { progress: { tag: "Listing" } } }])
		status.onMessages([{ tag: "ResyncProgress", inner: { progress: { tag: "Applying" } } }])

		// Both ticks bump the heartbeat the hook's watchdog + stall timers re-arm on.
		expect(useDriveSearchStore.getState().resyncProgress).toBe(before + 2)
	})

	it("re-filters via setConfig", async () => {
		const fake = makeFakeSearch()
		mocks.createSearch.mockResolvedValueOnce(fake.search)
		const ds = new DriveSearch()

		await ds.open({ rootUuid: "dir", name: "a", onSnapshot: vi.fn(), signal: signal() })
		await ds.setName("ab")

		expect(fake.setConfig).toHaveBeenCalledWith({ name: "ab", itemType: 0, recursive: true, caseSensitive: false })
	})

	it("closeActive closes the search and destroys the window handle", async () => {
		const fake = makeFakeSearch()
		mocks.createSearch.mockResolvedValueOnce(fake.search)
		const ds = new DriveSearch()

		await ds.open({ rootUuid: "dir", name: "a", onSnapshot: vi.fn(), signal: signal() })
		await ds.closeActive()

		expect(fake.close).toHaveBeenCalledTimes(1)
		expect(fake.uniffiDestroy).toHaveBeenCalledTimes(1)
	})

	it("teardownOnLogout closes the active search, destroys the handle, and deletes the cache dir", async () => {
		const fake = makeFakeSearch()
		mocks.createSearch.mockResolvedValueOnce(fake.search)
		mocks.dirHolder.exists = true
		const ds = new DriveSearch()

		await ds.open({ rootUuid: "dir", name: "a", onSnapshot: vi.fn(), signal: signal() })
		await ds.teardownOnLogout()

		// MUST close the live search (releasing the worker's socket listener) BEFORE the authed
		// client is destroyed by the logout flow, then wipe the decrypted-at-rest cache DB.
		expect(fake.close).toHaveBeenCalledTimes(1)
		expect(fake.uniffiDestroy).toHaveBeenCalledTimes(1)
		expect(mocks.deleteDirFn).toHaveBeenCalledTimes(1)
	})

	it("closes the orphan when superseded during createSearch (no install, no snapshot)", async () => {
		let resolveCreate: ((s: unknown) => void) | undefined
		mocks.createSearch.mockReturnValueOnce(
			new Promise(resolve => {
				resolveCreate = resolve
			})
		)
		const fake = makeFakeSearch()
		const onSnapshot = vi.fn()
		const ds = new DriveSearch()

		const openPromise = ds.open({ rootUuid: "dir", name: "x", onSnapshot, signal: signal() })

		// Let doOpen advance past getSdkClients into the (still-pending) createSearch await.
		await new Promise(resolve => setTimeout(resolve, 0))

		await ds.closeActive()

		resolveCreate?.(fake.search)
		await openPromise

		expect(mocks.createSearch).toHaveBeenCalledTimes(1)
		expect(fake.getRange).not.toHaveBeenCalled()
		expect(onSnapshot).not.toHaveBeenCalled()
		expect(fake.close).toHaveBeenCalledTimes(1)
	})
})

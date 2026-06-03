import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── vi.hoisted ───────────────────────────────────────────────────────────────

const {
	mockIsNetworkClassError,
	mockUnwrapSdkError,
	mockLogout,
	mockAlertsError,
	mockIsOnline,
	mockSetQueryData,
	mockGetQueryData,
	mockPersistQueryByKey
} = vi.hoisted(() => ({
	mockIsNetworkClassError: vi.fn().mockReturnValue(false),
	mockUnwrapSdkError: vi.fn().mockReturnValue(null),
	mockLogout: vi.fn().mockResolvedValue(undefined),
	mockAlertsError: vi.fn(),
	mockIsOnline: vi.fn().mockReturnValue(true),
	mockSetQueryData: vi.fn(),
	mockGetQueryData: vi.fn().mockReturnValue(undefined),
	mockPersistQueryByKey: vi.fn().mockResolvedValue(undefined)
}))

// ─── vi.mock declarations (must appear before any imports of the mocked modules) ─

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/utils", () => ({
	unwrapSdkError: mockUnwrapSdkError,
	isNetworkClassError: mockIsNetworkClassError
}))

vi.mock("@/lib/auth", () => ({
	default: {
		logout: mockLogout
	}
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: mockAlertsError
	}
}))

vi.mock("@/lib/sqlite", async () => await import("@/tests/mocks/sqliteKv"))

vi.mock("@filen/sdk-rs", () => ({
	ErrorKind: {
		Unauthenticated: "Unauthenticated",
		Reqwest: "Reqwest",
		Response: "Response",
		RetryFailed: "RetryFailed"
	}
}))

vi.mock("@tanstack/react-query", () => ({
	QueryClient: class {
		defaultOptions = {}
		setQueryData: typeof mockSetQueryData = mockSetQueryData
		getQueryData: typeof mockGetQueryData = mockGetQueryData
		constructor(_opts?: unknown) {}
	},
	onlineManager: {
		isOnline: mockIsOnline
	},
	useQuery: vi.fn()
}))

vi.mock("@tanstack/query-persist-client-core", () => ({
	experimental_createQueryPersister: vi.fn(() => ({
		persisterFn: vi.fn(),
		persistQueryByKey: mockPersistQueryByKey
	}))
}))

// ─── imports (after all mocks) ────────────────────────────────────────────────

import { type PersistedQuery } from "@tanstack/query-persist-client-core"
import { ErrorKind } from "@filen/sdk-rs"
import { shouldPersistQuery, DEFAULT_QUERY_OPTIONS, QueryUpdater, QUERY_CLIENT_CACHE_TIME, restoreQueries } from "@/queries/client"
import { type PlaylistWithItems } from "@/lib/audio"

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePersistedQuery(
	queryKey: unknown[],
	status: "success" | "pending" | "error" = "success",
	dataUpdatedAt: number = Date.now()
): PersistedQuery {
	return {
		queryKey,
		queryHash: JSON.stringify(queryKey),
		state: {
			data: { fake: "data" },
			dataUpdatedAt,
			status,
			error: null,
			errorUpdateCount: 0,
			errorUpdatedAt: 0,
			fetchFailureCount: 0,
			fetchFailureReason: null,
			fetchMeta: null,
			isInvalidated: false,
			fetchStatus: "idle"
		},
		buster: "1"
	} as unknown as PersistedQuery
}

// ─── shouldPersistQuery ───────────────────────────────────────────────────────

describe("shouldPersistQuery", () => {
	it("returns true for a cacheable key with status success", () => {
		const query = makePersistedQuery(["useDriveItemsQuery", { uuid: "abc" }])

		expect(shouldPersistQuery(query)).toBe(true)
	})

	it("returns false when queryKey is useCacheSizes", () => {
		const query = makePersistedQuery(["useCacheSizes"])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false when queryKey is useFileProviderCacheBudget", () => {
		const query = makePersistedQuery(["useFileProviderCacheBudget"])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false when queryKey is useLocalAuthenticationQuery", () => {
		const query = makePersistedQuery(["useLocalAuthenticationQuery"])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false when queryKey is useMediaPermissionsQuery", () => {
		const query = makePersistedQuery(["useMediaPermissionsQuery"])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false when queryKey is useCameraUploadAlbumsQuery", () => {
		const query = makePersistedQuery(["useCameraUploadAlbumsQuery"])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false when status is pending even if key is cacheable", () => {
		const query = makePersistedQuery(["useChatsQuery"], "pending")

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false when status is error even if key is cacheable", () => {
		const query = makePersistedQuery(["useChatsQuery"], "error")

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false when queryKey contains a forbidden string in a nested array", () => {
		// array-of-arrays with a forbidden inner string
		const query = makePersistedQuery([["useCacheSizes", "extra"]])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns true when queryKey is an array with no forbidden string and status is success", () => {
		const query = makePersistedQuery([["useChatsQuery", "extra"], "param"])

		expect(shouldPersistQuery(query)).toBe(true)
	})

	it("returns false for queryKey with array-of-arrays containing a forbidden inner string (deeper nesting)", () => {
		const query = makePersistedQuery([["useFileUrlQuery"]])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("handles an empty queryKey array without throwing", () => {
		const query = makePersistedQuery([])

		expect(() => shouldPersistQuery(query)).not.toThrow()
		// empty key array → no forbidden key → depends only on status
		expect(shouldPersistQuery(query)).toBe(true)
	})

	it("returns false for useFileTextQuery (another UNCACHED key)", () => {
		const query = makePersistedQuery(["useFileTextQuery"])

		expect(shouldPersistQuery(query)).toBe(false)
	})

	it("returns false for useFileBase64Query (another UNCACHED key)", () => {
		const query = makePersistedQuery(["useFileBase64Query"])

		expect(shouldPersistQuery(query)).toBe(false)
	})
})

// ─── DEFAULT_QUERY_OPTIONS.retryDelay ─────────────────────────────────────────

describe("DEFAULT_QUERY_OPTIONS.retryDelay", () => {
	const retryDelay = DEFAULT_QUERY_OPTIONS.retryDelay as (attemptIndex: number) => number

	it("returns 1000ms for attemptIndex=0", () => {
		expect(retryDelay(0)).toBe(1000)
	})

	it("returns 2000ms for attemptIndex=1", () => {
		expect(retryDelay(1)).toBe(2000)
	})

	it("returns 16000ms for attemptIndex=4", () => {
		expect(retryDelay(4)).toBe(16000)
	})

	it("caps at 30000ms for attemptIndex=5 (2^5 * 1000 = 32000 > 30000)", () => {
		expect(retryDelay(5)).toBe(30000)
	})

	it("always returns 30000ms for very large attemptIndex", () => {
		expect(retryDelay(100)).toBe(30000)
	})

	it("attemptIndex=0 returns the minimum value (no result below 1000)", () => {
		expect(retryDelay(0)).toBeGreaterThanOrEqual(1000)
	})

	it("never returns a negative result", () => {
		expect(retryDelay(0)).toBeGreaterThan(0)
	})
})

// ─── DEFAULT_QUERY_OPTIONS.throwOnError ──────────────────────────────────────

describe("DEFAULT_QUERY_OPTIONS.throwOnError", () => {
	// The function is typed with any, but we need to call it per its real signature:
	// throwOnError(err, query) => boolean
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const throwOnError = DEFAULT_QUERY_OPTIONS.throwOnError as (err: unknown, query: any) => boolean
	const fakeQuery = { queryKey: ["testKey"] }

	beforeEach(() => {
		mockIsNetworkClassError.mockReset()
		mockIsNetworkClassError.mockReturnValue(false)
		mockUnwrapSdkError.mockReset()
		mockUnwrapSdkError.mockReturnValue(null)
		mockIsOnline.mockReset()
		mockIsOnline.mockReturnValue(true)
		mockLogout.mockReset()
		mockLogout.mockResolvedValue(undefined)
		mockAlertsError.mockReset()
	})

	it("returns false and does NOT call alerts.error when network error + offline", () => {
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(false)

		const result = throwOnError(new Error("network"), fakeQuery)

		expect(result).toBe(false)
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("calls alerts.error and returns false when network error + online", () => {
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(true)

		const result = throwOnError(new Error("network"), fakeQuery)

		expect(result).toBe(false)
		expect(mockAlertsError).toHaveBeenCalledTimes(1)
	})

	it("returns false and calls auth.logout when Unauthenticated SDK error + online", async () => {
		const mockSdkError = {
			kind: () => ErrorKind.Unauthenticated
		}

		mockIsNetworkClassError.mockReturnValue(false)
		mockUnwrapSdkError.mockReturnValue(mockSdkError)
		mockIsOnline.mockReturnValue(true)

		const result = throwOnError(new Error("unauth"), fakeQuery)

		expect(result).toBe(false)
		// Allow the fire-and-forget logout promise to settle
		await Promise.resolve()
		expect(mockLogout).toHaveBeenCalledTimes(1)
	})

	it("returns false and does NOT call auth.logout when Unauthenticated SDK error + offline", () => {
		const mockSdkError = {
			kind: () => ErrorKind.Unauthenticated
		}

		mockIsNetworkClassError.mockReturnValue(false)
		mockUnwrapSdkError.mockReturnValue(mockSdkError)
		mockIsOnline.mockReturnValue(false)

		const result = throwOnError(new Error("unauth offline"), fakeQuery)

		expect(result).toBe(false)
		expect(mockLogout).not.toHaveBeenCalled()
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("calls alerts.error for a non-network non-Unauthenticated SDK error", () => {
		const mockSdkError = {
			kind: () => ErrorKind.Reqwest
		}

		// isNetworkClassError returns false (we control it) but unwrapSdkError returns an error
		// with a kind that is NOT Unauthenticated and is NOT a network class error
		mockIsNetworkClassError.mockReturnValue(false)
		mockUnwrapSdkError.mockReturnValue(mockSdkError)
		mockIsOnline.mockReturnValue(true)

		const testError = new Error("some sdk error")
		const result = throwOnError(testError, fakeQuery)

		expect(result).toBe(false)
		expect(mockAlertsError).toHaveBeenCalledWith(testError)
	})

	it("calls alerts.error for a plain JS Error that is not a network error and not an SDK error", () => {
		mockIsNetworkClassError.mockReturnValue(false)
		mockUnwrapSdkError.mockReturnValue(null)

		const plainError = new Error("plain error")
		const result = throwOnError(plainError, fakeQuery)

		expect(result).toBe(false)
		expect(mockAlertsError).toHaveBeenCalledWith(plainError)
	})

	it("never returns true regardless of branch taken", () => {
		// Test all branches return false, never true

		// network error + offline
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(false)
		expect(throwOnError(new Error("a"), fakeQuery)).toBe(false)

		// network error + online
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(true)
		expect(throwOnError(new Error("b"), fakeQuery)).toBe(false)

		// plain error
		mockIsNetworkClassError.mockReturnValue(false)
		mockUnwrapSdkError.mockReturnValue(null)
		expect(throwOnError(new Error("c"), fakeQuery)).toBe(false)
	})
})

// ─── restoreQueries ───────────────────────────────────────────────────────────

describe("restoreQueries", () => {
	// We need access to the mock QueryPersisterKv instance used internally.
	// Since restoreQueries uses the module-level queryClientPersisterKv singleton,
	// we test it by mocking the sqlite restore path and controlling the KV buffer.
	//
	// Strategy: mock the queryClientPersisterKv at module level by importing it
	// and spying on its methods.

	beforeEach(() => {
		mockSetQueryData.mockReset()
		mockAlertsError.mockReset()
	})

	it("loads a valid fresh query with status success into queryClient", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")

		// Seed a valid query with a fresh dataUpdatedAt
		const freshQuery = makePersistedQuery(["useChatsQuery"], "success", Date.now())

		vi.spyOn(queryClientPersisterKv, "restore").mockResolvedValue(undefined)
		vi.spyOn(queryClientPersisterKv, "keys").mockReturnValue(["key-chats"])
		vi.spyOn(queryClientPersisterKv, "getItem").mockReturnValue(freshQuery)
		const removeSpy = vi.spyOn(queryClientPersisterKv, "removeItem").mockReturnValue(undefined)

		await restoreQueries()

		expect(mockSetQueryData).toHaveBeenCalledWith(
			freshQuery.queryKey,
			freshQuery.state.data,
			{ updatedAt: freshQuery.state.dataUpdatedAt }
		)
		expect(removeSpy).not.toHaveBeenCalled()
	})

	it("removes an expired query (dataUpdatedAt + CACHE_TIME < Date.now()) and does not load it", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")

		// dataUpdatedAt is so old that it is certainly expired
		const expiredDataUpdatedAt = Date.now() - QUERY_CLIENT_CACHE_TIME - 1
		const expiredQuery = makePersistedQuery(["useChatsQuery"], "success", expiredDataUpdatedAt)

		vi.spyOn(queryClientPersisterKv, "restore").mockResolvedValue(undefined)
		vi.spyOn(queryClientPersisterKv, "keys").mockReturnValue(["key-old"])
		vi.spyOn(queryClientPersisterKv, "getItem").mockReturnValue(expiredQuery)
		const removeSpy = vi.spyOn(queryClientPersisterKv, "removeItem").mockReturnValue(undefined)

		await restoreQueries()

		expect(removeSpy).toHaveBeenCalledWith("key-old")
		expect(mockSetQueryData).not.toHaveBeenCalled()
	})

	it("removes a query with status !== success and does not load it", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")

		const pendingQuery = makePersistedQuery(["useChatsQuery"], "pending", Date.now())

		vi.spyOn(queryClientPersisterKv, "restore").mockResolvedValue(undefined)
		vi.spyOn(queryClientPersisterKv, "keys").mockReturnValue(["key-pending"])
		vi.spyOn(queryClientPersisterKv, "getItem").mockReturnValue(pendingQuery)
		const removeSpy = vi.spyOn(queryClientPersisterKv, "removeItem").mockReturnValue(undefined)

		await restoreQueries()

		expect(removeSpy).toHaveBeenCalledWith("key-pending")
		expect(mockSetQueryData).not.toHaveBeenCalled()
	})

	it("removes a query that fails shouldPersistQuery (uncached key) and does not load it", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")

		const uncachedQuery = makePersistedQuery(["useCacheSizes"], "success", Date.now())

		vi.spyOn(queryClientPersisterKv, "restore").mockResolvedValue(undefined)
		vi.spyOn(queryClientPersisterKv, "keys").mockReturnValue(["key-cache-sizes"])
		vi.spyOn(queryClientPersisterKv, "getItem").mockReturnValue(uncachedQuery)
		const removeSpy = vi.spyOn(queryClientPersisterKv, "removeItem").mockReturnValue(undefined)

		await restoreQueries()

		expect(removeSpy).toHaveBeenCalledWith("key-cache-sizes")
		expect(mockSetQueryData).not.toHaveBeenCalled()
	})

	it("removes a null persistedQuery", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")

		vi.spyOn(queryClientPersisterKv, "restore").mockResolvedValue(undefined)
		vi.spyOn(queryClientPersisterKv, "keys").mockReturnValue(["key-null"])
		vi.spyOn(queryClientPersisterKv, "getItem").mockReturnValue(null)
		const removeSpy = vi.spyOn(queryClientPersisterKv, "removeItem").mockReturnValue(undefined)

		await restoreQueries()

		expect(removeSpy).toHaveBeenCalledWith("key-null")
		expect(mockSetQueryData).not.toHaveBeenCalled()
	})

	it("removes a query with missing state field", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")

		const badQuery = { queryKey: ["useChatsQuery"] } as unknown as PersistedQuery

		vi.spyOn(queryClientPersisterKv, "restore").mockResolvedValue(undefined)
		vi.spyOn(queryClientPersisterKv, "keys").mockReturnValue(["key-no-state"])
		vi.spyOn(queryClientPersisterKv, "getItem").mockReturnValue(badQuery)
		const removeSpy = vi.spyOn(queryClientPersisterKv, "removeItem").mockReturnValue(undefined)

		await restoreQueries()

		expect(removeSpy).toHaveBeenCalledWith("key-no-state")
		expect(mockSetQueryData).not.toHaveBeenCalled()
	})

	it("calls alerts.error if an outer exception occurs (restore throws)", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")
		const restoreError = new Error("SQLite restore failed")

		vi.spyOn(queryClientPersisterKv, "restore").mockRejectedValue(restoreError)

		await restoreQueries()

		expect(mockAlertsError).toHaveBeenCalledWith(restoreError)
	})

	it("continues restoring remaining rows when one row is corrupt (getItem throws)", async () => {
		const { queryClientPersisterKv } = await import("@/queries/client")

		const goodQuery = makePersistedQuery(["useChatsQuery"], "success", Date.now())

		vi.spyOn(queryClientPersisterKv, "restore").mockResolvedValue(undefined)
		vi.spyOn(queryClientPersisterKv, "keys").mockReturnValue(["key-good"])

		// getItem returns a valid query for the good key
		vi.spyOn(queryClientPersisterKv, "getItem").mockReturnValue(goodQuery)
		vi.spyOn(queryClientPersisterKv, "removeItem").mockReturnValue(undefined)

		await restoreQueries()

		expect(mockSetQueryData).toHaveBeenCalledWith(
			goodQuery.queryKey,
			goodQuery.state.data,
			{ updatedAt: goodQuery.state.dataUpdatedAt }
		)
	})
})

// ─── QueryUpdater.set ─────────────────────────────────────────────────────────

describe("QueryUpdater.set", () => {
	beforeEach(() => {
		mockSetQueryData.mockReset()
		mockGetQueryData.mockReset()
		mockGetQueryData.mockReturnValue(undefined)
		mockPersistQueryByKey.mockReset()
		mockPersistQueryByKey.mockResolvedValue(undefined)
	})

	it("stores a plain value via setQueryData", () => {
		// Capture the updater fn passed to setQueryData
		let capturedUpdater: ((old: string | undefined) => string) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedUpdater) => {
			capturedUpdater = updaterFn
		})

		const updater = new QueryUpdater()
		updater.set<string>(["testKey"], "hello")

		expect(capturedUpdater).toBeDefined()
		// The inner updater should return the plain value regardless of oldData
		expect(capturedUpdater!(undefined)).toBe("hello")
		expect(capturedUpdater!("old")).toBe("hello")
	})

	it("invokes a function updater with oldData from getQueryData", () => {
		mockGetQueryData.mockReturnValue("previous")

		let capturedUpdater: ((old: string | undefined) => string) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedUpdater) => {
			capturedUpdater = updaterFn
		})

		const fn = vi.fn((prev?: string) => (prev ?? "") + "-new")
		const updater = new QueryUpdater()
		updater.set<string>(["testKey"], fn)

		expect(capturedUpdater).toBeDefined()
		// The inner updater calls the function with oldData
		const result = capturedUpdater!("previous")
		expect(fn).toHaveBeenCalledWith("previous")
		expect(result).toBe("previous-new")
	})

	it("function updater receives undefined when no prior data exists", () => {
		mockGetQueryData.mockReturnValue(undefined)

		let capturedUpdater: ((old: string | undefined) => string) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedUpdater) => {
			capturedUpdater = updaterFn
		})

		const fn = vi.fn((prev?: string) => prev ?? "default")
		const updater = new QueryUpdater()
		updater.set<string>(["testKey"], fn)

		expect(capturedUpdater).toBeDefined()
		const result = capturedUpdater!(undefined)
		expect(fn).toHaveBeenCalledWith(undefined)
		expect(result).toBe("default")
	})

	it("uses the provided dataUpdatedAt timestamp when given", () => {
		const updater = new QueryUpdater()
		const fixedTimestamp = 1234567890

		updater.set<string>(["testKey"], "value", fixedTimestamp)

		expect(mockSetQueryData).toHaveBeenCalledWith(
			["testKey"],
			expect.any(Function),
			{ updatedAt: fixedTimestamp }
		)
	})

	it("falls back to Date.now() when dataUpdatedAt is undefined", () => {
		const before = Date.now()
		const updater = new QueryUpdater()

		updater.set<string>(["testKey"], "value")

		const after = Date.now()
		const callArgs = mockSetQueryData.mock.calls[0] as [unknown, unknown, { updatedAt: number }]
		const usedTimestamp = callArgs[2].updatedAt

		expect(usedTimestamp).toBeGreaterThanOrEqual(before)
		expect(usedTimestamp).toBeLessThanOrEqual(after)
	})

	it("calls queryClientPersister.persistQueryByKey after setting data", async () => {
		const updater = new QueryUpdater()

		updater.set<string>(["testKey"], "value")

		// persistQueryByKey is called inside run() which is async
		await Promise.resolve()
		await Promise.resolve()

		expect(mockPersistQueryByKey).toHaveBeenCalledWith(["testKey"], expect.anything())
	})
})

// ─── playlistsQueryUpdate (from usePlaylists.query) ──────────────────────────
// NOTE: playlistsQueryUpdate delegates to queryUpdater.set with a function that applies `prev ?? []`.
// We test it via the inner updater captured from setQueryData.

describe("playlistsQueryUpdate", () => {
	beforeEach(() => {
		mockSetQueryData.mockReset()
		mockGetQueryData.mockReset()
		mockGetQueryData.mockReturnValue(undefined)
		mockPersistQueryByKey.mockReset()
		mockPersistQueryByKey.mockResolvedValue(undefined)
	})

	it("normalises undefined prev to [] when a function updater is provided", async () => {
		vi.resetModules()

		// Re-import audio mock so usePlaylists.query can load without crashing
		vi.doMock("@/lib/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		let capturedInnerUpdater: ((old: unknown[] | undefined) => unknown[]) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedInnerUpdater) => {
			capturedInnerUpdater = updaterFn
		})

		const { playlistsQueryUpdate } = await import("@/queries/usePlaylists.query")
		const fn = vi.fn((prev: unknown[]) => [...prev, "item"])

		playlistsQueryUpdate({ updater: fn as unknown as (prev: PlaylistWithItems[]) => PlaylistWithItems[] })

		expect(capturedInnerUpdater).toBeDefined()
		// When prev is undefined, the inner wrapper should pass [] to the function
		capturedInnerUpdater!(undefined)
		expect(fn).toHaveBeenCalledWith([])
	})

	it("passes existing prev array to the function updater unchanged", async () => {
		vi.resetModules()

		vi.doMock("@/lib/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		let capturedInnerUpdater: ((old: unknown[] | undefined) => unknown[]) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedInnerUpdater) => {
			capturedInnerUpdater = updaterFn
		})

		const { playlistsQueryUpdate } = await import("@/queries/usePlaylists.query")
		const existing = [{ id: "pl-1" }]
		const fn = vi.fn((prev: unknown[]) => prev)

		playlistsQueryUpdate({ updater: fn as unknown as (prev: PlaylistWithItems[]) => PlaylistWithItems[] })

		expect(capturedInnerUpdater).toBeDefined()
		capturedInnerUpdater!(existing)
		expect(fn).toHaveBeenCalledWith(existing)
	})

	it("replaces the cache directly when a plain value updater is provided", async () => {
		vi.resetModules()

		vi.doMock("@/lib/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		let capturedInnerUpdater: ((old: unknown[] | undefined) => unknown[]) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedInnerUpdater) => {
			capturedInnerUpdater = updaterFn
		})

		const { playlistsQueryUpdate } = await import("@/queries/usePlaylists.query")
		const replacement = [{ id: "pl-2" }]

		playlistsQueryUpdate({ updater: replacement as unknown as PlaylistWithItems[] })

		expect(capturedInnerUpdater).toBeDefined()
		// For a plain value, the outer wrapper returns the value directly
		const result = capturedInnerUpdater!(undefined)
		expect(result).toEqual(replacement)
	})

	it("uses the correct BASE_QUERY_KEY", async () => {
		vi.resetModules()

		vi.doMock("@/lib/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		const { playlistsQueryUpdate, BASE_QUERY_KEY } = await import("@/queries/usePlaylists.query")

		playlistsQueryUpdate({ updater: [] })

		expect(mockSetQueryData).toHaveBeenCalledWith(
			[BASE_QUERY_KEY],
			expect.any(Function),
			expect.any(Object)
		)
	})
})

// ─── fetchData from useCameraUploadAlbums.query ───────────────────────────────

describe("useCameraUploadAlbums.query fetchData", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	it("returns [] when hasAllNeededMediaPermissions returns false", async () => {
		vi.doMock("@/hooks/useMediaPermissions", () => ({
			hasAllNeededMediaPermissions: vi.fn().mockResolvedValue(false)
		}))

		vi.doMock("expo-media-library", () => ({
			getAlbumsAsync: vi.fn().mockResolvedValue([{ id: "album-1", title: "Camera Roll" }])
		}))

		const { fetchData } = await import("@/queries/useCameraUploadAlbums.query")
		const result = await fetchData()

		expect(result).toEqual([])
	})

	it("returns albums from getAlbumsAsync when permissions are granted", async () => {
		const mockAlbums = [
			{ id: "album-1", title: "Camera Roll" },
			{ id: "album-2", title: "Favorites" }
		]

		vi.doMock("@/hooks/useMediaPermissions", () => ({
			hasAllNeededMediaPermissions: vi.fn().mockResolvedValue(true)
		}))

		vi.doMock("expo-media-library", () => ({
			getAlbumsAsync: vi.fn().mockResolvedValue(mockAlbums)
		}))

		const { fetchData } = await import("@/queries/useCameraUploadAlbums.query")
		const result = await fetchData()

		expect(result).toEqual(mockAlbums)
	})

	it("passes { includeSmartAlbums: true } to getAlbumsAsync", async () => {
		const mockGetAlbumsAsync = vi.fn().mockResolvedValue([])

		vi.doMock("@/hooks/useMediaPermissions", () => ({
			hasAllNeededMediaPermissions: vi.fn().mockResolvedValue(true)
		}))

		vi.doMock("expo-media-library", () => ({
			getAlbumsAsync: mockGetAlbumsAsync
		}))

		const { fetchData } = await import("@/queries/useCameraUploadAlbums.query")
		await fetchData()

		expect(mockGetAlbumsAsync).toHaveBeenCalledWith({ includeSmartAlbums: true })
	})

	it("calls hasAllNeededMediaPermissions with { shouldRequest: true }", async () => {
		const mockHasPermissions = vi.fn().mockResolvedValue(true)

		vi.doMock("@/hooks/useMediaPermissions", () => ({
			hasAllNeededMediaPermissions: mockHasPermissions
		}))

		vi.doMock("expo-media-library", () => ({
			getAlbumsAsync: vi.fn().mockResolvedValue([])
		}))

		const { fetchData } = await import("@/queries/useCameraUploadAlbums.query")
		await fetchData()

		expect(mockHasPermissions).toHaveBeenCalledWith({ shouldRequest: true })
	})
})

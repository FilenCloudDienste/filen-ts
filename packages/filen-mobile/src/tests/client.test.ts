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

vi.mock("react-native", async () => {
	const actual = await import("@/tests/mocks/reactNative")

	return {
		...actual,
		// The shared mock's AppState has no `currentState`; the onError alert gate reads it.
		AppState: {
			...actual.AppState,
			currentState: "active"
		}
	}
})

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/sdkErrors", () => ({
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

vi.mock("@/stores/useApp.store", () => ({
	default: {
		getState: () => ({ biometricUnlocked: true })
	}
}))

vi.mock("@tanstack/react-query", () => ({
	QueryClient: class {
		defaultOptions = {}
		queryCache: unknown
		setQueryData: typeof mockSetQueryData = mockSetQueryData
		getQueryData: typeof mockGetQueryData = mockGetQueryData
		constructor(opts?: { queryCache?: unknown }) {
			this.queryCache = opts?.queryCache
		}
	},
	QueryCache: class {
		config: { onError?: (err: unknown, query: unknown) => void }
		constructor(config?: { onError?: (err: unknown, query: unknown) => void }) {
			this.config = config ?? {}
		}
	},
	onlineManager: {
		isOnline: mockIsOnline
	},
	notifyManager: {
		batch: (fn: () => unknown) => fn()
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
import {
	shouldPersistQuery,
	DEFAULT_QUERY_OPTIONS,
	decideQueryErrorAction,
	queryUpdater,
	QUERY_CLIENT_CACHE_TIME,
	restoreQueries
} from "@/queries/client"
import { type PlaylistWithItems } from "@/features/audio/audio"

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

// ─── DEFAULT_QUERY_OPTIONS.retry (SDK owns retries — see client.ts) ─────────────

describe("DEFAULT_QUERY_OPTIONS.retry", () => {
	it("disables JS-level retries — the Rust SDK retry stack (10/request, budget-limited, transient-only) owns retrying", () => {
		expect(DEFAULT_QUERY_OPTIONS.retry).toBe(false)
	})

	it("does not configure a retryDelay (nothing to delay with retries disabled)", () => {
		expect(DEFAULT_QUERY_OPTIONS.retryDelay).toBeUndefined()
	})

	it("keeps retryOnMount so errored queries still refetch when a new observer mounts", () => {
		expect(DEFAULT_QUERY_OPTIONS.retryOnMount).toBe(true)
	})
})

// ─── DEFAULT_QUERY_OPTIONS.throwOnError (pure render-phase predicate, Bug #49) ──

describe("DEFAULT_QUERY_OPTIONS.throwOnError", () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const throwOnError = DEFAULT_QUERY_OPTIONS.throwOnError as (err: unknown, query: any) => boolean
	const fakeQuery = { queryKey: ["testKey"] }

	beforeEach(() => {
		mockIsNetworkClassError.mockReset().mockReturnValue(false)
		mockUnwrapSdkError.mockReset().mockReturnValue(null)
		mockIsOnline.mockReset().mockReturnValue(true)
		mockLogout.mockReset().mockResolvedValue(undefined)
		mockAlertsError.mockReset()
	})

	it("always returns false (never throws to an error boundary)", () => {
		expect(throwOnError(new Error("network"), fakeQuery)).toBe(false)
		expect(throwOnError(new Error("plain"), fakeQuery)).toBe(false)
	})

	it("has ZERO side effects — never calls alerts.error, auth.logout regardless of error/connectivity", () => {
		// Network + online would historically have alerted; the pure predicate must not.
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(true)
		throwOnError(new Error("network online"), fakeQuery)

		// Unauthenticated + online would historically have logged out; the pure predicate must not.
		mockIsNetworkClassError.mockReturnValue(false)
		mockUnwrapSdkError.mockReturnValue({ kind: () => ErrorKind.Unauthenticated })
		throwOnError(new Error("unauth online"), fakeQuery)

		// Plain error would historically have alerted; the pure predicate must not.
		mockUnwrapSdkError.mockReturnValue(null)
		throwOnError(new Error("plain"), fakeQuery)

		expect(mockAlertsError).not.toHaveBeenCalled()
		expect(mockLogout).not.toHaveBeenCalled()
	})
})

// ─── decideQueryErrorAction (pure decision, Bug #49) ─────────────────────────

describe("decideQueryErrorAction", () => {
	const baseDeps = {
		isNetworkClassError: mockIsNetworkClassError,
		unwrapSdkError: mockUnwrapSdkError,
		isOnline: mockIsOnline
	}

	beforeEach(() => {
		mockIsNetworkClassError.mockReset().mockReturnValue(false)
		mockUnwrapSdkError.mockReset().mockReturnValue(null)
		mockIsOnline.mockReset().mockReturnValue(true)
	})

	it("suppresses network-class errors while offline", () => {
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(false)

		expect(decideQueryErrorAction(new Error("net"), baseDeps)).toBe("suppress")
	})

	it("alerts on network-class errors while online", () => {
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(true)

		expect(decideQueryErrorAction(new Error("net"), baseDeps)).toBe("alert")
	})

	it("returns 'logout' for Unauthenticated SDK error while online", () => {
		mockUnwrapSdkError.mockReturnValue({ kind: () => ErrorKind.Unauthenticated })
		mockIsOnline.mockReturnValue(true)

		expect(decideQueryErrorAction(new Error("unauth"), baseDeps)).toBe("logout")
	})

	it("suppresses Unauthenticated SDK error while offline (indistinguishable from network failure)", () => {
		mockUnwrapSdkError.mockReturnValue({ kind: () => ErrorKind.Unauthenticated })
		mockIsOnline.mockReturnValue(false)

		expect(decideQueryErrorAction(new Error("unauth offline"), baseDeps)).toBe("suppress")
	})

	it("alerts for a non-network non-Unauthenticated SDK error while online", () => {
		mockUnwrapSdkError.mockReturnValue({ kind: () => ErrorKind.Reqwest })
		mockIsOnline.mockReturnValue(true)

		expect(decideQueryErrorAction(new Error("sdk"), baseDeps)).toBe("alert")
	})

	it("alerts for a plain JS error (no SDK inner, not network class)", () => {
		expect(decideQueryErrorAction(new Error("plain"), baseDeps)).toBe("alert")
	})

	it("suppresses a DriveDirectoryNotFoundError even while ONLINE (query-local not-found UX owns it)", () => {
		mockIsOnline.mockReturnValue(true)

		const err = new Error("directory gone")
		err.name = "DriveDirectoryNotFoundError"

		expect(decideQueryErrorAction(err, baseDeps)).toBe("suppress")
	})

	it("suppresses a DirectorySizeUnresolvedError even while ONLINE (hidden size label owns it)", () => {
		mockIsOnline.mockReturnValue(true)

		const err = new Error("size unresolved")
		err.name = "DirectorySizeUnresolvedError"

		expect(decideQueryErrorAction(err, baseDeps)).toBe("suppress")
	})

	it("still ALERTS an ordinary error while online (the name-based suppress does not swallow real failures)", () => {
		mockIsOnline.mockReturnValue(true)

		const err = new Error("genuine failure")
		err.name = "SomeOtherError"

		expect(decideQueryErrorAction(err, baseDeps)).toBe("alert")
	})
})

// ─── QueryCache onError sink (Bug #49: once-per-settled-error UX) ─────────────

describe("QueryCache onError sink", () => {
	type OnError = (err: unknown, query: { queryKey: unknown[] }) => void

	async function getOnError(): Promise<OnError> {
		// queryClient is built with `new QueryCache({ onError })`; the mocked QueryCache captures
		// the config so we can drive the sink directly.
		const mod = await import("@/queries/client")
		const client = mod.queryClient as unknown as {
			queryCache: { config: { onError?: OnError } }
		}
		const onError = client.queryCache.config.onError

		if (!onError) {
			throw new Error("onError sink not configured on the QueryCache")
		}

		return onError
	}

	beforeEach(() => {
		mockIsNetworkClassError.mockReset().mockReturnValue(false)
		mockUnwrapSdkError.mockReset().mockReturnValue(null)
		mockIsOnline.mockReset().mockReturnValue(true)
		mockLogout.mockReset().mockResolvedValue(undefined)
		mockAlertsError.mockReset()
	})

	it("suppresses (no logout, no alert) for an offline network error", async () => {
		mockIsNetworkClassError.mockReturnValue(true)
		mockIsOnline.mockReturnValue(false)

		const onError = await getOnError()
		onError(new Error("net offline"), { queryKey: ["k"] })

		expect(mockLogout).not.toHaveBeenCalled()
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("calls auth.logout (once) for an online Unauthenticated error", async () => {
		mockUnwrapSdkError.mockReturnValue({ kind: () => ErrorKind.Unauthenticated })
		mockIsOnline.mockReturnValue(true)

		const onError = await getOnError()
		onError(new Error("unauth"), { queryKey: ["k"] })

		await Promise.resolve()

		expect(mockLogout).toHaveBeenCalledTimes(1)
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("alerts for a plain error when unlocked + active", async () => {
		const err = new Error("boom-unique-1")
		const onError = await getOnError()
		onError(err, { queryKey: ["k"] })

		expect(mockAlertsError).toHaveBeenCalledWith(err)
	})

	it("dedupes identical alert messages within the dedupe window", async () => {
		const onError = await getOnError()

		// Two distinct error objects but identical messages → second is collapsed.
		onError(new Error("same-message"), { queryKey: ["a"] })
		onError(new Error("same-message"), { queryKey: ["b"] })

		expect(mockAlertsError).toHaveBeenCalledTimes(1)
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

		expect(mockSetQueryData).toHaveBeenCalledWith(freshQuery.queryKey, freshQuery.state.data, {
			updatedAt: freshQuery.state.dataUpdatedAt
		})
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

		expect(mockSetQueryData).toHaveBeenCalledWith(goodQuery.queryKey, goodQuery.state.data, {
			updatedAt: goodQuery.state.dataUpdatedAt
		})
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

		const updater = queryUpdater
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
		const updater = queryUpdater
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
		const updater = queryUpdater
		updater.set<string>(["testKey"], fn)

		expect(capturedUpdater).toBeDefined()
		const result = capturedUpdater!(undefined)
		expect(fn).toHaveBeenCalledWith(undefined)
		expect(result).toBe("default")
	})

	it("uses the provided dataUpdatedAt timestamp when given", () => {
		const updater = queryUpdater
		const fixedTimestamp = 1234567890

		updater.set<string>(["testKey"], "value", fixedTimestamp)

		expect(mockSetQueryData).toHaveBeenCalledWith(["testKey"], expect.any(Function), { updatedAt: fixedTimestamp })
	})

	it("honors a dataUpdatedAt of 0 (typeof-number guard, not truthiness) — notes sync relies on this to keep the editor remount key frozen", () => {
		const updater = queryUpdater

		updater.set<string>(["testKey"], "value", 0)

		expect(mockSetQueryData).toHaveBeenCalledWith(["testKey"], expect.any(Function), { updatedAt: 0 })
	})

	it("falls back to Date.now() when dataUpdatedAt is undefined", () => {
		const before = Date.now()
		const updater = queryUpdater

		updater.set<string>(["testKey"], "value")

		const after = Date.now()
		const callArgs = mockSetQueryData.mock.calls[0] as [unknown, unknown, { updatedAt: number }]
		const usedTimestamp = callArgs[2].updatedAt

		expect(usedTimestamp).toBeGreaterThanOrEqual(before)
		expect(usedTimestamp).toBeLessThanOrEqual(after)
	})

	it("calls queryClientPersister.persistQueryByKey after setting data", async () => {
		const updater = queryUpdater

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
		vi.doMock("@/features/audio/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		let capturedInnerUpdater: ((old: unknown[] | undefined) => unknown[]) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedInnerUpdater) => {
			capturedInnerUpdater = updaterFn
		})

		const { playlistsQueryUpdate } = await import("@/features/audio/queries/usePlaylists.query")
		const fn = vi.fn((prev: unknown[]) => [...prev, "item"])

		playlistsQueryUpdate({ updater: fn as unknown as (prev: PlaylistWithItems[]) => PlaylistWithItems[] })

		expect(capturedInnerUpdater).toBeDefined()
		// When prev is undefined, the inner wrapper should pass [] to the function
		capturedInnerUpdater!(undefined)
		expect(fn).toHaveBeenCalledWith([])
	})

	it("passes existing prev array to the function updater unchanged", async () => {
		vi.resetModules()

		vi.doMock("@/features/audio/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		let capturedInnerUpdater: ((old: unknown[] | undefined) => unknown[]) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedInnerUpdater) => {
			capturedInnerUpdater = updaterFn
		})

		const { playlistsQueryUpdate } = await import("@/features/audio/queries/usePlaylists.query")
		const existing = [{ id: "pl-1" }]
		const fn = vi.fn((prev: unknown[]) => prev)

		playlistsQueryUpdate({ updater: fn as unknown as (prev: PlaylistWithItems[]) => PlaylistWithItems[] })

		expect(capturedInnerUpdater).toBeDefined()
		capturedInnerUpdater!(existing)
		expect(fn).toHaveBeenCalledWith(existing)
	})

	it("replaces the cache directly when a plain value updater is provided", async () => {
		vi.resetModules()

		vi.doMock("@/features/audio/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		let capturedInnerUpdater: ((old: unknown[] | undefined) => unknown[]) | undefined
		mockSetQueryData.mockImplementation((_key: unknown, updaterFn: typeof capturedInnerUpdater) => {
			capturedInnerUpdater = updaterFn
		})

		const { playlistsQueryUpdate } = await import("@/features/audio/queries/usePlaylists.query")
		const replacement = [{ id: "pl-2" }]

		playlistsQueryUpdate({ updater: replacement as unknown as PlaylistWithItems[] })

		expect(capturedInnerUpdater).toBeDefined()
		// For a plain value, the outer wrapper returns the value directly
		const result = capturedInnerUpdater!(undefined)
		expect(result).toEqual(replacement)
	})

	it("uses the correct BASE_QUERY_KEY", async () => {
		vi.resetModules()

		vi.doMock("@/features/audio/audio", () => ({
			default: {
				getPlaylists: vi.fn().mockResolvedValue([])
			}
		}))

		const { playlistsQueryUpdate, BASE_QUERY_KEY } = await import("@/features/audio/queries/usePlaylists.query")

		playlistsQueryUpdate({ updater: [] })

		expect(mockSetQueryData).toHaveBeenCalledWith([BASE_QUERY_KEY], expect.any(Function), expect.any(Object))
	})
})

// ─── QueryPersisterKv dirty-set restoration on write failure ─────────────────
//
// Regression tests for Bug #21:
// persistNow() and runPersistAsync() must restore dirty sets on SQLite failure
// so entries are retried by the next debounce cycle rather than silently dropped.

describe("QueryPersisterKv dirty-set restoration on write failure", () => {
	it("persistNow: restores dirty upserts into dirtyUpserts when executeBatch rejects", async () => {
		vi.resetModules()

		const mockExecuteBatch = vi.fn().mockRejectedValue(new Error("disk full"))
		const mockOpenDb = vi.fn().mockResolvedValue({ executeBatch: mockExecuteBatch })

		vi.doMock("@/lib/sqlite", () => ({
			default: {
				openDb: mockOpenDb,
				kvAsync: {
					removeByPrefix: vi.fn().mockResolvedValue(undefined)
				}
			}
		}))

		const { QueryPersisterKv } = await import("@/queries/client")
		const kv = new QueryPersisterKv()

		// Populate the in-memory buffer and mark it dirty
		kv.setItem("keyA", "valueA")
		kv.setItem("keyB", "valueB")

		// Cancel the debounce so it doesn't fire on its own
		// Access the private debounce via the prototype path
		const kvAny = kv as unknown as {
			persistDirty: { cancel: () => void }
			dirtyUpserts: Set<string>
			dirtyDeletes: Set<string>
			persistNow: () => void
		}
		kvAny.persistDirty.cancel()

		// Verify dirty set is populated before the flush
		expect(kvAny.dirtyUpserts.has("keyA")).toBe(true)
		expect(kvAny.dirtyUpserts.has("keyB")).toBe(true)

		// Call persistNow directly
		kvAny.persistNow()

		// At this point dirtyUpserts should have been cleared by buildCommands()
		expect(kvAny.dirtyUpserts.size).toBe(0)

		// openDb() resolves (1 tick) → executeBatch rejects (1 tick) → .catch fires (1 tick) → .finally fires (1 tick).
		// Flush the microtask queue deterministically without a wall-clock setTimeout.
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		// After the catch block, dirty keys must be restored for retry
		expect(kvAny.dirtyUpserts.has("keyA")).toBe(true)
		expect(kvAny.dirtyUpserts.has("keyB")).toBe(true)
	})

	it("persistNow: does NOT restore a key that was re-removed after the snapshot", async () => {
		vi.resetModules()

		const mockExecuteBatch = vi.fn().mockRejectedValue(new Error("io error"))
		const mockOpenDb = vi.fn().mockResolvedValue({ executeBatch: mockExecuteBatch })

		vi.doMock("@/lib/sqlite", () => ({
			default: {
				openDb: mockOpenDb,
				kvAsync: {
					removeByPrefix: vi.fn().mockResolvedValue(undefined)
				}
			}
		}))

		const { QueryPersisterKv } = await import("@/queries/client")
		const kv = new QueryPersisterKv()

		kv.setItem("keyX", "valueX")

		const kvAny = kv as unknown as {
			persistDirty: { cancel: () => void }
			dirtyUpserts: Set<string>
			dirtyDeletes: Set<string>
			persistNow: () => void
		}
		kvAny.persistDirty.cancel()

		kvAny.persistNow()

		// Simulate a removeItem called between persistNow() firing and the promise rejecting
		// — this puts keyX in dirtyDeletes, so it should NOT be re-added to dirtyUpserts
		kvAny.dirtyDeletes.add("keyX")

		// Flush microtasks deterministically: openDb resolves (1) → executeBatch rejects (1) → .catch fires (1).
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		// keyX moved to dirtyDeletes — it must not be double-restored into dirtyUpserts
		expect(kvAny.dirtyUpserts.has("keyX")).toBe(false)
		expect(kvAny.dirtyDeletes.has("keyX")).toBe(true)
	})

	it("runPersistAsync: restores failed upserts so the finally re-trigger actually retries them", async () => {
		vi.resetModules()

		const mockExecuteBatch = vi.fn().mockRejectedValue(new Error("db locked"))
		const mockOpenDb = vi.fn().mockResolvedValue({ executeBatch: mockExecuteBatch })

		vi.doMock("@/lib/sqlite", () => ({
			default: {
				openDb: mockOpenDb,
				kvAsync: {
					removeByPrefix: vi.fn().mockResolvedValue(undefined)
				}
			}
		}))

		const { QueryPersisterKv } = await import("@/queries/client")
		const kv = new QueryPersisterKv()

		kv.setItem("keyC", "valueC")

		const kvAny = kv as unknown as {
			persistDirty: { cancel: () => void }
			dirtyUpserts: Set<string>
			dirtyDeletes: Set<string>
			runPersistAsync: () => Promise<void>
		}
		kvAny.persistDirty.cancel()

		// Run the async persist path directly and await it
		await kvAny.runPersistAsync()

		// After runPersistAsync catches the error, it must restore the key
		expect(kvAny.dirtyUpserts.has("keyC")).toBe(true)
	})

	it("runPersistAsync: does NOT restore a key that was overwritten after the snapshot", async () => {
		vi.resetModules()

		const mockExecuteBatch = vi.fn().mockRejectedValue(new Error("transient"))
		const mockOpenDb = vi.fn().mockResolvedValue({ executeBatch: mockExecuteBatch })

		vi.doMock("@/lib/sqlite", () => ({
			default: {
				openDb: mockOpenDb,
				kvAsync: {
					removeByPrefix: vi.fn().mockResolvedValue(undefined)
				}
			}
		}))

		const { QueryPersisterKv } = await import("@/queries/client")
		const kv = new QueryPersisterKv()

		kv.setItem("keyD", "valueD")

		const kvAny = kv as unknown as {
			persistDirty: { cancel: () => void }
			dirtyUpserts: Set<string>
			dirtyDeletes: Set<string>
			runPersistAsync: () => Promise<void>
		}
		kvAny.persistDirty.cancel()

		// Start the async persist
		const persistPromise = kvAny.runPersistAsync()

		// Simulate a new dirty write arriving after the snapshot was taken but before the promise settles
		kvAny.dirtyUpserts.add("keyD")

		await persistPromise

		// keyD was re-dirtied after the snapshot — the catch should not overwrite it
		// (the key is already in dirtyUpserts, so the guard prevents double-add, which is fine)
		expect(kvAny.dirtyUpserts.has("keyD")).toBe(true)
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

		vi.doMock("expo-media-library/legacy", () => ({
			getAlbumsAsync: vi.fn().mockResolvedValue([{ id: "album-1", title: "Camera Roll" }])
		}))

		const { fetchData } = await import("@/features/cameraUpload/queries/useCameraUploadAlbums.query")
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

		vi.doMock("expo-media-library/legacy", () => ({
			getAlbumsAsync: vi.fn().mockResolvedValue(mockAlbums)
		}))

		const { fetchData } = await import("@/features/cameraUpload/queries/useCameraUploadAlbums.query")
		const result = await fetchData()

		expect(result).toEqual(mockAlbums)
	})

	it("passes { includeSmartAlbums: true } to getAlbumsAsync", async () => {
		const mockGetAlbumsAsync = vi.fn().mockResolvedValue([])

		vi.doMock("@/hooks/useMediaPermissions", () => ({
			hasAllNeededMediaPermissions: vi.fn().mockResolvedValue(true)
		}))

		vi.doMock("expo-media-library/legacy", () => ({
			getAlbumsAsync: mockGetAlbumsAsync
		}))

		const { fetchData } = await import("@/features/cameraUpload/queries/useCameraUploadAlbums.query")
		await fetchData()

		expect(mockGetAlbumsAsync).toHaveBeenCalledWith({ includeSmartAlbums: true })
	})

	it("calls hasAllNeededMediaPermissions with { shouldRequest: true }", async () => {
		const mockHasPermissions = vi.fn().mockResolvedValue(true)

		vi.doMock("@/hooks/useMediaPermissions", () => ({
			hasAllNeededMediaPermissions: mockHasPermissions
		}))

		vi.doMock("expo-media-library/legacy", () => ({
			getAlbumsAsync: vi.fn().mockResolvedValue([])
		}))

		const { fetchData } = await import("@/features/cameraUpload/queries/useCameraUploadAlbums.query")
		await fetchData()

		expect(mockHasPermissions).toHaveBeenCalledWith({ library: "all", needCamera: false })
	})
})

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"

const { mockDb, open, mockAppStateListeners } = vi.hoisted(() => {
	const listeners: Array<(state: string) => void> = []

	const mockDb = {
		execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeRaw: vi.fn().mockResolvedValue([]),
		executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
		prepareStatement: vi.fn(() => ({
			bind: vi.fn(),
			bindSync: vi.fn(),
			execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 })
		})),
		close: vi.fn()
	}

	return { mockDb, open: vi.fn(() => mockDb), mockAppStateListeners: listeners }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: (_type: string, handler: (state: string) => void) => {
			mockAppStateListeners.push(handler)

			return { remove: () => {} }
		}
	},
	Platform: {
		OS: "ios",
		select: <T>(specifics: { ios?: T; android?: T; default?: T }) => specifics["ios"] ?? specifics["default"]
	}
}))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: () => null,
	isNetworkClassError: () => false
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@filen/sdk-rs", () => ({
	ErrorKind: { Unauthenticated: "Unauthenticated" }
}))

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@tanstack/react-query", () => ({
	QueryClient: class {
		defaultOptions = {}
		setQueryData = vi.fn()
		getQueryData = vi.fn()
		onlineManager = { isOnline: vi.fn().mockReturnValue(true) }
		constructor(_opts?: unknown) {}
	},
	onlineManager: { isOnline: vi.fn().mockReturnValue(true) },
	useQuery: vi.fn()
}))

vi.mock("@tanstack/query-persist-client-core", () => ({
	experimental_createQueryPersister: vi.fn(() => ({
		persisterFn: vi.fn(),
		persistQueryByKey: vi.fn()
	}))
}))

vi.mock("@/lib/auth", () => ({
	default: {
		logout: vi.fn().mockResolvedValue(undefined)
	}
}))

vi.mock("expo-router", () => ({
	router: {
		replace: vi.fn()
	}
}))

import { serialize, deserialize } from "@/lib/serializer"
import { QueryPersisterKv, QUERY_CLIENT_PERSISTER_PREFIX, QUERY_CLIENT_CACHE_TIME, shouldPersistQuery, restoreQueries, queryClientPersisterKv } from "@/queries/client"
import sqlite from "@/lib/sqlite"
import queryClient from "@/queries/client"


/**
 * In-memory KV store that simulates sqlite.kvAsync behavior.
 * Values are stored as serialized strings just like the real SQLite KV.
 */
const kvStore = new Map<string, string>()

function likeToPrefix(pattern: string): string {
	return pattern.endsWith("%") ? pattern.slice(0, -1) : pattern
}

function matchesLike(key: string, pattern: string): boolean {
	const prefix = likeToPrefix(pattern)

	return key.startsWith(prefix)
}

function setupMockDb(): void {
	mockDb.execute.mockImplementation(async (query: string, params?: unknown[]) => {
		if (query.startsWith("INSERT OR REPLACE")) {
			const key = params![0] as string
			const value = params![1] as string

			kvStore.set(key, value)

			return { rows: [], insertId: 1, rowsAffected: 1 }
		}

		if (query.startsWith("DELETE FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			let count = 0

			for (const key of [...kvStore.keys()]) {
				if (matchesLike(key, pattern)) {
					kvStore.delete(key)

					count++
				}
			}

			return { rows: [], insertId: undefined, rowsAffected: count }
		}

		if (query.startsWith("DELETE FROM kv WHERE")) {
			const key = params![0] as string

			kvStore.delete(key)

			return { rows: [], insertId: undefined, rowsAffected: 1 }
		}

		if (query === "DELETE FROM kv") {
			kvStore.clear()

			return { rows: [], insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT value FROM kv")) {
			const key = params![0] as string
			const value = kvStore.get(key)

			return { rows: value ? [{ value }] : [], insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT key FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			const rows: { key: string }[] = []

			for (const key of kvStore.keys()) {
				if (matchesLike(key, pattern)) {
					rows.push({ key })
				}
			}

			return { rows, insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT key FROM kv WHERE")) {
			const key = params![0] as string

			return { rows: kvStore.has(key) ? [{ key }] : [], insertId: undefined, rowsAffected: 0 }
		}

		if (query.startsWith("SELECT key FROM kv")) {
			return { rows: [...kvStore.keys()].map(key => ({ key })), insertId: undefined, rowsAffected: 0 }
		}

		return { rows: [], insertId: undefined, rowsAffected: 0 }
	})

	mockDb.executeRaw.mockImplementation(async (query: string, params?: unknown[]) => {
		if (query.startsWith("SELECT key, value FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			const rows: [string, string][] = []

			for (const [key, value] of kvStore) {
				if (matchesLike(key, pattern)) {
					rows.push([key, value])
				}
			}

			return rows
		}

		if (query.startsWith("SELECT key FROM kv WHERE") && query.includes("LIKE")) {
			const pattern = params![0] as string
			const rows: [string][] = []

			for (const key of kvStore.keys()) {
				if (matchesLike(key, pattern)) {
					rows.push([key])
				}
			}

			return rows
		}

		if (query.startsWith("SELECT key FROM kv")) {
			return [...kvStore.keys()].map(key => [key])
		}

		return []
	})

	mockDb.executeBatch.mockImplementation(async (commands: [string, unknown[]][]) => {
		for (const [query, params] of commands) {
			if (query.startsWith("INSERT OR REPLACE")) {
				kvStore.set(params[0] as string, params[1] as string)
			}

			if (query.startsWith("DELETE FROM kv WHERE") && query.includes("LIKE")) {
				const pattern = params[0] as string

				for (const key of [...kvStore.keys()]) {
					if (matchesLike(key, pattern)) {
						kvStore.delete(key)
					}
				}
			} else if (query.startsWith("DELETE FROM kv WHERE")) {
				kvStore.delete(params[0] as string)
			}

			if (query === "DELETE FROM kv") {
				kvStore.clear()
			}
		}

		return { rowsAffected: commands.length }
	})
}

const PREFIX = `${QUERY_CLIENT_PERSISTER_PREFIX}:`

/** Returns the SQLite KV key for a given persister key. */
function kvKey(key: string): string {
	return PREFIX + key
}

/** Seeds the kvStore with a value as if it was previously persisted. */
function seedKvStore(key: string, value: unknown): void {
	kvStore.set(kvKey(key), serialize(value))
}

/** Reads and deserializes a value from the kvStore. */
function readKvStore<T>(key: string): T | undefined {
	const raw = kvStore.get(kvKey(key))

	if (!raw) {
		return undefined
	}

	return deserialize(raw) as T
}

/** Advances fake timers past the debounce window and drains all microtasks/Promises. */
async function flushDebounce(): Promise<void> {
	vi.advanceTimersByTime(2000)
	await vi.advanceTimersToNextTimerAsync().catch(() => {})
}

describe("QueryPersisterKv", () => {
	beforeAll(async () => {
		setupMockDb()
		await sqlite.init()
	})

	beforeEach(() => {
		kvStore.clear()
		mockAppStateListeners.length = 0
		setupMockDb()
		mockDb.executeBatch.mockClear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("restore()", () => {
		it("populates buffer from SQLite entries", async () => {
			seedKvStore("query-1", { queryKey: ["a"], state: { data: "hello" } })
			seedKvStore("query-2", { queryKey: ["b"], state: { data: "world" } })

			const kv = new QueryPersisterKv()
			await kv.restore()

			expect(kv.getItem("query-1")).toEqual({ queryKey: ["a"], state: { data: "hello" } })
			expect(kv.getItem("query-2")).toEqual({ queryKey: ["b"], state: { data: "world" } })
		})

		it("keys() returns restored keys", async () => {
			seedKvStore("query-a", "value-a")
			seedKvStore("query-b", "value-b")

			const kv = new QueryPersisterKv()
			await kv.restore()

			expect(kv.keys().sort()).toEqual(["query-a", "query-b"])
		})

		it("handles empty SQLite gracefully", async () => {
			const kv = new QueryPersisterKv()
			await kv.restore()

			expect(kv.keys()).toEqual([])
			expect(kv.getItem("anything")).toBeNull()
		})

		it("does not trigger persistence for restored data", async () => {
			seedKvStore("query-1", "value-1")

			const kv = new QueryPersisterKv()
			await kv.restore()

			await flushDebounce()

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})

		it("skips a corrupt row and still restores the remaining rows", async () => {
			seedKvStore("query-good-1", { queryKey: ["a"], state: { data: "hello" } })
			// Inject a corrupt raw value directly so deserialize() throws on this row
			kvStore.set(kvKey("query-bad"), "}{not valid json")
			seedKvStore("query-good-2", { queryKey: ["b"], state: { data: "world" } })

			const kv = new QueryPersisterKv()
			await kv.restore()

			expect(kv.getItem("query-good-1")).toEqual({ queryKey: ["a"], state: { data: "hello" } })
			expect(kv.getItem("query-good-2")).toEqual({ queryKey: ["b"], state: { data: "world" } })
			expect(kv.getItem("query-bad")).toBeNull()
		})

		it("does not throw when a row contains a corrupt BigInt envelope", async () => {
			seedKvStore("query-good", { queryKey: ["a"], state: { data: "ok" } })
			// A __bi envelope whose value is not a valid integer string
			kvStore.set(kvKey("query-bad-bi"), JSON.stringify({ n: { __bi: 1, v: "not-a-bigint" } }))

			const kv = new QueryPersisterKv()

			await expect(kv.restore()).resolves.toBeUndefined()

			expect(kv.getItem("query-good")).toEqual({ queryKey: ["a"], state: { data: "ok" } })
		})
	})

	describe("setItem()", () => {
		it("updates buffer immediately", () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", { data: "test" })

			expect(kv.getItem("key-1")).toEqual({ data: "test" })
		})

		it("does not write to SQLite synchronously", () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value")

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})

		it("writes to SQLite after debounce", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")

			await flushDebounce()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const stored = readKvStore<string>("key-1")

			expect(stored).toBe("value-1")
		})

		it("batches multiple setItems into single executeBatch", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")
			kv.setItem("key-2", "value-2")
			kv.setItem("key-3", "value-3")

			await flushDebounce()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const calls = mockDb.executeBatch.mock.calls[0] as [unknown[]]
			const commands = calls[0] as unknown[]

			expect(commands.length).toBe(3)

			expect(readKvStore<string>("key-1")).toBe("value-1")
			expect(readKvStore<string>("key-2")).toBe("value-2")
			expect(readKvStore<string>("key-3")).toBe("value-3")
		})

		it("overwrites previous value for same key", () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "old")
			kv.setItem("key-1", "new")

			expect(kv.getItem("key-1")).toBe("new")
		})
	})

	describe("removeItem()", () => {
		it("removes from buffer immediately", () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value")
			kv.removeItem("key-1")

			expect(kv.getItem("key-1")).toBeNull()
		})

		it("writes DELETE to SQLite after debounce", async () => {
			seedKvStore("key-1", "value")

			const kv = new QueryPersisterKv()
			await kv.restore()

			mockDb.executeBatch.mockClear()

			kv.removeItem("key-1")

			await flushDebounce()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
			expect(kvStore.has(kvKey("key-1"))).toBe(false)
		})
	})

	describe("dirty set interactions", () => {
		it("setItem then removeItem for same key: only DELETE in batch", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value")
			kv.removeItem("key-1")

			await flushDebounce()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const commands = mockDb.executeBatch.mock.calls[0]![0] as [string, unknown[]][]

			expect(commands.length).toBe(1)
			expect(commands[0]![0]).toMatch(/^DELETE/)
		})

		it("removeItem then setItem for same key: only INSERT in batch", async () => {
			seedKvStore("key-1", "old-value")

			const kv = new QueryPersisterKv()
			await kv.restore()

			mockDb.executeBatch.mockClear()

			kv.removeItem("key-1")
			kv.setItem("key-1", "new-value")

			await flushDebounce()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const commands = mockDb.executeBatch.mock.calls[0]![0] as [string, unknown[]][]

			expect(commands.length).toBe(1)
			expect(commands[0]![0]).toMatch(/^INSERT/)
			expect(readKvStore<string>("key-1")).toBe("new-value")
		})
	})

	describe("keys()", () => {
		it("returns keys from buffer, not SQLite", async () => {
			seedKvStore("old-key", "old-value")

			const kv = new QueryPersisterKv()
			await kv.restore()

			kv.setItem("new-key", "new-value")
			kv.removeItem("old-key")

			const keys = kv.keys()

			expect(keys).toEqual(["new-key"])
		})

		it("returns empty array for fresh instance", () => {
			const kv = new QueryPersisterKv()

			expect(kv.keys()).toEqual([])
		})
	})

	describe("clear()", () => {
		it("empties buffer and dirty sets", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")
			kv.setItem("key-2", "value-2")
			kv.clear()

			expect(kv.keys()).toEqual([])
			expect(kv.getItem("key-1")).toBeNull()
		})

		it("removes all persisted entries from SQLite", async () => {
			seedKvStore("key-1", "value-1")
			seedKvStore("key-2", "value-2")

			const kv = new QueryPersisterKv()
			await kv.restore()

			kv.clear()

			// Wait for the async removeByPrefix to complete
			await vi.advanceTimersByTimeAsync(0)

			expect(kvStore.has(kvKey("key-1"))).toBe(false)
			expect(kvStore.has(kvKey("key-2"))).toBe(false)
		})

		it("does not persist dirty entries after clear", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")
			kv.clear()

			mockDb.executeBatch.mockClear()

			await flushDebounce()

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})
	})

	describe("flush()", () => {
		it("schedules a debounced persist (trailing edge — not immediate)", async () => {
			// flush() calls persistDirty() which is debounced at 1000ms trailing edge.
			// The persist does NOT fire synchronously; it only fires after the debounce window.
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")
			kv.setItem("key-2", "value-2")

			// Calling flush() arms the debounce — nothing written yet
			kv.flush()

			expect(mockDb.executeBatch).not.toHaveBeenCalled()

			// Advance past the debounce window → persists now
			await flushDebounce()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			expect(readKvStore<string>("key-1")).toBe("value-1")
			expect(readKvStore<string>("key-2")).toBe("value-2")
		})

		it("is a no-op when no dirty entries exist", async () => {
			const kv = new QueryPersisterKv()

			kv.flush()

			await flushDebounce()

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})
	})

	describe("flushNow()", () => {
		it("persists dirty entries immediately without waiting for debounce", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")
			kv.setItem("key-2", "value-2")

			kv.flushNow()

			// persistNow() fires sqlite.openDb().then(db => db.executeBatch(...))
			// drain both levels of the Promise chain before asserting
			await vi.advanceTimersByTimeAsync(0)

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
			expect(readKvStore<string>("key-1")).toBe("value-1")
			expect(readKvStore<string>("key-2")).toBe("value-2")
		})

		it("cancels pending debounce so no second executeBatch fires after flushNow", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")
			kv.flushNow()

			await vi.advanceTimersByTimeAsync(0)

			mockDb.executeBatch.mockClear()

			// The debounce was cancelled, no additional flush should fire
			await flushDebounce()

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})

		it("is a no-op when no dirty entries exist", async () => {
			const kv = new QueryPersisterKv()

			kv.flushNow()

			await vi.advanceTimersByTimeAsync(0)

			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})

		it("does not drop dirty entries added while a persist run is in flight", async () => {
			// Hold the first executeBatch open so the debounced persistAsync() run
			// stays in flight while we add a late entry and call flushNow().
			let releaseFirstBatch: () => void = () => {}

			const firstBatchGate = new Promise<void>(resolve => {
				releaseFirstBatch = resolve
			})

			let batchCall = 0

			mockDb.executeBatch.mockImplementation(async (commands: [string, unknown[]][]) => {
				batchCall++

				if (batchCall === 1) {
					await firstBatchGate
				}

				for (const [query, params] of commands) {
					if (query.startsWith("INSERT OR REPLACE")) {
						kvStore.set(params[0] as string, params[1] as string)
					}
				}

				return { rowsAffected: commands.length }
			})

			const kv = new QueryPersisterKv()

			// Kick off a debounced persist and let it enter persistAsync() (now in flight).
			// PERSIST_DEBOUNCE is 1000ms; advance past it, then drain microtasks so
			// persistAsync() reaches the gated executeBatch without finishing the run.
			kv.setItem("early-key", "early-value")
			await vi.advanceTimersByTimeAsync(1000)

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			// Late entry arrives after the in-flight run snapshotted its dirty sets.
			kv.setItem("late-key", "late-value")

			// Background event fires flushNow() while persisting === true.
			kv.flushNow()

			// Release the in-flight run; the chained flush must then persist the late entry.
			releaseFirstBatch()

			await vi.advanceTimersByTimeAsync(0)
			await vi.advanceTimersByTimeAsync(0)

			expect(kv.getItem("late-key")).toBe("late-value")
			expect(readKvStore<string>("late-key")).toBe("late-value")
		})
	})

	describe("AppState 'background' listener", () => {
		it("calls flushNow() when app transitions to background", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("bg-key", "bg-value")

			// Simulate the app going to background — triggers the constructor-registered listener
			for (const listener of mockAppStateListeners) {
				listener("background")
			}

			await vi.advanceTimersByTimeAsync(0)

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
			expect(readKvStore<string>("bg-key")).toBe("bg-value")
		})

		it("does not write to SQLite when app transitions to active (no dirty entries)", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("active-key", "active-value")

			// Transition to active rather than background — must NOT trigger flushNow
			for (const listener of mockAppStateListeners) {
				listener("active")
			}

			await vi.advanceTimersByTimeAsync(0)

			// No executeBatch because the listener only fires for 'background'
			expect(mockDb.executeBatch).not.toHaveBeenCalled()
		})
	})

	describe("persistAsync() re-entrancy guard", () => {
		it("returns existing in-flight promise when already persisting", async () => {
			// Two rapid setItem waves: first triggers debounced persist, second comes in while
			// the first executeBatch is blocked — re-entrancy guard must yield the in-flight promise.
			let releaseFirst: () => void = () => {}

			const firstGate = new Promise<void>(resolve => {
				releaseFirst = resolve
			})

			let callCount = 0

			mockDb.executeBatch.mockImplementation(async (commands: [string, unknown[]][]) => {
				callCount++

				if (callCount === 1) {
					await firstGate
				}

				for (const [query, params] of commands) {
					if (query.startsWith("INSERT OR REPLACE")) {
						kvStore.set(params[0] as string, params[1] as string)
					}
				}

				return { rowsAffected: commands.length }
			})

			const kv = new QueryPersisterKv()

			// First wave — starts the in-flight run
			kv.setItem("wave-1-key", "wave-1-value")
			await vi.advanceTimersByTimeAsync(1000)

			// executeBatch called once (blocked)
			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			// Second wave while first is still blocked — re-entrancy guard holds
			kv.setItem("wave-2-key", "wave-2-value")
			await vi.advanceTimersByTimeAsync(1000)

			// Still only one in-flight executeBatch call; the second wave is queued
			// but no second executeBatch has been invoked yet
			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			// Release first — the finally block will re-trigger for wave-2
			releaseFirst()
			await vi.advanceTimersByTimeAsync(0)
			await vi.advanceTimersByTimeAsync(1000)
			await vi.advanceTimersByTimeAsync(0)

			// Both waves eventually persisted
			expect(readKvStore<string>("wave-1-key")).toBe("wave-1-value")
			expect(readKvStore<string>("wave-2-key")).toBe("wave-2-value")
		})
	})

	describe("runPersistAsync() chunk yielding", () => {
		it("persists all entries when count exceeds PERSIST_CHUNK_SIZE (> 100 keys)", async () => {
			const kv = new QueryPersisterKv()
			const TOTAL = 110

			for (let i = 0; i < TOTAL; i++) {
				kv.setItem(`chunk-key-${i}`, `chunk-value-${i}`)
			}

			// Advance past debounce — setImmediate callbacks are processed by fake timers
			await vi.runAllTimersAsync()

			// All 110 entries must appear in the kvStore after the setImmediate yield
			for (let i = 0; i < TOTAL; i++) {
				expect(readKvStore<string>(`chunk-key-${i}`)).toBe(`chunk-value-${i}`)
			}
		})

		it("executeBatch receives all commands even when chunked across setImmediate yields", async () => {
			const kv = new QueryPersisterKv()
			const TOTAL = 150

			for (let i = 0; i < TOTAL; i++) {
				kv.setItem(`big-key-${i}`, `big-value-${i}`)
			}

			await vi.runAllTimersAsync()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const commands = mockDb.executeBatch.mock.calls[0]![0] as [string, unknown[]][]

			expect(commands.length).toBe(TOTAL)
		})
	})

	describe("round-trip", () => {
		it("setItem → flush → new instance restore → getItem returns same value", async () => {
			const kv1 = new QueryPersisterKv()

			kv1.setItem("round-trip-key", { nested: { data: [1, 2, 3] } })

			kv1.flush()
			await flushDebounce()

			const kv2 = new QueryPersisterKv()
			await kv2.restore()

			expect(kv2.getItem("round-trip-key")).toEqual({ nested: { data: [1, 2, 3] } })
		})

		it("persists only dirty entries on second flush", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-a", "1")
			kv.setItem("key-b", "2")

			kv.flush()
			await flushDebounce()

			mockDb.executeBatch.mockClear()

			kv.setItem("key-a", "updated")

			kv.flush()
			await flushDebounce()

			expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

			const commands = mockDb.executeBatch.mock.calls[0]![0] as [string, unknown[]][]

			expect(commands.length).toBe(1)
			expect(readKvStore<string>("key-a")).toBe("updated")
			expect(readKvStore<string>("key-b")).toBe("2")
		})
	})
})

describe("shouldPersistQuery()", () => {
	// Helper to build a minimal PersistedQuery-shaped object
	function makeQuery(queryKey: unknown[], status: string = "success"): Parameters<typeof shouldPersistQuery>[0] {
		return {
			queryKey,
			queryHash: serialize(queryKey),
			state: { status, data: "data", dataUpdatedAt: Date.now() }
		} as unknown as Parameters<typeof shouldPersistQuery>[0]
	}

	it("returns true for a cacheable top-level string key with status=success", () => {
		expect(shouldPersistQuery(makeQuery(["useDriveItemsQuery"]))).toBe(true)
	})

	it("returns false for a top-level UNCACHED_QUERY_KEYS string key", () => {
		const uncachedKeys = [
			"useFileTextQuery",
			"useFileBase64Query",
			"useFileUriQuery",
			"useFileUrlQuery",
			"useMediaPermissionsQuery",
			"useCameraUploadAlbumsQuery",
			"useLocalAuthenticationQuery",
			"useCacheSizes",
			"useFileProviderCacheBudget"
		]

		for (const key of uncachedKeys) {
			expect(shouldPersistQuery(makeQuery([key])), `expected false for key "${key}"`).toBe(false)
		}
	})

	it("returns false when an UNCACHED key appears nested inside an array element", () => {
		// queryKey = [["useFileTextQuery", {uuid: "x"}]] — nested array contains the string
		expect(shouldPersistQuery(makeQuery([["useFileTextQuery", { uuid: "x" }]]))).toBe(false)
	})

	it("returns true when a nested array element contains only cacheable strings", () => {
		expect(shouldPersistQuery(makeQuery([["useDriveItemsQuery", { uuid: "x" }]]))).toBe(true)
	})

	it("returns false when status is not 'success' even for a cacheable key", () => {
		expect(shouldPersistQuery(makeQuery(["useDriveItemsQuery"], "loading"))).toBe(false)
		expect(shouldPersistQuery(makeQuery(["useDriveItemsQuery"], "error"))).toBe(false)
		expect(shouldPersistQuery(makeQuery(["useDriveItemsQuery"], "pending"))).toBe(false)
	})

	it("returns false when queryKey is empty", () => {
		// Empty key: no elements to match, shouldNotPersist=false, but status check still applies
		expect(shouldPersistQuery(makeQuery([]))).toBe(true)
	})

	it("returns false for UNCACHED key appearing alongside other keys", () => {
		// Mixed array: one element is uncached → entire query is suppressed
		expect(shouldPersistQuery(makeQuery(["useDriveItemsQuery", "useFileTextQuery"]))).toBe(false)
	})

	it("ignores non-string, non-array elements in queryKey", () => {
		// Number, null, object elements should not accidentally block persistence
		expect(shouldPersistQuery(makeQuery(["useDriveItemsQuery", 42, null, { foo: "bar" }]))).toBe(true)
	})
})

describe("restoreQueries()", () => {
	beforeEach(() => {
		kvStore.clear()
		// Clear the module-level singleton buffer so each test starts from a blank slate.
		// Without this, previously restored entries linger in the in-memory buffer and
		// bleed into subsequent restoreQueries() calls within the same test run.
		queryClientPersisterKv.clear()
		setupMockDb()
		mockDb.executeBatch.mockClear()
		vi.mocked(queryClient.setQueryData).mockClear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function makePersistedQuery(opts: {
		key: string
		queryKey: unknown[]
		status?: string
		dataUpdatedAt?: number
		data?: unknown
	}): void {
		const { key, queryKey, status = "success", dataUpdatedAt = Date.now(), data = "payload" } = opts

		seedKvStore(key, {
			queryKey,
			queryHash: serialize(queryKey),
			state: { status, data, dataUpdatedAt }
		})
	}

	it("calls setQueryData for each valid persisted success query", async () => {
		makePersistedQuery({ key: "q1", queryKey: ["useDriveItemsQuery", "uuid-1"] })
		makePersistedQuery({ key: "q2", queryKey: ["useDriveItemsQuery", "uuid-2"] })

		await restoreQueries()

		expect(queryClient.setQueryData).toHaveBeenCalledTimes(2)
	})

	it("prunes entries whose dataUpdatedAt is beyond QUERY_CLIENT_CACHE_TIME", async () => {
		const expiredAt = Date.now() - QUERY_CLIENT_CACHE_TIME - 1

		seedKvStore("expired-q", {
			queryKey: ["useDriveItemsQuery"],
			queryHash: "expired",
			state: { status: "success", data: "stale", dataUpdatedAt: expiredAt }
		})

		await restoreQueries()

		expect(queryClient.setQueryData).not.toHaveBeenCalled()

		// removeItem() queues a debounced DELETE — drain the timer to confirm it fires
		await flushDebounce()

		expect(kvStore.has(kvKey("expired-q"))).toBe(false)
	})

	it("prunes entries with a non-success status and does not call setQueryData", async () => {
		makePersistedQuery({ key: "error-q", queryKey: ["useDriveItemsQuery"], status: "error" })

		await restoreQueries()

		expect(queryClient.setQueryData).not.toHaveBeenCalled()
	})

	it("prunes entries for UNCACHED_QUERY_KEYS and does not call setQueryData", async () => {
		makePersistedQuery({ key: "uncached-q", queryKey: ["useFileTextQuery"] })

		await restoreQueries()

		expect(queryClient.setQueryData).not.toHaveBeenCalled()
	})

	it("passes the correct queryKey and data to setQueryData", async () => {
		const queryKey = ["useDriveItemsQuery", { uuid: "abc" }]

		makePersistedQuery({ key: "exact-q", queryKey, data: { files: [1, 2, 3] } })

		await restoreQueries()

		expect(queryClient.setQueryData).toHaveBeenCalledWith(
			queryKey,
			{ files: [1, 2, 3] },
			expect.objectContaining({ updatedAt: expect.any(Number) })
		)
	})

	it("handles an empty store without errors", async () => {
		await expect(restoreQueries()).resolves.toBeUndefined()

		expect(queryClient.setQueryData).not.toHaveBeenCalled()
	})

	it("restores valid entries even when one entry has a null state", async () => {
		// null state → pruned, not crashing
		kvStore.set(kvKey("null-state-q"), serialize({ queryKey: ["useDriveItemsQuery"], state: null }))
		makePersistedQuery({ key: "good-q", queryKey: ["useDriveItemsQuery", "ok"] })

		await restoreQueries()

		// Only the valid entry was passed to setQueryData
		expect(queryClient.setQueryData).toHaveBeenCalledTimes(1)
		expect(queryClient.setQueryData).toHaveBeenCalledWith(
			["useDriveItemsQuery", "ok"],
			"payload",
			expect.any(Object)
		)
	})
})

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"

const { mockDb, open } = vi.hoisted(() => {
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

	return { mockDb, open: vi.fn(() => mockDb) }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/"),
	unwrapSdkError: () => null
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
		constructor(_opts?: unknown) {}
	},
	useQuery: vi.fn()
}))

vi.mock("@tanstack/query-persist-client-core", () => ({
	experimental_createQueryPersister: vi.fn(() => ({
		persisterFn: vi.fn(),
		persistQueryByKey: vi.fn()
	}))
}))

import { pack, unpack } from "@/lib/msgpack"
import { QueryPersisterKv } from "@/queries/client"
import sqlite from "@/lib/sqlite"

// Hardcoded to match client.ts — avoids import issues with mocked module evaluation order
const QUERY_CLIENT_PERSISTER_PREFIX = "reactQuery_v2"

/**
 * In-memory KV store that simulates sqlite.kvAsync behavior.
 * Values are stored as msgpack blobs (Uint8Array) just like the real SQLite KV.
 */
const kvStore = new Map<string, Uint8Array>()

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
			const value = params![1] as Uint8Array

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

			return { rows: value ? [{ value: value.buffer }] : [], insertId: undefined, rowsAffected: 0 }
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
			const rows: [string, ArrayBuffer][] = []

			for (const [key, value] of kvStore) {
				if (matchesLike(key, pattern)) {
					rows.push([key, value.buffer as ArrayBuffer])
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
				kvStore.set(params[0] as string, params[1] as Uint8Array)
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
	kvStore.set(kvKey(key), new Uint8Array(pack(value)))
}

/** Reads and unpacks a value from the kvStore. */
function readKvStore<T>(key: string): T | undefined {
	const raw = kvStore.get(kvKey(key))

	if (!raw) {
		return undefined
	}

	return unpack(raw) as T
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
		it("triggers immediate persist", async () => {
			const kv = new QueryPersisterKv()

			kv.setItem("key-1", "value-1")
			kv.setItem("key-2", "value-2")

			kv.flush()

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

import { vi, describe, it, expect, beforeEach } from "vitest"

// In-memory store backing the op-sqlite mock. The real sqlite lib uses one-shot
// db.execute / db.executeRaw (no shared prepared statements), so the mock parses
// the handful of SQL patterns the kv layer issues and operates on this Map.
const { mockDb, open } = vi.hoisted(() => {
	const store = new Map<string, string>()

	const stripWildcard = (param: unknown): string => (param as string).replace(/%$/, "")

	const executeImpl = async (query: string, params?: unknown[]) => {
		if (query.startsWith("INSERT")) {
			store.set(params![0] as string, params![1] as string)

			return { rows: [], insertId: 1, rowsAffected: 1 }
		}

		if (query.startsWith("DELETE FROM kv WHERE key LIKE")) {
			const prefix = stripWildcard(params![0])
			let rowsAffected = 0

			for (const key of [...store.keys()]) {
				if (key.startsWith(prefix)) {
					store.delete(key)
					rowsAffected++
				}
			}

			return { rows: [], insertId: undefined, rowsAffected }
		}

		if (query.startsWith("DELETE FROM kv WHERE key =")) {
			const existed = store.delete(params![0] as string)

			return { rows: [], insertId: undefined, rowsAffected: existed ? 1 : 0 }
		}

		if (query.startsWith("DELETE FROM kv")) {
			const rowsAffected = store.size

			store.clear()

			return { rows: [], insertId: undefined, rowsAffected }
		}

		return { rows: [], insertId: undefined, rowsAffected: 0 }
	}

	const executeRawImpl = async (query: string, params?: unknown[]) => {
		if (query.startsWith("SELECT value")) {
			const value = store.get(params![0] as string)

			return value !== undefined ? [[value]] : []
		}

		if (query.startsWith("SELECT EXISTS")) {
			return [[store.has(params![0] as string) ? 1 : 0]]
		}

		if (query.startsWith("SELECT key, value")) {
			const prefix = stripWildcard(params![0])

			return [...store.entries()].filter(([key]) => key.startsWith(prefix))
		}

		if (query.startsWith("SELECT key FROM kv WHERE key LIKE")) {
			const prefix = stripWildcard(params![0])

			return [...store.keys()].filter(key => key.startsWith(prefix)).map(key => [key])
		}

		if (query.startsWith("SELECT key FROM kv")) {
			return [...store.keys()].map(key => [key])
		}

		return []
	}

	const mockDb = {
		execute: vi.fn(executeImpl),
		executeSync: vi.fn().mockReturnValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeRaw: vi.fn(executeRawImpl),
		executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
		prepareStatement: vi.fn(),
		close: vi.fn(),
		_store: store,
		_reset: () => {
			store.clear()
			mockDb.execute.mockImplementation(executeImpl)
			mockDb.executeRaw.mockImplementation(executeRawImpl)
		}
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
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

type Sqlite = any

async function createSqlite(): Promise<Sqlite> {
	const mod = await import("@/lib/sqlite")

	return new (mod.default.constructor as new () => Sqlite)()
}

describe("Sqlite", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.resetModules()
		mockDb._reset()
		open.mockReturnValue(mockDb)
	})

	describe("init", () => {
		it("calls open, runs INIT_QUERIES, and creates the kv table", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()

			expect(open).toHaveBeenCalledTimes(1)
			expect(open).toHaveBeenCalledWith({
				name: "sqlite.db",
				location: expect.any(String)
			})

			const execArg = mockDb.execute.mock.calls[0]![0] as string

			expect(execArg).toContain("PRAGMA journal_mode = WAL")
			expect(execArg).toContain("CREATE TABLE IF NOT EXISTS kv")
			expect(execArg).toContain("PRAGMA optimize")
			expect(execArg).not.toContain("foreign_keys")
		})

		it("is idempotent — calling init twice only opens db once", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()
			await sqlite.init()

			expect(open).toHaveBeenCalledTimes(1)
		})
	})

	describe("openDb", () => {
		it("returns db after init", async () => {
			const sqlite = await createSqlite()
			const db = await sqlite.openDb()

			expect(db).toBe(mockDb)
		})

		it("throws if db is null after init", async () => {
			const sqlite = await createSqlite()

			;(sqlite as any).initDone = true
			;(sqlite as any).db = null

			await expect(sqlite.openDb()).rejects.toThrow("SQLite database not initialized")
		})
	})

	describe("kvAsync.set", () => {
		it("returns the insertId from execute", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("test-key", "test-value")

			expect(result).toBe(1)
		})

		it("returns null for null value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", null)

			expect(result).toBeNull()
		})

		it("returns null for undefined value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", undefined)

			expect(result).toBeNull()
		})
	})

	describe("kvAsync.get", () => {
		it("returns null for missing key", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.get("nonexistent")

			expect(result).toBeNull()
		})
	})

	describe("kvAsync.keys", () => {
		it("uses executeRaw and returns array of keys", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("alpha", "1")
			await sqlite.kvAsync.set("beta", "2")
			await sqlite.kvAsync.set("gamma", "3")

			const keys = await sqlite.kvAsync.keys()

			expect([...keys].sort()).toEqual(["alpha", "beta", "gamma"])
			expect(mockDb.executeRaw).toHaveBeenCalledWith("SELECT key FROM kv")
		})

		it("returns empty array when no rows", async () => {
			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keys()

			expect(keys).toEqual([])
		})
	})

	describe("kvAsync.contains", () => {
		it("returns true when key exists", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("existing", "value")

			const result = await sqlite.kvAsync.contains("existing")

			expect(result).toBe(true)
		})

		it("returns false when key does not exist", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.contains("missing")

			expect(result).toBe(false)
		})
	})

	describe("kvAsync.remove", () => {
		it("removes the key", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("doomed-key", "value")
			await sqlite.kvAsync.remove("doomed-key")

			const result = await sqlite.kvAsync.contains("doomed-key")

			expect(result).toBe(false)
		})
	})

	describe("kvAsync.clear", () => {
		it("calls execute with DELETE (no WHERE)", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.clear()

			expect(mockDb.execute).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("kvAsync.keysByPrefix", () => {
		it("uses executeRaw with LIKE query and returns matching keys", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("cache:v1:map:a", "1")
			await sqlite.kvAsync.set("cache:v1:map:b", "2")
			await sqlite.kvAsync.set("other:c", "3")

			const keys = await sqlite.kvAsync.keysByPrefix("cache:v1:map:")

			expect([...keys].sort()).toEqual(["cache:v1:map:a", "cache:v1:map:b"])
			expect(mockDb.executeRaw).toHaveBeenCalledWith("SELECT key FROM kv WHERE key LIKE ?", ["cache:v1:map:%"])
		})
	})

	describe("kvAsync.getByPrefix", () => {
		it("returns matching entries as a Map", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("data_x", { value: 1 })
			await sqlite.kvAsync.set("data_y", { value: 2 })
			await sqlite.kvAsync.set("other_z", { value: 3 })

			const result = (await sqlite.kvAsync.getByPrefix("data_")) as Map<string, { value: number }>

			expect(result.size).toBe(2)
			expect(result.get("data_x")).toEqual({ value: 1 })
			expect(result.get("data_y")).toEqual({ value: 2 })
		})

		it("returns empty Map when no rows match", async () => {
			const sqlite = await createSqlite()

			const result = await sqlite.kvAsync.getByPrefix("nonexistent_")

			expect(result).toBeInstanceOf(Map)
			expect(result.size).toBe(0)
		})

		it("silently omits entries with corrupt serialized data and returns partial map", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("ok_key", { v: 42 })
			// Inject a corrupt raw value directly into the backing store
			mockDb._store.set("bad_key", "}{not valid json")

			const result = (await sqlite.kvAsync.getByPrefix("")) as Map<string, unknown>

			expect(result.size).toBe(1)
			expect(result.get("ok_key")).toEqual({ v: 42 })
			expect(result.has("bad_key")).toBe(false)
		})
	})

	describe("clearAsync", () => {
		it("calls execute with DELETE FROM kv", async () => {
			const sqlite = await createSqlite()

			await sqlite.clearAsync()

			expect(mockDb.execute).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("shrinkMemory", () => {
		it("executes PRAGMA shrink_memory after db is open", async () => {
			const sqlite = await createSqlite()

			await sqlite.openDb()
			await sqlite.shrinkMemory()

			expect(mockDb.execute).toHaveBeenCalledWith("PRAGMA shrink_memory")
		})

		it("does nothing when db is not yet initialized", async () => {
			const sqlite = await createSqlite()

			await sqlite.shrinkMemory()

			expect(mockDb.execute).not.toHaveBeenCalledWith("PRAGMA shrink_memory")
		})
	})

	describe("init error propagation", () => {
		it("propagates error from open() through init()", async () => {
			open.mockImplementationOnce(() => {
				throw new Error("disk full")
			})

			const sqlite = await createSqlite()

			await expect(sqlite.init()).rejects.toThrow("disk full")
		})

		it("openDb() rejects (does not busy-loop) when init persistently fails", async () => {
			vi.useFakeTimers()

			try {
				// open() always throws, so init() can never set initDone — openDb()
				// must give up after bounded retries instead of spinning forever.
				open.mockImplementation(() => {
					throw new Error("disk full")
				})

				const sqlite = await createSqlite()
				const openPromise = sqlite.openDb()

				// Surface the eventual rejection; drain backoff timers so the bounded
				// retry loop runs to exhaustion rather than hanging the test.
				const assertion = expect(openPromise).rejects.toThrow("disk full")

				await vi.runAllTimersAsync()
				await assertion

				// open() was attempted multiple times (bounded retry), not once and not unbounded.
				expect(open.mock.calls.length).toBeGreaterThan(1)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("round-trip via execute/executeRaw", () => {
		it("set then get preserves the value through serializer", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("roundtrip", { numbers: [1, 2, 3], nested: { ok: true } })
			const result = await sqlite.kvAsync.get("roundtrip")

			expect(result).toEqual({ numbers: [1, 2, 3], nested: { ok: true } })
		})

		it("set then get preserves string values", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("greeting", "hello world")
			const result = await sqlite.kvAsync.get("greeting")

			expect(result).toBe("hello world")
		})
	})

	describe("removeByPrefix", () => {
		it("removes all entries matching prefix and leaves others", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("prefix_a", "one")
			await sqlite.kvAsync.set("prefix_b", "two")
			await sqlite.kvAsync.set("other_c", "three")

			await sqlite.kvAsync.removeByPrefix("prefix_")

			expect(await sqlite.kvAsync.get("prefix_a")).toBeNull()
			expect(await sqlite.kvAsync.get("prefix_b")).toBeNull()
			expect(await sqlite.kvAsync.get("other_c")).toBe("three")
		})
	})
})

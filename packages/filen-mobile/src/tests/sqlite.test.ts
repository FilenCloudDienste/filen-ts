import { vi, describe, it, expect, beforeEach } from "vitest"

// Capture the AppState 'change' handler the Sqlite constructor registers.
// Must be declared before vi.mock calls so hoisting can close over it.
let capturedAppStateHandler: ((state: string) => void) | null = null

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

// Custom react-native mock that also captures the AppState.addEventListener handler.
vi.mock("react-native", () => ({
	AppState: {
		addEventListener: vi.fn((_type: string, handler: (state: string) => void) => {
			capturedAppStateHandler = handler

			return { remove: vi.fn() }
		})
	},
	Platform: {
		OS: "ios" as "ios" | "android",
		select<T>(specifics: { ios?: T; android?: T; default?: T }): T | undefined {
			return (specifics as any)["ios"] ?? (specifics as any)["default"]
		}
	}
}))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

// Shared module references that survive across tests without resetModules.
// We import them once at the top level — they stay consistent with what
// sqlite.ts imports (same module evaluation, same object references).
let sqliteModule: typeof import("@/lib/sqlite") | null = null
let storageRootsModule: typeof import("@/lib/storageRoots") | null = null
let expoFsModule: typeof import("@/tests/mocks/expoFileSystem") | null = null

type Sqlite = any

async function getModules() {
	if (!sqliteModule) {
		sqliteModule = await import("@/lib/sqlite")
		storageRootsModule = await import("@/lib/storageRoots")
		expoFsModule = await import("@/tests/mocks/expoFileSystem")
	}

	return { sqliteModule, storageRootsModule: storageRootsModule!, expoFsModule: expoFsModule! }
}

async function createSqlite(): Promise<Sqlite> {
	const { sqliteModule } = await getModules()

	return new (sqliteModule!.default.constructor as new () => Sqlite)()
}

// Clear the op-sqlite store between tests; also clear the expo-file-system
// backing map so Directory.exists returns false for a freshly created instance.
async function resetAll() {
	vi.clearAllMocks()
	mockDb._reset()
	open.mockReturnValue(mockDb)
	capturedAppStateHandler = null

	const { expoFsModule } = await getModules()

	expoFsModule.fs.clear()
}

describe("Sqlite", () => {
	beforeEach(async () => {
		await resetAll()
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

		it("creates the DB_FILE_DIRECTORY when it does not exist", async () => {
			// expoFsModule.fs is cleared in beforeEach, so Directory.exists === false
			// on any URI not yet present in the map. The spy must be set before init().
			const sqlite = await createSqlite()
			const { storageRootsModule } = await getModules()
			const dir = storageRootsModule.SQLITE_DB_FILE_DIRECTORY
			const createSpy = vi.spyOn(dir, "create")

			await sqlite.init()

			expect(createSpy).toHaveBeenCalledWith({ idempotent: true, intermediates: true })
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

		it("returns null when insertId is undefined (insertId ?? null coercion)", async () => {
			const sqlite = await createSqlite()

			// The INIT_QUERIES batch is the first execute() call; replace the mock
			// with one that returns insertId: undefined specifically for INSERT queries.
			// All other calls (PRAGMA, etc.) fall through to the real executeImpl via
			// the default implementation already on mockDb.execute.
			const originalImpl = mockDb.execute.getMockImplementation()!

			mockDb.execute.mockImplementation(async (query: string, params?: unknown[]) => {
				if (query.startsWith("INSERT")) {
					return { rows: [], insertId: undefined, rowsAffected: 1 }
				}

				return originalImpl(query, params)
			})

			const result = await sqlite.kvAsync.set("any-key", "any-value")

			expect(result).toBeNull()
		})
	})

	describe("kvAsync.get", () => {
		it("returns null for missing key", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.get("nonexistent")

			expect(result).toBeNull()
		})

		it("returns the deserialized value for an existing key", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("existing-key", { foo: "bar", n: 42 })
			const result = await sqlite.kvAsync.get("existing-key")

			expect(result).toEqual({ foo: "bar", n: 42 })
		})

		it("rejects when the stored value is corrupt and cannot be deserialized", async () => {
			const sqlite = await createSqlite()

			// Inject raw corrupt data directly into the backing store, bypassing
			// set() so the serializer never processes it.
			mockDb._store.set("corrupt-key", "}{not valid json at all")

			await expect(sqlite.kvAsync.get("corrupt-key")).rejects.toThrow()
		})
	})

	describe("kvAsync.keys", () => {
		it("returns all keys when entries exist", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("alpha", "1")
			await sqlite.kvAsync.set("beta", "2")
			await sqlite.kvAsync.set("gamma", "3")

			const keys = await sqlite.kvAsync.keys()

			expect([...keys].sort()).toEqual(["alpha", "beta", "gamma"])
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
		it("removes all entries from the store", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("a", "1")
			await sqlite.kvAsync.set("b", "2")

			await sqlite.kvAsync.clear()

			expect(await sqlite.kvAsync.keys()).toEqual([])
			expect(await sqlite.kvAsync.contains("a")).toBe(false)
			expect(await sqlite.kvAsync.contains("b")).toBe(false)
		})

		it("is a no-op when the store is already empty", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.clear()

			expect(await sqlite.kvAsync.keys()).toEqual([])
		})
	})

	describe("kvAsync.keysByPrefix", () => {
		it("returns only keys matching the prefix", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("cache:v1:map:a", "1")
			await sqlite.kvAsync.set("cache:v1:map:b", "2")
			await sqlite.kvAsync.set("other:c", "3")

			const keys = await sqlite.kvAsync.keysByPrefix("cache:v1:map:")

			expect([...keys].sort()).toEqual(["cache:v1:map:a", "cache:v1:map:b"])
		})

		it("returns empty array when no keys match the prefix", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("unrelated:x", "1")

			const keys = await sqlite.kvAsync.keysByPrefix("nope:")

			expect(keys).toEqual([])
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
		it("removes all entries from the store", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("one", "1")
			await sqlite.kvAsync.set("two", "2")

			await sqlite.clearAsync()

			expect(await sqlite.kvAsync.keys()).toEqual([])
			expect(await sqlite.kvAsync.contains("one")).toBe(false)
			expect(await sqlite.kvAsync.contains("two")).toBe(false)
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

	describe("AppState background maintenance", () => {
		it("runs WAL checkpoint, incremental_vacuum, and optimize when app backgrounds", async () => {
			// createSqlite() creates a new Sqlite instance. Its constructor registers
			// an AppState listener, which is captured in capturedAppStateHandler.
			// The listener's body references `sqlite` (the module-level singleton),
			// so we must initialize the SINGLETON (mod.default) to get sqlite.db set.
			const { sqliteModule } = await getModules()
			const singleton = sqliteModule!.default

			// Create a new instance to trigger the AppState.addEventListener call
			// so capturedAppStateHandler is populated.
			await createSqlite()

			expect(capturedAppStateHandler).not.toBeNull()

			// Initialize the singleton — the handler checks !sqlite.db (the singleton).
			await singleton.init()

			// Firing 'active' should not trigger maintenance.
			await (capturedAppStateHandler as (state: string) => void)("active")

			const callsBefore = mockDb.execute.mock.calls.length

			// Firing 'background' triggers the three PRAGMA maintenance queries.
			await (capturedAppStateHandler as (state: string) => void)("background")

			// Allow the async run() inside the handler to settle.
			await new Promise(resolve => setTimeout(resolve, 0))

			const maintenanceCalls = mockDb.execute.mock.calls.slice(callsBefore).map(call => call[0] as string)

			expect(maintenanceCalls).toContain("PRAGMA wal_checkpoint(PASSIVE)")
			expect(maintenanceCalls).toContain("PRAGMA incremental_vacuum(64)")
			expect(maintenanceCalls).toContain("PRAGMA optimize")
		})

		it("skips maintenance when db is not yet open", async () => {
			// Create an instance to register the AppState listener.
			// Do NOT call init() on the singleton — db stays null.
			const { sqliteModule } = await getModules()
			const singleton = sqliteModule!.default

			// Ensure singleton.db is null (it starts null; clearAllMocks won't affect it)
			;(singleton as any).db = null
			;(singleton as any).initDone = false

			await createSqlite()

			expect(capturedAppStateHandler).not.toBeNull()

			await (capturedAppStateHandler as (state: string) => void)("background")
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockDb.execute).not.toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE)")
		})
	})
})

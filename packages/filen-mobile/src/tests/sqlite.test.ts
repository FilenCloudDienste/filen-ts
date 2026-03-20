import { vi, describe, it, expect, beforeEach } from "vitest"

const { UniffiEnum } = vi.hoisted(() => ({
	UniffiEnum: class UniffiEnum {
		protected constructor(..._args: any[]) {}
	}
}))

const { mockDb, openDatabaseAsync } = vi.hoisted(() => {
	const mockDb = {
		execAsync: vi.fn(),
		getFirstAsync: vi.fn(),
		getAllAsync: vi.fn(),
		runAsync: vi.fn()
	}

	const openDatabaseAsync = vi.fn().mockResolvedValue(mockDb)

	return { mockDb, openDatabaseAsync }
})

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-sqlite", () => ({
	openDatabaseAsync
}))

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app"
}))

import { pack } from "@/lib/msgpack"

type Sqlite = any

async function createSqlite(): Promise<Sqlite> {
	const mod = await import("@/lib/sqlite")

	return new (mod.default.constructor as new () => Sqlite)()
}

describe("Sqlite", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.resetModules()
		mockDb.execAsync.mockResolvedValue(undefined)
		mockDb.runAsync.mockResolvedValue({ lastInsertRowId: 1, changes: 1 })
		mockDb.getFirstAsync.mockResolvedValue(null)
		mockDb.getAllAsync.mockResolvedValue([])
	})

	describe("init", () => {
		it("calls openDatabaseAsync and runs INIT_QUERIES via execAsync", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()

			expect(openDatabaseAsync).toHaveBeenCalledTimes(1)
			expect(openDatabaseAsync).toHaveBeenCalledWith("sqlite.v1.db", { useNewConnection: true }, expect.any(String))
			expect(mockDb.execAsync).toHaveBeenCalledTimes(1)

			const execArg = mockDb.execAsync.mock.calls[0]![0] as string

			expect(execArg).toContain("PRAGMA journal_mode = WAL")
			expect(execArg).toContain("CREATE TABLE IF NOT EXISTS kv")
			expect(execArg).toContain("PRAGMA optimize")
		})

		it("is idempotent — calling init twice only opens db once", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()
			await sqlite.init()

			expect(openDatabaseAsync).toHaveBeenCalledTimes(1)
			expect(mockDb.execAsync).toHaveBeenCalledTimes(1)
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

			// Force init to complete without setting db
			;(sqlite as any).initDone = true
			;(sqlite as any).db = null

			await expect(sqlite.openDb()).rejects.toThrow("SQLite database not initialized")
		})
	})

	describe("kvAsync.set", () => {
		it("calls runAsync with INSERT OR REPLACE and returns lastInsertRowId", async () => {
			mockDb.runAsync.mockResolvedValue({ lastInsertRowId: 42, changes: 1 })

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("test-key", "test-value")

			expect(result).toBe(42)
			expect(mockDb.runAsync).toHaveBeenCalledTimes(1)

			const [query, params] = mockDb.runAsync.mock.calls[0] as [string, unknown[]]

			expect(query).toBe("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
			expect(params[0]).toBe("test-key")
			expect(params[1]).toBeInstanceOf(Uint8Array)
		})

		it("returns null for null value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", null)

			expect(result).toBeNull()
			expect(mockDb.runAsync).not.toHaveBeenCalled()
		})

		it("returns null for undefined value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", undefined)

			expect(result).toBeNull()
			expect(mockDb.runAsync).not.toHaveBeenCalled()
		})
	})

	describe("kvAsync.get", () => {
		it("calls getFirstAsync and unpacks result", async () => {
			const packed = new Uint8Array(pack({ hello: "world" }))

			mockDb.getFirstAsync.mockResolvedValue({ value: packed })

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.get("test-key")

			expect(result).toEqual({ hello: "world" })
			expect(mockDb.getFirstAsync).toHaveBeenCalledWith("SELECT value FROM kv WHERE key = ?", ["test-key"])
		})

		it("returns null for missing key", async () => {
			mockDb.getFirstAsync.mockResolvedValue(null)

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.get("nonexistent")

			expect(result).toBeNull()
		})
	})

	describe("kvAsync.keys", () => {
		it("returns array of keys", async () => {
			mockDb.getAllAsync.mockResolvedValue([{ key: "alpha" }, { key: "beta" }, { key: "gamma" }])

			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keys()

			expect(keys).toEqual(["alpha", "beta", "gamma"])
			expect(mockDb.getAllAsync).toHaveBeenCalledWith("SELECT key FROM kv")
		})

		it("returns empty array when no rows", async () => {
			mockDb.getAllAsync.mockResolvedValue([])

			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keys()

			expect(keys).toEqual([])
		})
	})

	describe("kvAsync.contains", () => {
		it("returns true when key exists", async () => {
			mockDb.getFirstAsync.mockResolvedValue({ key: "existing" })

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.contains("existing")

			expect(result).toBe(true)
			expect(mockDb.getFirstAsync).toHaveBeenCalledWith("SELECT key FROM kv WHERE key = ?", ["existing"])
		})

		it("returns false when key does not exist", async () => {
			mockDb.getFirstAsync.mockResolvedValue(null)

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.contains("missing")

			expect(result).toBe(false)
		})
	})

	describe("kvAsync.remove", () => {
		it("calls runAsync with DELETE WHERE", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.remove("doomed-key")

			expect(mockDb.runAsync).toHaveBeenCalledWith("DELETE FROM kv WHERE key = ?", ["doomed-key"])
		})
	})

	describe("kvAsync.clear", () => {
		it("calls runAsync with DELETE (no WHERE)", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.clear()

			expect(mockDb.runAsync).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("clearAsync", () => {
		it("calls execAsync with DELETE FROM kv", async () => {
			const sqlite = await createSqlite()

			await sqlite.clearAsync()

			expect(mockDb.execAsync).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("round-trip via pack/unpack", () => {
		it("set then get preserves the value through msgpack", async () => {
			const store = new Map<string, Uint8Array>()

			mockDb.runAsync.mockImplementation(async (query: string, params?: unknown[]) => {
				if (query.startsWith("INSERT")) {
					store.set(params![0] as string, params![1] as Uint8Array)
				}

				return { lastInsertRowId: 1, changes: 1 }
			})

			mockDb.getFirstAsync.mockImplementation(async (_query: string, params?: unknown[]) => {
				const value = store.get(params![0] as string)

				if (!value) {
					return null
				}

				return { value }
			})

			const sqlite = await createSqlite()

			const data = { numbers: [1, 2, 3], nested: { ok: true } }

			await sqlite.kvAsync.set("roundtrip", data)
			const result = await sqlite.kvAsync.get("roundtrip")

			expect(result).toEqual(data)
		})

		it("set then get preserves string values", async () => {
			const store = new Map<string, Uint8Array>()

			mockDb.runAsync.mockImplementation(async (query: string, params?: unknown[]) => {
				if (query.startsWith("INSERT")) {
					store.set(params![0] as string, params![1] as Uint8Array)
				}

				return { lastInsertRowId: 1, changes: 1 }
			})

			mockDb.getFirstAsync.mockImplementation(async (_query: string, params?: unknown[]) => {
				const value = store.get(params![0] as string)

				if (!value) {
					return null
				}

				return { value }
			})

			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("greeting", "hello world")
			const result = await sqlite.kvAsync.get("greeting")

			expect(result).toBe("hello world")
		})
	})
})

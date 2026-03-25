import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockDb, open } = vi.hoisted(() => ({
	mockDb: {
		execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeSync: vi.fn().mockReturnValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
		executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
		close: vi.fn()
	},
	open: vi.fn()
}))

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
		open.mockReturnValue(mockDb)
		mockDb.execute.mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 })
		mockDb.executeBatch.mockResolvedValue({ rowsAffected: 0 })
	})

	describe("init", () => {
		it("calls open and runs INIT_QUERIES via execute", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()

			expect(open).toHaveBeenCalledTimes(1)
			expect(open).toHaveBeenCalledWith({
				name: "sqlite.db",
				location: expect.any(String)
			})
			expect(mockDb.execute).toHaveBeenCalledTimes(1)

			const execArg = mockDb.execute.mock.calls[0]![0] as string

			expect(execArg).toContain("PRAGMA journal_mode = WAL")
			expect(execArg).toContain("CREATE TABLE IF NOT EXISTS kv")
			expect(execArg).toContain("PRAGMA optimize")
		})

		it("is idempotent — calling init twice only opens db once", async () => {
			const sqlite = await createSqlite()

			await sqlite.init()
			await sqlite.init()

			expect(open).toHaveBeenCalledTimes(1)
			expect(mockDb.execute).toHaveBeenCalledTimes(1)
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
		it("calls execute with INSERT OR REPLACE and returns insertId", async () => {
			const sqlite = await createSqlite()

			mockDb.execute.mockResolvedValue({ rows: [], insertId: 42, rowsAffected: 1 })

			const result = await sqlite.kvAsync.set("test-key", "test-value")

			expect(result).toBe(42)

			const calls = mockDb.execute.mock.calls
			const [query, params] = calls[calls.length - 1] as [string, unknown[]]

			expect(query).toBe("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
			expect(params[0]).toBe("test-key")
			expect(params[1]).toBeInstanceOf(Uint8Array)
		})

		it("returns null for null value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", null)

			expect(result).toBeNull()
			expect(mockDb.execute).not.toHaveBeenCalled()
		})

		it("returns null for undefined value", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.set("key", undefined)

			expect(result).toBeNull()
			expect(mockDb.execute).not.toHaveBeenCalled()
		})
	})

	describe("kvAsync.get", () => {
		it("calls execute and unpacks result", async () => {
			const packed = new Uint8Array(pack({ hello: "world" }))

			mockDb.execute.mockResolvedValue({ rows: [{ value: packed.buffer }], insertId: undefined, rowsAffected: 0 })

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.get("test-key")

			expect(result).toEqual({ hello: "world" })
			expect(mockDb.execute).toHaveBeenCalledWith("SELECT value FROM kv WHERE key = ?", ["test-key"])
		})

		it("returns null for missing key", async () => {
			mockDb.execute.mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 })

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.get("nonexistent")

			expect(result).toBeNull()
		})
	})

	describe("kvAsync.keys", () => {
		it("returns array of keys", async () => {
			mockDb.execute.mockResolvedValue({
				rows: [{ key: "alpha" }, { key: "beta" }, { key: "gamma" }],
				insertId: undefined,
				rowsAffected: 0
			})

			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keys()

			expect(keys).toEqual(["alpha", "beta", "gamma"])
			expect(mockDb.execute).toHaveBeenCalledWith("SELECT key FROM kv")
		})

		it("returns empty array when no rows", async () => {
			const sqlite = await createSqlite()
			const keys = await sqlite.kvAsync.keys()

			expect(keys).toEqual([])
		})
	})

	describe("kvAsync.contains", () => {
		it("returns true when key exists", async () => {
			mockDb.execute.mockResolvedValue({ rows: [{ key: "existing" }], insertId: undefined, rowsAffected: 0 })

			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.contains("existing")

			expect(result).toBe(true)
			expect(mockDb.execute).toHaveBeenCalledWith("SELECT key FROM kv WHERE key = ?", ["existing"])
		})

		it("returns false when key does not exist", async () => {
			const sqlite = await createSqlite()
			const result = await sqlite.kvAsync.contains("missing")

			expect(result).toBe(false)
		})
	})

	describe("kvAsync.remove", () => {
		it("calls execute with DELETE WHERE", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.remove("doomed-key")

			expect(mockDb.execute).toHaveBeenCalledWith("DELETE FROM kv WHERE key = ?", ["doomed-key"])
		})
	})

	describe("kvAsync.clear", () => {
		it("calls execute with DELETE (no WHERE)", async () => {
			const sqlite = await createSqlite()

			await sqlite.kvAsync.clear()

			expect(mockDb.execute).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("clearAsync", () => {
		it("calls execute with DELETE FROM kv", async () => {
			const sqlite = await createSqlite()

			await sqlite.clearAsync()

			expect(mockDb.execute).toHaveBeenCalledWith("DELETE FROM kv")
		})
	})

	describe("round-trip via pack/unpack", () => {
		it("set then get preserves the value through msgpack", async () => {
			const store = new Map<string, Uint8Array>()

			mockDb.execute.mockImplementation(async (query: string, params?: unknown[]) => {
				if (query.startsWith("INSERT")) {
					store.set(params![0] as string, params![1] as Uint8Array)

					return { rows: [], insertId: 1, rowsAffected: 1 }
				}

				if (query.startsWith("SELECT value")) {
					const value = store.get(params![0] as string)

					return { rows: value ? [{ value: value.buffer }] : [], insertId: undefined, rowsAffected: 0 }
				}

				return { rows: [], insertId: undefined, rowsAffected: 0 }
			})

			const sqlite = await createSqlite()

			const data = { numbers: [1, 2, 3], nested: { ok: true } }

			await sqlite.kvAsync.set("roundtrip", data)
			const result = await sqlite.kvAsync.get("roundtrip")

			expect(result).toEqual(data)
		})

		it("set then get preserves string values", async () => {
			const store = new Map<string, Uint8Array>()

			mockDb.execute.mockImplementation(async (query: string, params?: unknown[]) => {
				if (query.startsWith("INSERT")) {
					store.set(params![0] as string, params![1] as Uint8Array)

					return { rows: [], insertId: 1, rowsAffected: 1 }
				}

				if (query.startsWith("SELECT value")) {
					const value = store.get(params![0] as string)

					return { rows: value ? [{ value: value.buffer }] : [], insertId: undefined, rowsAffected: 0 }
				}

				return { rows: [], insertId: undefined, rowsAffected: 0 }
			})

			const sqlite = await createSqlite()

			await sqlite.kvAsync.set("greeting", "hello world")
			const result = await sqlite.kvAsync.get("greeting")

			expect(result).toBe("hello world")
		})
	})
})

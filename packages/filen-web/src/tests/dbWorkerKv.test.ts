import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { StorageApi } from "@/workers/db.worker"

// The kv ops against a real sqlite (the package's node build, in memory): only the OPFS pool install is
// swapped out, so the SQL the worker runs is exactly what ships.

const mocks = vi.hoisted(() => ({
	expose: vi.fn(),
	db: null as { selectValue: (sql: string) => unknown; isOpen: () => boolean } | null,
	wipeFiles: vi.fn<() => Promise<void>>()
}))

vi.mock("comlink", () => ({ expose: mocks.expose }))
vi.mock("@sqlite.org/sqlite-wasm", async importOriginal => {
	const actual = await importOriginal<typeof import("@sqlite.org/sqlite-wasm")>()

	return {
		default: async () => {
			const sqlite3 = await actual.default()

			class MemoryDb extends sqlite3.oo1.DB {
				public constructor() {
					super(":memory:")
					mocks.db = this
				}
			}

			// A fresh in-memory connection after a wipe is empty, as reopening the cut-back pool files is.
			return { installOpfsSAHPoolVfs: () => Promise.resolve({ OpfsSAHPoolDb: MemoryDb, wipeFiles: mocks.wipeFiles }) }
		}
	}
})

let api: StorageApi

beforeAll(async () => {
	vi.stubGlobal("navigator", {
		storage: { getDirectory: () => Promise.reject(new DOMException("missing", "NotFoundError")) }
	})
	await import("@/workers/db.worker")
	api = mocks.expose.mock.calls[0]?.[0] as StorageApi
	await api.open()
})

beforeEach(async () => {
	await api.kvDeletePrefix("")
})

describe("db.worker wipe", () => {
	it("cuts the pool files back with the connection closed, then serves an empty database", async () => {
		await api.kvSet("session", "secret")
		const before = mocks.db
		let openDuringWipe: boolean | undefined

		mocks.wipeFiles.mockImplementationOnce(() => {
			openDuringWipe = before?.isOpen()

			return Promise.resolve()
		})

		await api.wipe()

		expect(openDuringWipe).toBe(false)
		expect(mocks.db).not.toBe(before)
		expect(await api.kvGet("session")).toBeNull()
		await api.kvSet("after", "1")
		expect(await api.kvGet("after")).toBe("1")
	})
})

describe("db.worker open", () => {
	it("bounds the journal the connection keeps between writes", () => {
		expect(mocks.db?.selectValue("PRAGMA journal_size_limit")).toBe(1048576)
	})
})

describe("db.worker bulk kv ops", () => {
	it("kvEntries returns every row under a prefix in one call, and nothing outside it", async () => {
		await api.kvSet("rq.v3-a", "1")
		await api.kvSet("rq.v3-b", "2")
		await api.kvSet("rq.v2-c", "3")
		await api.kvSet("rq/", "outside")
		await api.kvSet("photos.rootUuid.v1", "outside")

		const rows = await api.kvEntries("rq.")

		expect([...rows].sort()).toEqual([
			["rq.v2-c", "3"],
			["rq.v3-a", "1"],
			["rq.v3-b", "2"]
		])
	})

	it("matches LIKE wildcards and letter case literally", async () => {
		await api.kvSet("a_b-1", "literal")
		await api.kvSet("axb-1", "wildcard")
		await api.kvSet("A_B-1", "upper")
		await api.kvSet("a%b-1", "percent")

		expect(await api.kvEntries("a_b")).toEqual([["a_b-1", "literal"]])
		expect(await api.kvEntries("a%")).toEqual([["a%b-1", "percent"]])
		expect(await api.kvKeys("a_b")).toEqual(["a_b-1"])
	})

	it("kvDeletePrefix drops every row under the prefix and leaves the rest", async () => {
		await api.kvSet("rq.v3-a", "1")
		await api.kvSet("rq.v2-b", "2")
		await api.kvSet("keymap.v1", "kept")

		await api.kvDeletePrefix("rq.")

		expect(await api.kvKeys("")).toEqual(["keymap.v1"])
	})

	it("an empty prefix covers every key", async () => {
		await api.kvSet("a", "1")
		await api.kvSet("\u{10ffff}", "2")

		expect(await api.kvEntries("")).toHaveLength(2)

		await api.kvDeletePrefix("")

		expect(await api.kvKeys("")).toEqual([])
	})
})

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
vi.mock("@sqlite.org/sqlite-wasm", async importOriginal =>
	(await import("@/tests/support/dbWorkerSqlite")).memorySqliteModule(await importOriginal(), {
		onOpen: db => {
			mocks.db = db
		},
		wipeFiles: mocks.wipeFiles
	})
)

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

	it("kvDeleteIfAt drops only rows still holding the planned at, and names them", async () => {
		await api.kvSet("r.a", '{"value":1,"at":5}')
		await api.kvSet("r.b", '{"value":2,"at":7}')
		await api.kvSet("r.c", "not json")
		await api.kvSet("r.d", "[1]")
		await api.kvSet("r.e", '{"at":"5"}')

		expect(
			await api.kvDeleteIfAt([
				["r.a", 5],
				["r.b", 6],
				["r.c", 1],
				["r.d", 1],
				["r.e", 5],
				["r.missing", 1]
			])
		).toEqual(["r.a"])
		expect(await api.kvKeys("r.")).toEqual(["r.b", "r.c", "r.d", "r.e"])
	})

	it("kvDeletePrefix drops every row under the prefix and leaves the rest", async () => {
		await api.kvSet("rq.v3-a", "1")
		await api.kvSet("rq.v2-b", "2")
		await api.kvSet("keymap.v1", "kept")

		await api.kvDeletePrefix("rq.")

		expect(await api.kvKeys("")).toEqual(["keymap.v1"])
	})

	it("kvEntriesPage reads a prefix in key order a page at a time, from after the last key read", async () => {
		for (let n = 0; n < 25; n++) {
			await api.kvSet(`p.${String(n).padStart(2, "0")}`, String(n))
		}

		await api.kvSet("o.outside", "x")
		await api.kvSet("q.outside", "x")

		const pages: string[][] = []
		let after: string | null = null

		for (;;) {
			const page: [string, string][] = await api.kvEntriesPage("p.", after, 10)

			pages.push(page.map(([key]) => key))

			if (page.length < 10) {
				break
			}

			after = page.at(-1)?.[0] ?? null
		}

		expect(pages.map(page => page.length)).toEqual([10, 10, 5])
		expect(pages.flat()).toEqual(Array.from({ length: 25 }, (_, n) => `p.${String(n).padStart(2, "0")}`))
		expect(await api.kvEntriesPage("", "p.24", 10)).toEqual([["q.outside", "x"]])
	})

	it("kvEntriesPage ends on a page boundary with an empty page, and keeps to the prefix at both bounds", async () => {
		// The prefix itself is a key under it; the upper bound ("q/" after "q.") is not.
		for (const key of ["q.", "q.a", "q.b", "q.c", "q/", "q-", "p.z"]) {
			await api.kvSet(key, key)
		}

		expect(await api.kvEntriesPage("q.", null, 2)).toEqual([
			["q.", "q."],
			["q.a", "q.a"]
		])
		expect(await api.kvEntriesPage("q.", "q.a", 2)).toEqual([
			["q.b", "q.b"],
			["q.c", "q.c"]
		])
		// Exactly a page's worth read: the next page is empty.
		expect(await api.kvEntriesPage("q.", "q.c", 2)).toEqual([])
		// A key equal to the resume point is not read again; one below the prefix leaves the prefix as the bound.
		expect((await api.kvEntriesPage("q.", "q.b", 10)).map(([key]) => key)).toEqual(["q.c"])
		expect((await api.kvEntriesPage("q.", "a", 10)).map(([key]) => key)).toEqual(["q.", "q.a", "q.b", "q.c"])
		// An empty prefix pages through every key.
		expect((await api.kvEntriesPage("", null, 3)).map(([key]) => key)).toEqual(["p.z", "q-", "q."])
		expect((await api.kvEntriesPage("", "q.c", 3)).map(([key]) => key)).toEqual(["q/"])
		expect(await api.kvEntriesPage("", "q/", 3)).toEqual([])
		// The one-call reads are unchanged by it.
		expect((await api.kvEntries("q.")).map(([key]) => key).sort()).toEqual(["q.", "q.a", "q.b", "q.c"])
		expect((await api.kvKeys("q.")).sort()).toEqual(["q.", "q.a", "q.b", "q.c"])
	})

	it("an empty prefix covers every key", async () => {
		await api.kvSet("a", "1")
		await api.kvSet("\u{10ffff}", "2")

		expect(await api.kvEntries("")).toHaveLength(2)

		await api.kvDeletePrefix("")

		expect(await api.kvKeys("")).toEqual([])
	})
})

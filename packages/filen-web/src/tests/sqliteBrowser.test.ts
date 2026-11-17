import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import { formatBytes } from "@filen/shared"
import { tileKeyRow, type SheetTile } from "@filen/office/core/sheet"
import {
	SCHEMA_LIMITS,
	SqliteBrowser,
	SqliteOpenError,
	isSqliteInterrupted,
	isSqliteUnreadable,
	sqliteApiConfig,
	type SqliteLabels,
	type SqliteSource
} from "@/features/preview/lib/sqliteBrowser"
import type { SyncByteReader } from "@/features/preview/lib/sqliteRangeVfs"
import {
	INTERRUPT_CHECK,
	INTERRUPT_COUNT,
	INTERRUPT_TILES,
	SQLITE_COUNT_CHUNK,
	SQLITE_FIRST_COUNT_CHUNK,
	SQLITE_HEADER_READ_VERSION,
	SQLITE_HEADER_WRITE_VERSION,
	SQLITE_HEX_DUMP_BYTES,
	SQLITE_INTERRUPT_SLOTS
} from "@/features/preview/lib/sqliteBrowse.logic"

// The SQLite browser against the real engine (the package's node build), on databases node:sqlite writes: both ways
// in (the range VFS, and whole into sqlite's memory) answer the same, the hardening holds, virtual tables and views
// are listed and never run, rows are counted in chunks however sparse their keys, and the integrity check finds damage.

const LABELS: SqliteLabels = { null: "NULL", text: "Text, {{size}}", blob: "BLOB, {{size}}" }
const BIG_TEXT_BYTES = 70_000

let sqlite3: Sqlite3Static
let directory: string

function database(build: (db: DatabaseSync) => void, options: { wal?: boolean } = {}): Uint8Array {
	const path = join(directory, `${crypto.randomUUID()}.sqlite`)
	const db = new DatabaseSync(path)

	if (options.wal === true) db.exec("PRAGMA journal_mode=WAL")

	build(db)

	if (options.wal === true) db.exec("PRAGMA wal_checkpoint(TRUNCATE)")

	db.close()

	return new Uint8Array(readFileSync(path))
}

// A range reader over bytes held in memory, counting what it was asked for.
function memoryReader(bytes: Uint8Array, fail = false): SyncByteReader & { reads: number } {
	return {
		length: bytes.length,
		reads: 0,
		read(target, offset, length, position) {
			this.reads++

			// Every read after the header's fails, as an aborted or timed-out bridge read does.
			if (fail && this.reads > 1) return -1

			const slice = bytes.subarray(position, Math.min(bytes.length, position + length))

			target.set(slice, offset)

			return slice.length
		}
	}
}

// The bytes in blocks of `blockBytes` (small by default, so blocks are stitched at many boundaries), counting reads.
function whole(bytes: Uint8Array, blockBytes = 4096): SqliteSource & { reads: number } {
	return {
		kind: "whole",
		size: bytes.length,
		blockBytes,
		reads: 0,
		read(start, end) {
			this.reads++

			return Promise.resolve(bytes.slice(start, end))
		}
	}
}

async function open(source: SqliteSource): Promise<SqliteBrowser> {
	return await SqliteBrowser.open(sqlite3, source, LABELS, new Int32Array(new SharedArrayBuffer(4 * SQLITE_INTERRUPT_SLOTS)))
}

function only<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing")

	return value
}

// A tile's texts by grid row and column.
function texts(tile: SheetTile): Map<string, string> {
	const out = new Map<string, string>()

	for (let i = 0; i < tile.count; i++) {
		const position = tile.positions[i] ?? 0
		const text = tile.strings[tile.texts[i] ?? -1]

		out.set(`${String(tile.tileRow * 64 + (position >>> 5))}:${String(position & 31)}`, text ?? "")
	}

	return out
}

const APP = (db: DatabaseSync): void => {
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, doc TEXT, avatar BLOB, big INTEGER);
		CREATE TABLE log (n INTEGER);
		CREATE TABLE pairs (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
		CREATE TABLE odd (rowid TEXT, oid TEXT, _rowid_ TEXT);
		CREATE VIEW emails AS SELECT email FROM users;
		CREATE TRIGGER audit AFTER INSERT ON users BEGIN INSERT INTO log VALUES (1); END;
		CREATE VIRTUAL TABLE notes USING fts5(body);
		INSERT INTO notes VALUES ('hello');
	`)

	const insert = db.prepare("INSERT INTO users (id, email, doc, avatar, big) VALUES (?, ?, ?, ?, ?)")

	insert.run(1, "a@ex.com", "x".repeat(BIG_TEXT_BYTES), new Uint8Array([1, 2, 3]), 9007199254740993n)
	insert.run(2, "b@ex.com", null, null, 7)

	for (let i = 0; i < 70; i++) db.prepare("INSERT INTO pairs VALUES (?, ?, ?)").run(i < 35 ? "a" : "b", i, `v${String(i)}`)

	db.prepare("INSERT INTO odd VALUES ('r', 'o', 'u')").run()
}

beforeAll(async () => {
	Object.assign(globalThis, { sqlite3ApiConfig: sqliteApiConfig() })
	sqlite3 = await sqlite3InitModule()
	directory = mkdtempSync(join(tmpdir(), "sqlite-browser-"))
})

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
})

describe("SqliteBrowser", () => {
	it("lists tables, views and virtual tables (shadow tables browsable), and pages each table by its key", async () => {
		const browser = await open({ kind: "ranged", reader: memoryReader(database(APP)) })
		const kinds = Object.fromEntries(browser.schema.tables.map(table => [table.name, table.kind]))

		expect(kinds).toMatchObject({
			users: "table",
			emails: "view",
			notes: "virtual",
			notes_content: "table",
			pairs: "table",
			odd: "table"
		})
		expect(browser.schema.tables.find(table => table.name === "emails")?.sql).toContain("CREATE VIEW")
		expect(browser.schema.tables.find(table => table.name === "notes")?.columns).toEqual([])
		browser.close()
	})

	it("answers the same through the range VFS and whole in memory", async () => {
		const bytes = database(APP)
		const reader = memoryReader(bytes)
		const ranged = await open({ kind: "ranged", reader })
		const held = await open(whole(bytes))
		const users = ranged.schema.tables.findIndex(table => table.name === "users")

		const fromRanged = ranged.tiles(users, 0, Uint32Array.of(0, 0), 1)
		const fromWhole = held.tiles(users, 0, Uint32Array.of(0, 0), 1)

		expect(fromRanged).toEqual(fromWhole)

		const cells = texts(only(fromRanged[0]))

		expect(cells.get("0:1")).toBe("email")
		expect(cells.get("1:1")).toBe("a@ex.com")
		expect(cells.get("1:2")).toBe(`Text, ${formatBytes(BIG_TEXT_BYTES)}`)
		expect(cells.get("1:3")).toBe(`BLOB, ${formatBytes(3)}`)
		// Past 2^53, exact.
		expect(cells.get("1:4")).toBe("9007199254740993")
		expect(cells.get("2:2")).toBe("NULL")
		expect(ranged.countStep(users, 2)).toEqual({ rows: 2, exact: true })
		// Only some pages were read, not the whole file.
		expect(reader.reads).toBeGreaterThan(0)
		ranged.close()
		held.close()
	})

	it("runs no virtual table module's code over the file's data while opening and listing", async () => {
		const seen: string[] = []
		const { capi, wasm, oo1 } = sqlite3
		// Every statement each connection runs, nested ones (a module's own reads of its shadow tables) included.
		class TracedDb extends oo1.DB {
			constructor(...args: ConstructorParameters<typeof oo1.DB>) {
				super(...args)
				const record = (_reason: number, _ctx: number, _statement: number, sql: number): number => {
					seen.push(wasm.cstrToJs(sql) ?? "")

					return 0
				}

				// The binding takes the callback's argument too, which its typings leave out.
				Reflect.apply(capi.sqlite3_trace_v2, capi, [this.pointer ?? 0, capi.SQLITE_TRACE_STMT, record, 0])
			}
		}
		const traced = { ...sqlite3, oo1: { ...oo1, DB: TracedDb } } as Sqlite3Static
		const browser = await SqliteBrowser.open(
			traced,
			whole(
				database(db => {
					db.exec(
						"CREATE VIRTUAL TABLE f USING fts5(body); INSERT INTO f VALUES ('x'); CREATE VIRTUAL TABLE r USING rtree(id, a, b)"
					)
				})
			),
			LABELS,
			new Int32Array(new SharedArrayBuffer(4 * SQLITE_INTERRUPT_SLOTS))
		)

		expect(seen.filter(sql => sql.includes("'main'."))).toEqual([])
		expect(browser.schema.tables.filter(table => table.kind === "virtual").map(table => table.name)).toEqual(["f", "r"])
		expect(browser.schema.tables.find(table => table.name === "f_config")?.kind).toBe("table")
		browser.close()
	})

	it("sets the schema limits", async () => {
		const browser = await open(whole(database(APP)))
		const pointer = (browser as unknown as { db: { pointer: number } }).db.pointer

		for (const [limit, value] of SCHEMA_LIMITS) expect(sqlite3.capi.sqlite3_limit(pointer, sqlite3.capi[limit], -1), limit).toBe(value)

		browser.close()
	})

	it("refuses views, triggers, ATTACH and writes", async () => {
		const browser = await open(whole(database(APP)))
		const db = (browser as unknown as { db: { exec: (sql: string) => unknown } }).db

		expect(() => db.exec("SELECT * FROM emails")).toThrow()
		expect(() => db.exec("ATTACH ':memory:' AS other")).toThrow()
		expect(() => db.exec("INSERT INTO users (email) VALUES ('c')")).toThrow()
		browser.close()
	})

	it("walks a WITHOUT ROWID table by its key, and a table whose columns take every rowid alias by OFFSET", async () => {
		const browser = await open(whole(database(APP)))
		const pairs = browser.schema.tables.findIndex(table => table.name === "pairs")
		const odd = browser.schema.tables.findIndex(table => table.name === "odd")
		const [first, second] = browser.tiles(pairs, 0, Uint32Array.of(0, 0, 1, 0), 1)

		expect(texts(only(first)).get("63:2")).toBe("v62")
		expect(texts(only(second)).get("64:2")).toBe("v63")
		expect(texts(only(second)).get("70:2")).toBe("v69")
		expect(tileKeyRow(0)).toBe(0)
		expect(texts(only(browser.tiles(odd, 0, Uint32Array.of(0, 0), 2)[0])).get("1:0")).toBe("r")
		expect(browser.countStep(odd, 3)).toEqual({ rows: 1, exact: true })
		browser.close()
	})

	it("counts rows in chunks however sparse the keys, and reads a window past the grid's rows", async () => {
		const rows = SQLITE_COUNT_CHUNK * 2 + 17
		const browser = await open(
			whole(
				database(db => {
					db.exec("CREATE TABLE sparse (id INTEGER PRIMARY KEY, v INTEGER)")
					db.exec("BEGIN")

					const insert = db.prepare("INSERT INTO sparse VALUES (?, ?)")

					for (let i = 0; i < rows; i++) insert.run(BigInt(i) * 1_000_000_000_000n, i)

					db.exec("COMMIT")
				})
			)
		)
		const steps = []

		for (let step = browser.countStep(0, 1); ; step = browser.countStep(0, 1)) {
			steps.push(step)

			if (step.exact) break
		}

		// A small first chunk, so the grid draws before a large one has walked the table.
		expect(steps).toEqual([
			{ rows: SQLITE_FIRST_COUNT_CHUNK, exact: false },
			{ rows: SQLITE_FIRST_COUNT_CHUNK + SQLITE_COUNT_CHUNK, exact: false },
			{ rows, exact: true }
		])

		// Data row 100,010: grid row 11 of a window based at 100,000, walked from the last chunk's anchor.
		expect(texts(only(browser.tiles(0, 100_000, Uint32Array.of(0, 0), 2)[0])).get("11:1")).toBe("100010")
		expect(browser.cell(0, 100_000, 11, 1, 3)).toEqual({ type: "integer", bytes: 6, value: "100010" })
		browser.close()
	})

	it("counts first only the rows the first tile reads, so opening a table of large values reads no page past it", async () => {
		const pageBytes = 4096
		// Each row's value overflows: a few rows per leaf page, the leaves spread over the file between overflow chains.
		const bytes = database(db => {
			db.exec(`
				CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB);
				WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
				INSERT INTO blobs (payload) SELECT zeroblob(65536) FROM n;
			`)
		})
		const pages = new Set<number>()
		const reader = memoryReader(bytes)
		const read = reader.read.bind(reader)

		reader.read = (target, offset, length, position) => {
			for (let page = Math.floor(position / pageBytes); page <= Math.floor((position + length - 1) / pageBytes); page++)
				pages.add(page)

			return read(target, offset, length, position)
		}

		const browser = await open({ kind: "ranged", reader })

		expect(browser.countStep(0, 1)).toEqual({ rows: SQLITE_FIRST_COUNT_CHUNK, exact: false })

		const counted = pages.size
		const tile = only(browser.tiles(0, 0, Uint32Array.of(0, 0), 1)[0])

		// The tile's last data row is the count's last.
		expect(texts(tile).get(`${String(SQLITE_FIRST_COUNT_CHUNK)}:0`)).toBe(String(SQLITE_FIRST_COUNT_CHUNK))
		expect(pages.size).toBe(counted)

		// A step covers the rows it is asked for, no more.
		expect(browser.countStep(0, 1, 37)).toEqual({ rows: SQLITE_FIRST_COUNT_CHUNK + 37, exact: false })

		// The whole count reads every leaf, far more than the first step did.
		while (!browser.countStep(0, 1).exact);

		expect(pages.size).toBeGreaterThan(counted * 3)
		browser.close()
	})

	it("reads a WAL-mode file as rollback mode and says so, without changing the bytes", async () => {
		const bytes = database(APP, { wal: true })

		expect([bytes[SQLITE_HEADER_WRITE_VERSION], bytes[SQLITE_HEADER_READ_VERSION]]).toEqual([2, 2])

		const browser = await open({ kind: "ranged", reader: memoryReader(bytes) })

		expect(browser.schema.wal).toBe(true)
		expect(bytes[SQLITE_HEADER_WRITE_VERSION]).toBe(2)
		expect(browser.check(5, () => undefined)).toBe("ok")
		browser.close()
	})

	it("passes the integrity check, finds damage, and cancels on the flag", async () => {
		const bytes = database(APP)
		const interrupt = new Int32Array(new SharedArrayBuffer(4 * SQLITE_INTERRUPT_SLOTS))
		const browser = await SqliteBrowser.open(sqlite3, { kind: "ranged", reader: memoryReader(bytes) }, LABELS, interrupt)

		expect(browser.check(1, () => undefined)).toBe("ok")
		browser.close()

		// Long enough a check for the progress handler to see the flag.
		const many = database(db => {
			db.exec("CREATE TABLE t (v TEXT); BEGIN")

			for (let i = 0; i < 20_000; i++) db.prepare("INSERT INTO t VALUES (?)").run(`row ${String(i)}`)

			db.exec("COMMIT")
		})
		const cancelled = await SqliteBrowser.open(sqlite3, { kind: "ranged", reader: memoryReader(many) }, LABELS, interrupt)

		Atomics.store(interrupt, INTERRUPT_CHECK, 2)
		expect(cancelled.check(2, () => undefined)).toBe("cancelled")
		cancelled.close()

		// The users table's root page is overwritten with garbage past its header.
		const damaged = bytes.slice()
		const pageSize = (damaged[16] ?? 0) * 256 + (damaged[17] ?? 0)

		damaged.fill(0xff, pageSize * 2 + 8, pageSize * 3)

		const broken = await open(whole(damaged)).catch((error: unknown) => error)

		if (broken instanceof SqliteBrowser) {
			expect(broken.check(3, () => undefined)).toBe("damaged")
			broken.close()
		} else {
			expect(broken).toBeInstanceOf(SqliteOpenError)
		}
	})

	it("opens nothing through the range VFS but the database it was given", async () => {
		const browser = await open({ kind: "ranged", reader: memoryReader(database(APP)) })

		expect(() => new sqlite3.oo1.DB({ filename: "file:other.db?immutable=1", flags: "r", vfs: "filen-ranged" })).toThrow()
		browser.close()
	})

	it("reads a database cut short as damaged, never past its end", async () => {
		const bytes = database(APP)
		const pageSize = (bytes[16] ?? 0) * 256 + (bytes[17] ?? 0)
		// Every page past the third is gone: those reads come back short, zero-filled.
		const cut = await open({ kind: "ranged", reader: memoryReader(bytes.subarray(0, pageSize * 3)) }).catch((error: unknown) => error)

		if (cut instanceof SqliteBrowser) {
			expect(cut.check(1, () => undefined)).toBe("damaged")
			cut.close()
		} else {
			expect(cut).toMatchObject({ reason: "damaged" })
		}
	})

	it("stops stale tile requests and the count a grid read went ahead of, never a cell read", async () => {
		const interrupt = new Int32Array(new SharedArrayBuffer(4 * SQLITE_INTERRUPT_SLOTS))
		const browser = await SqliteBrowser.open(sqlite3, whole(database(APP)), LABELS, interrupt)
		const users = browser.schema.tables.findIndex(table => table.name === "users")
		const stopped = (run: () => unknown): boolean => {
			try {
				run()
			} catch (error) {
				return isSqliteInterrupted(error)
			}

			return false
		}

		Atomics.store(interrupt, INTERRUPT_TILES, 5)
		expect(stopped(() => browser.tiles(users, 0, Uint32Array.of(0, 0), 5))).toBe(true)
		expect(stopped(() => browser.tiles(users, 0, Uint32Array.of(0, 0), 6))).toBe(false)
		Atomics.store(interrupt, INTERRUPT_COUNT, 7)
		expect(stopped(() => browser.countStep(users, 7))).toBe(true)
		expect(stopped(() => browser.countStep(users, 8))).toBe(false)
		expect(stopped(() => browser.cell(users, 0, 1, 1, 1))).toBe(false)
		browser.close()
	})

	it("says a read that fails after opening is unreadable", async () => {
		const bytes = database(APP)
		const reader = memoryReader(bytes)
		const browser = await open({ kind: "ranged", reader })
		const users = browser.schema.tables.findIndex(table => table.name === "users")

		reader.read = () => -1

		const failure = (() => {
			try {
				browser.tiles(users, 0, Uint32Array.of(1, 0), 1)
			} catch (error) {
				return error
			}

			return null
		})()

		expect(isSqliteUnreadable(failure)).toBe(true)
		browser.close()
	})

	it("reads a BLOB's first 64 KiB only, however small it is", async () => {
		const blob = new Uint8Array(1024 * 1024).fill(7)
		const browser = await open(
			whole(
				database(db => {
					db.exec("CREATE TABLE t (b BLOB)")
					db.prepare("INSERT INTO t VALUES (?)").run(blob)
				})
			)
		)
		const value = browser.cell(0, 0, 1, 0, 1)

		expect(value.bytes).toBe(blob.length)
		expect(value.value).toHaveLength(SQLITE_HEX_DUMP_BYTES)
		browser.close()
	})

	it("reads only the first block of a whole file that is no database", async () => {
		const source = whole(new Uint8Array(64 * 1024).fill(1), 4096)

		await expect(open(source)).rejects.toMatchObject({ reason: "notSqlite" })
		expect(source.reads).toBe(1)
	})

	it("refuses a file that is no database, and one whose reads fail", async () => {
		const notDb = new TextEncoder().encode("SQLite format 2\0 and more bytes than that")

		await expect(open({ kind: "ranged", reader: memoryReader(notDb) })).rejects.toMatchObject({ reason: "notSqlite" })
		await expect(open(whole(notDb))).rejects.toMatchObject({ reason: "notSqlite" })
		await expect(open({ kind: "ranged", reader: memoryReader(database(APP), true) })).rejects.toMatchObject({ reason: "unreadable" })
	})
})

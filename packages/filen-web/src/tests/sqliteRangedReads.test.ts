import { once } from "node:events"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { MessageChannel, Worker } from "node:worker_threads"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { SYNC_RANGE_DEFAULT_SLOTS, SyncRangeReader, createSyncRangeBuffer } from "@filen/office/dom/pdfedit"
import { SqliteBrowser, sqliteApiConfig } from "@/features/preview/lib/sqliteBrowser"
import { SQLITE_FIRST_COUNT_CHUNK, SQLITE_INTERRUPT_SLOTS } from "@/features/preview/lib/sqliteBrowse.logic"

// A large database read in ranges the way the app reads it: the browser in this thread through the sync range reader,
// the app's serveFileSyncRange (its read-ahead included) in a thread of its own over the file, every source read
// counted as the 1 MiB chunk download it is. Rows of 1 MiB values, as in the large-database e2e: three rows to a leaf
// page, each leaf past its rows' overflow pages, so every leaf is a block of its own.

const ROWS = 150
const ROWS_PER_LEAF = 3

let sqlite3: Sqlite3Static
let directory: string
let path: string
let length: number

beforeAll(async () => {
	Object.assign(globalThis, { sqlite3ApiConfig: sqliteApiConfig() })
	sqlite3 = await sqlite3InitModule()
	directory = mkdtempSync(join(tmpdir(), "filen-sqlite-ranged-"))
	path = join(directory, "large.sqlite")

	const db = new DatabaseSync(path)

	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
		INSERT INTO users (email) VALUES ('first@example.com'), ('second@example.com');
		CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB);
		WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(ROWS)})
		INSERT INTO blobs (payload) SELECT zeroblob(${String(BLOCK_BYTES)}) FROM n;
	`)
	db.close()
	length = statSync(path).size
})

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
})

interface Served {
	readonly reader: SyncRangeReader
	// Source reads, and each block's.
	reads(): number
	blockReads(): number[]
	close(): Promise<void>
}

async function serve(): Promise<Served> {
	const blocks = Math.ceil(length / BLOCK_BYTES)
	const buffer = createSyncRangeBuffer(SYNC_RANGE_DEFAULT_SLOTS, BLOCK_BYTES)
	const counts = new Int32Array(new SharedArrayBuffer(4 * (1 + blocks)))
	const { port1, port2 } = new MessageChannel()
	const worker = new Worker(new URL("./fixtures/sqlite/rangeServer.ts", import.meta.url), {
		execArgv: ["--import", "tsx"],
		workerData: { path, length, buffer, port: port2, counts: counts.buffer },
		transferList: [port2]
	})

	await once(worker, "message")

	const reader = new SyncRangeReader(buffer, port1, length, { deadlineMs: 60_000, now: () => performance.now() })

	return {
		reader,
		reads: () => Atomics.load(counts, 0),
		blockReads: () => Array.from(counts.subarray(1)),
		close: async () => {
			reader.close()
			port1.close()
			await worker.terminate()
		}
	}
}

describe("a large database read in ranges", () => {
	it("downloads only the first tile's leaves to open, and each block once however much a taller view reads", async () => {
		const served = await serve()
		const browser = await SqliteBrowser.open(
			sqlite3,
			{ kind: "ranged", reader: served.reader },
			{ null: "NULL", text: "Text, {{size}}", blob: "BLOB, {{size}}" },
			new Int32Array(new SharedArrayBuffer(4 * SQLITE_INTERRUPT_SLOTS))
		)

		try {
			const blobs = browser.schema.tables.findIndex(table => table.name === "blobs")

			// What the viewer does on open: the first counting step, then the first tile its grid shows.
			expect(browser.countStep(blobs, 1)).toEqual({ rows: SQLITE_FIRST_COUNT_CHUNK, exact: false })
			browser.tiles(blobs, 0, Uint32Array.of(0, 0), 2)

			// The block holding the header, the schema and the first leaf, then one per further leaf of the tile's rows:
			// no read-ahead past them (the leaves are not contiguous blocks), each one a read of its own.
			const firstTileLeaves = SQLITE_FIRST_COUNT_CHUNK / ROWS_PER_LEAF

			expect(served.reads()).toBe(firstTileLeaves)
			expect(served.blockReads().filter(reads => reads > 0)).toHaveLength(firstTileLeaves)

			// A view tall enough to show every row (the e2e's 8000 px page) asks for every tile: every leaf, once.
			browser.tiles(blobs, 0, Uint32Array.of(0, 0, 1, 0, 2, 0), 3)

			const allLeaves = ROWS / ROWS_PER_LEAF

			expect(served.reads()).toBe(allLeaves)

			// Counting to the end reads the leaves the tiles read: no block again.
			while (!browser.countStep(blobs, 4).exact);

			expect(served.reads()).toBe(allLeaves)
			expect(Math.max(...served.blockReads())).toBe(1)
		} finally {
			browser.close()
			await served.close()
		}
	}, 60_000)
})

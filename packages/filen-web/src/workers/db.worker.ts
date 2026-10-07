/// <reference lib="webworker" />
import * as Comlink from "comlink"
import sqlite3InitModule, { type SAHPoolUtil, type SqlValue } from "@sqlite.org/sqlite-wasm"
import { opfsUnavailableError } from "@/lib/storage/errors"
import { isLockConflictError, isNotFoundError } from "@/lib/storage/opfs"
import { log } from "@/lib/log"

// Narrow local interface — sqlite-wasm's own typings are inconsistent here (see the SAH pool / oo1
// overload set in the installed `.d.mts`): an `OpfsSAHPoolDb` instance (which extends the base
// `Database` class) structurally satisfies this — the only members this worker calls.
interface Db {
	exec(opts: { sql: string; bind?: readonly SqlValue[]; callback?: (row: SqlValue[]) => void }): unknown
	close(): void
}

let db: Db | null = null
let pool: SAHPoolUtil | null = null

function requireDb(): Db {
	if (db === null) {
		throw new Error("db.worker: open() must be called first")
	}

	return db
}

const POOL_NAME = "filen-web"
const DB_PATH = "/filen-web.sqlite3"
// The library's own default for this name, spelled out because waitForPoolRelease reads the layout: the
// pool keeps its files in a fixed ".opaque" subdirectory, which the library can never rename without
// orphaning every existing database.
const POOL_DIRECTORY = `.${POOL_NAME}`
const POOL_FILES_DIRECTORY = ".opaque"

// Waits between lock probes, ~3s in all.
const POOL_RELEASE_BACKOFF_MS = [50, 100, 200, 400, 800, 1600] as const

// Locks and releases every pool file once, sequentially, so no handle outlives a failed step. close() is
// synchronous in every browser the pool supports (the library's apiVersionCheck refuses the rest), so
// the install right after never meets a lock of the probe's own.
async function probePool(): Promise<void> {
	let files: FileSystemDirectoryHandle

	try {
		const root = await navigator.storage.getDirectory()

		files = await (await root.getDirectoryHandle(POOL_DIRECTORY)).getDirectoryHandle(POOL_FILES_DIRECTORY)
	} catch (e) {
		if (isNotFoundError(e)) {
			return // first run: no pool yet, nothing can hold it
		}

		throw e
	}

	for await (const handle of files.values()) {
		if (handle.kind === "file") {
			const access = await handle.createSyncAccessHandle()

			access.close()
		}
	}
}

// Right after a reload or a leader handoff, the previous document's db worker can still hold the pool's
// sync access handles: they are released only when that worker is torn down, which can land after this
// tab already holds the leader lock. Installing the pool then fails with NoModificationAllowedError, and
// the library's failure cleanup (removeVfs) tries to delete the pool directory, so a transient lock is
// waited out here rather than retried through the install. Only a dying holder can own the handles while
// this tab holds the lock, so once the probe passes they stay free. Anything other than a lock conflict,
// or one outlasting the budget, is left to the install to surface.
async function waitForPoolRelease(): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await probePool()

			return
		} catch (e) {
			const delay = POOL_RELEASE_BACKOFF_MS[attempt]

			if (!isLockConflictError(e) || delay === undefined) {
				return
			}

			log.warn("db.worker", `OPFS pool still locked by a previous worker, retry ${String(attempt + 1)} in ${String(delay)}ms`)

			await new Promise(resolve => setTimeout(resolve, delay))
		}
	}
}

// OPFS is a hard requirement — there is no in-memory fallback. A failed SAH pool install / DB open
// (OPFS disabled, private browsing, an unsupported browser) is fatal to boot: it throws a tagged
// error (see @/lib/storage/errors) instead of silently swapping to a `:memory:` database, so the
// caller can map it to the dedicated `opfs` boot-failure reason.
async function open(): Promise<void> {
	const [sqlite3] = await Promise.all([sqlite3InitModule(), waitForPoolRelease()])

	try {
		pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME, directory: POOL_DIRECTORY, initialCapacity: 4 })
		db = connect(pool)
	} catch (e) {
		throw opfsUnavailableError(e)
	}
}

function connect(from: SAHPoolUtil): Db {
	const connection: Db = new from.OpfsSAHPoolDb(DB_PATH)

	connection.exec({
		sql: "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID"
	})
	// Per connection. The pool VFS pays a header write, a flush and a truncate to create and delete a journal,
	// so every autocommit write would pay them twice; PERSIST keeps the journal (same atomicity) and the size
	// limit trims what a large delete leaves in it.
	connection.exec({ sql: "PRAGMA journal_mode=PERSIST" })
	connection.exec({ sql: "PRAGMA journal_size_limit=1048576" })

	return connection
}

// Sign-out's wipe. Deleting rows leaves their bytes behind (secure_delete is off, so freed pages keep the
// old content, and the PERSIST journal keeps pre-images), so the pool's files are cut back to their headers
// instead: the database and its journal together, in a few truncates however many rows there were. The
// files must not be open while that runs, so the connection is closed first and reopened, empty, after. A
// kv call arriving meanwhile fails like one before open().
async function wipe(): Promise<void> {
	const from = pool

	if (from === null) {
		throw new Error("db.worker: open() must be called first")
	}

	requireDb().close()
	db = null

	try {
		await from.wipeFiles()
	} finally {
		db = connect(from)
	}
}

// A prefix scan as a range on the primary key: no LIKE, so "_" and "%" in a prefix match literally and the
// index serves it. The upper bound is the prefix with its last code point incremented (the smallest string
// above every extension of it); an empty prefix matches every key.
function prefixRange(prefix: string): { where: string; bind: string[] } {
	const points = Array.from(prefix)

	for (let i = points.length - 1; i >= 0; i--) {
		const code = points[i]?.codePointAt(0) ?? 0

		if (code < 0x10ffff) {
			// 0xD800-0xDFFF are surrogates, never a character of their own.
			const next = code === 0xd7ff ? 0xe000 : code + 1

			return { where: "key >= ? AND key < ?", bind: [prefix, points.slice(0, i).join("") + String.fromCodePoint(next)] }
		}
	}

	return { where: "key >= ?", bind: [prefix] }
}

const api = {
	open,
	wipe,
	kvGet: (key: string): string | null => {
		let out: string | null = null

		requireDb().exec({
			sql: "SELECT value FROM kv WHERE key = ?",
			bind: [key],
			callback: row => {
				const value = row[0]

				if (typeof value === "string") {
					out = value
				}
			}
		})

		return out
	},
	kvSet: (key: string, value: string): void => {
		requireDb().exec({
			sql: "INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			bind: [key, value]
		})
	},
	kvDelete: (key: string): void => {
		requireDb().exec({ sql: "DELETE FROM kv WHERE key = ?", bind: [key] })
	},
	kvKeys: (prefix: string): string[] => {
		const out: string[] = []
		const { where, bind } = prefixRange(prefix)

		requireDb().exec({
			sql: `SELECT key FROM kv WHERE ${where}`,
			bind,
			callback: row => {
				const value = row[0]

				if (typeof value === "string") {
					out.push(value)
				}
			}
		})

		return out
	},
	// Every row under a prefix in one statement, so a bulk read (the boot restore) is one round trip instead
	// of one per row.
	kvEntries: (prefix: string): [string, string][] => {
		const out: [string, string][] = []
		const { where, bind } = prefixRange(prefix)

		requireDb().exec({
			sql: `SELECT key, value FROM kv WHERE ${where}`,
			bind,
			callback: row => {
				const [key, value] = row

				if (typeof key === "string" && typeof value === "string") {
					out.push([key, value])
				}
			}
		})

		return out
	},
	// One statement, so one transaction, however many rows it drops.
	kvDeletePrefix: (prefix: string): void => {
		const { where, bind } = prefixRange(prefix)

		requireDb().exec({ sql: `DELETE FROM kv WHERE ${where}`, bind })
	}
}

// Every method is re-typed to return a Promise regardless of its (synchronous, in-worker) local
// signature — this is the shape BOTH transports promise: Comlink for the leader's real worker, and
// leader.ts's hand-rolled BroadcastChannel RPC for followers (which can never be synchronous).
export type StorageApi = {
	[K in keyof typeof api]: (...a: Parameters<(typeof api)[K]>) => Promise<Awaited<ReturnType<(typeof api)[K]>>>
}

Comlink.expose(api)

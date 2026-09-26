/// <reference lib="webworker" />
import * as Comlink from "comlink"
import sqlite3InitModule, { type SqlValue } from "@sqlite.org/sqlite-wasm"
import { opfsUnavailableError } from "@/lib/storage/errors"
import { log } from "@/lib/log"

// Narrow local interface — sqlite-wasm's own typings are inconsistent here (see the SAH pool / oo1
// overload set in the installed `.d.mts`): an `OpfsSAHPoolDb` instance (which extends the base
// `Database` class) structurally satisfies this — the only member `open()` below actually calls.
interface Db {
	exec(opts: { sql: string; bind?: readonly SqlValue[]; callback?: (row: SqlValue[]) => void }): unknown
}

let db: Db | null = null

function requireDb(): Db {
	if (db === null) {
		throw new Error("db.worker: open() must be called first")
	}

	return db
}

const POOL_NAME = "filen-web"
// The library's own default for this name, spelled out because waitForPoolRelease reads the layout: the
// pool keeps its files in a fixed ".opaque" subdirectory, which the library can never rename without
// orphaning every existing database.
const POOL_DIRECTORY = `.${POOL_NAME}`
const POOL_FILES_DIRECTORY = ".opaque"

// Waits between lock probes, ~3s in all.
const POOL_RELEASE_BACKOFF_MS = [50, 100, 200, 400, 800, 1600] as const

function isLockConflict(e: unknown): boolean {
	return e instanceof DOMException && e.name === "NoModificationAllowedError"
}

// Locks and releases every pool file once, sequentially, so no handle outlives a failed step. close() is
// synchronous in every browser the pool supports (the library's apiVersionCheck refuses the rest), so
// the install right after never meets a lock of the probe's own.
async function probePool(): Promise<void> {
	let files: FileSystemDirectoryHandle

	try {
		const root = await navigator.storage.getDirectory()

		files = await (await root.getDirectoryHandle(POOL_DIRECTORY)).getDirectoryHandle(POOL_FILES_DIRECTORY)
	} catch (e) {
		if (e instanceof DOMException && e.name === "NotFoundError") {
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

			if (!isLockConflict(e) || delay === undefined) {
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
		const pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME, directory: POOL_DIRECTORY, initialCapacity: 4 })

		db = new pool.OpfsSAHPoolDb("/filen-web.sqlite3")
	} catch (e) {
		throw opfsUnavailableError(e)
	}

	requireDb().exec({
		sql: "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID"
	})
}

const api = {
	open,
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

		requireDb().exec({
			sql: "SELECT key FROM kv WHERE key LIKE ? || '%'",
			bind: [prefix],
			callback: row => {
				const value = row[0]

				if (typeof value === "string") {
					out.push(value)
				}
			}
		})

		return out
	}
}

// Every method is re-typed to return a Promise regardless of its (synchronous, in-worker) local
// signature — this is the shape BOTH transports promise: Comlink for the leader's real worker, and
// leader.ts's hand-rolled BroadcastChannel RPC for followers (which can never be synchronous).
export type StorageApi = {
	[K in keyof typeof api]: (...a: Parameters<(typeof api)[K]>) => Promise<Awaited<ReturnType<(typeof api)[K]>>>
}

Comlink.expose(api)

/// <reference lib="webworker" />
import * as Comlink from "comlink"
import sqlite3InitModule, { type SqlValue } from "@sqlite.org/sqlite-wasm"
import { opfsUnavailableError } from "@/lib/storage/errors"

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

// OPFS is a hard requirement — there is no in-memory fallback. A failed SAH pool install / DB open
// (OPFS disabled, private browsing, an unsupported browser) is fatal to boot: it throws a tagged
// error (see @/lib/storage/errors) instead of silently swapping to a `:memory:` database, so the
// caller can map it to the dedicated `opfs` boot-failure reason.
async function open(): Promise<void> {
	const sqlite3 = await sqlite3InitModule()

	try {
		const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "filen-web", initialCapacity: 4 })

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

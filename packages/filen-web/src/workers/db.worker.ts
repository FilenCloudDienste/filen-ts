/// <reference lib="webworker" />
import * as Comlink from "comlink"
import sqlite3InitModule, { type SqlValue } from "@sqlite.org/sqlite-wasm"
import { log } from "@/lib/log"

type Mode = "persistent" | "ephemeral"

// Narrow local interface — sqlite-wasm's own typings are inconsistent here (see the SAH pool / oo1
// overload set in the installed `.d.mts`): both `oo1.DB` instances and
// `OpfsSAHPoolDb` instances (the latter extends the former's base `Database` class) structurally
// satisfy this — the only member either branch of `open()` below actually calls.
interface Db {
	exec(opts: { sql: string; bind?: readonly SqlValue[]; callback?: (row: SqlValue[]) => void }): unknown
}

let db: Db | null = null
let mode: Mode = "ephemeral"

function requireDb(): Db {
	if (db === null) {
		throw new Error("db.worker: open() must be called first")
	}

	return db
}

async function open(forceEphemeral: boolean): Promise<Mode> {
	const sqlite3 = await sqlite3InitModule()

	if (!forceEphemeral) {
		try {
			const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "filen-web", initialCapacity: 4 })

			db = new pool.OpfsSAHPoolDb("/filen-web.sqlite3")
			mode = "persistent"
		} catch (e) {
			log.warn("db.worker", "OPFS unavailable — falling back to in-memory ephemeral storage", e)
		}
	}

	if (db === null) {
		db = new sqlite3.oo1.DB() // default ':memory:'
		mode = "ephemeral"
	}

	requireDb().exec({
		sql: "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID"
	})

	return mode
}

const api = {
	open,
	mode: (): Mode => mode,
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

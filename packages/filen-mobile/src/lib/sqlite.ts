import { open, type DB } from "@op-engineering/op-sqlite"
import { Semaphore, run } from "@filen/utils"
import { AppState } from "react-native"
import { serialize, deserialize } from "@/lib/serializer"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { SQLITE_VERSION, SQLITE_DB_FILE_NAME, SQLITE_DB_FILE_DIRECTORY } from "@/lib/storageRoots"

// Critical: When changing anything related to the on-disk database file format, bump SQLITE_VERSION in storageRoots.ts to invalidate old databases and prevent potential issues from stale or incompatible data.
export const VERSION = SQLITE_VERSION
export const DB_FILE_NAME = SQLITE_DB_FILE_NAME
export const DB_FILE_DIRECTORY = SQLITE_DB_FILE_DIRECTORY

const OPEN_DB_MAX_ATTEMPTS = 10
const OPEN_DB_BASE_BACKOFF_MS = 100
const OPEN_DB_MAX_BACKOFF_MS = 5000

// Order matters: page_size before journal_mode, locking_mode before first WAL access.
// page_size only takes effect on a fresh database or after VACUUM outside WAL mode.
const INIT_QUERIES: string[] = [
	"PRAGMA page_size = 8192",
	"PRAGMA journal_mode = WAL",
	// "PRAGMA locking_mode = EXCLUSIVE",
	"PRAGMA synchronous = NORMAL",
	"PRAGMA busy_timeout = 15000",
	"PRAGMA cache_size = -4000",
	"PRAGMA mmap_size = 0",
	"PRAGMA temp_store = MEMORY",
	"PRAGMA wal_autocheckpoint = 500",
	"PRAGMA journal_size_limit = 16777216",
	"PRAGMA auto_vacuum = INCREMENTAL",
	"PRAGMA trusted_schema = OFF",
	"PRAGMA secure_delete = OFF",
	"PRAGMA cell_size_check = OFF",
	"PRAGMA max_page_count = 2147483646",
	"PRAGMA encoding = 'UTF-8'",
	"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID",
	"PRAGMA optimize = 0x10002"
]

// Exclusive upper bound for a prefix range scan over the BINARY-collated `key` column: the prefix
// with its final character incremented by one code unit. Querying `key >= prefix AND key < upper`
// uses the PRIMARY KEY index (a SEARCH), whereas `key LIKE 'prefix%'` cannot be index-optimized under
// SQLite's default case_sensitive_like = OFF and degrades to a full table scan. All current callers
// pass a non-empty prefix ending in ":".
export function prefixUpperBound(prefix: string): string {
	if (prefix.length === 0) {
		return prefix
	}

	const lastIndex = prefix.length - 1

	return prefix.slice(0, lastIndex) + String.fromCharCode(prefix.charCodeAt(lastIndex) + 1)
}

class Sqlite {
	public db: DB | null = null
	private initDone: boolean = false

	private initMutex: Semaphore = new Semaphore(1)

	// Bumped by every kv wipe (clearAsync / kvAsync.clear). kv writes capture the generation
	// when they start and silently no-op if a wipe landed before their INSERT executed —
	// defense-in-depth (mirroring cache.ts's clearGeneration) so an aborted sync's late
	// `INSERT OR REPLACE` cannot re-INSERT decrypted metadata AFTER the logout Phase 6 wipe.
	private clearGeneration = 0

	public constructor() {
		// Maintenance on app background: checkpoint WAL, reclaim free pages, run optimize with query history
		AppState.addEventListener("change", state => {
			if (state !== "background" || !sqlite.db) {
				return
			}

			run(async () => {
				const db = await sqlite.openDb()

				await db.execute("PRAGMA wal_checkpoint(PASSIVE)")
				await db.execute("PRAGMA incremental_vacuum(64)")
				await db.execute("PRAGMA optimize")
			})
		})
	}

	public async openDb(): Promise<DB> {
		let attempt = 0

		// Bounded retry with backoff. A persistent init() failure (corrupt DB file,
		// filesystem permission error, out-of-disk during PRAGMA) must not busy-loop
		// re-entering init() — it surfaces as a rejection after exhausting attempts.
		while (!this.initDone) {
			const result = await run(() => this.init())

			if (!result.success) {
				attempt++

				if (attempt >= OPEN_DB_MAX_ATTEMPTS) {
					throw result.error
				}

				await new Promise<void>(resolve => {
					setTimeout(resolve, Math.min(OPEN_DB_BASE_BACKOFF_MS * 2 ** (attempt - 1), OPEN_DB_MAX_BACKOFF_MS))
				})
			}
		}

		if (!this.db) {
			throw new Error("SQLite database not initialized")
		}

		return this.db
	}

	public async init(): Promise<void> {
		const result = await run(async defer => {
			await this.initMutex.acquire()

			defer(() => {
				this.initMutex.release()
			})

			if (this.initDone) {
				return
			}

			if (!this.db) {
				if (!DB_FILE_DIRECTORY.exists) {
					DB_FILE_DIRECTORY.create({
						idempotent: true,
						intermediates: true
					})
				}

				this.db = open({
					name: DB_FILE_NAME,
					location: normalizeFilePathForSdk(DB_FILE_DIRECTORY.uri)
				})
			}

			await this.db.execute(INIT_QUERIES.join("; "))

			this.initDone = true
		})

		if (!result.success) {
			throw result.error
		}
	}

	// Release page cache and non-essential allocations. Call on memory warnings.
	public async shrinkMemory(): Promise<void> {
		if (!this.db) {
			return
		}

		await this.db.execute("PRAGMA shrink_memory")
	}

	public async clearAsync(): Promise<void> {
		// Bump BEFORE the wipe so any write that captured its generation earlier is already
		// superseded — even one landing while the DELETE is still executing.
		this.clearGeneration++

		const db = await this.openDb()

		await db.execute("DELETE FROM kv")
	}

	public kvAsync = {
		get: async <T>(key: string): Promise<T | null> => {
			const db = await this.openDb()
			const result = await db.executeRaw("SELECT value FROM kv WHERE key = ?", [key])
			const row = result[0]

			if (!row) {
				return null
			}

			try {
				return deserialize(row[0] as string) as T
			} catch (e) {
				// Defensive: catch and log deserialization errors to prevent a single bad row from breaking the whole read. The caller can handle a null return as needed; returning null is better than throwing and returning nothing.
				console.error(`[Sqlite] Failed to deserialize value for key ${key}`, e)

				return null
			}
		},
		set: async <T>(key: string, value: T): Promise<number | null> => {
			if (value == null) {
				return null
			}

			const generation = this.clearGeneration
			let serialized: string

			try {
				serialized = serialize(value)
			} catch (e) {
				// Defensive: catch and log serialization errors to prevent a single bad value from breaking the whole write. The caller can handle failed writes as needed; failing silently is better than throwing and leaving the store in an inconsistent state.
				console.error(`[Sqlite] Failed to serialize value for key ${key}`, e)

				return null
			}

			const db = await this.openDb()

			// A kv wipe (logout) landed after this write started — discard it silently
			// rather than re-INSERTing the row into the just-emptied store.
			if (generation !== this.clearGeneration) {
				return null
			}

			const result = await db.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [key, serialized])

			return result.insertId ?? null
		},
		keys: async (): Promise<string[]> => {
			const db = await this.openDb()
			const result = await db.executeRaw("SELECT key FROM kv")

			return result.map(row => row[0] as string)
		},
		clear: async (): Promise<void> => {
			// Same wipe as clearAsync() — bump the generation so in-flight writes are superseded.
			this.clearGeneration++

			const db = await this.openDb()

			await db.execute("DELETE FROM kv")
		},
		contains: async (key: string): Promise<boolean> => {
			const db = await this.openDb()
			const result = await db.executeRaw("SELECT EXISTS(SELECT 1 FROM kv WHERE key = ?)", [key])

			return (result[0]?.[0] as number) === 1
		},
		remove: async (key: string): Promise<void> => {
			const db = await this.openDb()

			await db.execute("DELETE FROM kv WHERE key = ?", [key])
		},
		removeByPrefix: async (prefix: string): Promise<void> => {
			const db = await this.openDb()

			await db.execute("DELETE FROM kv WHERE key LIKE ?", [prefix + "%"])
		},
		keysByPrefix: async (prefix: string): Promise<string[]> => {
			const db = await this.openDb()
			const result = await db.executeRaw("SELECT key FROM kv WHERE key LIKE ?", [prefix + "%"])

			return result.map(row => row[0] as string)
		},
		getByPrefix: async <T>(prefix: string): Promise<Map<string, T>> => {
			const db = await this.openDb()
			const result = await db.executeRaw("SELECT key, value FROM kv WHERE key LIKE ?", [prefix + "%"])
			const map = new Map<string, T>()

			try {
				for (const row of result) {
					map.set(row[0] as string, deserialize(row[1] as string) as T)
				}
			} catch (e) {
				// Defensive: catch and log deserialization errors to prevent a single bad row from breaking the whole prefix read. The caller can handle missing keys as needed; returning a partial map is better than throwing and returning nothing.
				console.error(`[Sqlite] Failed to deserialize value for prefix ${prefix}`, e)
			}

			return map
		}
	}
}

const sqlite = new Sqlite()

export default sqlite

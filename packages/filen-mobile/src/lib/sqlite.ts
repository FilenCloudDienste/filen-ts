import { open, type DB } from "@op-engineering/op-sqlite"
import { Semaphore, run } from "@filen/utils"
import { serialize, deserialize } from "@/lib/serializer"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { SQLITE_VERSION, SQLITE_DB_FILE_NAME, SQLITE_DB_FILE_DIRECTORY } from "@/lib/storageRoots"
import logger from "@/lib/logger"

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
	// Memory-mapped reads cover the boot restore's full-table range scans (file-backed
	// clean pages — evictable, not dirty RSS). INVARIANT: safe only while THIS app is
	// the sole process opening sqlite.db — an mmap'd file truncated by ANOTHER process
	// (our incremental_vacuum / post-wipe vacuum truncate the main file) can SIGBUS its
	// readers; same-process/same-connection truncation is handled by SQLite itself. The
	// FP extension consumes auth.json + its own rusqlite DB, never this file. Revisit
	// before ever pointing a second process at the kv.
	"PRAGMA mmap_size = 134217728",
	"PRAGMA temp_store = MEMORY",
	"PRAGMA wal_autocheckpoint = 500",
	"PRAGMA journal_size_limit = 16777216",
	"PRAGMA auto_vacuum = INCREMENTAL",
	"PRAGMA trusted_schema = OFF",
	// FAST zeroes freed pages whenever it costs no extra I/O — near-free insurance that
	// ordinary deletes of decrypted metadata don't linger in free pages. The logout wipe
	// additionally runs a full vacuum + WAL truncate (reclaimAfterWipe).
	"PRAGMA secure_delete = FAST",
	"PRAGMA cell_size_check = OFF",
	"PRAGMA max_page_count = 2147483646",
	"PRAGMA encoding = 'UTF-8'",
	"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID",
	"PRAGMA optimize = 0x10002"
]

// prefixUpperBound moved to @/lib/kvScan (pure, dependency-free) together with the paged
// restore walker; re-exported here because it is part of this module's historical surface.
export { prefixUpperBound } from "@/lib/kvScan"

class Sqlite {
	public db: DB | null = null
	private initDone: boolean = false

	private initMutex: Semaphore = new Semaphore(1)

	// Bumped by every kv wipe (clearAsync / kvAsync.clear). kv writes capture the generation
	// when they start and silently no-op if a wipe landed before their INSERT executed —
	// defense-in-depth (mirroring cache.ts's clearGeneration) so an aborted sync's late
	// `INSERT OR REPLACE` cannot re-INSERT decrypted metadata AFTER the logout Phase 6 wipe.
	private clearGeneration = 0

	// NOTE deliberately NO background-maintenance AppState hook here: running checkpoint/vacuum
	// work right as the app backgrounds is the worst possible timing on iOS — suspension can
	// land mid-write and a held SQLite lock at suspension is a kill (0xdead10cc; observed in
	// production crash logs as pwrite→walWriteOneFrame at kill time). wal_autocheckpoint (set in
	// INIT_QUERIES) keeps the WAL bounded during normal writes, `PRAGMA optimize` runs at open,
	// and the logout wipe still performs the full vacuum + WAL truncate (reclaimAfterWipe).
	// Accepted trade: with no periodic incremental_vacuum, freed pages are recycled internally
	// but only returned to the OS at logout — the DB file parks at its high-water mark.

	public async openDb(): Promise<DB> {
		let attempt = 0

		// Bounded retry with backoff. A persistent init() failure (corrupt DB file,
		// filesystem permission error, out-of-disk during PRAGMA) must not busy-loop
		// re-entering init() — it surfaces as a rejection after exhausting attempts.
		while (!this.initDone) {
			const result = await run(() => this.init())

			if (!result.success) {
				attempt++

				logger.warn("sqlite", "DB init attempt failed, retrying", { attempt, error: result.error })

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

	/**
	 * Size profile of the kv store: row count, total octets (keys + values), and the largest
	 * value rows. Diagnostics only — storage-driven OOMs (giant persisted listings) are
	 * invisible in a native crash trace, so boot logs this to make the magnitude readable
	 * from a user's log export. CAST AS BLOB so lengths are bytes, not UTF-8 characters.
	 */
	public async kvStats(): Promise<{ rows: number; totalBytes: number; largest: { key: string; bytes: number }[] }> {
		const db = await this.openDb()
		const totalsRow = (
			await db.executeRaw("SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(key AS BLOB)) + LENGTH(CAST(value AS BLOB))), 0) FROM kv", [])
		).rawRows[0]
		const largestRows = (
			await db.executeRaw("SELECT key, LENGTH(CAST(value AS BLOB)) FROM kv ORDER BY LENGTH(CAST(value AS BLOB)) DESC LIMIT 3", [])
		).rawRows

		return {
			rows: Number(totalsRow?.[0] ?? 0),
			totalBytes: Number(totalsRow?.[1] ?? 0),
			largest: largestRows.map(row => ({
				key: String(row[0]),
				bytes: Number(row[1] ?? 0)
			}))
		}
	}

	// Reclaim disk + scrub residue after a kv wipe (logout): the DELETE moves every page
	// of decrypted metadata to the freelist, where the bytes otherwise LINGER on disk
	// until the slow background drip (incremental_vacuum(64) per app-backgrounding)
	// happens to reach them — and up to journal_size_limit of pre-wipe frames stay
	// readable in the WAL. An unbounded incremental_vacuum returns every free page to
	// the OS; wal_checkpoint(TRUNCATE) resets the WAL to zero bytes. Failures are
	// logged, never thrown — the wipe itself already succeeded.
	private async reclaimAfterWipe(db: DB): Promise<void> {
		try {
			await db.execute("PRAGMA incremental_vacuum")
			await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
		} catch (err) {
			logger.warn("sqlite", "Post-wipe reclaim failed — freed pages may persist on disk", { error: err })
		}
	}

	public async clearAsync(): Promise<void> {
		// Bump BEFORE the wipe so any write that captured its generation earlier is already
		// superseded — even one landing while the DELETE is still executing.
		this.clearGeneration++

		const db = await this.openDb()

		await db.execute("DELETE FROM kv")

		await this.reclaimAfterWipe(db)
	}

	public kvAsync = {
		get: async <T>(key: string): Promise<T | null> => {
			const db = await this.openDb()
			// op-sqlite 17: executeRaw returns { rawRows, columnNames, ... } — the row arrays live on .rawRows.
			const result = (await db.executeRaw("SELECT value FROM kv WHERE key = ?", [key])).rawRows
			const row = result[0]

			if (!row) {
				return null
			}

			return deserialize(row[0] as string) as T
		},
		set: async <T>(key: string, value: T): Promise<number | null> => {
			if (value == null) {
				return null
			}

			const generation = this.clearGeneration
			const serialized = serialize(value)
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
			const result = (await db.executeRaw("SELECT key FROM kv")).rawRows

			return result.map(row => row[0] as string)
		},
		clear: async (): Promise<void> => {
			// Same wipe as clearAsync() — bump the generation so in-flight writes are superseded.
			this.clearGeneration++

			const db = await this.openDb()

			await db.execute("DELETE FROM kv")

			await this.reclaimAfterWipe(db)
		},
		contains: async (key: string): Promise<boolean> => {
			const db = await this.openDb()
			const result = (await db.executeRaw("SELECT EXISTS(SELECT 1 FROM kv WHERE key = ?)", [key])).rawRows

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
			const result = (await db.executeRaw("SELECT key FROM kv WHERE key LIKE ?", [prefix + "%"])).rawRows

			return result.map(row => row[0] as string)
		},
		getByPrefix: async <T>(prefix: string): Promise<Map<string, T>> => {
			const db = await this.openDb()
			const result = (await db.executeRaw("SELECT key, value FROM kv WHERE key LIKE ?", [prefix + "%"])).rawRows
			const map = new Map<string, T>()

			for (const row of result) {
				try {
					map.set(row[0] as string, deserialize(row[1] as string) as T)
				} catch (e) {
					logger.warn("sqlite", "KV row deserialization failed", { rowId: row[0] as string, error: e })
				}
			}

			return map
		}
	}
}

const sqlite = new Sqlite()

export default sqlite

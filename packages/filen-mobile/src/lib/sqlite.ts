import * as FileSystem from "expo-file-system"
import { open, type DB, type PreparedStatement } from "@op-engineering/op-sqlite"
import { Semaphore, run } from "@filen/utils"
import { Platform, AppState } from "react-native"
import { pack, unpack } from "@/lib/msgpack"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import { normalizeFilePathForSdk } from "@/lib/utils"

// Order matters: page_size before journal_mode, locking_mode before first WAL access.
// page_size only takes effect on a fresh database or after VACUUM outside WAL mode.
const INIT_QUERIES: string[] = [
	"PRAGMA page_size = 8192",
	"PRAGMA journal_mode = WAL",
	"PRAGMA locking_mode = EXCLUSIVE",
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
	"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL) WITHOUT ROWID",
	"PRAGMA optimize = 0x10002"
]

class Sqlite {
	public db: DB | null = null
	private initDone: boolean = false

	private initMutex: Semaphore = new Semaphore(1)

	private stmtGet: PreparedStatement | null = null
	private stmtSet: PreparedStatement | null = null
	private stmtRemove: PreparedStatement | null = null
	private stmtContains: PreparedStatement | null = null

	public readonly version: number = 1
	public readonly dbFileName: string = "sqlite.db"
	public readonly dbFileDirectory: FileSystem.Directory = new FileSystem.Directory(
		FileSystem.Paths.join(
			Platform.select({
				ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
				default: FileSystem.Paths.document
			}),
			"sqlite",
			`v${this.version}`
		)
	)

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
		while (!this.initDone) {
			await this.init()
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
				if (!this.dbFileDirectory.exists) {
					this.dbFileDirectory.create({
						idempotent: true,
						intermediates: true
					})
				}

				this.db = open({
					name: this.dbFileName,
					location: normalizeFilePathForSdk(this.dbFileDirectory.uri)
				})
			}

			await this.db.execute(INIT_QUERIES.join("; "))

			this.stmtGet = this.db.prepareStatement("SELECT value FROM kv WHERE key = ?")
			this.stmtSet = this.db.prepareStatement("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
			this.stmtRemove = this.db.prepareStatement("DELETE FROM kv WHERE key = ?")
			this.stmtContains = this.db.prepareStatement("SELECT EXISTS(SELECT 1 FROM kv WHERE key = ?) AS found")

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
		const db = await this.openDb()

		await db.execute("DELETE FROM kv")
	}

	public kvAsync = {
		get: async <T>(key: string): Promise<T | null> => {
			await this.openDb()

			await this.stmtGet!.bind([key])

			const result = await this.stmtGet!.execute()
			const row = result.rows[0]

			if (!row) {
				return null
			}

			return await new Promise<T>((resolve, reject) => {
				queueMicrotask(() => {
					try {
						resolve(unpack(new Uint8Array(row["value"] as ArrayBuffer)) as T)
					} catch (err) {
						reject(err)
					}
				})
			})
		},
		set: async <T>(key: string, value: T): Promise<number | null> => {
			if (value == null) {
				return null
			}

			await this.openDb()

			await new Promise<void>((resolve, reject) => {
				queueMicrotask(() => {
					try {
						this.stmtSet!.bind([key, new Uint8Array(pack(value))])
							.then(resolve)
							.catch(reject)
					} catch (err) {
						reject(err)
					}
				})
			})

			const result = await this.stmtSet!.execute()

			return result.insertId ?? null
		},
		keys: async (): Promise<string[]> => {
			const db = await this.openDb()
			const result = await db.executeRaw("SELECT key FROM kv")

			return result.map(row => row[0] as string)
		},
		clear: async (): Promise<void> => {
			const db = await this.openDb()

			await db.execute("DELETE FROM kv")
		},
		contains: async (key: string): Promise<boolean> => {
			await this.openDb()

			await this.stmtContains!.bind([key])

			const result = await this.stmtContains!.execute()

			return (result.rows[0]?.["found"] as number) === 1
		},
		remove: async (key: string): Promise<void> => {
			await this.openDb()

			await this.stmtRemove!.bind([key])
			await this.stmtRemove!.execute()
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

			await Promise.allSettled(
				result.map(
					row =>
						new Promise<void>((resolve, reject) => {
							queueMicrotask(() => {
								try {
									map.set(row[0] as string, unpack(new Uint8Array(row[1] as ArrayBuffer)) as T)

									resolve()
								} catch (err) {
									reject(err)
								}
							})
						})
				)
			)

			return map
		}
	}
}

const sqlite = new Sqlite()

export default sqlite

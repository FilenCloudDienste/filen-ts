import * as FileSystem from "expo-file-system"
import { open, type DB } from "@op-engineering/op-sqlite"
import { Semaphore, run } from "@filen/utils"
import { Platform } from "react-native"
import { pack, unpack } from "@/lib/msgpack"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import { normalizeFilePathForSdk } from "@/lib/utils"

const INIT_QUERIES: string[] = [
	"PRAGMA journal_mode = WAL",
	"PRAGMA synchronous = NORMAL",
	"PRAGMA temp_store = MEMORY",
	"PRAGMA mmap_size = 67108864",
	"PRAGMA page_size = 4096",
	"PRAGMA cache_size = -16000",
	"PRAGMA foreign_keys = ON",
	"PRAGMA busy_timeout = 15000",
	"PRAGMA auto_vacuum = INCREMENTAL",
	"PRAGMA wal_autocheckpoint = 1000",
	"PRAGMA journal_size_limit = 67108864",
	"PRAGMA max_page_count = 2147483646",
	"PRAGMA encoding = 'UTF-8'",
	"PRAGMA secure_delete = OFF",
	"PRAGMA cell_size_check = OFF",
	"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL) WITHOUT ROWID",
	"PRAGMA optimize"
]

class Sqlite {
	public db: DB | null = null
	private initDone: boolean = false

	private initMutex: Semaphore = new Semaphore(1)

	public readonly version: number = 1
	public readonly dbFileName: string = "sqlite.db"
	public readonly dbFileDirectory: FileSystem.Directory = new FileSystem.Directory(
		FileSystem.Paths.join(
			Platform.select({
				ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
				default: FileSystem.Paths.document.uri
			}),
			"sqlite",
			`v${this.version}`
		)
	)

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

			this.initDone = true
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async clearAsync(): Promise<void> {
		const db = await this.openDb()

		await db.execute("DELETE FROM kv")
	}

	public kvAsync = {
		get: async <T>(key: string): Promise<T | null> => {
			const db = await this.openDb()
			const result = await db.execute("SELECT value FROM kv WHERE key = ?", [key])
			const row = result.rows[0]

			if (!row) {
				return null
			}

			return unpack(new Uint8Array(row["value"] as ArrayBuffer)) as T
		},
		set: async <T>(key: string, value: T): Promise<number | null> => {
			if (value == null) {
				return null
			}

			const db = await this.openDb()
			const result = await db.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [key, new Uint8Array(pack(value))])

			return result.insertId ?? null
		},
		keys: async (): Promise<string[]> => {
			const db = await this.openDb()
			const result = await db.execute("SELECT key FROM kv")

			return result.rows.map(row => row["key"] as string)
		},
		clear: async (): Promise<void> => {
			const db = await this.openDb()

			await db.execute("DELETE FROM kv")
		},
		contains: async (key: string): Promise<boolean> => {
			const db = await this.openDb()
			const result = await db.execute("SELECT key FROM kv WHERE key = ?", [key])

			return result.rows.length > 0
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
			const result = await db.execute("SELECT key FROM kv WHERE key LIKE ?", [prefix + "%"])

			return result.rows.map(row => row["key"] as string)
		}
	}
}

const sqlite = new Sqlite()

export default sqlite

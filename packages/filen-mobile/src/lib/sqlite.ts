import * as FileSystem from "expo-file-system"
import * as ExpoSqlite from "expo-sqlite"
import { Semaphore, run } from "@filen/utils"
import { Platform } from "react-native"
import { pack, unpack } from "@/lib/msgpack"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"

const INIT_QUERIES: {
	query: string
	pragma: boolean
}[] = [
	{
		query: "PRAGMA journal_mode = WAL",
		pragma: true
	},
	{
		query: "PRAGMA synchronous = NORMAL",
		pragma: true
	},
	{
		query: "PRAGMA temp_store = FILE", // Use disk instead of memory for temp storage
		pragma: true
	},
	{
		query: "PRAGMA mmap_size = 33554432", // Set memory mapping size to 32MB
		pragma: true
	},
	{
		query: "PRAGMA page_size = 4096", // Must be set before any tables are created
		pragma: true
	},
	{
		query: "PRAGMA cache_size = -8000", // 8MB cache - much smaller for low memory
		pragma: true
	},
	{
		query: "PRAGMA foreign_keys = ON",
		pragma: true
	},
	{
		query: "PRAGMA busy_timeout = 15000", // 5s timeout
		pragma: true
	},
	{
		query: "PRAGMA auto_vacuum = INCREMENTAL",
		pragma: true
	},
	{
		query: "PRAGMA wal_autocheckpoint = 100", // More frequent checkpoints to keep WAL small
		pragma: true
	},
	{
		query: "PRAGMA journal_size_limit = 33554432", // 32MB WAL size limit (small)
		pragma: true
	},
	{
		query: "PRAGMA max_page_count = 107374182300", // Prevent database from growing too large
		pragma: true
	},
	{
		query: "PRAGMA encoding = 'UTF-8'",
		pragma: true
	},
	{
		query: "PRAGMA secure_delete = OFF",
		pragma: true
	},
	{
		query: "PRAGMA cell_size_check = OFF",
		pragma: true
	},
	{
		query: "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL) WITHOUT ROWID",
		pragma: false
	},
	{
		query: "CREATE INDEX IF NOT EXISTS kv_key ON kv (key)",
		pragma: false
	},
	{
		query: "CREATE UNIQUE INDEX IF NOT EXISTS kv_key_unique ON kv (key)",
		pragma: false
	},
	{
		query: "PRAGMA optimize", // Run at the end after schema is created
		pragma: true
	}
]

class Sqlite {
	public db: ExpoSqlite.SQLiteDatabase | null = null
	private initDone: boolean = false

	private initMutex: Semaphore = new Semaphore(1)

	public readonly version: number = 1
	public readonly dbFileName: string = `sqlite.v${this.version}.db`
	public readonly dbFileDirectory: FileSystem.Directory = new FileSystem.Directory(
		Platform.select({
			ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
			default: FileSystem.Paths.document.uri
		})
	)

	public async openDb(): Promise<ExpoSqlite.SQLiteDatabase> {
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

			if (this.db) {
				return
			}

			this.db = await ExpoSqlite.openDatabaseAsync(
				this.dbFileName,
				{
					useNewConnection: true
				},
				this.dbFileDirectory.uri
			)

			await this.db.execAsync(INIT_QUERIES.map(q => q.query).join("; "))

			this.initDone = true
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async clearAsync(): Promise<void> {
		const db = await this.openDb()

		await db.execAsync("DELETE FROM kv")
	}

	public kvAsync = {
		get: async <T>(key: string): Promise<T | null> => {
			const db = await this.openDb()
			const row = await db.getFirstAsync<{ value: Buffer }>("SELECT value FROM kv WHERE key = ?", [key])

			if (!row) {
				return null
			}

			return unpack(new Uint8Array(row.value)) as T
		},
		set: async <T>(key: string, value: T): Promise<number | null> => {
			if (!value) {
				return null
			}

			const db = await this.openDb()
			const row = await db.runAsync("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [key, new Uint8Array(pack(value))])

			return row.lastInsertRowId
		},
		keys: async (): Promise<string[]> => {
			const db = await this.openDb()
			const rows = await db.getAllAsync<{ key: string }>("SELECT key FROM kv")

			if (!rows || rows.length === 0) {
				return []
			}

			return rows.map(row => row.key)
		},
		clear: async (): Promise<void> => {
			const db = await this.openDb()

			await db.runAsync("DELETE FROM kv")
		},
		contains: async (key: string): Promise<boolean> => {
			const db = await this.openDb()
			const rows = await db.getFirstAsync<{ key: string }>("SELECT key FROM kv WHERE key = ?", [key])

			if (!rows) {
				return false
			}

			return true
		},
		remove: async (key: string): Promise<void> => {
			const db = await this.openDb()

			await db.runAsync("DELETE FROM kv WHERE key = ?", [key])
		}
	}
}

const sqlite = new Sqlite()

export default sqlite

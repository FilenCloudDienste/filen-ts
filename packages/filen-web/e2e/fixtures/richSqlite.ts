import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

// SQLite databases for the database viewer's legs, written by node:sqlite on the setup's disk.

export const RICH_SQLITE_USERS = 70_000
export const RICH_SQLITE_DOC_BYTES = 12 * 1024 * 1024
// The large database: past the 256 MiB the integrity check runs by itself up to.
export const RICH_SQLITE_BIG_BYTES = 300 * 1024 * 1024

// A database built by `build` in a fresh file, returned as its bytes (WAL mode left in its header when asked).
export function sqliteBytes(build: (db: DatabaseSync) => void, options: { wal?: boolean } = {}): Buffer {
	const dir = mkdtempSync(join(tmpdir(), "filen-e2e-sqlite-"))

	try {
		const path = join(dir, "db.sqlite")
		const db = new DatabaseSync(path)

		if (options.wal === true) db.exec("PRAGMA journal_mode=WAL")

		build(db)

		if (options.wal === true) db.exec("PRAGMA wal_checkpoint(TRUNCATE)")

		db.close()

		return readFileSync(path)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// Tables, a view, a trigger, a full-text index (a virtual table and its shadow tables), 70,000 users and one 12 MB
// text cell.
export function appDatabase(): Buffer {
	return sqliteBytes(db => {
		db.exec(`
			CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, created TEXT);
			CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
			CREATE TABLE audit (n INTEGER);
			CREATE VIEW recent AS SELECT email FROM users ORDER BY id DESC LIMIT 10;
			CREATE TRIGGER logged AFTER INSERT ON documents BEGIN INSERT INTO audit VALUES (1); END;
			CREATE VIRTUAL TABLE notes USING fts5(body);
			INSERT INTO notes VALUES ('hello from a note');
			BEGIN;
		`)

		const user = db.prepare("INSERT INTO users (email, created) VALUES (?, ?)")

		for (let i = 1; i <= RICH_SQLITE_USERS; i++) user.run(`user${String(i)}@example.com`, "2024-01-02")

		db.exec("COMMIT")
		db.prepare("INSERT INTO documents (title, body) VALUES (?, ?)").run("big", "x".repeat(RICH_SQLITE_DOC_BYTES))
	})
}

export function walDatabase(): Buffer {
	return sqliteBytes(
		db => {
			db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO entries (v) VALUES ('kept')")
		},
		{ wal: true }
	)
}

// Writes about RICH_SQLITE_BIG_BYTES of database to `path`, straight on disk: one small table first, then a table of
// 1 MiB values. Returns its size.
export function writeBigDatabase(path: string): number {
	const db = new DatabaseSync(path)

	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
		INSERT INTO users (email) VALUES ('first@example.com'), ('second@example.com');
		CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB);
		WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(RICH_SQLITE_BIG_BYTES / (1024 * 1024))})
		INSERT INTO blobs (payload) SELECT zeroblob(1048576) FROM n;
	`)
	db.close()

	return statSync(path).size
}

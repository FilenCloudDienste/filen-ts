import type { SqlValue } from "@sqlite.org/sqlite-wasm"
import { matchesNameSearch } from "@filen/shared"

// The notes full-text index, in the db worker's own database. Holds decrypted note text in the origin's
// private OPFS storage, by the owner's decision: sign-out wipes the database files (db.worker.ts wipe),
// and rows of another account are dropped before any use.
//
// The version is in the table names: a changed schema or text derivation bumps it, and the old tables are
// dropped on first use. `edited` is the note's editedTimestamp (bigint as text) the text was read at; a row is
// only ever replaced by one at least as new.

interface Exec {
	exec(opts: { sql: string; bind?: readonly SqlValue[]; callback?: (row: SqlValue[]) => void }): unknown
	createFunction(
		name: string,
		func: (ctxPtr: number, ...values: SqlValue[]) => SqlValue,
		options: { arity: number; deterministic: boolean }
	): unknown
}

export interface NoteIndexRow {
	uuid: string
	edited: string
	text: string
}

const ROWS = "note_search_v2"
const FTS = "note_search_fts_v2"
const OWNER = "note_search_owner_v2"
// Tables of earlier versions, dropped on first use (the full-text table before the one it indexes). v1 indexed words
// (unicode61), so a body matched only at a word's start.
const RETIRED_TABLES: readonly string[] = ["note_search_fts_v1", "note_search_v1", "note_search_owner_v1"]

// The trigram tokenizer indexes every 3-character run, so a query part of 3+ characters matches anywhere in the text,
// in any script.
const TRIGRAM_MIN = 3
// The title search's own test (matchesNameSearch), for query parts too short for the trigram index.
const MATCHES_FN = "note_search_matches"

// U+0002 / U+0003 around each hit in a snippet: never part of note text the user can type, so the page splits on
// them without escaping anything.
export const SNIPPET_OPEN = "\u0002"
export const SNIPPET_CLOSE = "\u0003"
// snippet() counts trigram tokens, about one per character.
const SNIPPET_TOKENS = 48

// Connections whose schema is in place; a wipe reconnects, so this keys on the connection.
const ready = new WeakSet<Exec>()

function ensureSchema(db: Exec): void {
	if (ready.has(db)) {
		return
	}

	for (const table of RETIRED_TABLES) {
		db.exec({ sql: `DROP TABLE IF EXISTS ${table}` })
	}

	db.exec({
		sql: `CREATE TABLE IF NOT EXISTS ${ROWS} (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, edited TEXT NOT NULL, text TEXT NOT NULL)`
	})
	// External content: the text is stored once, in the rows table, and snippet() reads it from there. Case folds and
	// diacritics are kept, as in the title search.
	db.exec({
		sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(text, content='${ROWS}', content_rowid='id', tokenize='trigram case_sensitive 0 remove_diacritics 0')`
	})
	db.createFunction(
		MATCHES_FN,
		(_ctx, text, key) => (typeof text === "string" && typeof key === "string" && matchesNameSearch(text, key) ? 1 : 0),
		{ arity: 2, deterministic: true }
	)
	db.exec({
		sql: `CREATE TRIGGER IF NOT EXISTS ${ROWS}_ai AFTER INSERT ON ${ROWS} BEGIN INSERT INTO ${FTS}(rowid, text) VALUES (new.id, new.text); END`
	})
	db.exec({
		sql: `CREATE TRIGGER IF NOT EXISTS ${ROWS}_ad AFTER DELETE ON ${ROWS} BEGIN INSERT INTO ${FTS}(${FTS}, rowid, text) VALUES ('delete', old.id, old.text); END`
	})
	db.exec({
		sql: `CREATE TRIGGER IF NOT EXISTS ${ROWS}_au AFTER UPDATE OF text ON ${ROWS} BEGIN INSERT INTO ${FTS}(${FTS}, rowid, text) VALUES ('delete', old.id, old.text); INSERT INTO ${FTS}(rowid, text) VALUES (new.id, new.text); END`
	})
	db.exec({ sql: `CREATE TABLE IF NOT EXISTS ${OWNER} (account TEXT NOT NULL)` })
	ready.add(db)
}

function dropAll(db: Exec): void {
	db.exec({ sql: `DROP TABLE IF EXISTS ${FTS}` })
	db.exec({ sql: `DROP TABLE IF EXISTS ${ROWS}` })
	db.exec({ sql: `DROP TABLE IF EXISTS ${OWNER}` })
	ready.delete(db)
}

// Every call names the account it is for: rows another account left (a sign-out whose wipe never landed) are
// dropped before this one reads or writes any.
function claim(db: Exec, account: string): void {
	ensureSchema(db)

	const owners: string[] = []

	db.exec({
		sql: `SELECT account FROM ${OWNER} LIMIT 1`,
		callback: row => {
			if (typeof row[0] === "string") {
				owners.push(row[0])
			}
		}
	})

	const owner = owners[0] ?? null

	if (owner === account) {
		return
	}

	if (owner !== null) {
		dropAll(db)
		ensureSchema(db)
	}

	db.exec({ sql: `INSERT INTO ${OWNER}(account) VALUES (?)`, bind: [account] })
}

function inTransaction(db: Exec, work: () => void): void {
	db.exec({ sql: "BEGIN" })

	try {
		work()
		db.exec({ sql: "COMMIT" })
	} catch (e) {
		db.exec({ sql: "ROLLBACK" })

		throw e
	}
}

// What each indexed note was read at: the page compares it with the list's editedTimestamp to find stale rows.
export function noteIndexStamps(db: Exec, account: string): [string, string][] {
	claim(db, account)

	const out: [string, string][] = []

	db.exec({
		sql: `SELECT uuid, edited FROM ${ROWS}`,
		callback: row => {
			const [uuid, edited] = row

			if (typeof uuid === "string" && typeof edited === "string") {
				out.push([uuid, edited])
			}
		}
	})

	return out
}

// One transaction for the batch. A row older than the one held is ignored: a read that started before an edit can
// land after the edit's own row.
export function noteIndexPut(db: Exec, account: string, rows: readonly NoteIndexRow[]): void {
	claim(db, account)
	inTransaction(db, () => {
		for (const row of rows) {
			db.exec({
				sql: `INSERT INTO ${ROWS}(uuid, edited, text) VALUES (?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET edited = excluded.edited, text = excluded.text WHERE CAST(excluded.edited AS INTEGER) >= CAST(${ROWS}.edited AS INTEGER) AND (excluded.edited <> ${ROWS}.edited OR excluded.text <> ${ROWS}.text)`,
				bind: [row.uuid, row.edited, row.text]
			})
		}
	})
}

export function noteIndexDelete(db: Exec, account: string, uuids: readonly string[]): void {
	claim(db, account)
	db.exec({ sql: `DELETE FROM ${ROWS} WHERE uuid IN (SELECT value FROM json_each(?))`, bind: [JSON.stringify(uuids)] })
}

// Drops every row whose note is no longer listed (deleted elsewhere, left, or no longer shared).
export function noteIndexPrune(db: Exec, account: string, keep: readonly string[]): void {
	claim(db, account)
	db.exec({ sql: `DELETE FROM ${ROWS} WHERE uuid NOT IN (SELECT value FROM json_each(?))`, bind: [JSON.stringify(keep)] })
}

// Where a short-query snippet starts before its hit, and how much of the text it shows.
const SNIPPET_LEAD = 24
const SNIPPET_CHARS = 72

// A snippet for a hit the trigram index did not find (every query part under 3 characters): the text around the
// first part's first occurrence, marked like snippet()'s. Located on the lowercased text, which keeps its indexes
// for all but a few characters; a miss there shows the text's start.
function plainSnippet(text: string, part: string): string {
	const at = text.toLowerCase().indexOf(part)

	if (at === -1) {
		return text.slice(0, SNIPPET_CHARS) + (text.length > SNIPPET_CHARS ? "…" : "")
	}

	const start = Math.max(0, at - SNIPPET_LEAD)
	const hitEnd = at + part.length
	const end = Math.max(hitEnd, Math.min(text.length, start + SNIPPET_CHARS))

	return (
		(start > 0 ? "…" : "") +
		text.slice(start, at) +
		SNIPPET_OPEN +
		text.slice(at, hitEnd) +
		SNIPPET_CLOSE +
		text.slice(hitEnd, end) +
		(end < text.length ? "…" : "")
	)
}

// Notes whose text holds every whitespace-separated part of `key` (a nameSearchKey), anywhere, best first, each with
// a snippet around its hits. Parts of 3+ characters go through the trigram index (bm25 order, snippet()); shorter
// ones are checked on the candidates it returns with the title search's own match. With no part long enough the rows
// are scanned with that match alone, newest first: local text, bounded by the note count.
export function noteIndexSearch(db: Exec, account: string, key: string, limit: number): [string, string][] {
	claim(db, account)

	const parts = key.split(/\s+/u).filter(part => part.length > 0)
	const long = parts.filter(part => Array.from(part).length >= TRIGRAM_MIN)
	const short = parts.filter(part => Array.from(part).length < TRIGRAM_MIN)
	const shortFilter = short.map(() => ` AND ${MATCHES_FN}(r.text, ?) = 1`).join("")
	const out: [string, string][] = []

	if (parts.length === 0) {
		return out
	}

	if (long.length === 0) {
		db.exec({
			sql: `SELECT r.uuid, r.text FROM ${ROWS} r WHERE 1 = 1${shortFilter} ORDER BY CAST(r.edited AS INTEGER) DESC LIMIT ?`,
			bind: [...short, limit],
			callback: row => {
				const [uuid, text] = row

				if (typeof uuid === "string" && typeof text === "string") {
					out.push([uuid, plainSnippet(text, short[0] ?? "")])
				}
			}
		})

		return out
	}

	// Each long part as one quoted string: a trigram phrase is a substring match, and quoting makes FTS5 syntax in it
	// literal text. Space-separated strings must all match.
	const match = long.map(part => `"${part.replaceAll('"', '""')}"`).join(" ")

	db.exec({
		sql: `SELECT r.uuid, snippet(${FTS}, 0, ?, ?, '…', ?) FROM ${FTS} JOIN ${ROWS} r ON r.id = ${FTS}.rowid WHERE ${FTS} MATCH ?${shortFilter} ORDER BY rank LIMIT ?`,
		bind: [SNIPPET_OPEN, SNIPPET_CLOSE, SNIPPET_TOKENS, match, ...short, limit],
		callback: row => {
			const [uuid, snippet] = row

			if (typeof uuid === "string" && typeof snippet === "string") {
				out.push([uuid, snippet])
			}
		}
	})

	return out
}

export function noteIndexClear(db: Exec): void {
	dropAll(db)
}

// The SQLite browser's pure parts: identifier quoting, the schema's classes, how each table is paged (the key a
// keyset walks), the SQL every read runs, and how cell values are shown. Only app-built SELECTs ever run; every
// identifier in them is quoted here.

// Grid tiles (TILE_ROWS × TILE_COLS of @filen/office's sheet protocol).
export const SQLITE_TILE_ROWS = 64
export const SQLITE_TILE_COLS = 32
// Rows each counting step covers: one step is O(chunk) however sparse the keys are. The first step runs before the grid
// draws, at once: it covers the first tile's data rows (its first grid row is the header) and nothing past them, so it
// reads only the pages that tile reads anyway. Rows of large values spread a table's leaf pages over the file; a ranged
// read of each is a block download of its own.
export const SQLITE_COUNT_CHUNK = 50_000
export const SQLITE_FIRST_COUNT_CHUNK = SQLITE_TILE_ROWS - 1
// The shared interrupt flag's slots (an Int32Array the page and the worker both hold): tile requests with an id at or
// below slot 0 are stale; the count with slot 1's id stops; the check with slot 2's id stops.
export const INTERRUPT_TILES = 0
export const INTERRUPT_COUNT = 1
export const INTERRUPT_CHECK = 2
export const SQLITE_INTERRUPT_SLOTS = 3
// A text cell's tile text is read only up to this many bytes; a longer one shows its size instead.
export const SQLITE_INLINE_TEXT_BYTES = 65_536
// What a tile shows of a text cell.
export const SQLITE_TILE_TEXT_CHARS = 256
// A selected cell's whole value is loaded only up to this.
export const SQLITE_CELL_MAX_BYTES = 1_048_576
// A selected BLOB shows a hex dump of its start.
export const SQLITE_HEX_DUMP_BYTES = 65_536
// The integrity check runs by itself up to this size; above it, when asked (the whole-path cap too).
export const SQLITE_AUTO_CHECK_MAX_BYTES = 268_435_456
// The SQLite file header's first 16 bytes.
export const SQLITE_HEADER = "SQLite format 3\0"
// The header's write and read format versions: 2 means WAL.
export const SQLITE_HEADER_WRITE_VERSION = 18
export const SQLITE_HEADER_READ_VERSION = 19

export function isSqliteHeader(head: Uint8Array): boolean {
	if (head.length < SQLITE_HEADER.length) return false

	for (let i = 0; i < SQLITE_HEADER.length; i++) {
		if (head[i] !== SQLITE_HEADER.charCodeAt(i)) return false
	}

	return true
}

// Rewrites the header's format versions to 1 (rollback) in `target`, which holds the file's bytes from `position` on;
// true when either was 2 (WAL). A WAL database then opens without its -wal and -shm files; what is only in the WAL is
// not shown. The file itself is never touched.
export function patchWalHeader(target: Uint8Array, offset: number, length: number, position: number): boolean {
	let wal = false

	for (const at of [SQLITE_HEADER_WRITE_VERSION, SQLITE_HEADER_READ_VERSION]) {
		if (at >= position && at < position + length) {
			const index = offset + (at - position)

			if (target[index] === 2) {
				wal = true
				target[index] = 1
			}
		}
	}

	return wal
}

// "name" with embedded quotes doubled: safe for any identifier.
export function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

export type SchemaKind = "table" | "view" | "virtual"

// A sqlite_schema row of type table or view.
export interface SchemaObject {
	readonly name: string
	readonly kind: SchemaKind
	readonly sql: string
	// A table declared WITHOUT ROWID.
	readonly withoutRowid: boolean
}

const VIRTUAL = /^\s*create\s+virtual\s+table\b/i

// The kind of a sqlite_schema table or view row by its SQL. A virtual table is listed, never queried: its module's
// code would run over the file's data (shadow tables stay browsable as plain tables).
export function schemaKind(type: string, sql: string): SchemaKind {
	if (type === "view") return "view"

	return VIRTUAL.test(sql) ? "virtual" : "table"
}

// Internal tables a database keeps for itself, never user data.
export function isInternalTable(name: string): boolean {
	return name.toLowerCase().startsWith("sqlite_") && name.toLowerCase() !== "sqlite_sequence" && name.toLowerCase() !== "sqlite_stat1"
}

export interface TableColumn {
	readonly name: string
	readonly type: string
	// Position in the primary key (1-based), 0 when not in it.
	readonly pk: number
}

// How a table's rows are walked in order: by a key (the rowid through an alias no user column takes, or a WITHOUT
// ROWID table's primary key), or by OFFSET when a table's columns take every rowid alias.
export type TablePaging = { readonly kind: "keyset"; readonly key: readonly string[] } | { readonly kind: "offset" }

const ROWID_ALIASES = ["_rowid_", "rowid", "oid"] as const

// The paging of a rowid table: its first rowid alias no column is named.
export function rowidPaging(columns: readonly TableColumn[]): TablePaging {
	const names = new Set(columns.map(column => column.name.toLowerCase()))
	const alias = ROWID_ALIASES.find(candidate => !names.has(candidate))

	return alias === undefined ? { kind: "offset" } : { kind: "keyset", key: [alias] }
}

function keyList(key: readonly string[]): string {
	return key.map(quoteIdent).join(", ")
}

// `(a, b) > (?, ?)`: rows after a key, by the row-value comparison the ORDER BY of the same columns agrees with.
function after(key: readonly string[]): string {
	return key.length === 1 ? `${quoteIdent(key[0] ?? "")} > ?` : `(${keyList(key)}) > (${key.map(() => "?").join(", ")})`
}

// Each column's tile value: its type, its byte length (metadata only for TEXT and BLOB) and, for short text, its
// first SQLITE_TILE_TEXT_CHARS characters, so a large value is never read into a tile.
export function cellProjection(column: string): string {
	const c = quoteIdent(column)

	return (
		`typeof(${c}), octet_length(${c}), ` +
		`CASE WHEN typeof(${c}) = 'text' AND octet_length(${c}) <= ${String(SQLITE_INLINE_TEXT_BYTES)} THEN substr(${c}, 1, ${String(SQLITE_TILE_TEXT_CHARS)}) ` +
		`WHEN typeof(${c}) IN ('integer', 'real') THEN ${c} END`
	)
}

// The SELECT of one tile's rows: `count` rows from the start of a run (`skip` past the anchor), over `columns`; the
// key's columns come last, so the next run can continue from the last row's key.
export function tileSql(
	table: string,
	paging: TablePaging,
	columns: readonly string[],
	anchored: boolean,
	skip: number,
	count: number
): string {
	const projection = [...columns.map(cellProjection), ...(paging.kind === "keyset" ? paging.key.map(quoteIdent) : [])].join(", ")
	const from = `FROM ${quoteIdent(table)}`

	if (paging.kind === "offset") return `SELECT ${projection} ${from} LIMIT ${String(count)} OFFSET ${String(skip)}`

	const where = anchored ? ` WHERE ${after(paging.key)}` : ""

	return `SELECT ${projection} ${from}${where} ORDER BY ${keyList(paging.key)} LIMIT ${String(count)} OFFSET ${String(skip)}`
}

// The key of the row `skip` rows past an anchor (or the start): where the next counting chunk continues from.
export function chunkEndSql(table: string, key: readonly string[], anchored: boolean, chunk: number = SQLITE_COUNT_CHUNK): string {
	const where = anchored ? ` WHERE ${after(key)}` : ""

	return `SELECT ${keyList(key)} FROM ${quoteIdent(table)}${where} ORDER BY ${keyList(key)} LIMIT 1 OFFSET ${String(chunk - 1)}`
}

// How many rows remain after an anchor (or in all), the last chunk: fewer than SQLITE_COUNT_CHUNK.
export function chunkRestSql(table: string, key: readonly string[], anchored: boolean, chunk: number = SQLITE_COUNT_CHUNK): string {
	const where = anchored ? ` WHERE ${after(key)}` : ""

	return `SELECT count(*) FROM (SELECT 1 FROM ${quoteIdent(table)}${where} LIMIT ${String(chunk)})`
}

// One cell's whole value (up to SQLITE_CELL_MAX_BYTES; a longer one's first SQLITE_HEX_DUMP_BYTES), `skip` rows past an
// anchor (or the start), as tileSql walks.
export function cellSql(table: string, paging: TablePaging, column: string, anchored: boolean): string {
	const c = quoteIdent(column)
	// A BLOB is shown as a hex dump of its start only, whatever its size.
	const value =
		`typeof(${c}), octet_length(${c}), CASE WHEN typeof(${c}) <> 'blob' AND octet_length(${c}) <= ${String(SQLITE_CELL_MAX_BYTES)} THEN ${c} ` +
		`ELSE substr(${c}, 1, ${String(SQLITE_HEX_DUMP_BYTES)}) END`

	if (paging.kind === "offset") return `SELECT ${value} FROM ${quoteIdent(table)} LIMIT 1 OFFSET ?`

	const where = anchored ? ` WHERE ${after(paging.key)}` : ""

	return `SELECT ${value} FROM ${quoteIdent(table)}${where} ORDER BY ${keyList(paging.key)} LIMIT 1 OFFSET ?`
}

// Where in the table's order a row index lies: the nearest known anchor at or before it.
export interface RowAnchor {
	// Rows before the anchor's key (the anchor row itself is the last of them).
	readonly index: number
	readonly key: readonly SqlKeyValue[]
}

export type SqlKeyValue = number | bigint | string | Uint8Array | null

// Anchors kept per table, ascending by index: one per counting chunk, one per tile run.
export class AnchorIndex {
	private readonly anchors: RowAnchor[] = []

	// The nearest anchor at or before `row` (rows before it); null: from the start.
	before(row: number): RowAnchor | null {
		let low = 0
		let high = this.anchors.length - 1
		let found: RowAnchor | null = null

		while (low <= high) {
			const middle = (low + high) >>> 1
			const anchor = this.anchors[middle]

			if (anchor === undefined) break

			if (anchor.index <= row) {
				found = anchor
				low = middle + 1
			} else {
				high = middle - 1
			}
		}

		return found
	}

	add(anchor: RowAnchor): void {
		let at = this.anchors.length

		while (at > 0 && (this.anchors[at - 1]?.index ?? 0) > anchor.index) at--

		if (this.anchors[at - 1]?.index === anchor.index) return

		this.anchors.splice(at, 0, anchor)
	}

	get size(): number {
		return this.anchors.length
	}
}

// A tile cell as read: its storage class, its byte length, and its short value.
export interface CellRead {
	readonly type: string
	readonly bytes: number
	readonly value: SqlKeyValue
}

// What a cell's tile shows, and whether it is a value (number, text) or a note about one (NULL, a large value).
export type CellView =
	| { readonly kind: "number"; readonly text: string }
	| { readonly kind: "text"; readonly text: string; readonly clipped: boolean }
	| { readonly kind: "null" }
	| { readonly kind: "blob"; readonly bytes: number }
	| { readonly kind: "largeText"; readonly bytes: number }

export function cellView(cell: CellRead): CellView {
	switch (cell.type) {
		case "null":
			return { kind: "null" }
		case "integer":
		case "real":
			// Integers past 2^53 arrive as bigints: shown exactly.
			return { kind: "number", text: String(cell.value) }
		case "blob":
			return { kind: "blob", bytes: cell.bytes }
		default:
			if (typeof cell.value !== "string") return { kind: "largeText", bytes: cell.bytes }

			return {
				kind: "text",
				text: cell.value,
				clipped: cell.value.length >= SQLITE_TILE_TEXT_CHARS && cell.bytes > cell.value.length
			}
	}
}

// A hex dump of `bytes`: 16 per line, offset, hex, and the printable ASCII.
export function hexDump(bytes: Uint8Array): string {
	const lines: string[] = []

	for (let at = 0; at < bytes.length; at += 16) {
		const row = bytes.subarray(at, at + 16)
		const hex = [...row].map(byte => byte.toString(16).padStart(2, "0")).join(" ")
		const ascii = [...row].map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("")

		lines.push(`${at.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`)
	}

	return lines.join("\n")
}

// The text a selected cell's full view shows: the value's text, or a hex dump of a BLOB's first SQLITE_HEX_DUMP_BYTES.
export function fullValueText(value: string | Uint8Array | null): string {
	if (value === null) return ""
	if (typeof value === "string") return value

	return hexDump(value.subarray(0, SQLITE_HEX_DUMP_BYTES))
}

// Where "Go to row" (1-based) goes: a row of the grid's window, or a new window whose first row is it. Past the end of a
// table whose count is exact, its last row.
export type RowTarget = { readonly kind: "reveal"; readonly gridRow: number } | { readonly kind: "rebase"; readonly base: number }

export function goToRow(
	row: number,
	base: number,
	windowRows: number,
	count: { readonly rows: number; readonly exact: boolean } | null
): RowTarget {
	const target = count?.exact === true ? Math.max(1, Math.min(row, count.rows)) : row

	if (target > base && target - base <= windowRows) return { kind: "reveal", gridRow: target - base }

	return { kind: "rebase", base: target - 1 }
}

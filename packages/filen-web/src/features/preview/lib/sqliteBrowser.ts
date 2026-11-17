import type { Database, PreparedStatement, SqlValue, Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import { formatBytes } from "@filen/shared"
import { CellFlag, tilePosition, type SheetTile } from "@filen/office/core/sheet"
import { RANGE_VFS_NAME, rangeVfs, type RangeFileState, type SyncByteReader } from "@/features/preview/lib/sqliteRangeVfs"
import {
	AnchorIndex,
	INTERRUPT_CHECK,
	INTERRUPT_COUNT,
	INTERRUPT_TILES,
	SQLITE_COUNT_CHUNK,
	SQLITE_FIRST_COUNT_CHUNK,
	SQLITE_TILE_COLS,
	SQLITE_TILE_ROWS,
	cellSql,
	cellView,
	chunkEndSql,
	chunkRestSql,
	isInternalTable,
	isSqliteHeader,
	patchWalHeader,
	quoteIdent,
	rowidPaging,
	tileSql,
	type CellRead,
	type SchemaKind,
	type SqlKeyValue,
	type TableColumn,
	type TablePaging
} from "@/features/preview/lib/sqliteBrowse.logic"

// A database opened read-only and hardened (sqlite.org/security.html), in its own worker: the schema listed, tables
// read by tiles of 64 rows × 32 columns through app-built SELECTs alone, rows counted in chunks, and the integrity
// check. Views are listed with their SQL and never queried; virtual tables are listed and never touched (their
// module's code would run over the file's data).

// The grid's render styles: the default, the header row, and a note about a value (NULL, a large value).
export const STYLE_HEADER = 1
export const STYLE_NOTE = 2

export interface SqliteLabels {
	readonly null: string
	// "Text, {{size}}" and "BLOB, {{size}}", the size filled in.
	readonly text: string
	readonly blob: string
}

export interface SqliteTableInfo {
	readonly name: string
	readonly kind: SchemaKind
	readonly sql: string
	readonly columns: readonly TableColumn[]
}

export interface SqliteSchema {
	readonly tables: readonly SqliteTableInfo[]
	// The header said WAL: what is only in the -wal file is not shown.
	readonly wal: boolean
}

// What a counting step found: the rows so far, and whether that is all of them.
export interface SqliteCount {
	readonly rows: number
	readonly exact: boolean
}

export type SqliteCheck = "ok" | "damaged" | "cancelled"

// A failure the viewer names: not a database, unreadable (a read failed), or damaged.
export class SqliteOpenError extends Error {
	readonly reason: "notSqlite" | "unreadable" | "damaged"

	constructor(reason: "notSqlite" | "unreadable" | "damaged", message: string) {
		super(message)

		this.name = "SqliteOpenError"
		this.reason = reason
	}
}

const MAIN_NAME = "main.db"
// Ops between checks of the interrupt flag.
const PROGRESS_OPS = 1000
const PAGE_CACHE_KIB = 8192
const MAX_SQL_LENGTH = 100_000
const MAX_VALUE_LENGTH = 64 * 1024 * 1024
// sqlite.org/security.html §1.1's limits, set well below the defaults but above what real schemas and this browser's own
// SELECTs need: a wide table keeps its columns (the column limit stays), a schema's CHECK and DEFAULT expressions their
// depth. Triggers never run.
export const SCHEMA_LIMITS = [
	["SQLITE_LIMIT_EXPR_DEPTH", 200],
	["SQLITE_LIMIT_COMPOUND_SELECT", 50],
	["SQLITE_LIMIT_FUNCTION_ARG", 32],
	["SQLITE_LIMIT_LIKE_PATTERN_LENGTH", 10_000],
	["SQLITE_LIMIT_VARIABLE_NUMBER", 100],
	["SQLITE_LIMIT_TRIGGER_DEPTH", 1]
] as const

interface TableState {
	readonly info: SqliteTableInfo
	readonly paging: TablePaging
	readonly anchors: AnchorIndex
	// Counting so far: rows before `next` (null: from the start), and whether it reached the end.
	counted: number
	next: readonly SqlKeyValue[] | null
	done: boolean
}

// How the database reaches sqlite: ranged through the VFS, or whole in sqlite's own memory.
// A whole source hands its bytes over in blocks, in order.
export type SqliteSource =
	| { readonly kind: "ranged"; readonly reader: SyncByteReader }
	| {
			readonly kind: "whole"
			readonly size: number
			readonly blockBytes: number
			readonly read: (start: number, end: number) => Promise<Uint8Array>
	  }

function quiet(): void {
	// Library diagnostics stay out of the console.
}

// The library's own VFSes (OPFS, kvvfs) stay uninstalled: nothing of the user's file is ever written anywhere.
export function sqliteApiConfig(): Record<string, unknown> {
	return {
		warn: quiet,
		log: quiet,
		debug: quiet,
		disable: { vfs: { opfs: true, "opfs-vfs": true, "opfs-sahpool": true, "opfs-wl": true, kvvfs: true } }
	}
}

// A request stopped by the interrupt flag: the page asked for it to stop (stale tiles, a count a grid read went ahead
// of, a cancelled check). Matched by name, which crosses the worker boundary.
export class SqliteInterrupted extends Error {
	constructor() {
		super("interrupted")

		this.name = "SqliteInterrupted"
	}
}

// A read of the file failed after the database opened (an aborted or timed-out bridge read).
export class SqliteUnreadable extends Error {
	constructor(message: string) {
		super(message)

		this.name = "SqliteUnreadable"
	}
}

export function isSqliteInterrupted(error: unknown): boolean {
	return error instanceof Error && error.name === "SqliteInterrupted"
}

export function isSqliteUnreadable(error: unknown): boolean {
	return error instanceof Error && error.name === "SqliteUnreadable"
}

type RequestKind = "tiles" | "count" | "cell"

function sqlError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export class SqliteBrowser {
	readonly schema: SqliteSchema
	private readonly sqlite3: Sqlite3Static
	private readonly db: Database
	private readonly file: RangeFileState | null
	private readonly tables: TableState[]
	private readonly labels: SqliteLabels
	// The shared interrupt flag (INTERRUPT_* slots).
	private readonly interrupt: Int32Array
	private current: { kind: RequestKind; id: number } | null = null
	// The progress handler stopped the running request.
	private stopped = false

	private constructor(
		sqlite3: Sqlite3Static,
		db: Database,
		file: RangeFileState | null,
		wal: boolean,
		labels: SqliteLabels,
		interrupt: Int32Array
	) {
		this.sqlite3 = sqlite3
		this.db = db
		this.file = file
		this.labels = labels
		this.interrupt = interrupt
		this.harden()
		this.tables = this.readTables()
		this.schema = { tables: this.tables.map(table => table.info), wal: wal || (file?.wal ?? false) }
	}

	// Opens `source` read-only. Rejects with SqliteOpenError when it is no database, cannot be read, or its schema is
	// damaged.
	static async open(sqlite3: Sqlite3Static, source: SqliteSource, labels: SqliteLabels, interrupt: Int32Array): Promise<SqliteBrowser> {
		const { capi, wasm, oo1 } = sqlite3

		if (source.kind === "ranged") {
			const head = new Uint8Array(16)

			if (source.reader.read(head, 0, 16, 0) < 16 || !isSqliteHeader(head)) {
				throw new SqliteOpenError("notSqlite", "the file does not start with the SQLite header")
			}

			const vfs = rangeVfs(sqlite3)
			const file = vfs.add(MAIN_NAME, source.reader)
			let db: Database

			try {
				db = new oo1.DB({ filename: `file:${MAIN_NAME}?immutable=1`, flags: "r", vfs: RANGE_VFS_NAME })
			} catch (error) {
				throw new SqliteOpenError(file.failed ? "unreadable" : "damaged", sqlError(error))
			}

			return SqliteBrowser.opened(sqlite3, db, file, false, labels, interrupt)
		}

		if (source.size < 16) throw new SqliteOpenError("notSqlite", "the file is too short for a database")

		// The header is checked on the first block, before anything else is read or allocated.
		const first = await source.read(0, Math.min(source.size, source.blockBytes))

		if (!isSqliteHeader(first)) throw new SqliteOpenError("notSqlite", "the file does not start with the SQLite header")

		// FREEONCLOSE: sqlite frees the copy, so it must be sqlite's own memory.
		const pointer = capi.sqlite3_malloc64(BigInt(source.size))

		if (pointer === 0) throw new SqliteOpenError("unreadable", "no memory for the database")

		const db = new oo1.DB(":memory:", "c")
		let owned = false

		try {
			// The heap view is taken again per block: wasm memory may grow in between.
			wasm.heap8u().set(first, pointer)

			for (let at = first.length; at < source.size; at += source.blockBytes) {
				wasm.heap8u().set(await source.read(at, Math.min(source.size, at + source.blockBytes)), pointer + at)
			}

			// An in-memory database has no WAL: read as rollback mode.
			const wal = patchWalHeader(wasm.heap8u(), pointer, source.size, 0)
			const rc = capi.sqlite3_deserialize(
				db.pointer ?? 0,
				"main",
				pointer,
				source.size,
				source.size,
				capi.SQLITE_DESERIALIZE_READONLY | capi.SQLITE_DESERIALIZE_FREEONCLOSE
			)

			owned = true

			if (rc !== 0) throw new SqliteOpenError("damaged", `sqlite3_deserialize: ${String(rc)}`)

			return SqliteBrowser.opened(sqlite3, db, null, wal, labels, interrupt)
		} catch (error) {
			if (!owned) capi.sqlite3_free(pointer)

			db.close()

			throw error
		}
	}

	private static opened(
		sqlite3: Sqlite3Static,
		db: Database,
		file: RangeFileState | null,
		wal: boolean,
		labels: SqliteLabels,
		interrupt: Int32Array
	): SqliteBrowser {
		try {
			return new SqliteBrowser(sqlite3, db, file, wal, labels, interrupt)
		} catch (error) {
			db.close()

			if (error instanceof SqliteOpenError) throw error

			// A read that failed made sqlite fail; anything else is the file's own damage.
			throw new SqliteOpenError(file?.failed === true ? "unreadable" : "damaged", sqlError(error))
		}
	}

	// sqlite.org/security.html §1.1 and §1.2: no trust in the schema, no triggers or views run, no writes.
	private harden(): void {
		const { capi } = this.sqlite3
		const pointer = this.db.pointer ?? 0

		// No virtual table module is left to connect: listing the schema prepares every virtual table, which would run
		// fts5's or rtree's code over the file's own shadow data. They stay listed by their SQL.
		capi.sqlite3_drop_modules(pointer, 0)
		capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, 0)
		capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, 0, 0)
		capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_ENABLE_VIEW, 0, 0)
		capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_DEFENSIVE, 1, 0)
		capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_ATTACHED, 0)
		capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_LENGTH)
		capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_LENGTH, MAX_VALUE_LENGTH)

		// security.html §1.1: what a hostile schema may make the parser hold. (No hard heap limit: this build binds
		// none; the worker's memory is bounded by its owner ending it.)
		for (const [limit, value] of SCHEMA_LIMITS) capi.sqlite3_limit(pointer, capi[limit], value)
		this.db.exec(`PRAGMA cell_size_check=ON; PRAGMA mmap_size=0; PRAGMA query_only=ON; PRAGMA cache_size=-${String(PAGE_CACHE_KIB)}`)
		this.installInterrupt()
	}

	// The interrupt flag, checked every PROGRESS_OPS ops.
	private installInterrupt(): void {
		this.sqlite3.capi.sqlite3_progress_handler(
			this.db.pointer ?? 0,
			PROGRESS_OPS,
			() => {
				if (this.current === null || !this.isStale(this.current.kind, this.current.id)) return 0

				this.stopped = true

				return 1
			},
			0
		)
	}

	private wasStopped(): boolean {
		return this.stopped
	}

	private isStale(kind: RequestKind, id: number): boolean {
		switch (kind) {
			case "tiles":
				return id <= Atomics.load(this.interrupt, INTERRUPT_TILES)
			case "count":
				return Atomics.load(this.interrupt, INTERRUPT_COUNT) === id
			case "cell":
				return false
		}
	}

	private readTables(): TableState[] {
		const rows = this.db.exec({
			sql: "SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main' ORDER BY name COLLATE NOCASE",
			rowMode: "array",
			returnValue: "resultRows"
		})
		const sqlOf = (name: string): string => {
			const value = this.db.selectValue("SELECT sql FROM sqlite_schema WHERE name = ?", [name])

			return typeof value === "string" ? value : ""
		}
		const tables: TableState[] = []

		for (const [name, type, withoutRowid] of rows) {
			if (typeof name !== "string" || isInternalTable(name)) continue

			// sqlite_schema's own SQL decides a virtual table too: a module the library lacks reads as a table here.
			const sql = sqlOf(name)
			const kind: SchemaKind =
				type === "view" ? "view" : type === "virtual" || /^\s*create\s+virtual\s+table\b/i.test(sql) ? "virtual" : "table"
			const columns = kind === "table" ? this.columnsOf(name) : []
			const paging: TablePaging =
				kind !== "table"
					? { kind: "offset" }
					: withoutRowid === 1
						? {
								kind: "keyset",
								key: columns
									.filter(column => column.pk > 0)
									.sort((a, b) => a.pk - b.pk)
									.map(column => column.name)
							}
						: rowidPaging(columns)

			tables.push({ info: { name, kind, sql, columns }, paging, anchors: new AnchorIndex(), counted: 0, next: null, done: false })
		}

		return tables
	}

	private columnsOf(table: string): TableColumn[] {
		const rows = this.db.exec({
			sql: "SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid",
			bind: [table],
			rowMode: "array",
			returnValue: "resultRows"
		})

		return rows.map(([name, type, pk]) => ({ name: sqlText(name), type: sqlText(type), pk: Number(pk) }))
	}

	private table(index: number): TableState {
		const table = this.tables[index]

		if (table?.info.kind !== "table") throw new Error(`no browsable table ${String(index)}`)

		return table
	}

	// Runs `run` as request `id` of `kind`. A request the flag marks stale (before or while it runs) rejects with
	// SqliteInterrupted; one a failed read of the file stopped, with SqliteUnreadable.
	private request<T>(kind: RequestKind, id: number, run: () => T): T {
		if (this.isStale(kind, id)) throw new SqliteInterrupted()

		this.current = { kind, id }
		this.stopped = false

		if (this.file !== null) this.file.failed = false

		try {
			return run()
		} catch (error) {
			// The progress handler set it meanwhile.
			if (this.wasStopped()) throw new SqliteInterrupted()
			if (this.file?.failed === true) throw new SqliteUnreadable(sqlError(error))

			throw error
		} finally {
			this.current = null
		}
	}

	private statement<T>(sql: string, bind: readonly SqlValue[], read: (statement: PreparedStatement) => T): T {
		const statement = this.db.prepare(sql)

		try {
			if (bind.length > 0) statement.bind([...bind])

			return read(statement)
		} finally {
			statement.finalize()
		}
	}

	// The rows a table holds, counted on from where the last step stopped by one chunk (SQLITE_COUNT_CHUNK rows); every
	// chunk boundary becomes an anchor the tiles walk from. For a table no key orders, all at once.
	countStep(index: number, id: number): SqliteCount {
		const table = this.table(index)

		if (table.done) return { rows: table.counted, exact: true }

		return this.request("count", id, () => {
			const { paging, info } = table

			if (paging.kind === "offset") {
				table.counted = Number(this.db.selectValue(`SELECT count(*) FROM ${quoteIdent(info.name)}`) ?? 0)
				table.done = true

				return { rows: table.counted, exact: true }
			}

			const anchored = table.next !== null
			const bind = table.next ?? []
			const chunk = anchored ? SQLITE_COUNT_CHUNK : SQLITE_FIRST_COUNT_CHUNK
			const end = this.statement(chunkEndSql(info.name, paging.key, anchored, chunk), bind, statement =>
				statement.step() ? paging.key.map((_, k) => keyValue(statement.get(k))) : null
			)

			if (end !== null) {
				table.counted += chunk
				table.next = end
				table.anchors.add({ index: table.counted, key: end })

				return { rows: table.counted, exact: false }
			}

			table.counted += Number(
				this.statement(chunkRestSql(info.name, paging.key, anchored, chunk), bind, statement =>
					statement.step() ? statement.get(0) : 0
				)
			)
			table.done = true

			return { rows: table.counted, exact: true }
		})
	}

	// Tiles of a table's grid, its first row the column names; grid row g ≥ 1 is data row `base + g - 1`.
	tiles(index: number, base: number, coordinates: Uint32Array, id: number): SheetTile[] {
		const table = this.table(index)

		return this.request("tiles", id, () => {
			const tiles: SheetTile[] = []

			for (let at = 0; at + 1 < coordinates.length; at += 2) {
				tiles.push(this.tile(table, base, coordinates[at] ?? 0, coordinates[at + 1] ?? 0))
			}

			return tiles
		})
	}

	private tile(table: TableState, base: number, tileRow: number, tileCol: number): SheetTile {
		const { info, paging } = table
		const firstCol = tileCol * SQLITE_TILE_COLS
		const columns = info.columns.slice(firstCol, firstCol + SQLITE_TILE_COLS).map(column => column.name)
		const builder = new TileBuilder()
		const firstGridRow = tileRow * SQLITE_TILE_ROWS
		let gridRow = firstGridRow

		if (firstGridRow === 0) {
			columns.forEach((name, c) => {
				builder.add(0, c, name, STYLE_HEADER, 0)
			})
			gridRow = 1
		}

		const firstData = base + gridRow - 1
		const count = firstGridRow + SQLITE_TILE_ROWS - gridRow

		if (columns.length > 0) {
			const anchor = paging.kind === "keyset" ? table.anchors.before(firstData) : null
			const skip = firstData - (anchor?.index ?? 0)
			const sql = tileSql(info.name, paging, columns, anchor !== null, skip, count)
			const keyCount = paging.kind === "keyset" ? paging.key.length : 0
			let fetched = 0
			const last: { key: SqlKeyValue[] | null } = { key: null }

			this.statement(sql, anchor?.key ?? [], statement => {
				while (statement.step()) {
					const row = gridRow + fetched

					for (let c = 0; c < columns.length; c++) {
						this.addCell(builder, row, c, {
							type: sqlText(statement.get(c * 3)),
							bytes: Number(statement.get(c * 3 + 1) ?? 0),
							value: keyValue(statement.get(c * 3 + 2))
						})
					}

					if (keyCount > 0) {
						const key: SqlKeyValue[] = []

						for (let k = 0; k < keyCount; k++) key.push(keyValue(statement.get(columns.length * 3 + k)))

						last.key = key
					}

					fetched++
				}
			})

			if (last.key !== null) table.anchors.add({ index: firstData + fetched, key: last.key })
		}

		return builder.build(0, tileRow, tileCol)
	}

	private addCell(builder: TileBuilder, row: number, col: number, cell: CellRead): void {
		const view = cellView(cell)

		switch (view.kind) {
			case "number":
				builder.add(row, col, view.text, 0, CellFlag.NUMBER)
				break
			case "text":
				if (view.text !== "") builder.add(row, col, view.text, 0, view.clipped ? CellFlag.CLIPPED : 0)
				break
			case "null":
				builder.add(row, col, this.labels.null, STYLE_NOTE, 0)
				break
			case "blob":
				builder.add(row, col, this.labels.blob.replace("{{size}}", formatBytes(view.bytes)), STYLE_NOTE, 0)
				break
			case "largeText":
				builder.add(row, col, this.labels.text.replace("{{size}}", formatBytes(view.bytes)), STYLE_NOTE, 0)
				break
		}
	}

	// One cell's value as a selection shows it: its storage class, size, and value (text, a number, or a BLOB's first
	// bytes); `value` is null for NULL and for a text longer than SQLITE_CELL_MAX_BYTES, whose start is in `preview`.
	cell(index: number, base: number, gridRow: number, col: number, id: number): SqliteCellValue {
		const table = this.table(index)
		const column = table.info.columns[col]

		if (gridRow === 0 || column === undefined) return { type: "text", bytes: 0, value: column?.name ?? "" }

		return this.request("cell", id, () => {
			const dataRow = base + gridRow - 1
			const anchor = table.paging.kind === "keyset" ? table.anchors.before(dataRow) : null
			const skip = dataRow - (anchor?.index ?? 0)

			return this.statement(
				cellSql(table.info.name, table.paging, column.name, anchor !== null),
				[...(anchor?.key ?? []), skip],
				statement => {
					if (!statement.step()) return { type: "null", bytes: 0, value: null }

					return { type: sqlText(statement.get(0)), bytes: Number(statement.get(1) ?? 0), value: cellValue(statement.get(2)) }
				}
			)
		})
	}

	// PRAGMA quick_check: every page read. `onProgress` gets the bytes read so far (ranged) about every PROGRESS_OPS
	// ops; setting the interrupt flag to `id` cancels it.
	check(id: number, onProgress: (bytesRead: number) => void): SqliteCheck {
		const { capi } = this.sqlite3
		const pointer = this.db.pointer ?? 0
		let last = 0

		if (this.file !== null) this.file.failed = false

		capi.sqlite3_progress_handler(
			pointer,
			PROGRESS_OPS,
			() => {
				if (Atomics.load(this.interrupt, INTERRUPT_CHECK) === id) return 1

				const now = performance.now()

				if (this.file !== null && now - last > 100) {
					last = now
					onProgress(this.file.bytesRead)
				}

				return 0
			},
			0
		)

		try {
			const rows = this.db.exec({ sql: "PRAGMA quick_check", rowMode: "array", returnValue: "resultRows" })

			return rows.length === 1 && rows[0]?.[0] === "ok" ? "ok" : "damaged"
		} catch (error) {
			if (Atomics.load(this.interrupt, INTERRUPT_CHECK) === id) return "cancelled"
			if (this.file?.failed === true) throw new SqliteUnreadable(sqlError(error))

			return "damaged"
		} finally {
			this.installInterrupt()
		}
	}

	close(): void {
		this.db.close()

		if (this.file !== null) rangeVfs(this.sqlite3).remove(MAIN_NAME)
	}
}

export interface SqliteCellValue {
	readonly type: string
	readonly bytes: number
	// Text or a number as text; a BLOB's (first) bytes; null for NULL.
	readonly value: string | Uint8Array | null
}

// A column's text: a string as it is, a number as its digits, anything else empty.
function sqlText(value: SqlValue | undefined): string {
	return typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : ""
}

function keyValue(value: SqlValue): SqlKeyValue {
	if (value instanceof Int8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	if (value instanceof ArrayBuffer) return new Uint8Array(value)

	return value
}

function cellValue(value: SqlValue): string | Uint8Array | null {
	const key = keyValue(value)

	return typeof key === "number" || typeof key === "bigint" ? String(key) : key
}

// One tile's sparse cells, in row-major order.
class TileBuilder {
	private readonly positions: number[] = []
	private readonly texts: number[] = []
	private readonly styles: number[] = []
	private readonly flags: number[] = []
	private readonly strings: string[] = []

	add(row: number, col: number, text: string, style: number, flags: number): void {
		this.positions.push(tilePosition(row, col))
		this.texts.push(this.strings.length)
		this.strings.push(text)
		this.styles.push(style)
		this.flags.push(flags)
	}

	build(sheet: number, tileRow: number, tileCol: number): SheetTile {
		const count = this.positions.length

		return {
			sheet,
			tileRow,
			tileCol,
			version: 0,
			count,
			positions: Uint16Array.from(this.positions),
			texts: Int32Array.from(this.texts),
			inputs: new Int32Array(count).fill(-1),
			styles: Uint32Array.from(this.styles),
			flags: Uint32Array.from(this.flags),
			strings: this.strings
		}
	}
}

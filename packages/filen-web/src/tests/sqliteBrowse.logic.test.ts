import { describe, expect, it } from "vitest"
import {
	AnchorIndex,
	SQLITE_HEADER,
	SQLITE_COUNT_CHUNK,
	SQLITE_GROW_CHUNK,
	SQLITE_HEX_DUMP_BYTES,
	SQLITE_TILE_ROWS,
	countChunk,
	gridRows,
	cellView,
	fullValueText,
	goToRow,
	chunkEndSql,
	hexDump,
	isSqliteHeader,
	patchWalHeader,
	quoteIdent,
	rowidPaging,
	schemaKind,
	tileSql
} from "@/features/preview/lib/sqliteBrowse.logic"

function column(name: string) {
	return { name, type: "", pk: 0 }
}

describe("sqlite browse logic", () => {
	it("quotes any identifier", () => {
		expect(quoteIdent("users")).toBe('"users"')
		expect(quoteIdent('we"ird; DROP')).toBe('"we""ird; DROP"')
	})

	it("pages by the first rowid alias no column takes, else by OFFSET", () => {
		expect(rowidPaging([column("id")])).toEqual({ kind: "keyset", key: ["_rowid_"] })
		expect(rowidPaging([column("_ROWID_")])).toEqual({ kind: "keyset", key: ["rowid"] })
		expect(rowidPaging([column("_rowid_"), column("rowid")])).toEqual({ kind: "keyset", key: ["oid"] })
		expect(rowidPaging([column("_rowid_"), column("rowid"), column("oid")])).toEqual({ kind: "offset" })
	})

	it("continues after a key by a row-value comparison for 1-, 2- and 3-column keys", () => {
		const columns = ["v"]

		expect(tileSql("t", { kind: "keyset", key: ["k"] }, columns, true, 3, 64)).toContain('WHERE "k" > ? ORDER BY "k" LIMIT 64 OFFSET 3')
		expect(tileSql("t", { kind: "keyset", key: ["a", "b"] }, columns, true, 0, 64)).toContain(
			'WHERE ("a", "b") > (?, ?) ORDER BY "a", "b"'
		)
		expect(chunkEndSql("t", ["a", "b", "c"], true)).toContain(
			'WHERE ("a", "b", "c") > (?, ?, ?) ORDER BY "a", "b", "c" LIMIT 1 OFFSET 49999'
		)
		expect(tileSql("t", { kind: "keyset", key: ["k"] }, columns, false, 10, 64)).not.toContain("WHERE")
		expect(tileSql("t", { kind: "offset" }, columns, false, 128, 64)).toMatch(/LIMIT 64 OFFSET 128$/)
	})

	it("reads a large value's size, never its bytes, into a tile", () => {
		const sql = tileSql("t", { kind: "offset" }, ["doc"], false, 0, 64)

		expect(sql).toContain('octet_length("doc")')
		expect(sql).toContain('<= 65536 THEN substr("doc", 1, 256)')
	})

	it("tells virtual tables and views from tables", () => {
		expect(schemaKind("table", "CREATE VIRTUAL TABLE f USING fts5(a)")).toBe("virtual")
		expect(schemaKind("table", "  create  virtual table r using rtree(id, a, b)")).toBe("virtual")
		expect(schemaKind("table", "CREATE TABLE t (a)")).toBe("table")
		expect(schemaKind("view", "CREATE VIEW v AS SELECT 1")).toBe("view")
		expect(schemaKind("virtual", "")).toBe("virtual")
	})

	it("rewrites WAL format versions in what is read only, and only where the read covers them", () => {
		const head = new Uint8Array(100)

		head[18] = 2
		head[19] = 2

		const copy = head.slice()

		expect(patchWalHeader(copy, 0, 100, 0)).toBe(true)
		expect([copy[18], copy[19]]).toEqual([1, 1])
		expect([head[18], head[19]]).toEqual([2, 2])

		// A read of bytes 19..30 into offset 5 of its buffer: only byte 19 is in it.
		const part = new Uint8Array(20).fill(2)

		expect(patchWalHeader(part, 5, 12, 19)).toBe(true)
		expect(part[5]).toBe(1)
		expect(part[4]).toBe(2)
		expect(patchWalHeader(new Uint8Array(10).fill(2), 0, 10, 20)).toBe(false)
	})

	it("recognizes the header", () => {
		expect(isSqliteHeader(new TextEncoder().encode(SQLITE_HEADER))).toBe(true)
		expect(isSqliteHeader(new TextEncoder().encode("SQLite format 2\0"))).toBe(false)
		expect(isSqliteHeader(new Uint8Array(4))).toBe(false)
	})

	it("shows values, NULL, large text and BLOBs", () => {
		expect(cellView({ type: "integer", bytes: 19, value: 9007199254740993n })).toEqual({ kind: "number", text: "9007199254740993" })
		expect(cellView({ type: "null", bytes: 0, value: null })).toEqual({ kind: "null" })
		expect(cellView({ type: "text", bytes: 70_000, value: null })).toEqual({ kind: "largeText", bytes: 70_000 })
		expect(cellView({ type: "blob", bytes: 2100, value: null })).toEqual({ kind: "blob", bytes: 2100 })
		expect(cellView({ type: "text", bytes: 300, value: "x".repeat(256) })).toEqual({
			kind: "text",
			text: "x".repeat(256),
			clipped: true
		})
	})

	it("finds the nearest anchor at or before a row", () => {
		const anchors = new AnchorIndex()

		anchors.add({ index: 100, key: [100] })
		anchors.add({ index: 50, key: [50] })
		anchors.add({ index: 100, key: [999] })

		expect(anchors.size).toBe(2)
		expect(anchors.before(49)).toBeNull()
		expect(anchors.before(50)?.key).toEqual([50])
		expect(anchors.before(99)?.key).toEqual([50])
		expect(anchors.before(1000)?.key).toEqual([100])
	})

	it("dumps bytes as hex with their printable characters", () => {
		expect(hexDump(new TextEncoder().encode("AB\n"))).toBe(`00000000  41 42 0a${" ".repeat(39)}  AB.`)
	})

	it("dumps only a BLOB's first 64 KiB in the full view, as its label says", () => {
		expect(fullValueText(new Uint8Array(1024 * 1024)).split("\n")).toHaveLength(SQLITE_HEX_DUMP_BYTES / 16)
		expect(fullValueText("text")).toBe("text")
		expect(fullValueText(null)).toBe("")
	})

	it("goes to a row in the window, rebases past it, and stops at the last row of an exact count", () => {
		expect(goToRow(10, 0, 100, { rows: 50, exact: true })).toEqual({ kind: "reveal", gridRow: 10 })
		expect(goToRow(500, 0, 100, { rows: 50, exact: true })).toEqual({ kind: "reveal", gridRow: 50 })
		expect(goToRow(500, 0, 100, { rows: 50, exact: false })).toEqual({ kind: "rebase", base: 499 })
		expect(goToRow(5_000_000, 0, 1_048_575, { rows: 2_000_010, exact: true })).toEqual({ kind: "rebase", base: 2_000_009 })
		expect(goToRow(5, 100, 100, null)).toEqual({ kind: "rebase", base: 4 })
	})
})

describe("countChunk", () => {
	it("covers as far as the grid needs in ranges, at least a tile window and at most a full chunk, nothing once there", () => {
		expect(countChunk(63, 63 + 10)).toBe(SQLITE_GROW_CHUNK)
		expect(countChunk(63, 63 + 5_000)).toBe(5_000)
		expect(countChunk(63, 10_000_000)).toBe(SQLITE_COUNT_CHUNK)
		expect(countChunk(63, Number.POSITIVE_INFINITY)).toBe(SQLITE_COUNT_CHUNK)
		expect(countChunk(500, 400)).toBe(0)
	})

	it("shows one tile of rows past an inexact count, the count itself once exact", () => {
		expect(gridRows({ rows: 63, exact: false })).toBe(63 + SQLITE_TILE_ROWS)
		expect(gridRows({ rows: 300, exact: true })).toBe(300)
	})
})

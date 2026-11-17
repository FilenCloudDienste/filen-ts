import { describe, expect, it, vi } from "vitest"
import { SHEET_MAX_ROWS } from "@filen/office/core/sheet"
import { SQLITE_WINDOW_ROWS, sqliteLayout, sqliteReadSource, sqliteWorkbookInfo, windowRows } from "@/features/preview/lib/sqliteSource"

// A table as the read-only grid's one sheet: the header row frozen, a window of at most the grid's rows from `base`,
// and only the cell query answered.

describe("sqlite read source", () => {
	it("lays a window of the table out below its frozen header row", () => {
		const layout = sqliteLayout(3, 48_210, 0, 1)

		expect(layout.rowCount).toBe(48_211)
		expect(layout.colCount).toBe(3)
		expect(layout.pane).toMatchObject({ rows: 1, topRow: 1 })
		expect(SQLITE_WINDOW_ROWS).toBe(SHEET_MAX_ROWS - 1)
		expect(windowRows(5_000_000, 0)).toBe(SHEET_MAX_ROWS - 1)
		expect(windowRows(5_000_000, 2_000_000)).toBe(SHEET_MAX_ROWS - 1)
		expect(windowRows(2_000_010, 2_000_000)).toBe(10)
		expect(sqliteWorkbookInfo("users", layout).writability).toEqual({ state: "viewOnly", reason: "unsafe" })
	})

	it("reads tiles and cells through the worker at the window's base, and answers no other query", async () => {
		const reads = {
			tiles: vi.fn(() => Promise.resolve([])),
			cell: vi.fn(() => Promise.resolve({ type: "text", bytes: 5, value: "hello" }))
		}
		const source = sqliteReadSource(reads, [{ name: "email", type: "TEXT", pk: 0 }], 2_000_000, () => sqliteLayout(1, 10, 0, 0))

		await source.tiles(0, Uint32Array.of(0, 0))
		expect(reads.tiles).toHaveBeenCalledWith(2_000_000, Uint32Array.of(0, 0))
		expect(await source.query("cell", { sheet: 0, row: 3, col: 0 })).toMatchObject({ input: "hello" })
		expect(await source.query("cell", { sheet: 0, row: 0, col: 0 })).toMatchObject({ input: "email" })
		await expect(source.query("navigate", { sheet: 0, row: 1, col: 0, direction: "down", to: "dataEdge" })).rejects.toThrow()
	})
})

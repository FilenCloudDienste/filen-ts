import { describe, expect, it } from "vitest"
import { cellKey, cellKeyCol, cellKeyRow } from "../core/sheet/model/model"
import {
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	TILE_COLS,
	TILE_ROWS,
	tileColOf,
	tilePosition,
	tilePositionCol,
	tilePositionRow,
	tileRowOf
} from "../core/sheet/protocol"

// The packed keys of cells and tile positions, read back.

const CORNERS: readonly (readonly [number, number])[] = [
	[0, 0],
	[0, SHEET_MAX_COLS - 1],
	[SHEET_MAX_ROWS - 1, 0],
	[SHEET_MAX_ROWS - 1, SHEET_MAX_COLS - 1],
	[TILE_ROWS + 3, TILE_COLS + 7]
]

describe("grid keys", () => {
	it("reads a cell key's row and column back at the grid's corners", () => {
		for (const [row, col] of CORNERS) {
			const key = cellKey(row, col)

			expect([cellKeyRow(key), cellKeyCol(key)]).toEqual([row, col])
		}
	})

	it("reads a tile position's row and column back, the tile's origin beside them", () => {
		for (const [row, col] of CORNERS) {
			const position = tilePosition(row, col)

			expect([
				tileRowOf(row) * TILE_ROWS + tilePositionRow(position),
				tileColOf(col) * TILE_COLS + tilePositionCol(position)
			]).toEqual([row, col])
		}
	})
})

import { cellKey, keyCol, keyRow, type CellRange } from "@/features/spreadsheet/lib/model"

export interface CellEntry {
	row: number
	col: number
	input: string
}

// The entries a clear sends: one emptying each cell in the range holding anything. Whichever is smaller is
// walked, the range or the sheet's filled cells, so selecting whole columns costs what the sheet holds.
// Null once past `limit` (more than the worker takes in one edit), before the rest is built.
export function clearedCells(
	cells: { readonly size: number; has: (key: number) => boolean; keys: () => Iterable<number> },
	target: CellRange,
	limit: number
): CellEntry[] | null {
	const cleared: CellEntry[] = []
	const area = (target.endRow - target.startRow + 1) * (target.endCol - target.startCol + 1)

	if (area <= cells.size) {
		for (let row = target.startRow; row <= target.endRow; row++) {
			for (let col = target.startCol; col <= target.endCol; col++) {
				if (cells.has(cellKey(row, col))) {
					if (cleared.length === limit) {
						return null
					}

					cleared.push({ row, col, input: "" })
				}
			}
		}

		return cleared
	}

	for (const key of cells.keys()) {
		const row = keyRow(key)
		const col = keyCol(key)

		if (row >= target.startRow && row <= target.endRow && col >= target.startCol && col <= target.endCol) {
			if (cleared.length === limit) {
				return null
			}

			cleared.push({ row, col, input: "" })
		}
	}

	return cleared
}

// The name an added sheet proposes: numbered after the sheets there are, or the first number past it no
// sheet's name takes (sheet names are unique whatever their case).
export function newSheetName(names: readonly string[], nameFor: (number: number) => string): string {
	const taken = new Set(names.map(name => name.toLowerCase()))
	let number = names.length + 1

	while (taken.has(nameFor(number).toLowerCase())) {
		number++
	}

	return nameFor(number)
}

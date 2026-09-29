import { describe, expect, it } from "vitest"
import { createAxis } from "@/features/spreadsheet/lib/axis.logic"
import { cellName, columnIndex, columnName, expandToMerges, rangeName } from "@/features/spreadsheet/lib/cellRef.logic"
import { gridMove, type GridBounds } from "@/features/spreadsheet/lib/navigation.logic"
import { parseTsv, rangeToTsv } from "@/features/spreadsheet/lib/tsv.logic"
import { cellKey, type SheetView } from "@/features/spreadsheet/lib/model"

describe("createAxis", () => {
	const axis = createAxis(10, 20, new Map([[2, 50]]), [5])

	it("places indices past the exceptions and sizes the exceptions", () => {
		expect(axis.offset(0)).toBe(0)
		expect(axis.offset(2)).toBe(40)
		expect(axis.offset(3)).toBe(90)
		expect(axis.size(5)).toBe(0)
		expect(axis.offset(6)).toBe(90 + 40)
		expect(axis.total).toBe(20 * 10 + 30 - 20)
	})

	it("finds the index holding a position, skipping hidden ones", () => {
		expect(axis.indexAt(0)).toBe(0)
		expect(axis.indexAt(45)).toBe(2)
		expect(axis.indexAt(89)).toBe(2)
		expect(axis.indexAt(90)).toBe(3)
		expect(axis.indexAt(130)).toBe(6)
		expect(axis.indexAt(1e9)).toBe(9)
	})

	it("stays cheap for a million rows with few exceptions", () => {
		const big = createAxis(1_000_000, 24, new Map([[500_000, 100]]), [])

		expect(big.indexAt(big.offset(750_000) + 1)).toBe(750_000)
	})
})

describe("cell names", () => {
	it("names columns and ranges as spreadsheets do", () => {
		expect([columnName(0), columnName(25), columnName(26), columnName(701), columnName(702)]).toEqual(["A", "Z", "AA", "ZZ", "AAA"])
		expect(cellName(0, 0)).toBe("A1")
		expect(rangeName({ startRow: 1, startCol: 1, endRow: 6, endCol: 3 })).toBe("B2:D7")
		expect(rangeName({ startRow: 4, startCol: 2, endRow: 4, endCol: 2 })).toBe("C5")
	})

	it("parses column letters in either case back to their index", () => {
		expect(["A", "Z", "AA", "ZZ", "AAA", "xfd", "aB"].map(columnIndex)).toEqual([0, 25, 26, 701, 702, 16383, 27])
	})

	it("grows a selection over the merges it touches, and the ones those reach", () => {
		const merges = [
			{ startRow: 0, startCol: 1, endRow: 2, endCol: 1 },
			{ startRow: 2, startCol: 1, endRow: 2, endCol: 4 }
		]

		expect(expandToMerges({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, merges)).toEqual({
			startRow: 0,
			startCol: 0,
			endRow: 2,
			endCol: 4
		})
	})
})

describe("gridMove", () => {
	const bounds: GridBounds = { rowCount: 200, colCount: 40, lastUsedRow: 9, lastUsedCol: 4, pageRows: 20 }
	const at = (row: number, col: number) => ({ anchor: { row, col }, focus: { row, col } })
	const key = (name: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
		key: name,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...extra
	})

	it("moves, clamps and extends", () => {
		expect(gridMove(key("ArrowRight"), at(0, 0), bounds)).toEqual(at(0, 1))
		expect(gridMove(key("ArrowUp"), at(0, 0), bounds)).toEqual(at(0, 0))
		expect(gridMove(key("ArrowDown", { shiftKey: true }), at(3, 3), bounds)).toEqual({
			anchor: { row: 3, col: 3 },
			focus: { row: 4, col: 3 }
		})
	})

	it("jumps to the used area's edge, then the sheet's", () => {
		expect(gridMove(key("ArrowDown", { ctrlKey: true }), at(2, 0), bounds)?.focus).toEqual({ row: 9, col: 0 })
		expect(gridMove(key("ArrowDown", { metaKey: true }), at(9, 0), bounds)?.focus).toEqual({ row: 199, col: 0 })
		expect(gridMove(key("End", { ctrlKey: true }), at(0, 0), bounds)?.focus).toEqual({ row: 9, col: 4 })
	})

	it("steps with Tab and Enter, collapsing the selection", () => {
		expect(gridMove(key("Tab", { shiftKey: true }), { anchor: { row: 0, col: 0 }, focus: { row: 2, col: 2 } }, bounds)).toEqual(
			at(2, 1)
		)
		expect(gridMove(key("Enter"), at(2, 2), bounds)).toEqual(at(3, 2))
	})

	it("selects the used area on mod+A and leaves other keys alone", () => {
		expect(gridMove(key("a", { ctrlKey: true }), at(5, 5), bounds)).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 9, col: 4 } })
		expect(gridMove(key("a"), at(5, 5), bounds)).toBeNull()
		expect(gridMove(key("Escape"), at(5, 5), bounds)).toBeNull()
	})
})

describe("TSV", () => {
	const sheet = {
		cells: new Map([
			[cellKey(0, 0), { text: "name" }],
			[cellKey(0, 1), { text: 'say "hi"' }],
			[cellKey(1, 0), { text: "two\nlines" }],
			[cellKey(1, 1), { text: "3" }]
		])
	} as unknown as SheetView

	it("copies what cells show, quoting what would break the layout", () => {
		expect(rangeToTsv(sheet, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 })).toBe('name\t"say ""hi"""\r\n"two\nlines"\t3')
	})

	it("reads pasted TSV back, quotes and a trailing line end included", () => {
		expect(parseTsv('name\t"say ""hi"""\r\n"two\nlines"\t3\r\n')).toEqual([
			["name", 'say "hi"'],
			["two\nlines", "3"]
		])
		expect(parseTsv("a\t\tb")).toEqual([["a", "", "b"]])
	})
})

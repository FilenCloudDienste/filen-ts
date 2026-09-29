import { describe, expect, it } from "vitest"
import { applyEditResult, CellStore, gridDoc } from "@/features/spreadsheet/lib/cellStore.logic"
import type { DocState } from "@/features/spreadsheet/lib/edits"
import { cellKey, type CellView, type SheetView, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import {
	gridMove,
	isTypedCharacter,
	sheetBounds,
	sheetCols,
	sheetRows,
	snapToMerge,
	type GridBounds
} from "@/features/spreadsheet/lib/navigation.logic"
import { isImeKeydown } from "@/lib/ime"
import { mockSheetView } from "@/tests/mockSheetView"

const STATE: DocState = { dirty: true, canUndo: true, canRedo: false }

function view(text: string): CellView {
	return { text }
}

function sheetView(name: string, cells: [number, CellView][], extra: Partial<SheetView> = {}): SheetView {
	return mockSheetView({ name, rowCount: 10, colCount: 5, cells: new Map(cells), ...extra })
}

describe("CellStore", () => {
	it("patches without touching the base, and keeps its count", () => {
		const base = new Map([
			[1, view("a")],
			[2, view("b")]
		])
		const store = new CellStore(base).with([
			[2, null],
			[3, view("c")],
			[1, view("A")]
		])

		expect(base.get(1)?.text).toBe("a")
		expect(base.has(2)).toBe(true)
		expect(store.get(1)?.text).toBe("A")
		expect(store.has(2)).toBe(false)
		expect(store.get(3)?.text).toBe("c")
		expect(store.size).toBe(2)
		expect([...store.keys()].sort()).toEqual([1, 3])
	})

	it("counts a cell emptied, filled again, and emptied twice", () => {
		const store = new CellStore(new Map([[1, view("a")]]))
			.with([[1, null]])
			.with([[1, view("b")]])
			.with([[1, null]])
			.with([[1, null]])

		expect(store.size).toBe(0)
		expect(store.has(1)).toBe(false)
	})

	it("folds a patch that outgrows the base into a new base", () => {
		const changes: [number, CellView | null][] = []

		for (let key = 0; key < 2000; key++) {
			changes.push([key, view(String(key))])
		}

		const store = new CellStore(new Map()).with(changes).with([[5, null]])

		expect(store.size).toBe(1999)
		expect(store.get(1999)?.text).toBe("1999")
		expect(store.has(5)).toBe(false)
	})
})

describe("applyEditResult", () => {
	const doc: SpreadsheetDoc = {
		kind: "xlsx",
		activeSheet: 0,
		styles: [],
		writable: true,
		sheets: [sheetView("One", [[cellKey(0, 0), view("1")]], { rowCount: 30 }), sheetView("Two", []), sheetView("Three", [])]
	}

	it("folds one patch per sheet, and leaves other sheets as they were", () => {
		const before = gridDoc(doc)
		const after = applyEditResult(before, {
			type: "cells",
			patches: [
				{ sheet: 0, cells: [[cellKey(0, 0), view("2")]], rowCount: 1, colCount: 1 },
				{ sheet: 2, cells: [[cellKey(20, 7), view("x")]], rowCount: 21, colCount: 8 }
			],
			styles: [],
			state: STATE
		})

		expect(after.sheets[0]?.cells.get(cellKey(0, 0))?.text).toBe("2")
		// A patch's extent never shrinks the view's, which also covers merges and formats.
		expect(after.sheets[0]?.rowCount).toBe(30)
		expect(after.sheets[1]).toBe(before.sheets[1])
		expect(after.sheets[2]?.cells.get(cellKey(20, 7))?.text).toBe("x")
		expect(after.sheets[2]?.rowCount).toBe(21)
		expect(after.sheets[2]?.colCount).toBe(8)
		expect(before.sheets[0]?.cells.get(cellKey(0, 0))?.text).toBe("1")
	})
})

describe("applyEditResult for structural edits", () => {
	const doc: SpreadsheetDoc = {
		kind: "xlsx",
		activeSheet: 0,
		styles: [],
		writable: true,
		sheets: [sheetView("One", [[cellKey(0, 0), view("1")]]), sheetView("Two", [[cellKey(0, 0), view("2")]])]
	}

	it("keeps the sheets sent as unchanged, and replaces the rest", () => {
		const before = gridDoc(doc)
		const after = applyEditResult(before, {
			type: "sheets",
			sheets: [null, sheetView("Two", [[cellKey(1, 0), view("x")]]), sheetView("Three", [])],
			styles: [],
			state: STATE
		})

		expect(after.sheets).toHaveLength(3)
		expect(after.sheets[0]).toBe(before.sheets[0])
		expect(after.sheets[1]?.cells.get(cellKey(1, 0))?.text).toBe("x")
		expect(after.sheets[2]?.name).toBe("Three")
	})

	it("drops a sheet when the count shrinks, as undoing an added sheet does", () => {
		const before = gridDoc({ ...doc, sheets: [...doc.sheets, sheetView("Three", [])] })
		const after = applyEditResult(before, { type: "sheets", sheets: [null, null], styles: [], state: STATE })

		expect(after.sheets).toEqual([before.sheets[0], before.sheets[1]])
		expect(after.sheets[1]).toBe(before.sheets[1])
	})
})

describe("gridMove over hidden rows, columns and merges", () => {
	const at = (row: number, col: number) => ({ anchor: { row, col }, focus: { row, col } })
	const key = (name: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
		key: name,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...extra
	})
	const sheet = sheetView("S", [], {
		hiddenRows: [2, 3],
		hiddenCols: [0],
		colWidths: new Map([[4, 0]]),
		merges: [{ startRow: 5, startCol: 1, endRow: 6, endCol: 3 }]
	})
	const bounds: GridBounds = { ...sheetBounds(sheet, sheetRows(sheet).axis, sheetCols(sheet)), pageRows: 3 }

	it("passes over hidden rows and columns", () => {
		expect(gridMove(key("ArrowDown"), at(1, 1), bounds)).toEqual(at(4, 1))
		expect(gridMove(key("ArrowUp"), at(4, 1), bounds)).toEqual(at(1, 1))
		expect(gridMove(key("ArrowRight"), at(0, 3), bounds)).toEqual(at(0, 5))
		// Nothing shown to the left: stays.
		expect(gridMove(key("ArrowLeft"), at(0, 1), bounds)).toEqual(at(0, 1))
		expect(gridMove(key("Home"), at(0, 3), bounds)).toEqual(at(0, 1))
	})

	it("lands on a merge's anchor, and leaves it from its far edge", () => {
		expect(gridMove(key("ArrowDown"), at(4, 2), bounds)).toEqual(at(5, 1))
		expect(gridMove(key("ArrowLeft"), at(6, 5), bounds)).toEqual(at(5, 1))
		expect(gridMove(key("ArrowRight"), at(5, 1), bounds)).toEqual(at(5, 5))
		expect(gridMove(key("ArrowDown"), at(5, 1), bounds)).toEqual(at(7, 1))
		expect(gridMove(key("ArrowDown", { shiftKey: true }), at(4, 1), bounds)).toEqual({
			anchor: { row: 4, col: 1 },
			focus: { row: 5, col: 1 }
		})
	})

	it("snaps a position inside a merge to its anchor", () => {
		expect(snapToMerge({ row: 6, col: 3 }, sheet.merges)).toEqual({ row: 5, col: 1 })
		expect(snapToMerge({ row: 7, col: 3 }, sheet.merges)).toEqual({ row: 7, col: 3 })
	})
})

describe("sheetRows", () => {
	it("stops a sheet taller than the browser can scroll, and says so", () => {
		const tall = sheetRows(sheetView("T", [], { rowCount: 1_000_000 }))
		const short = sheetRows(sheetView("S", [], { rowCount: 1000 }))

		expect(tall.truncated).toBe(true)
		expect(tall.axis.total).toBeLessThanOrEqual(15_000_000)
		expect(short.truncated).toBe(false)
		expect(short.axis.count).toBe(1100)
	})
})

describe("sheet axes", () => {
	it("are reused after a cell edit, which keeps the sizes, and rebuilt when the sizes change", () => {
		const sheet = sheetView("S", [], { rowHeights: new Map([[3, 40]]), colWidths: new Map([[1, 10]]) })
		const edited = { ...sheet, cells: new Map([[0, view("x")]]) }
		const resized = { ...sheet, rowHeights: new Map([[3, 50]]) }

		expect(sheetRows(edited)).toBe(sheetRows(sheet))
		expect(sheetCols(edited)).toBe(sheetCols(sheet))
		expect(sheetRows(resized)).not.toBe(sheetRows(sheet))
		expect(sheetRows(resized).axis.size(3)).toBe(50)
		expect(sheetRows({ ...sheet, rowCount: 500 }).axis.count).toBe(600)
	})
})

describe("typing into the grid", () => {
	const typed = (key: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
		isTypedCharacter({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra })

	it("types characters, AltGr and Option ones included, but not shortcuts", () => {
		expect(typed("a")).toBe(true)
		expect(typed("@", { ctrlKey: true, altKey: true })).toBe(true)
		expect(typed("å", { altKey: true })).toBe(true)
		expect(typed("😀")).toBe(true)
		expect(typed("c", { ctrlKey: true })).toBe(false)
		expect(typed("c", { metaKey: true })).toBe(false)
		expect(typed("ArrowDown")).toBe(false)
		expect(typed("Dead")).toBe(false)
	})

	it("recognises input-method keydowns, Safari's confirming Enter included", () => {
		expect(isImeKeydown({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(true)
		expect(isImeKeydown({ key: "Process", isComposing: false, keyCode: 0 })).toBe(true)
		expect(isImeKeydown({ key: "a", isComposing: true, keyCode: 65 })).toBe(true)
		expect(isImeKeydown({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false)
	})
})

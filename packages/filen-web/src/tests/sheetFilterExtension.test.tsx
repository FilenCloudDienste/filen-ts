// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { SheetLayout } from "@filen/office/core/sheet"
import type { SheetCellPointer, SheetGridHandle, SheetGridModel, SheetGridState } from "@filen/office/react/sheet"
import "@/lib/i18n"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { useSheetSortFilter } from "@/features/spreadsheet/data/filterExtension"
import { setSortFilterOpen, useSortFilterOpen } from "@/features/spreadsheet/data/sortFilterState"
import { quickSort, toggleFilter } from "@/features/spreadsheet/data/sortCommands"

vi.mock("@/features/spreadsheet/data/sortCommands", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/spreadsheet/data/sortCommands")>()),
	quickSort: vi.fn(() => Promise.resolve(true)),
	toggleFilter: vi.fn(() => Promise.resolve(true))
}))

// The sort and filter extension's grid parts: a press on a header's filter button (and only on it) opens that
// header's menu and a second press closes it, Alt+Down on a filter header opens it, and a text file gets the sort
// (its items and keys) alone.

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const LAYOUT = {
	rightToLeft: false,
	extensions: {
		filters: { ranges: [{ table: null, range: { startRow: 0, startCol: 0, endRow: 9, endCol: 1 }, buttons: Uint8Array.of(1, 0) }] }
	}
} as unknown as SheetLayout

// Every cell at the same box on screen: its button is the 16 px square at its bottom right (x 57-73, y 23-39).
const HANDLE = { clientRect: () => ({ x: 10, y: 20, width: 64, height: 20 }) } as unknown as SheetGridHandle

function setup(text = false, active = { row: 0, col: 0 }) {
	const selection = {
		active,
		anchor: active,
		focus: active,
		ranges: [{ startRow: active.row, startCol: active.col, endRow: active.row, endCol: active.col }]
	}
	const model = {
		kind: text ? "csv" : "xlsx",
		getSnapshot: () => ({ sheet: 0, layout: LAYOUT, selection }),
		scale: () => 1,
		entry: () => null
	} as unknown as SheetGridModel
	const grid = {
		model,
		layout: LAYOUT,
		selection,
		sheet: 0,
		state: { version: 1 },
		active: { text: "", flags: 0 }
	} as unknown as SheetGridState
	const run = vi.fn()
	const { result } = renderHook(() => {
		const extension = useSheetSortFilter({ grid, gridRef: { current: HANDLE }, handle: {} as SheetHandle, canEdit: true, text, run })

		return { extension, open: useSortFilterOpen(model) }
	})

	return { model, result }
}

function press(row: number, col: number, x: number, y: number): SheetCellPointer {
	return {
		kind: "down",
		row,
		col,
		clientX: x,
		clientY: y,
		pointerType: "mouse",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		editing: false
	}
}

describe("the sort and filter extension", () => {
	it("opens a header's menu from its button alone, and closes it with a second press", () => {
		const { model, result } = setup()
		const pointer = result.current.extension.grid?.pointer

		expect(pointer?.(press(0, 0, 20, 30))).toBe(false)
		expect(result.current.open).toBeNull()
		// A column without a button (hiddenButton), and a data row, take nothing.
		expect(pointer?.(press(0, 1, 65, 30))).toBe(false)
		expect(pointer?.(press(3, 0, 65, 30))).toBe(false)

		act(() => {
			expect(pointer?.(press(0, 0, 65, 30))).toBe(true)
		})
		expect(result.current.open).toEqual({ type: "menu", row: 0, col: 0 })

		act(() => {
			expect(result.current.extension.grid?.pointer?.(press(0, 0, 65, 30))).toBe(true)
		})
		expect(result.current.open).toBeNull()
		setSortFilterOpen(model, null)
	})

	it("opens the menu with Alt+Down on a filter header only", () => {
		const header = setup(false, { row: 0, col: 0 })

		act(() => {
			expect(header.result.current.extension.shortcut?.("openDropdown")).toBe(true)
		})
		expect(header.result.current.open).toEqual({ type: "menu", row: 0, col: 0 })
		setSortFilterOpen(header.model, null)
		cleanup()

		const data = setup(false, { row: 4, col: 0 })

		expect(data.result.current.extension.shortcut?.("openDropdown")).toBe(false)
		expect(data.result.current.open).toBeNull()
	})

	it("gives a text file the sort items and keys and no filter", () => {
		const { model, result } = setup(true)
		const shortcut = result.current.extension.shortcut

		expect(result.current.extension.grid).toBeUndefined()
		expect(result.current.extension.menuItems).toBeTruthy()

		expect(shortcut?.("sortAscending")).toBe(true)
		expect(shortcut?.("sortDescending")).toBe(true)
		expect(vi.mocked(quickSort).mock.calls).toEqual([
			[model, false],
			[model, true]
		])

		// The filter keys, and Alt+Down on what would be a filter header, stay the grid's.
		act(() => {
			for (const key of ["filter", "clearFilters", "reapplyFilter", "openDropdown"] as const) expect(shortcut?.(key)).toBe(false)
		})
		expect(toggleFilter).not.toHaveBeenCalled()
		expect(result.current.open).toBeNull()
	})
})

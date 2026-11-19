// @vitest-environment happy-dom
import { act } from "react"
import { describe, expect, it } from "vitest"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRefusal } from "../core/sheet/protocol"
import type { SheetGridHandle, SheetGridModel } from "../react/sheet/index"
import { type MountedGrid, key, mountGrid, pointer, registerSheetGridDom, settleGrid } from "./sheetGridDomFixtures.dom"
import { sheetBody } from "./sheetKeysFixtures"
import { buildFixture, firstTile, tileEntry } from "./sheetSessionFixtures"
import { STYLES } from "./xlsxWriteFixtures"

// The grid's pointer and keys where Excel's are known: a right-click on a header, the Mac's delete key,
// Ctrl+Shift+Enter, typing on a locked cell, and Page Down scrolling a screen.

registerSheetGridDom()

interface Mounted extends MountedGrid {
	readonly refusals: SheetRefusal[]
}

const BOOK = {
	sheets: [
		{
			name: "One",
			body: sheetBody([
				[1, 2, 3],
				[4, 5, 6],
				[7, 8, 9]
			])
		}
	]
}

async function mount(fixture: Parameters<typeof buildFixture>[0] = BOOK, mac = false): Promise<Mounted> {
	const mounted = await mountGrid({ bytes: buildFixture(fixture), forwardEvents: true, props: { mac } })
	const refusals: SheetRefusal[] = []

	mounted.model.setRefusalHandler(refusal => refusals.push(refusal))

	return { ...mounted, refusals }
}

function cellBox(handle: SheetGridHandle, row: number, col: number): { x: number; y: number; width: number; height: number } {
	const view = handle.renderer.currentView()
	const box = view === null ? null : handle.renderer.cellBox(view, { row, col })

	if (box === null) throw new Error("off screen")

	return box
}

function editor(): HTMLTextAreaElement | null {
	return document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor")
}

async function text(model: SheetGridModel, row: number, col: number): Promise<string | undefined> {
	return tileEntry(await firstTile(model.session, 0), row, col)?.text
}

function selectRange(model: SheetGridModel, startRow: number, startCol: number, endRow: number, endCol: number): void {
	act(() =>
		model.select({
			active: { row: startRow, col: startCol },
			anchor: { row: startRow, col: startCol },
			focus: { row: endRow, col: endCol },
			ranges: [{ startRow, startCol, endRow, endCol }]
		})
	)
}

describe("a right-click on a header", () => {
	it("selects the column under it when it is not selected whole, even with one of its cells selected", async () => {
		const { model, handle, scroller } = await mount()
		const c = cellBox(handle, 0, 2)

		pointer(scroller, "pointerdown", { button: 2, clientX: c.x + c.width / 2, clientY: c.y / 2 })

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 2, endRow: SHEET_MAX_ROWS - 1, endCol: 2 }])

		// C1 alone is part of column C, not the whole of it.
		selectRange(model, 0, 2, 0, 2)
		pointer(scroller, "pointerdown", { button: 2, clientX: c.x + c.width / 2, clientY: c.y / 2 })

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 2, endRow: SHEET_MAX_ROWS - 1, endCol: 2 }])
	})

	it("keeps a selection of whole columns or rows that holds the one under it", async () => {
		const { model, handle, scroller } = await mount()

		selectRange(model, 0, 1, SHEET_MAX_ROWS - 1, 3)

		const before = model.getSnapshot().selection
		const c = cellBox(handle, 0, 2)

		pointer(scroller, "pointerdown", { button: 2, clientX: c.x + c.width / 2, clientY: c.y / 2 })

		expect(model.getSnapshot().selection).toBe(before)

		selectRange(model, 1, 0, 2, SHEET_MAX_COLS - 1)

		const rows = model.getSnapshot().selection
		const row3 = cellBox(handle, 2, 0)

		pointer(scroller, "pointerdown", { button: 2, clientX: row3.x / 2, clientY: row3.y + row3.height / 2 })

		expect(model.getSnapshot().selection).toBe(rows)

		// Row 1 is outside it: the row is selected.
		const row1 = cellBox(handle, 0, 0)

		pointer(scroller, "pointerdown", { button: 2, clientX: row1.x / 2, clientY: row1.y + row1.height / 2 })

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 0, endCol: SHEET_MAX_COLS - 1 }])
	})
})

describe("the delete key", () => {
	it("clears the selection on a Mac, where it sends Backspace", async () => {
		const { model, scroller } = await mount(BOOK, true)

		selectRange(model, 0, 0, 1, 1)

		expect(key(scroller, { key: "Backspace", code: "Backspace" }).defaultPrevented).toBe(true)
		await settleGrid()

		expect(editor()).toBeNull()
		expect(await text(model, 0, 0)).toBeUndefined()
		expect(await text(model, 1, 1)).toBeUndefined()
		expect(await text(model, 2, 2)).toBe("9")
	})

	it("opens an empty entry in the active cell on Windows, leaving the rest", async () => {
		const { model, scroller } = await mount(BOOK, false)

		selectRange(model, 0, 0, 1, 1)
		key(scroller, { key: "Backspace", code: "Backspace" })

		expect(editor()?.value).toBe("")
		expect(await text(model, 1, 1)).toBe("5")
	})
})

describe("Ctrl+Shift+Enter in an entry", () => {
	it.each([
		["Ctrl", { ctrlKey: true }],
		["Cmd", { metaKey: true }]
	])("commits it with %s and keeps the active cell", async (_, modifier) => {
		const { model, scroller } = await mount()

		selectRange(model, 1, 1, 1, 1)
		key(scroller, { key: "7", code: "Digit7" })
		key(editor() as HTMLTextAreaElement, { key: "Enter", code: "Enter", shiftKey: true, ...modifier })
		await settleGrid()

		expect(editor()).toBeNull()
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 1 })
		expect(await text(model, 1, 1)).toBe("7")
	})
})

describe("a locked cell on a protected sheet", () => {
	// xf 2 unlocks its cells; the default format locks them.
	const styles = STYLES.replace('<cellXfs count="2">', '<cellXfs count="3">').replace(
		"</cellXfs>",
		'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs>'
	)
	const PROTECTED = {
		sheets: [
			{
				name: "One",
				body: '<sheetData><row r="1"><c r="A1" s="2"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData><sheetProtection sheet="1"/>'
			}
		],
		styles
	}

	it("says the sheet is protected when a key is typed, F2 or Delete pressed on it", async () => {
		const { model, handle, scroller, refusals } = await mount(PROTECTED)

		act(() => handle.goTo({ row: 0, col: 1 }))
		await settleGrid()
		key(scroller, { key: "x", code: "KeyX" })
		key(scroller, { key: "F2", code: "F2" })
		key(scroller, { key: "Delete", code: "Delete" })

		expect(editor()).toBeNull()
		expect(refusals.map(refusal => refusal.reason)).toEqual(["protectedSheet", "protectedSheet", "protectedSheet"])
		expect(await text(model, 0, 1)).toBe("2")

		// An unlocked cell takes the entry.
		act(() => handle.goTo({ row: 0, col: 0 }))
		await settleGrid()
		key(scroller, { key: "x", code: "KeyX" })

		expect(editor()?.value).toBe("x")
		expect(refusals).toHaveLength(3)
	})

	it("says nothing in a view-only grid", async () => {
		const { model, handle, scroller, refusals } = await mount(PROTECTED)

		act(() => handle.goTo({ row: 0, col: 1 }))
		await settleGrid()
		act(() => model.setReadOnly(true))
		key(scroller, { key: "x", code: "KeyX" })

		expect(refusals).toEqual([])
	})
})

describe("Page Down and Page Up", () => {
	it("scroll a screen with the active cell, which keeps its place on screen", async () => {
		const { model, handle, scroller } = await mount()

		act(() => handle.goTo({ row: 2, col: 0 }))

		const before = cellBox(handle, 2, 0)

		key(scroller, { key: "PageDown", code: "PageDown" })

		const active = model.getSnapshot().selection.active

		expect(active.row).toBeGreaterThan(10)
		expect(cellBox(handle, active.row, 0).y).toBe(before.y)

		key(scroller, { key: "PageDown", code: "PageDown" })
		key(scroller, { key: "PageUp", code: "PageUp" })

		expect(cellBox(handle, model.getSnapshot().selection.active.row, 0).y).toBe(before.y)

		// Back at the sheet's start the view cannot scroll further: the cell comes to row 3 as it was.
		key(scroller, { key: "PageUp", code: "PageUp" })

		expect(model.getSnapshot().selection.active).toEqual({ row: 2, col: 0 })
		expect(handle.renderer.currentView()?.rows.scroll).toBe(0)
	})

	it("scroll a screen sideways with Alt", async () => {
		const { model, handle, scroller } = await mount()

		act(() => handle.goTo({ row: 0, col: 1 }))

		const before = cellBox(handle, 0, 1)

		key(scroller, { key: "PageDown", code: "PageDown", altKey: true })

		const active = model.getSnapshot().selection.active

		expect(active.col).toBeGreaterThan(3)
		expect(cellBox(handle, 0, active.col).x).toBe(before.x)
	})
})

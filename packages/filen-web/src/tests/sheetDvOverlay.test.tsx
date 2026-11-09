// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { SheetCommand, SheetLayout, SheetSessionApi } from "@filen/office/core/sheet"
import type { SheetGridHandle, SheetGridState } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { ValidationOverlay } from "@/features/spreadsheet/data/dvOverlay"

// A list validation's button beside the active cell (its values picked and written as typed), and the input
// message under it; neither while the cell is being edited, the list not on a read-only sheet.

afterEach(() => {
	cleanup()
})

const LAYOUT = {
	rightToLeft: false,
	extensions: {
		validations: {
			ranges: Uint32Array.of(0, 0, 9, 0, 0, 1, 0, 1),
			rules: Uint32Array.of(0, 1),
			entries: [
				{ dropdown: true, promptTitle: "Status", prompt: "Pick one" },
				{ dropdown: false, promptTitle: null, prompt: "Free text" }
			]
		}
	}
} as unknown as SheetLayout

function grid(row: number, col: number, editing = false): SheetGridState {
	return {
		sheet: 3,
		layout: LAYOUT,
		selection: {
			active: { row, col },
			anchor: { row, col },
			focus: { row, col },
			ranges: [{ startRow: row, startCol: col, endRow: row, endCol: col }]
		},
		editing: editing ? { sheet: 3, row, col, text: "x" } : null,
		readOnly: false,
		active: { text: "No", input: "No", flags: 0, known: true }
	} as unknown as SheetGridState
}

// Every cell on screen at the same box: the overlays are placed (and shown) from it.
const focus = vi.fn()
const HANDLE = {
	cellRect: () => ({ x: 10, y: 20, width: 64, height: 20 }),
	onFrame: () => () => undefined,
	focus
} as unknown as SheetGridHandle

function Overlay(props: Omit<Parameters<typeof ValidationOverlay>[0], "openList" | "onOpenList"> & { opened?: string }) {
	const [openList, setOpenList] = useState<string | null>(props.opened ?? null)

	return (
		<ValidationOverlay
			{...props}
			openList={openList}
			onOpenList={setOpenList}
		/>
	)
}

function show(state: SheetGridState, canEdit = true, opened?: string) {
	const run = vi.fn<(command: SheetCommand) => void>()
	const query = vi.fn().mockResolvedValue({
		items: [
			{ text: "Yes", input: "Yes" },
			{ text: "No", input: "No" },
			{ text: "1,234", input: "1234" }
		]
	})
	const session = { query } as unknown as SheetSessionApi

	render(
		<Overlay
			grid={state}
			gridRef={{ current: HANDLE }}
			session={session}
			canEdit={canEdit}
			run={run}
			{...(opened !== undefined && { opened })}
		/>
	)

	return { run, query }
}

describe("data validation over the grid", () => {
	it("opens the list's values and writes the one picked as it is typed", async () => {
		const { run, query } = show(grid(2, 0))

		expect(screen.getByRole("note").textContent).toBe("StatusPick one")

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOpenList }))
			await Promise.resolve()
		})

		expect(query).toHaveBeenCalledWith("validation.list", { sheet: 3, row: 2, col: 0 })
		expect(screen.getByRole("option", { name: "No" }).getAttribute("aria-selected")).toBe("true")

		fireEvent.click(screen.getByRole("option", { name: "1,234" }))

		expect(run).toHaveBeenCalledWith({
			type: "cells.set",
			sheet: 3,
			cells: { rows: Uint32Array.of(2), cols: Uint16Array.of(0), inputs: ["1234"] }
		})
	})

	it("shows a message without a list, and nothing while editing or where the sheet has no validation", () => {
		show(grid(0, 1))

		expect(screen.queryByRole("button", { name: preview.previewSheetValidationOpenList })).toBeNull()
		expect(screen.getByRole("note").textContent).toBe("Free text")

		cleanup()
		show(grid(2, 0, true))

		expect(screen.queryByRole("button")).toBeNull()
		expect(screen.queryByRole("note")).toBeNull()

		cleanup()
		show(grid(20, 5))

		expect(screen.queryByRole("note")).toBeNull()
	})

	it("offers no list where the user cannot edit", () => {
		show(grid(2, 0), false)

		expect(screen.queryByRole("button", { name: preview.previewSheetValidationOpenList })).toBeNull()
	})

	it("moves through the values with the keys, jumps to what is typed and picks with Enter", async () => {
		const { run } = show(grid(2, 0))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOpenList }))
			await Promise.resolve()
		})

		const list = screen.getByRole("listbox")
		const selected = (): string =>
			screen.getAllByRole("option").find(option => option.getAttribute("aria-selected") === "true")?.textContent ?? ""

		// The cell's own value is highlighted first, and named as the active option.
		expect(selected()).toBe("No")
		expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "No" }).id)

		fireEvent.keyDown(list, { key: "ArrowUp" })
		expect(selected()).toBe("Yes")
		fireEvent.keyDown(list, { key: "End" })
		expect(selected()).toBe("1,234")
		fireEvent.keyDown(list, { key: "Home" })
		expect(selected()).toBe("Yes")
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000)

		fireEvent.keyDown(list, { key: "n" })
		expect(selected()).toBe("No")
		// Typed together, letters make one prefix; a pause starts a new one.
		fireEvent.keyDown(list, { key: "x" })
		expect(selected()).toBe("No")
		now.mockReturnValue(20_000)
		fireEvent.keyDown(list, { key: "1" })
		expect(selected()).toBe("1,234")
		now.mockRestore()
		fireEvent.keyDown(list, { key: "Enter" })

		expect(run).toHaveBeenCalledWith({
			type: "cells.set",
			sheet: 3,
			cells: { rows: Uint32Array.of(2), cols: Uint16Array.of(0), inputs: ["1234"] }
		})
		expect(focus).toHaveBeenCalled()
	})

	it("opens from the outside (Alt+Down) with the list focused, and gives Esc's typing back to the grid", async () => {
		focus.mockClear()
		show(grid(2, 0), true, "3:2:0")

		await act(async () => {
			await Promise.resolve()
		})

		const list = screen.getByRole("listbox")

		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 20))
		})
		expect(document.activeElement).toBe(list)

		await act(async () => {
			fireEvent.keyDown(list, { key: "Escape" })
			await new Promise(resolve => setTimeout(resolve, 50))
		})

		expect(screen.queryByRole("listbox")).toBeNull()
		expect(focus).toHaveBeenCalled()
	})

	it("lists the column's entries, sorted, on a cell without a list (Alt+Down), and writes the one picked", async () => {
		const run = vi.fn<(command: SheetCommand) => void>()
		const query = vi.fn().mockResolvedValue({
			entries: [
				{ text: "pear", input: "pear" },
				{ text: "Apple", input: "Apple" },
				{ text: "007", input: "'007" }
			]
		})

		render(
			<Overlay
				grid={grid(20, 5)}
				gridRef={{ current: HANDLE }}
				session={{ query } as unknown as SheetSessionApi}
				canEdit
				run={run}
				opened="column:3:20:5"
			/>
		)

		await act(async () => {
			await Promise.resolve()
		})

		expect(query).toHaveBeenCalledWith("autoComplete.entries", { sheet: 3, row: 20, col: 5 })
		expect(screen.getByRole("listbox", { name: preview.previewSheetAutoCompleteListLabel })).toBeTruthy()
		expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["007", "Apple", "pear"])
		// No button shows on a plain cell.
		expect(screen.queryByRole("button", { name: preview.previewSheetValidationOpenList })).toBeNull()

		fireEvent.click(screen.getByRole("option", { name: "007" }))

		expect(run).toHaveBeenCalledWith({
			type: "cells.set",
			sheet: 3,
			cells: { rows: Uint32Array.of(20), cols: Uint16Array.of(5), inputs: ["'007"] }
		})
	})

	it("closes the column's list again when the column holds no entries", async () => {
		focus.mockClear()

		const query = vi.fn().mockResolvedValue({ entries: [] })

		render(
			<Overlay
				grid={grid(20, 5)}
				gridRef={{ current: HANDLE }}
				session={{ query } as unknown as SheetSessionApi}
				canEdit
				run={vi.fn()}
				opened="column:3:20:5"
			/>
		)

		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 20))
		})

		expect(screen.queryByRole("listbox")).toBeNull()
		expect(focus).toHaveBeenCalled()
	})

	it("moves the input message beside the open list, so both show", async () => {
		show(grid(2, 0))

		// Under the cell, from its middle (the cell's box is at 10, 20, 64 wide, 20 high).
		expect(screen.getByRole("note").style.transform).toBe("translate(42px, 44px)")

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOpenList }))
			await Promise.resolve()
		})

		// Ending where the list's button starts, the list opening from there.
		expect(screen.getByRole("note").style.transform).toBe("translate(74px, 44px)")
	})
})

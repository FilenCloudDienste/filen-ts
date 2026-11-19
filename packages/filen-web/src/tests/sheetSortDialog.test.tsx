// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { SheetCommand } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { SortDialog } from "@/features/spreadsheet/data/sortDialog"

// The custom sort dialog: each level's order shown by its text, levels added, copied, removed and moved with the chosen
// one following, the keys sent in order, and sorting left to right (no header row, the columns reordered by rows).

afterEach(() => {
	cleanup()
})

const RANGE = { startRow: 0, startCol: 0, endRow: 5, endCol: 2 }

function renderSort() {
	const run = vi.fn<(command: SheetCommand) => void>()
	// No header texts: every column goes by its letter.
	const model = { getSnapshot: () => ({ sheet: 3 }), entry: () => null } as unknown as SheetGridModel

	render(
		<SortDialog
			model={model}
			open={{ type: "sort", range: RANGE, header: true, key: 1 }}
			run={run}
		/>
	)

	return run
}

// Picks a select's option as a mouse does.
function choose(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseDown(option, { button: 0 })
	fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseUp(option, { button: 0 })
	fireEvent.click(option)
}

// Each level's key and order, as the closed selects show them (without the trigger's icon).
function levels(): string[] {
	return screen
		.getAllByRole("listitem")
		.map(row => [...row.querySelectorAll("[data-slot='select-value']")].map(value => value.textContent).join(" / "))
}

function chosen(): number {
	return screen.getAllByRole("listitem").findIndex(row => row.getAttribute("aria-current") === "true")
}

function button(name: string): HTMLButtonElement {
	return screen.getByRole<HTMLButtonElement>("button", { name })
}

const ASC = preview.previewSheetSortOrderAscending
const DESC = preview.previewSheetSortOrderDescending

describe("the Sort dialog", () => {
	it("shows each level's order by its text", async () => {
		renderSort()

		expect(levels()).toEqual([`Column B / ${ASC}`])

		fireEvent.click(screen.getByRole("combobox", { name: preview.previewSheetSortOrder }))
		choose(await screen.findByRole("option", { name: DESC }))
		expect(levels()).toEqual([`Column B / ${DESC}`])
	})

	it("adds, moves, copies and deletes levels with the chosen one following, and sends the keys in order", async () => {
		const run = renderSort()

		// Each new level takes the first column not yet used.
		fireEvent.click(button(preview.previewSheetSortAddLevel))
		fireEvent.click(button(preview.previewSheetSortAddLevel))
		expect(levels()).toEqual([`Column B / ${ASC}`, `Column A / ${ASC}`, `Column C / ${ASC}`])
		expect(chosen()).toBe(2)

		const order = screen.getAllByRole("combobox", { name: preview.previewSheetSortOrder })[2]

		if (order === undefined) throw new Error("No third level")

		fireEvent.click(order)
		choose(await screen.findByRole("option", { name: DESC }))

		fireEvent.click(button(preview.previewSheetSortMoveUp))
		expect(levels()).toEqual([`Column B / ${ASC}`, `Column C / ${DESC}`, `Column A / ${ASC}`])
		expect(chosen()).toBe(1)

		fireEvent.click(button(preview.previewSheetSortCopyLevel))
		expect(levels()).toEqual([`Column B / ${ASC}`, `Column C / ${DESC}`, `Column C / ${DESC}`, `Column A / ${ASC}`])
		expect(chosen()).toBe(2)

		fireEvent.click(button(preview.previewSheetSortDeleteLevel))
		expect(levels()).toEqual([`Column B / ${ASC}`, `Column C / ${DESC}`, `Column A / ${ASC}`])
		expect(chosen()).toBe(1)

		fireEvent.click(button(preview.previewSheetSortMoveDown))
		expect(levels()).toEqual([`Column B / ${ASC}`, `Column A / ${ASC}`, `Column C / ${DESC}`])
		expect(chosen()).toBe(2)

		fireEvent.click(button(preview.previewSheetSortApply))
		expect(run).toHaveBeenCalledWith({
			type: "sort.apply",
			sheet: 3,
			range: RANGE,
			orientation: "rows",
			header: true,
			caseSensitive: false,
			keys: [
				{ index: 1, descending: false },
				{ index: 0, descending: false },
				{ index: 2, descending: true }
			]
		})
	})

	it("sorts left to right by rows, without a header row, starting over from the first row", () => {
		const run = renderSort()

		fireEvent.click(button(preview.previewSheetSortAddLevel))
		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetSortLeftToRight }))

		const header = screen.getByRole<HTMLInputElement>("checkbox", { name: preview.previewSheetSortHeaders })

		expect(header.checked).toBe(false)
		expect(header.disabled).toBe(true)
		expect(levels()).toEqual([`Row 1 / ${ASC}`])

		fireEvent.click(button(preview.previewSheetSortApply))
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ orientation: "cols", header: false, keys: [{ index: 0, descending: false }] })
		)
	})
})

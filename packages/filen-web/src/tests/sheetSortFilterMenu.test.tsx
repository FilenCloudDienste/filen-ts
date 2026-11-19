// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { SheetCommand, SheetLayout } from "@filen/office/core/sheet"
import type { SheetGridModel, SheetGridState } from "@filen/office/react/sheet"
import type { ReactNode } from "react"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"

// The toolbar's sort and filter menu: a quick sort of the data around the active cell by its column (the header row
// guessed and kept), the filter turned on over that data, a text file offered the sort alone, and Filter's keys the
// binding in effect (none when unbound).

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { SortFilterMenu } = await import("@/features/spreadsheet/data/sortFilterMenu")
const { SHEET_ACTIONS, sheetActionId } = await import("@/features/spreadsheet/lib/keymap")
const { Kbd } = await import("@/lib/keymap/kbd")
const { registerAction, registeredAction, setUserCombo } = await import("@/lib/keymap/registry")

const FILTER = sheetActionId("filter")

for (const def of SHEET_ACTIONS) {
	if (def.id === FILTER && registeredAction(def.id) === undefined) {
		registerAction(def)
	}
}

afterEach(() => {
	cleanup()
})

// A header of text over numbers in A1:B4, the active cell B3.
function fixture(kind: "xlsx" | "csv", layout: SheetLayout | null = null, filterKeys?: ReactNode) {
	const command = vi.fn<(command: SheetCommand) => Promise<unknown>>().mockResolvedValue({ ok: true })
	const region = { startRow: 0, startCol: 0, endRow: 3, endCol: 1 }
	const selection = {
		active: { row: 2, col: 1 },
		anchor: { row: 2, col: 1 },
		focus: { row: 2, col: 1 },
		ranges: [{ startRow: 2, startCol: 1, endRow: 2, endCol: 1 }]
	}
	const tile = { flags: Uint32Array.of(0, 1), texts: Int32Array.of(0, 1), styles: Uint32Array.of(0, 0), strings: ["Name", "3"] }
	const model = {
		kind,
		session: { query: vi.fn().mockResolvedValue(region) },
		getSnapshot: () => ({ sheet: 1, selection, layout }),
		entry: (_sheet: number, row: number) => (row === 0 ? { tile, entry: 0 } : { tile, entry: 1 }),
		intent: vi.fn().mockResolvedValue({ state: "writable" }),
		command
	} as unknown as SheetGridModel
	const grid = { model, layout, selection, sheet: 1 } as unknown as SheetGridState

	render(
		<SortFilterMenu
			grid={grid}
			disabled={false}
			filterKeys={filterKeys}
		/>
	)

	return { command, region }
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let k = 0; k < 4; k++) await Promise.resolve()
	})
}

describe("the sort and filter menu", () => {
	it("sorts the data around the active cell by its column, its header kept", async () => {
		const { command, region } = fixture("xlsx")

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetSortFilter }))
		fireEvent.click(await screen.findByRole("menuitem", { name: preview.previewSheetSortDescending }))
		await settle()

		expect(command).toHaveBeenCalledWith({
			type: "sort.apply",
			sheet: 1,
			range: region,
			orientation: "rows",
			header: true,
			caseSensitive: false,
			keys: [{ index: 1, descending: true }]
		})
	})

	it("turns the filter on over the data around the active cell", async () => {
		const { command, region } = fixture("xlsx")

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetSortFilter }))
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: new RegExp(preview.previewSheetFilter) }))
		await settle()

		expect(command).toHaveBeenCalledWith({ type: "filter.toggle", sheet: 1, range: region, active: { row: 2, col: 1 } })
	})

	it("offers a text file the sort alone", async () => {
		fixture("csv")

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetSortFilter }))

		expect(await screen.findByRole("menuitem", { name: preview.previewSheetSortAscending })).toBeTruthy()
		expect(screen.queryByRole("menuitemcheckbox", { name: new RegExp(preview.previewSheetFilter) })).toBeNull()
	})

	it("shows Filter's keys as the user has them bound", async () => {
		await act(() => setUserCombo(FILTER, "alt+f"))
		fixture("xlsx", null, <Kbd action={FILTER} />)

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetSortFilter }))

		const filter = await screen.findByRole("menuitemcheckbox", { name: new RegExp(preview.previewSheetFilter) })

		expect(filter.querySelector("[data-slot=menu-shortcut]")?.textContent).toContain("Alt")
		expect(filter.textContent).not.toContain("Ctrl+Shift+L")
		expect(filter.textContent).not.toContain("⇧⌘F")
	})

	it("shows no keys for Filter when it is unbound", async () => {
		fixture("xlsx")

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetSortFilter }))

		const filter = await screen.findByRole("menuitemcheckbox", { name: new RegExp(preview.previewSheetFilter) })

		expect(filter.querySelector("[data-slot=menu-shortcut]")).toBeNull()
	})
})

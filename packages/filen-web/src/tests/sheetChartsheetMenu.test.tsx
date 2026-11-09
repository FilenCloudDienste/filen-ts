// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { SheetGridState } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { ContextMenuItem } from "@/components/ui/context-menu"
import { openGrid, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"

// The grid's menu on a chartsheet: it has no cells, so none of the cells' items (insert, delete, hide, merge,
// clear, freeze, size resets) are offered; the features' groups handed to it (its chart's) still are.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { SheetGridMenu } = await import("@/features/spreadsheet/components/sheetGridMenu")

// The same grid with its sheets as chartsheets (or not).
function asChartsheets(grid: SheetGridState, chartsheet: boolean): SheetGridState {
	return chartsheet ? { ...grid, sheets: grid.sheets.map(sheet => ({ ...sheet, kind: "chartsheet" as const })) } : grid
}

async function openMenu(chartsheet: boolean): Promise<void> {
	const model = await openGrid(await workbook([{ name: "One", rows: [["a"]] }]), "xlsx")
	const view = render(
		<GridHarness model={model}>
			{grid => (
				<SheetGridMenu
					grid={asChartsheets(grid, chartsheet)}
					canEdit
					run={() => undefined}
					actions={{
						copy: () => undefined,
						paste: () => undefined,
						insertCells: () => undefined,
						deleteCells: () => undefined,
						formatCells: () => undefined
					}}
					items={[{ id: "charts", node: <ContextMenuItem>Edit chart…</ContextMenuItem> }]}
				>
					<div />
				</SheetGridMenu>
			)}
		</GridHarness>
	)
	const trigger = view.container.querySelector("[data-slot=context-menu-trigger]")

	if (trigger === null) throw new Error("no menu trigger")

	fireEvent.contextMenu(trigger)
	await screen.findByText("Edit chart…")
}

describe("the grid menu on a chartsheet", () => {
	it("offers the cells' items on a worksheet", async () => {
		await openMenu(false)

		expect(screen.queryByText(preview.previewSpreadsheetClearCells)).not.toBeNull()
		expect(screen.queryByText(preview.previewSheetFreeze)).not.toBeNull()
	})

	it("offers only the features' groups on a chartsheet", async () => {
		await openMenu(true)

		expect(screen.getByRole("menu", { name: preview.previewSheetGridMenu })).toBeTruthy()
		expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Edit chart…"])
	})
})

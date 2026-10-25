// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createRef } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import type { SheetKind } from "@filen/office/core/sheet"
import type { SheetGridHandle, SheetGridState } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { openGrid, ribbonActions, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"

// The ribbon and the formula bar on a sheet that is not a worksheet: its cells take no command (the session refuses
// them), so the cells' controls are off. Undo and redo stay as they are; a chartsheet's name box names no cell.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { SheetToolbar } = await import("@/features/spreadsheet/toolbar/sheetToolbar")
const { SheetFormulaBar } = await import("@/features/spreadsheet/components/sheetFormulaBar")

afterEach(() => {
	cleanup()
})

function asKind(grid: SheetGridState, kind: SheetKind): SheetGridState {
	return { ...grid, sheets: grid.sheets.map(sheet => ({ ...sheet, kind })) }
}

async function renderControls(kind: SheetKind): Promise<void> {
	const model = await openGrid(await workbook([{ name: "One", rows: [["a", 1]] }]), "xlsx")

	render(
		<GridHarness model={model}>
			{grid => (
				<>
					<SheetToolbar
						grid={asKind(grid, kind)}
						disabled={false}
						formats
						onFormat={() => undefined}
						actions={ribbonActions()}
					/>
					<SheetFormulaBar
						grid={asKind(grid, kind)}
						gridRef={createRef<SheetGridHandle>()}
						canEdit
					>
						{null}
					</SheetFormulaBar>
				</>
			)}
		</GridHarness>
	)
	// The active cell's format arrives from the session.
	await screen.findByRole("toolbar", { name: preview.previewOfficeRibbonCommands })
}

function control(name: string): HTMLElement {
	return screen.getByRole("button", { name })
}

describe("controls on a sheet without editable cells", () => {
	it("offers the cells' controls on a worksheet", async () => {
		await renderControls("worksheet")

		expect(await screen.findByRole("button", { name: preview.previewSheetRibbonInsert })).toHaveProperty("disabled", false)
		expect(screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox }).disabled).toBe(false)
	})

	for (const kind of ["chartsheet", "dialogsheet", "macrosheet"] as const) {
		it(`turns the cells' controls off on a ${kind}`, async () => {
			await renderControls(kind)

			for (const name of [preview.previewSheetRibbonInsert, preview.previewSpreadsheetBold]) {
				expect(control(name)).toHaveProperty("disabled", true)
			}

			// A macro sheet's cells are still shown and gone to; the others have none.
			const nameBox = screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox })

			expect(nameBox.disabled).toBe(kind !== "macrosheet")
			expect(nameBox.value).toBe(kind === "macrosheet" ? "A1" : "")
			expect(screen.queryByRole("textbox", { name: preview.previewSpreadsheetCellContents })).toBeNull()
		})
	}
})

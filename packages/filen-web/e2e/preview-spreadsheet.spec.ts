import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { bootTo, enterScratchDirectory, trashScratchDirectory, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { trackCspViolations } from "./helpers/csp"

// The spreadsheet viewer end to end: a real parse in the spreadsheet worker (hucre, and HyperFormula for
// the recalculation — both of which must run under the app's CSP, which forbids eval), the grid, typing
// into cells, and saving. The xlsx leg reloads the page after its save, so what it reads back is the file
// the drive now holds, not the bytes the overlay kept.
test.describe.configure({ mode: "default" })

const CSV_BYTES = Buffer.from("Name;Qty\r\nApples;3\r\nPears;5\r\n", "utf8")

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: "Budget",
					rows: [
						["Item", "Cost"],
						["Rent", 1200],
						["Food", 300],
						["Total", 1500]
					],
					cells: new Map([["3,1", { value: 1500, type: "formula", formula: "SUM(B2:B3)", formulaResult: 1500 }]])
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

// `row` and `col` as the sheet numbers them (A1 = 1, 1); the grid's ARIA indices count its header row
// and column first.
function gridCell(grid: Locator, row: number, col: number): Locator {
	return grid.locator(`[role="row"][aria-rowindex="${String(row + 1)}"] [role="gridcell"][aria-colindex="${String(col + 1)}"]`)
}

async function typeInto(page: Page, grid: Locator, row: number, col: number, text: string): Promise<void> {
	await gridCell(grid, row, col).click()
	await expect(grid).toBeFocused()
	await page.keyboard.type(text)
	await page.keyboard.press("Enter")
}

test("csv and xlsx open as grids, edit, recalculate and save, no CSP console errors", async ({ page, injectedSession }) => {
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-spreadsheet-${runId}`
	const nameCsv = `e2e-sheet-${runId}.csv`
	const nameXlsx = `e2e-sheet-${runId}.xlsx`

	const cspViolations = trackCspViolations(page)
	const dialog = page.getByRole("dialog")
	const grid = dialog.getByRole("grid")
	const saveButton = dialog.getByRole("button", { name: "Save", exact: true })

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)
		const input = page.getByRole("main").locator('input[type="file"]').first()

		await input.setInputFiles([
			{ name: nameCsv, mimeType: "text/csv", buffer: CSV_BYTES },
			{ name: nameXlsx, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await xlsxBytes() }
		])
		await expect(listbox.getByRole("option", { name: nameCsv })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(listbox.getByRole("option", { name: nameXlsx })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// CSV: the delimiter is sniffed, a cell edit marks the file dirty, and the save keeps the grid.
		await listbox.getByRole("option", { name: nameCsv }).dblclick()
		await expect(gridCell(grid, 2, 1)).toHaveText("Apples", { timeout: 60_000 })
		await expect(gridCell(grid, 1, 2)).toHaveText("Qty")

		await typeInto(page, grid, 3, 2, "42")
		await expect(gridCell(grid, 3, 2)).toHaveText("42")
		await expect(dialog.getByLabel("Selected cells")).toHaveText("B4")
		await expect(saveButton).toBeEnabled()

		await saveButton.click()
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(gridCell(grid, 3, 2)).toHaveText("42", { timeout: LIVE_WRITE_TIMEOUT_MS })

		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		// XLSX: a formula recalculates as its inputs change, undo takes it back, and mod+s saves.
		const xlsxRow = listbox.getByRole("option", { name: nameXlsx })

		await xlsxRow.dblclick()
		await expect(gridCell(grid, 4, 2)).toHaveText("1500", { timeout: 60_000 })
		await expect(dialog.getByRole("tab", { name: "Notes" })).toBeVisible()

		await typeInto(page, grid, 3, 2, "500")
		await expect(gridCell(grid, 4, 2)).toHaveText("1700")

		await page.keyboard.press(`${await resolveModKey(page)}+Z`)
		await expect(gridCell(grid, 4, 2)).toHaveText("1500")
		await page.keyboard.press(`${await resolveModKey(page)}+Shift+Z`)
		await expect(gridCell(grid, 4, 2)).toHaveText("1700")

		// A formula typed into an empty cell, reached by keyboard (only filled cells and the active one are
		// rendered): the arrow keys move the selection, never page to the next file.
		await expect(dialog.getByLabel("Selected cells")).toHaveText("B4")
		await page.keyboard.press("ArrowRight")
		await page.keyboard.press("ArrowLeft")
		await page.keyboard.press("ArrowDown")
		await expect(dialog.getByLabel("Selected cells")).toHaveText("B5")
		await page.keyboard.type("=B4*2")
		await page.keyboard.press("Enter")
		await expect(gridCell(grid, 5, 2)).toHaveText("3400")

		await gridCell(grid, 5, 2).click()
		await expect(dialog.getByRole("textbox", { name: "Cell contents" })).toHaveValue("=B4*2")

		await page.keyboard.press(`${await resolveModKey(page)}+S`)
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		// What the drive now holds, read fresh.
		await page.reload()
		await expect(xlsxRow).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await xlsxRow.dblclick()
		await expect(gridCell(grid, 4, 2)).toHaveText("1700", { timeout: 60_000 })
		await expect(gridCell(grid, 5, 2)).toHaveText("3400")
		await expect(dialog.getByRole("tab", { name: "Notes" })).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		expect(cspViolations).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

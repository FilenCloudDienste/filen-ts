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

function columnHeader(grid: Locator, col: number): Locator {
	return grid.locator(`[role="columnheader"][aria-colindex="${String(col + 1)}"]`)
}

// Drags column `col`'s right edge by `dx` pixels (`col` as the sheet numbers it, A = 1).
async function dragColumnEdge(page: Page, grid: Locator, col: number, dx: number): Promise<void> {
	const handle = columnHeader(grid, col).locator("[data-resize-handle]")
	const box = await handle.boundingBox()

	if (box === null) throw new Error("no resize handle")

	const x = box.x + box.width / 2
	const y = box.y + box.height / 2

	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + dx / 2, y, { steps: 4 })
	await page.mouse.move(x + dx, y, { steps: 4 })
	await page.mouse.up()
}

async function columnWidth(grid: Locator, col: number): Promise<number> {
	return (await columnHeader(grid, col).boundingBox())?.width ?? 0
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
		// A workbook opens view-only (its toolbar disabled) until the worker has proven it saves intact; typing
		// waits for that.
		await expect(dialog.getByRole("button", { name: "Bold", exact: true })).toBeEnabled({ timeout: 60_000 })
		await expect(dialog.getByText("Checking this file can be saved…")).toHaveCount(0)

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

test("rails resize: an xlsx keeps a width in the file, a csv beside it, and the rails hide what scrolls under them", async ({
	page,
	injectedSession
}) => {
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-spreadsheet-resize-${runId}`
	const nameCsv = `e2e-sheet-resize-${runId}.csv`
	const nameXlsx = `e2e-sheet-resize-${runId}.xlsx`
	const dialog = page.getByRole("dialog")
	const grid = dialog.getByRole("grid")
	const saveButton = dialog.getByRole("button", { name: "Save", exact: true })

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await page
			.getByRole("main")
			.locator('input[type="file"]')
			.first()
			.setInputFiles([
				{ name: nameCsv, mimeType: "text/csv", buffer: CSV_BYTES },
				{ name: nameXlsx, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await xlsxBytes() }
			])
		await expect(listbox.getByRole("option", { name: nameXlsx })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// XLSX: once editable, a drag is an edit; saved, the width is the file's.
		await listbox.getByRole("option", { name: nameXlsx }).dblclick()
		await expect(dialog.getByRole("button", { name: "Bold", exact: true })).toBeEnabled({ timeout: 60_000 })

		const before = await columnWidth(grid, 2)

		await dragColumnEdge(page, grid, 2, 80)
		await expect.poll(() => columnWidth(grid, 2)).toBeGreaterThan(before + 70)
		await expect(saveButton).toBeEnabled()
		await saveButton.click()
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		await page.reload()
		await expect(listbox.getByRole("option", { name: nameXlsx })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await listbox.getByRole("option", { name: nameXlsx }).dblclick()
		await expect(gridCell(grid, 1, 1)).toHaveText("Item", { timeout: 60_000 })
		await expect.poll(() => columnWidth(grid, 2)).toBeGreaterThan(before + 70)
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		// CSV: sizes live beside the file and survive closing it.
		await listbox.getByRole("option", { name: nameCsv }).dblclick()
		await expect(gridCell(grid, 2, 1)).toHaveText("Apples", { timeout: 60_000 })

		const csvBefore = await columnWidth(grid, 1)

		await dragColumnEdge(page, grid, 1, 60)
		await expect.poll(() => columnWidth(grid, 1)).toBeGreaterThan(csvBefore + 50)
		// Resizing a CSV is not an edit.
		await expect(saveButton).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
		await listbox.getByRole("option", { name: nameCsv }).dblclick()
		await expect(gridCell(grid, 2, 1)).toHaveText("Apples", { timeout: 60_000 })
		await expect.poll(() => columnWidth(grid, 1)).toBeGreaterThan(csvBefore + 50)

		// Opaque rails: a cell scrolled under the column rail is not what the rail's centre hits.
		await grid.evaluate(element => {
			element.scrollTop = 4
		})

		const rail = await columnHeader(grid, 1).boundingBox()

		if (rail === null) throw new Error("no rail")

		const hit = await page.evaluate(
			([x, y]) => document.elementFromPoint(x, y)?.closest('[role="columnheader"], [role="gridcell"]')?.getAttribute("role"),
			[rail.x + rail.width / 2, rail.y + rail.height - 2] as const
		)

		expect(hit).toBe("columnheader")
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

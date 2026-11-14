import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { withScratchDirectory, uploadFiles, reloadAfterWrite } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { ribbonButton, ribbonTab } from "./helpers/ribbon"
import { closeDialog, expectCell, goTo, openRow, saveAndClose, XLSX_MIME } from "./helpers/sheet"
import { preview } from "@/locales/en/preview"
import { menuItemName } from "./helpers/menu"

// Sorting and autofilters on the office engine end to end: the toolbar's sort and
// filter menu sorts the data around the active cell and turns the filter on, a header's filter button opens its menu
// (a value unchecked, the rows holding it hidden), the custom sort dialog sorts by two columns, and Ctrl+Shift+L
// (Cmd+Shift+F) turns the filter off. Each leg saves and reopens, so what it checks is the file the drive now holds.
test.describe.configure({ mode: "default" })

const SHEET = "Fruit"

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: SHEET,
					rows: [
						["Fruit", "Count"],
						["pear", 7],
						["apple", 3],
						["fig", 9],
						["apple", 1]
					]
				}
			]
		})
	)
}

function menuItem(page: Page, name: string): Locator {
	return page.getByRole("menuitem", { name: menuItemName(name) })
}

// Home ▸ Editing ▸ Sort and filter, wherever the ribbon's width put it.
async function sortFilterMenu(dialog: Locator): Promise<void> {
	await ribbonTab(dialog, preview.previewOfficeRibbonTabHome)
	await (await ribbonButton(dialog.page(), dialog, preview.previewOfficeRibbonEditing, preview.previewSheetSortFilter)).click()
}

// A header's filter button, drawn at the bottom right of its cell (header 20 px, rows 20 px, a 32 px row header and
// 64 px columns at 100 %): column `col` (0-based) of row 1.
async function filterButton(dialog: Locator, col: number): Promise<void> {
	await dialog.getByRole("grid").click({ position: { x: 32 + (col + 1) * 64 - 8, y: 20 + 12 } })
}

const LEGS = ["filter", "sort"] as const

test("data sorted from the toolbar and the sort dialog, filtered from a header's button", async ({ page }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-sort-filter", async ({ listbox, runId }) => {
		const bytes = await xlsxBytes()
		const legs = LEGS.map(leg => ({ leg, name: `e2e-sheet-sort-filter-${leg}-${runId}.xlsx` }))

		await uploadFiles(
			page,
			legs.map(({ name }) => ({ name, mimeType: XLSX_MIME, buffer: bytes })),
			listbox
		)

		const rows = Object.fromEntries(legs.map(({ leg, name }) => [leg, listbox.getByRole("option", { name })])) as Record<
			(typeof LEGS)[number],
			Locator
		>

		// The filter on from the toolbar, then "pear" unchecked in the Fruit column's menu.
		await openRow(dialog, rows.filter, SHEET)
		await goTo(dialog, "A2")
		await sortFilterMenu(dialog)
		await page.getByRole("menuitemcheckbox", { name: new RegExp(preview.previewSheetFilter) }).click()

		const menu = page.locator("[data-sheet-filter-menu]")

		// The filter lands from the worker and its button is drawn on the canvas, with no DOM to wait on: a press
		// before it lands only selects the header cell, so press until the menu opens.
		await expect(async () => {
			await filterButton(dialog, 0)
			await expect(menu).toBeVisible({ timeout: 1_000 })
		}).toPass({ timeout: 10_000 })
		await expect(menu.getByLabel("pear", { exact: true })).toBeChecked()
		await menu.getByLabel("pear", { exact: true }).uncheck()
		await menu.getByRole("button", { name: preview.previewSheetFilterApply, exact: true }).click()
		await expect(menu).toHaveCount(0)
		await saveAndClose(page, dialog, mod)

		// Sorted by Count, smallest first, from the toolbar; then by Fruit, then Count descending, in the dialog.
		await openRow(dialog, rows.sort, SHEET)
		await goTo(dialog, "B3")
		await sortFilterMenu(dialog)
		await menuItem(page, preview.previewSheetSortAscending).click()
		await expectCell(dialog, "A2", "apple")
		await expectCell(dialog, "B2", "1")
		await expectCell(dialog, "A5", "fig")
		await goTo(dialog, "A2")
		await sortFilterMenu(dialog)
		await menuItem(page, preview.previewSheetSortCustom).click()

		const sortDialog = page.getByRole("dialog", { name: preview.previewSheetSortTitle })

		await sortDialog.getByRole("button", { name: preview.previewSheetSortAddLevel }).click()
		await sortDialog.getByRole("combobox", { name: preview.previewSheetSortOrder }).last().click()
		await page.getByRole("option", { name: preview.previewSheetSortOrderDescending, exact: true }).click()
		await sortDialog.getByRole("button", { name: preview.previewSheetSortApply, exact: true }).click()
		await expectCell(dialog, "A2", "apple")
		await expectCell(dialog, "B2", "3")
		await saveAndClose(page, dialog, mod)

		await reloadAfterWrite(page)

		// The filtered rows stay hidden: the menu shows "pear" unchecked; Ctrl+Shift+L then turns the filter off.
		await openRow(dialog, rows.filter, SHEET)
		await filterButton(dialog, 0)
		const filterMenu = page.locator("[data-sheet-filter-menu]")

		await expect(filterMenu.getByLabel("pear", { exact: true })).not.toBeChecked()
		// The Escape is the menu's once it holds focus; before, it would close the document (a slow runner's case).
		await expect.poll(() => filterMenu.evaluate(element => element.contains(document.activeElement))).toBe(true)
		await page.keyboard.press("Escape")
		await expect(filterMenu).toHaveCount(0)
		await goTo(dialog, "A1")
		await page.keyboard.press(mod === "Meta" ? "Meta+Shift+F" : "Control+Shift+L")
		await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeVisible()
		await expectCell(dialog, "A2", "pear")
		// The filter's change is a change of the file: saved, as any edit, before the viewer closes.
		await saveAndClose(page, dialog, mod)

		await openRow(dialog, rows.sort, SHEET)
		await expectCell(dialog, "A2", "apple")
		await expectCell(dialog, "B2", "3")
		await expectCell(dialog, "A3", "apple")
		await expectCell(dialog, "B3", "1")
		await expectCell(dialog, "A4", "fig")
		await closeDialog(page, dialog)
	})
})

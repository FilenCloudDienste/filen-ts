import type { Locator } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { withScratchDirectory, LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { activeCell, expectCell, expectSelection, goTo, nameBox, XLSX_MIME } from "./helpers/sheet"
import { preview } from "@/locales/en/preview"
import { menuItemName } from "./helpers/menu"

// The office engine's grid keyboard end to end: Excel's shortcuts (Ctrl+arrow to
// the data region's edge, Ctrl+A, Ctrl+Space, Ctrl+D, Ctrl+Page Down, Ctrl+;, F4 in a formula, Ctrl+Minus) and the
// find bar (Mod+F, Mod+H), against a real session in the sheet worker. Mod is Command where the page says it runs on
// a Mac, as the app's keymap reads it.
test.describe.configure({ mode: "default" })

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: "Fruit",
					rows: [["Item", "Qty"], ["apple", 3], ["pear", 5], ["Apple pie", 1], [], ["melon", 9]]
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

test("the grid's Excel shortcuts and the find bar", async ({ page }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-keys", async ({ listbox, runId }) => {
		const name = `e2e-sheet-keys-${runId}.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)
		await listbox.getByRole("option", { name }).dblclick()
		await expectCell(dialog, "A1", "Item", LAZY_VIEWER_TIMEOUT_MS)

		// Ctrl+Down: the end of the run of filled cells, then the next filled cell past the blank row.
		await page.keyboard.press(`${mod}+ArrowDown`)
		await expect(nameBox(dialog)).toHaveValue("A4")
		await page.keyboard.press(`${mod}+ArrowDown`)
		await expect(nameBox(dialog)).toHaveValue("A6")
		await page.keyboard.press(`${mod}+ArrowUp`)
		await expect(nameBox(dialog)).toHaveValue("A4")

		// Ctrl+A: the data region, then the whole sheet.
		await goTo(dialog, "B2")
		await page.keyboard.press(`${mod}+A`)
		await expectSelection(dialog, "A1:B4")
		await page.keyboard.press(`${mod}+A`)
		await expectSelection(dialog, "A1:XFD1048576")

		// Ctrl+D: the first row of the selection copied down it.
		await goTo(dialog, "B2")
		await page.keyboard.press("Shift+ArrowDown")
		await page.keyboard.press("Shift+ArrowDown")
		await page.keyboard.press(`${mod}+D`)
		await goTo(dialog, "B4")
		await expect(activeCell(dialog)).toHaveText("3")
		await page.keyboard.press(`${mod}+Z`)
		await expect(activeCell(dialog)).toHaveText("1")

		// Ctrl+; starts an entry with today's date; Escape drops it.
		await goTo(dialog, "D1")
		await page.keyboard.press("Control+Semicolon")
		await expect(dialog.getByRole("textbox", { name: preview.previewSheetCellEditor })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
		await page.keyboard.press("Escape")

		// F4 in a formula: the reference typed last turns absolute.
		await goTo(dialog, "D1")
		await page.keyboard.type("=B2")
		await page.keyboard.press("F4")
		await expect(dialog.getByRole("textbox", { name: preview.previewSheetCellEditor })).toHaveValue("=$B$2")
		await page.keyboard.press("Escape")

		// Ctrl+Minus on cells: Excel's Delete dialog, never the browser's zoom.
		await goTo(dialog, "B2")
		await page.keyboard.press("Control+Minus")

		const deleteDialog = page.getByRole("dialog", { name: preview.previewSheetDeleteDialogTitle })

		await expect(deleteDialog).toBeVisible()
		await deleteDialog.getByRole("button", { name: "Cancel" }).click()
		await expect(deleteDialog).toHaveCount(0)

		// Mod+F: the first match after the active cell is selected; Enter steps on.
		await goTo(dialog, "A1")
		await page.keyboard.press(`${mod}+F`)

		const field = dialog.getByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		await expect(field).toBeFocused()
		await field.fill("apple")
		await expect(nameBox(dialog)).toHaveValue("A2")
		await field.press("Enter")
		await expect(nameBox(dialog)).toHaveValue("A4")
		await field.press("Escape")
		await expect(dialog.getByRole("search")).toHaveCount(0)

		// Mod+H: Replace All, one undo step.
		await goTo(dialog, "A1")
		await page.keyboard.press("Control+H")
		await dialog.getByRole("searchbox", { name: preview.previewDocxFindPlaceholder }).fill("apple")
		await expect(nameBox(dialog)).toHaveValue("A2")
		await dialog.getByRole("textbox", { name: preview.previewDocxReplacePlaceholder }).fill("plum")
		await dialog.getByRole("button", { name: preview.previewDocxReplaceAll }).click()
		await expect(dialog.getByText(preview.previewDocxFindNoMatches)).toBeVisible()
		await dialog.getByRole("button", { name: preview.previewDocxFindClose }).click()
		await goTo(dialog, "A4")
		await expect(activeCell(dialog)).toHaveText("plum pie")
		await page.keyboard.press(`${mod}+Z`)
		await expect(activeCell(dialog)).toHaveText("Apple pie")

		// The formula bar keeps the active cell's contents while the view scrolls far away from it.
		await goTo(dialog, "B3")
		await expect(dialog.getByRole("textbox", { name: preview.previewSpreadsheetCellContents })).toHaveValue("5")

		const box = await dialog.getByRole("grid").boundingBox()

		if (box === null) throw new Error("the grid has no box")

		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

		for (let step = 0; step < 40; step++) await page.mouse.wheel(0, 4_000)

		await expect(nameBox(dialog)).toHaveValue("B3")
		await expect(dialog.getByRole("textbox", { name: preview.previewSpreadsheetCellContents })).toHaveValue("5")

		// Ctrl+Page Down: the next sheet.
		await page.keyboard.press("Control+PageDown")
		await expect(dialog.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true")
		// Ctrl+Alt+Page Up: back, as Excel for the web goes in Chrome, which keeps Ctrl+Page Up for its tabs.
		await page.keyboard.press("Control+Alt+PageUp")
		await expect(dialog.getByRole("tab", { name: "Fruit" })).toHaveAttribute("aria-selected", "true")

		await page.keyboard.press("Escape")
	})
})

// The grid's menu, opened by a right-click on column A's cell of row `row` (header 20 px, rows 20 px and a 32 px row
// header at 100 %), as a user right-clicks.
async function gridMenu(dialog: Locator, row: number): Promise<void> {
	await dialog.getByRole("grid").click({ button: "right", position: { x: 44, y: 20 + (row - 1) * 20 + 10 } })
}

test("the active cell reads what the grid shows after rows and columns move, and Escape closes only the grid's menu", async ({ page }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()
	const contents = dialog.getByRole("textbox", { name: preview.previewSpreadsheetCellContents })
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-keys-moves", async ({ listbox, runId }) => {
		const name = `e2e-sheet-keys-moves-${runId}.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)
		await listbox.getByRole("option", { name }).dblclick()
		await expectCell(dialog, "A2", "apple", LAZY_VIEWER_TIMEOUT_MS)

		// Escape with the menu open and the grid still focused closes the menu, never the viewer.
		await gridMenu(dialog, 2)
		await expect(page.getByRole("menu")).toBeVisible()
		await page.keyboard.press("Escape")
		await expect(page.getByRole("menu")).toHaveCount(0)
		await expect(dialog.getByRole("grid")).toBeVisible()

		// A row and a column inserted, then deleted again: A2 holds "apple" again, as the grid draws it.
		await gridMenu(dialog, 2)
		await page.getByRole("menuitem", { name: menuItemName(preview.previewSpreadsheetInsertRowsAbove_one) }).click()
		await goTo(dialog, "A1")
		await gridMenu(dialog, 1)
		await page.getByRole("menuitem", { name: menuItemName(preview.previewSpreadsheetInsertColumnsLeft_one) }).click()
		await goTo(dialog, "B3")
		await expect(activeCell(dialog)).toHaveText("apple")
		await expect(contents).toHaveValue("apple")
		await goTo(dialog, "A2")
		await gridMenu(dialog, 2)
		await page.getByRole("menuitem", { name: menuItemName(preview.previewSpreadsheetDeleteRows_one) }).click()
		await goTo(dialog, "A1")
		await gridMenu(dialog, 1)
		await page.getByRole("menuitem", { name: menuItemName(preview.previewSpreadsheetDeleteColumns_one) }).click()
		await goTo(dialog, "A2")
		await expect(activeCell(dialog)).toHaveText("apple")
		await expect(contents).toHaveValue("apple")
		await goTo(dialog, "B2")
		await expect(activeCell(dialog)).toHaveText("3")

		// Saved and opened again: the file the drive holds reads the same.
		const save = dialog.getByRole("button", { name: "Save", exact: true })

		await expect(save).toBeVisible()
		await page.keyboard.press(`${mod}+S`)
		await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
		await listbox.getByRole("option", { name }).dblclick()
		await expectCell(dialog, "A2", "apple", LAZY_VIEWER_TIMEOUT_MS)
		await expect(contents).toHaveValue("apple")
		await goTo(dialog, "B2")
		await expect(activeCell(dialog)).toHaveText("3")
	})
})

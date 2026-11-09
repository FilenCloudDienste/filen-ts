import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { withScratchDirectory, uploadFiles, reloadAfterWrite } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { ribbonButton, ribbonTab } from "./helpers/ribbon"
import { closeDialog, expectCell, expectSelection, goTo, nameBox, openRow, saveAndClose, XLSX_MIME } from "./helpers/sheet"
import { preview } from "@/locales/en/preview"

// Sheet structure on the office engine end to end: rows and columns inserted,
// deleted, hidden and shown from the grid's menu, the top row frozen, cells merged and centred (with Excel's
// value-loss question), sheets added, renamed, duplicated, moved and deleted from the tabs, and a protected sheet
// refusing an edit. Each leg saves and reopens, so what it checks is the file the drive now holds.
test.describe.configure({ mode: "default" })

const SHEET = "Budget"

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: SHEET,
					rows: [
						["Item", "Cost"],
						["Rent", 1200],
						["Food", 300],
						["Fun", 50]
					]
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

// The grid's menu, opened by a right-click on column A's cell of row `row` (1-based; header 20 px, rows 20 px and
// a 32 px row header at 100 %), inside the selection so it acts on it.
async function gridMenu(dialog: Locator, row: number): Promise<void> {
	await dialog.getByRole("grid").click({ button: "right", position: { x: 44, y: 20 + (row - 1) * 20 + 10 } })
}

function menuItem(page: Page, name: string): Locator {
	return page.getByRole("menuitem", { name, exact: true })
}

// Escape on the menu itself: it closes the menu and leaves the viewer open.
async function closeMenu(page: Page): Promise<void> {
	await page.getByRole("menu").press("Escape")
	await expect(page.getByRole("menu")).toHaveCount(0)
	await expect(page.getByRole("dialog").first().getByRole("grid")).toBeVisible()
}

function tabNames(dialog: Locator): Locator {
	return dialog.getByRole("tablist", { name: preview.previewSpreadsheetSheets }).getByRole("tab")
}

const LEGS = ["insert", "delete", "hide", "unhide", "freeze", "merge", "tabs", "protect"] as const

// One file per leg, uploaded together.
async function upload(page: Page, listbox: Locator, runId: string): Promise<Record<(typeof LEGS)[number], Locator>> {
	const bytes = await xlsxBytes()
	const legs = LEGS.map(leg => ({ leg, name: `e2e-sheet-structure-${leg}-${runId}.xlsx` }))

	await uploadFiles(
		page,
		legs.map(({ name }) => ({ name, mimeType: XLSX_MIME, buffer: bytes })),
		listbox
	)

	return Object.fromEntries(legs.map(({ leg, name }) => [leg, listbox.getByRole("option", { name })])) as Record<
		(typeof LEGS)[number],
		Locator
	>
}

test("rows and columns inserted, deleted, hidden and shown, the top row frozen, cells merged and centred", async ({ page }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()
	const mod = await resolveModKey(page)
	// View ▸ Window ▸ Freeze and Home ▸ Alignment ▸ Merge, wherever the ribbon's width put them.
	const freeze = async (): Promise<Locator> => {
		await ribbonTab(dialog, preview.previewOfficeRibbonTabView)

		return ribbonButton(page, dialog, preview.previewSheetRibbonWindow, preview.previewSheetFreeze)
	}
	const merge = async (): Promise<Locator> => {
		await ribbonTab(dialog, preview.previewOfficeRibbonTabHome)

		return ribbonButton(page, dialog, preview.previewOfficeRibbonAlignment, preview.previewSheetMerge)
	}

	await withScratchDirectory(page, "sheet-structure-cells", async ({ listbox, runId }) => {
		const rows = await upload(page, listbox, runId)

		// A row inserted above row 2 and a column left of A.
		await openRow(dialog, rows.insert, SHEET)
		await expectCell(dialog, "A2", "Rent")
		await gridMenu(dialog, 2)
		await menuItem(page, preview.previewSpreadsheetInsertRowsAbove_one).click()
		await goTo(dialog, "A1")
		await gridMenu(dialog, 1)
		await menuItem(page, preview.previewSpreadsheetInsertColumnsLeft_one).click()
		await expectCell(dialog, "B3", "Rent")
		await saveAndClose(page, dialog, mod)

		// Row 2 and column A deleted.
		await openRow(dialog, rows.delete, SHEET)
		await expectCell(dialog, "A2", "Rent")
		await gridMenu(dialog, 2)
		await menuItem(page, preview.previewSpreadsheetDeleteRows_one).click()
		await expectCell(dialog, "A2", "Food")
		await goTo(dialog, "A1")
		await gridMenu(dialog, 1)
		await menuItem(page, preview.previewSpreadsheetDeleteColumns_one).click()
		await saveAndClose(page, dialog, mod)

		// Row 3 hidden.
		await openRow(dialog, rows.hide, SHEET)
		await goTo(dialog, "A3")
		await gridMenu(dialog, 3)
		await menuItem(page, preview.previewSheetHideRows_one).click()
		await saveAndClose(page, dialog, mod)

		// Row 3 hidden and shown again.
		await openRow(dialog, rows.unhide, SHEET)
		await goTo(dialog, "A3")
		await gridMenu(dialog, 3)
		await menuItem(page, preview.previewSheetHideRows_one).click()
		await goTo(dialog, "A2:A4")
		await gridMenu(dialog, 2)
		await menuItem(page, preview.previewSheetUnhideRows).click()
		await saveAndClose(page, dialog, mod)

		// The top row frozen.
		await openRow(dialog, rows.freeze, SHEET)
		await (await freeze()).click()
		await expect(menuItem(page, preview.previewSheetUnfreeze)).toBeDisabled()
		await menuItem(page, preview.previewSheetFreezeTopRow).click()
		await saveAndClose(page, dialog, mod)

		// Merge and centre over two values: asked first.
		await openRow(dialog, rows.merge, SHEET)
		await goTo(dialog, "A1:B1")
		await (await merge()).click()
		await menuItem(page, preview.previewSheetMergeCenter).click()

		const ask = page.getByRole("alertdialog")

		await expect(ask.getByText(preview.previewSheetMergeLosesBody)).toBeVisible()
		await ask.getByRole("button", { name: preview.previewSheetMergeCells, exact: true }).click()
		await expect(ask).toHaveCount(0)
		await saveAndClose(page, dialog, mod)

		// What the drive now holds, read fresh.
		await reloadAfterWrite(page)

		await openRow(dialog, rows.insert, SHEET)
		await expectCell(dialog, "B3", "Rent")
		await expectCell(dialog, "B1", "Item")
		await expectCell(dialog, "A1", "")
		await closeDialog(page, dialog)

		await openRow(dialog, rows.delete, SHEET)
		await expectCell(dialog, "A1", "Cost")
		await expectCell(dialog, "A2", "300")
		await closeDialog(page, dialog)

		// Around the hidden row, the menu offers it back; where it was shown again, there is nothing to unhide.
		await openRow(dialog, rows.hide, SHEET)
		await goTo(dialog, "A2:A4")
		await gridMenu(dialog, 2)
		await expect(menuItem(page, preview.previewSheetUnhideRows)).toBeEnabled()
		await closeMenu(page)
		await closeDialog(page, dialog)

		await openRow(dialog, rows.unhide, SHEET)
		await goTo(dialog, "A2:A4")
		await gridMenu(dialog, 2)
		await expect(menuItem(page, preview.previewSheetUnhideRows)).toBeDisabled()
		await closeMenu(page)
		await expectCell(dialog, "A3", "Food")
		await closeDialog(page, dialog)

		await openRow(dialog, rows.freeze, SHEET)
		await (await freeze()).click()
		await expect(menuItem(page, preview.previewSheetUnfreeze)).toBeEnabled()
		await closeMenu(page)
		await closeDialog(page, dialog)

		// The upper-left value stays, and the merge is there to undo.
		await openRow(dialog, rows.merge, SHEET)
		await nameBox(dialog).fill("A1")
		await nameBox(dialog).press("Enter")
		// The merge is selected whole.
		await expectSelection(dialog, "A1:B1")
		await expect(dialog.getByRole("grid").getByRole("gridcell")).toHaveText("Item")
		await (await merge()).click()
		await expect(menuItem(page, preview.previewSheetUnmerge)).toBeEnabled()
		await closeMenu(page)
		await closeDialog(page, dialog)
	})
})

test("sheets added, renamed, duplicated, moved and deleted from the tabs, and a protected sheet refusing an edit", async ({ page }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()
	const mod = await resolveModKey(page)
	const actions = dialog.getByRole("button", { name: preview.previewSheetTabMenu, exact: true })

	async function refusesEdit(): Promise<void> {
		await goTo(dialog, "A2")
		await page.keyboard.type("changed")
		await page.keyboard.press("Enter")
		await expectCell(dialog, "A2", "Rent")
	}

	await withScratchDirectory(page, "sheet-structure-tabs", async ({ listbox, runId }) => {
		const rows = await upload(page, listbox, runId)

		// Added and renamed.
		await openRow(dialog, rows.tabs, SHEET)
		await dialog.getByRole("button", { name: preview.previewSpreadsheetAddSheet }).click()
		await dialog.getByRole("tab", { name: "Sheet 3" }).dblclick()

		const rename = page.getByRole("dialog", { name: preview.previewSpreadsheetRenameSheet })

		await rename.getByLabel(preview.previewSpreadsheetSheetName).fill("Summary")
		await rename.getByRole("button", { name: preview.previewSpreadsheetRenameSheet }).click()
		await expect(rename).toHaveCount(0)
		await expect(dialog.getByRole("tab", { name: "Summary", exact: true })).toHaveAttribute("aria-selected", "true")

		// Duplicated (the copy is shown), moved left, and Notes deleted.
		await actions.click()
		await menuItem(page, preview.previewSheetDuplicate).click()
		await expect(dialog.getByRole("tab", { name: "Summary (2)" })).toHaveAttribute("aria-selected", "true")
		await actions.click()
		await menuItem(page, preview.previewSheetMoveLeft).click()
		await expect(tabNames(dialog)).toHaveText(["Budget", "Notes", "Summary (2)", "Summary"])
		await dialog.getByRole("tab", { name: "Notes" }).click()
		await actions.click()
		await menuItem(page, preview.previewSheetDelete).click()

		const confirm = page.getByRole("alertdialog", { name: preview.previewSheetDeleteTitle })

		await confirm.getByRole("button", { name: preview.previewSheetDelete, exact: true }).click()
		await expect(confirm).toHaveCount(0)
		await expect(tabNames(dialog)).toHaveText(["Budget", "Summary (2)", "Summary"])
		await dialog.getByRole("tab", { name: "Budget" }).click()
		await saveAndClose(page, dialog, mod)

		// Protected without a password: a locked cell refuses an edit.
		await openRow(dialog, rows.protect, SHEET)
		await actions.click()
		await menuItem(page, preview.previewSheetProtect).click()

		const protect = page.getByRole("dialog", { name: preview.previewSheetProtectTitle })

		await protect.getByRole("button", { name: preview.previewSheetProtectAction, exact: true }).click()
		await expect(protect).toHaveCount(0)
		await refusesEdit()
		await saveAndClose(page, dialog, mod)

		// What the drive now holds, read fresh.
		await reloadAfterWrite(page)

		await openRow(dialog, rows.tabs, SHEET)
		await expect(tabNames(dialog)).toHaveText(["Budget", "Summary (2)", "Summary"])
		await closeDialog(page, dialog)

		await openRow(dialog, rows.protect, SHEET)
		await actions.click()
		await expect(menuItem(page, preview.previewSheetUnprotect)).toBeVisible()
		await closeMenu(page)
		await refusesEdit()
		await closeDialog(page, dialog)
	})
})

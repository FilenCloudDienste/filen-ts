import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { withScratchDirectory, LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { ribbonButton, ribbonTab } from "./helpers/ribbon"
import { preview } from "@/locales/en/preview"

// Sheet structure on the office engine end to end: rows and columns inserted,
// deleted, hidden and shown from the grid's menu, the top row frozen, cells merged and centred (with Excel's
// value-loss question), sheets added, renamed, duplicated, moved and deleted from the tabs, and a protected sheet
// refusing an edit. Each leg saves and reopens, so what it checks is the file the drive now holds.
test.describe.configure({ mode: "default" })

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

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
						["Fun", 50]
					]
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

function nameBox(dialog: Locator): Locator {
	return dialog.getByRole("textbox", { name: preview.previewSheetNameBox })
}

// Makes `ref` ("B4", "A2:A4") the selection through the name box; the grid has focus after.
async function goTo(dialog: Locator, ref: string): Promise<void> {
	const box = nameBox(dialog)

	await box.click()
	await box.fill(ref)
	await box.press("Enter")
	await expect(box).toHaveValue(ref)
	await expect(dialog.getByRole("grid")).toBeFocused()
}

async function expectCell(dialog: Locator, ref: string, text: string, timeout?: number): Promise<void> {
	await goTo(dialog, ref)
	await expect(dialog.getByRole("grid").getByRole("gridcell")).toHaveText(text, timeout === undefined ? {} : { timeout })
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

// Saves from the grid (Cmd/Ctrl+S) once the edit marked the file unsaved, and closes the viewer. Each leg works on
// a file of its own; one reload then reopens them all, so what each checks is the file the drive now holds.
async function saveAndClose(page: Page, dialog: Locator, mod: string): Promise<void> {
	const save = dialog.getByRole("button", { name: "Save", exact: true })

	await expect(save).toBeVisible()
	// A cell no leg merges: the grid has focus for the shortcut.
	await goTo(dialog, "D10")
	await page.keyboard.press(`${mod}+S`)
	await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
	await close(page, dialog)
}

async function open(dialog: Locator, row: Locator): Promise<void> {
	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()
	await expect(nameBox(dialog)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByRole("tab", { name: "Budget" })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

// Escape until the viewer is gone: a tooltip a toolbar button left open takes the first one.
async function close(page: Page, dialog: Locator): Promise<void> {
	await expect(async () => {
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: 15_000 })
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
		await open(dialog, rows.insert)
		await expectCell(dialog, "A2", "Rent")
		await gridMenu(dialog, 2)
		await menuItem(page, preview.previewSpreadsheetInsertRowsAbove_one).click()
		await goTo(dialog, "A1")
		await gridMenu(dialog, 1)
		await menuItem(page, preview.previewSpreadsheetInsertColumnsLeft_one).click()
		await expectCell(dialog, "B3", "Rent")
		await saveAndClose(page, dialog, mod)

		// Row 2 and column A deleted.
		await open(dialog, rows.delete)
		await expectCell(dialog, "A2", "Rent")
		await gridMenu(dialog, 2)
		await menuItem(page, preview.previewSpreadsheetDeleteRows_one).click()
		await expectCell(dialog, "A2", "Food")
		await goTo(dialog, "A1")
		await gridMenu(dialog, 1)
		await menuItem(page, preview.previewSpreadsheetDeleteColumns_one).click()
		await saveAndClose(page, dialog, mod)

		// Row 3 hidden.
		await open(dialog, rows.hide)
		await goTo(dialog, "A3")
		await gridMenu(dialog, 3)
		await menuItem(page, preview.previewSheetHideRows_one).click()
		await saveAndClose(page, dialog, mod)

		// Row 3 hidden and shown again.
		await open(dialog, rows.unhide)
		await goTo(dialog, "A3")
		await gridMenu(dialog, 3)
		await menuItem(page, preview.previewSheetHideRows_one).click()
		await goTo(dialog, "A2:A4")
		await gridMenu(dialog, 2)
		await menuItem(page, preview.previewSheetUnhideRows).click()
		await saveAndClose(page, dialog, mod)

		// The top row frozen.
		await open(dialog, rows.freeze)
		await (await freeze()).click()
		await expect(menuItem(page, preview.previewSheetUnfreeze)).toBeDisabled()
		await menuItem(page, preview.previewSheetFreezeTopRow).click()
		await saveAndClose(page, dialog, mod)

		// Merge and centre over two values: asked first.
		await open(dialog, rows.merge)
		await goTo(dialog, "A1:B1")
		await (await merge()).click()
		await menuItem(page, preview.previewSheetMergeCenter).click()

		const ask = page.getByRole("alertdialog")

		await expect(ask.getByText(preview.previewSheetMergeLosesBody)).toBeVisible()
		await ask.getByRole("button", { name: preview.previewSheetMergeCells, exact: true }).click()
		await expect(ask).toHaveCount(0)
		await saveAndClose(page, dialog, mod)

		// What the drive now holds, read fresh.
		await page.reload()

		await open(dialog, rows.insert)
		await expectCell(dialog, "B3", "Rent")
		await expectCell(dialog, "B1", "Item")
		await expectCell(dialog, "A1", "")
		await close(page, dialog)

		await open(dialog, rows.delete)
		await expectCell(dialog, "A1", "Cost")
		await expectCell(dialog, "A2", "300")
		await close(page, dialog)

		// Around the hidden row, the menu offers it back; where it was shown again, there is nothing to unhide.
		await open(dialog, rows.hide)
		await goTo(dialog, "A2:A4")
		await gridMenu(dialog, 2)
		await expect(menuItem(page, preview.previewSheetUnhideRows)).toBeEnabled()
		await closeMenu(page)
		await close(page, dialog)

		await open(dialog, rows.unhide)
		await goTo(dialog, "A2:A4")
		await gridMenu(dialog, 2)
		await expect(menuItem(page, preview.previewSheetUnhideRows)).toBeDisabled()
		await closeMenu(page)
		await expectCell(dialog, "A3", "Food")
		await close(page, dialog)

		await open(dialog, rows.freeze)
		await (await freeze()).click()
		await expect(menuItem(page, preview.previewSheetUnfreeze)).toBeEnabled()
		await closeMenu(page)
		await close(page, dialog)

		// The upper-left value stays, and the merge is there to undo.
		await open(dialog, rows.merge)
		await nameBox(dialog).fill("A1")
		await nameBox(dialog).press("Enter")
		// The merge is selected whole.
		await expect(nameBox(dialog)).toHaveValue("A1:B1")
		await expect(dialog.getByRole("grid").getByRole("gridcell")).toHaveText("Item")
		await (await merge()).click()
		await expect(menuItem(page, preview.previewSheetUnmerge)).toBeEnabled()
		await closeMenu(page)
		await close(page, dialog)
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
		await open(dialog, rows.tabs)
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
		await open(dialog, rows.protect)
		await actions.click()
		await menuItem(page, preview.previewSheetProtect).click()

		const protect = page.getByRole("dialog", { name: preview.previewSheetProtectTitle })

		await protect.getByRole("button", { name: preview.previewSheetProtectAction, exact: true }).click()
		await expect(protect).toHaveCount(0)
		await refusesEdit()
		await saveAndClose(page, dialog, mod)

		// What the drive now holds, read fresh.
		await page.reload()

		await open(dialog, rows.tabs)
		await expect(tabNames(dialog)).toHaveText(["Budget", "Summary (2)", "Summary"])
		await close(page, dialog)

		await open(dialog, rows.protect)
		await actions.click()
		await expect(menuItem(page, preview.previewSheetUnprotect)).toBeVisible()
		await closeMenu(page)
		await refusesEdit()
		await close(page, dialog)
	})
})

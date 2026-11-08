import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS } from "./listing"
import { preview } from "@/locales/en/preview"

// The xlsx MIME type the sheet specs upload their workbooks with.
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

// The spreadsheet viewer driven through its name box: a cell or range reached by its reference, the active cell read
// back, a value typed in, and the document opened, saved and closed.

// The preview dialog (the first one: a password prompt stacks above it).
export function dialogOf(page: Page): Locator {
	return page.getByRole("dialog").first()
}

export function nameBox(dialog: Locator): Locator {
	return dialog.getByRole("textbox", { name: preview.previewSheetNameBox })
}

// The active cell's shown text.
export function activeCell(dialog: Locator): Locator {
	return dialog.getByRole("grid").getByRole("gridcell")
}

// Makes `ref` ("B4", "A2:A4") the selection through the name box, without asserting where focus goes after.
// `timeout` bounds the wait for the viewer itself (the name box), which a first open after a reload spends loading
// the engine; without it the click's default action timeout applies.
export async function selectByNameBox(dialog: Locator, ref: string, timeout?: number): Promise<void> {
	const box = nameBox(dialog)

	if (timeout !== undefined) {
		await expect(box).toBeVisible({ timeout })
	}

	await box.click()
	await box.fill(ref)
	await box.press("Enter")
	await expect(box).toHaveValue(ref)
}

// selectByNameBox, and the grid has focus after.
export async function goTo(dialog: Locator, ref: string, timeout?: number): Promise<void> {
	await selectByNameBox(dialog, ref, timeout)
	await expect(dialog.getByRole("grid")).toBeFocused()
}

// `timeout` bounds both the wait for the viewer and the wait for the text.
export async function expectCell(dialog: Locator, ref: string, text: string, timeout?: number): Promise<void> {
	await goTo(dialog, ref, timeout)
	await expect(activeCell(dialog)).toHaveText(text, timeout === undefined ? {} : { timeout })
}

export async function typeInto(page: Page, dialog: Locator, ref: string, text: string): Promise<void> {
	await goTo(dialog, ref)
	await page.keyboard.type(text)
	await page.keyboard.press("Enter")
}

// Opens the listing's `name` row; the dialog is returned once its grid shows.
export async function openFromListing(page: Page, listbox: Locator, name: string | RegExp): Promise<Locator> {
	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()

	const dialog = dialogOf(page)

	await expect(dialog.getByRole("grid")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// Opens `row` into `dialog`, done once the name box and the workbook's `sheet` tab show.
export async function openRow(dialog: Locator, row: Locator, sheet: string): Promise<void> {
	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()
	await expect(nameBox(dialog)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByRole("tab", { name: sheet })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

export async function closeDialog(page: Page, dialog: Locator): Promise<void> {
	await expect(async () => {
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: 15_000 })
}

// Saves with Ctrl/Cmd+S from D10 (a cell no leg touches, so the grid has focus for the shortcut) and closes.
export async function saveAndClose(page: Page, dialog: Locator, mod: string): Promise<void> {
	const save = dialog.getByRole("button", { name: "Save", exact: true })

	await expect(save).toBeVisible()
	await goTo(dialog, "D10")
	await page.keyboard.press(`${mod}+S`)
	await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
	await closeDialog(page, dialog)
}

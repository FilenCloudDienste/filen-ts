import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { withScratchDirectory, LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { drive } from "@/locales/en/drive"
import { preview } from "@/locales/en/preview"

// New ▸ Office end to end: a blank document and a blank workbook created from the Upload menu open in their
// editors at once, take typing, save, and reopen with it; a taken name is refused in the dialog (the file it
// names is never versioned). Each leg works in its own scratch directory.

test.describe.configure({ mode: "default" })

async function startNew(page: Page, entry: string): Promise<Locator> {
	// .first(): an empty scratch directory renders a second Upload trigger in its empty state.
	await page.getByRole("button", { name: drive.driveNewMenuTrigger, exact: true }).first().click()
	await page.getByRole("menuitem", { name: drive.driveNewOffice, exact: true }).click()
	await page.getByRole("menuitem", { name: entry, exact: true }).click()

	const field = page.getByLabel(drive.driveNewOfficeFileLabel, { exact: true })

	await expect(field).toBeVisible()

	return field
}

async function create(page: Page, entry: string, name: string): Promise<void> {
	const field = await startNew(page, entry)

	await field.fill(name)
	await page.getByRole("button", { name: drive.driveNewOfficeFileSubmit, exact: true }).click()
}

async function closePreview(page: Page): Promise<void> {
	await expect(async () => {
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: 15_000 })
}

async function save(page: Page): Promise<void> {
	const button = page.getByRole("dialog").getByRole("button", { name: preview.previewSaveAction, exact: true })

	await button.click()
	await expect(button).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
}

test("New ▸ Office ▸ Document opens a blank document in the editor, which saves and reopens with what was typed", async ({ page }) => {
	await withScratchDirectory(page, "new-office-docx", async ({ listbox, runId }) => {
		const name = `e2e-new-docx-${runId}`
		const typed = `Typed into a new document ${runId}`
		const bold = page.getByRole("button", { name: preview.previewDocxBold, exact: true })

		// The field starts on the localized untitled name.
		await expect(await startNew(page, drive.driveNewOfficeDocx)).toHaveValue(`${drive.driveNewDocxUntitled}.docx`)
		await page.keyboard.press("Escape")

		await create(page, drive.driveNewOfficeDocx, name)
		await expect(bold).toBeEnabled({ timeout: LIVE_WRITE_TIMEOUT_MS + LAZY_VIEWER_TIMEOUT_MS })
		await expect(page.getByRole("dialog").getByText(`${name}.docx`)).toBeVisible()

		// The empty first line, a margin's width in from the page's corner.
		await page
			.locator(".fo-docx-page")
			.first()
			.click({ position: { x: 120, y: 112 } })
		await page.keyboard.type(typed)
		await expect(page.locator(".fo-docx-page").getByText(typed, { exact: true })).toBeVisible()
		await save(page)
		await closePreview(page)

		const row = listbox.getByRole("option", { name: `${name}.docx` })

		await expect(row).toBeVisible({ timeout: 15_000 })
		await row.dblclick()
		await expect(page.locator(".fo-docx-page").getByText(typed, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await closePreview(page)

		// The same name again is refused in the dialog; the saved document stays as it is.
		await create(page, drive.driveNewOfficeDocx, name)
		await expect(page.getByText(drive.driveNewFileNameTaken)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await page.keyboard.press("Escape")
		await expect(listbox.getByRole("option", { name: `${name}.docx` })).toHaveCount(1)
		await listbox.getByRole("option", { name: `${name}.docx` }).dblclick()
		await expect(page.locator(".fo-docx-page").getByText(typed, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await closePreview(page)
	})
})

test("New ▸ Office ▸ Spreadsheet opens a blank workbook, which saves and reopens with the typed cell", async ({ page }) => {
	await withScratchDirectory(page, "new-office-xlsx", async ({ listbox, runId }) => {
		const name = `e2e-new-xlsx-${runId}`
		const dialog = page.getByRole("dialog").first()
		const nameBox = dialog.getByRole("textbox", { name: preview.previewSheetNameBox })

		await create(page, drive.driveNewOfficeXlsx, name)
		await expect(dialog.getByRole("grid")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS + LAZY_VIEWER_TIMEOUT_MS })
		await expect(dialog.getByRole("tab", { name: drive.driveNewXlsxSheetName })).toBeVisible()

		await nameBox.fill("A1")
		await nameBox.press("Enter")
		await expect(dialog.getByRole("grid")).toBeFocused()
		await page.keyboard.type("1250")
		await page.keyboard.press("Enter")
		await save(page)
		await nameBox.fill("A1")
		await nameBox.press("Enter")
		await closePreview(page)

		const row = listbox.getByRole("option", { name: `${name}.xlsx` })

		await expect(row).toBeVisible({ timeout: 15_000 })
		await row.dblclick()
		await expect(dialog.getByRole("grid")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await nameBox.fill("A1")
		await nameBox.press("Enter")
		await expect(dialog.getByRole("grid").getByRole("gridcell")).toHaveText("1250")
		await closePreview(page)
	})
})

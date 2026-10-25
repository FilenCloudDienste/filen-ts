import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import {
	bootTo,
	descendInto,
	waitForListingSettled,
	withScratchDirectory,
	LAZY_VIEWER_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS,
	uploadFiles
} from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { trackCspViolations } from "./helpers/csp"
import { storedPassword, trackPasswordCanary } from "./helpers/passwordCanary"
import { WORKBOOK_PASSWORD, encryptedWorkbook } from "@/tests/encryptedWorkbookFixtures"
import { preview } from "@/locales/en/preview"
import { settings } from "@/locales/en/settings"

// Saving on the spreadsheet viewer end to end: the idle autosave,
// Cmd/Ctrl+S, a save made elsewhere asked about over unsaved edits, Save as .xlsx of a CSV (its unsaved edits go
// into the copy, the CSV stays as last saved), Download as CSV ("CSV UTF-8", with a BOM), and a password-protected
// workbook whose stored bytes are only ever its sealed package (the upload canary: the stored file holds neither
// the cells nor the password, as UTF-8 or UTF-16). Each leg reads back what the drive now holds.
test.describe.configure({ mode: "default" })

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
// The idle autosave waits 30 s after the last edit (features/office/lib/officeAutosave.ts AUTOSAVE_IDLE_MS).
const AUTOSAVE_TIMEOUT_MS = 30_000 + LIVE_WRITE_TIMEOUT_MS
const REMOTE_EVENT_TIMEOUT_MS = 30_000
const CANARY = "Canary cell 7f3a"

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: "Budget",
					rows: [
						["Item", "Cost"],
						["Rent", 1200],
						["Food", 300]
					]
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

function dialogOf(page: Page): Locator {
	return page.getByRole("dialog").first()
}

async function goTo(dialog: Locator, ref: string): Promise<void> {
	const box = dialog.getByRole("textbox", { name: preview.previewSheetNameBox })

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

async function typeInto(page: Page, dialog: Locator, ref: string, text: string): Promise<void> {
	await goTo(dialog, ref)
	await page.keyboard.type(text)
	await page.keyboard.press("Enter")
}

async function fileMenu(page: Page, dialog: Locator, item: string, submenu?: string): Promise<void> {
	await dialog.getByRole("button", { name: preview.previewSheetFileMenu, exact: true }).click()

	if (submenu !== undefined) await page.getByRole("menuitem", { name: submenu, exact: true }).click()

	await page.getByRole("menuitem", { name: item, exact: true }).click()
}

async function open(page: Page, listbox: Locator, name: string | RegExp): Promise<Locator> {
	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()

	const dialog = dialogOf(page)

	await expect(dialog.getByRole("grid")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// Escape until the preview is gone: a tooltip the pointer left open takes the first one (Chromium).
async function close(page: Page): Promise<void> {
	await expect(async () => {
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: 15_000 })
}

test("a workbook saves itself after an idle pause, and on Cmd/Ctrl+S from the grid", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-save-auto", async ({ listbox, runId }) => {
		const name = `e2e-sheet-save-${runId}.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)

		let dialog = await open(page, listbox, name)
		const saveButton = dialog.getByRole("button", { name: "Save", exact: true })

		await expectCell(dialog, "B2", "1200", LAZY_VIEWER_TIMEOUT_MS)

		// Idle: saved with nothing pressed.
		await typeInto(page, dialog, "B2", "1250")
		await expect(saveButton).toBeVisible()
		await expect(saveButton).toHaveCount(0, { timeout: AUTOSAVE_TIMEOUT_MS })

		// Cmd/Ctrl+S with the entry still open: it is committed and saved.
		await goTo(dialog, "B3")
		await page.keyboard.type("333")
		await page.keyboard.press(`${mod}+S`)
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		// Back on the grid: an Escape there closes the preview (in the cell editor it would only end the entry).
		await goTo(dialog, "A1")
		await close(page)

		await page.reload()
		dialog = await open(page, listbox, name)
		await expectCell(dialog, "B2", "1250", LAZY_VIEWER_TIMEOUT_MS)
		await expectCell(dialog, "B3", "333")
		await close(page)
	})

	expect(cspViolations).toEqual([])
})

test("a save made elsewhere is asked about over unsaved edits, which can go into a copy", async ({ page, context }) => {
	test.slow()

	// The other tab, a second device: opened inside the scratch directory, closed whatever happens.
	const tabs: Page[] = []

	try {
		await withScratchDirectory(page, "sheet-save-remote", async ({ listbox, runId, scratchName }) => {
			const name = `e2e-sheet-save-remote-${runId}.xlsx`

			await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)

			const mine = await open(page, listbox, name)

			await expectCell(mine, "B2", "1200", LAZY_VIEWER_TIMEOUT_MS)

			const other = await context.newPage()

			tabs.push(other)
			await bootTo(other)
			await descendInto(other, (await waitForListingSettled(other)).listbox, scratchName)

			const theirs = await open(other, (await waitForListingSettled(other)).listbox, name)

			await expectCell(theirs, "B2", "1200", LAZY_VIEWER_TIMEOUT_MS)
			await typeInto(other, theirs, "B2", "2000")
			await typeInto(page, mine, "A4", "Mine only")
			await theirs.getByRole("button", { name: "Save", exact: true }).click()
			await expect(theirs.getByRole("button", { name: "Save", exact: true })).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			const prompt = page.getByRole("alertdialog", { name: "This file changed elsewhere" })

			await expect(prompt).toBeVisible({ timeout: REMOTE_EVENT_TIMEOUT_MS })
			await prompt.getByRole("button", { name: "Save mine as copy", exact: true }).click()
			await expect(prompt).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			// This tab now shows the newer version; its edits went into a conflicted copy beside it.
			await expectCell(mine, "B2", "2000", LAZY_VIEWER_TIMEOUT_MS)
			await expectCell(mine, "A4", "")
			await close(page)

			const copy = await open(page, listbox, /\(conflicted copy .*\)\.xlsx/)

			await expectCell(copy, "A4", "Mine only", LAZY_VIEWER_TIMEOUT_MS)
			await expectCell(copy, "B2", "1200")
			await close(page)
		})
	} finally {
		for (const tab of tabs) await tab.close()
	}
})

test("a CSV saves as an .xlsx copy holding its unsaved edits, and a sheet downloads as CSV UTF-8", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "sheet-save-copy", async ({ listbox, runId }) => {
		const nameCsv = `e2e-sheet-save-${runId}.csv`
		const nameXlsx = `e2e-sheet-save-${runId}.xlsx`

		await uploadFiles(
			page,
			[{ name: nameCsv, mimeType: "text/csv", buffer: Buffer.from("Name;Qty\r\nApples;3\r\n007;=1+2\r\n", "utf8") }],
			listbox
		)

		let dialog = await open(page, listbox, nameCsv)

		await expectCell(dialog, "A2", "Apples", LAZY_VIEWER_TIMEOUT_MS)
		await typeInto(page, dialog, "A4", "Pears")
		await typeInto(page, dialog, "B4", "5")
		await fileMenu(page, dialog, preview.previewSpreadsheetSaveAsXlsx)

		const confirm = page.getByRole("alertdialog", { name: preview.previewSpreadsheetSaveAsXlsxTitle })

		await expect(confirm.getByText(preview.previewSheetSaveAsXlsxTextBody)).toBeVisible()
		await confirm.getByRole("button", { name: preview.previewSpreadsheetSaveAsXlsx, exact: true }).click()
		await expect(confirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		// The copy takes the preview's place: an editable workbook, the edits in it, the CSV's text kept as text.
		await expect(dialog.getByText(nameXlsx)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await expectCell(dialog, "A4", "Pears", LAZY_VIEWER_TIMEOUT_MS)
		await expectCell(dialog, "B4", "5")
		await expectCell(dialog, "A3", "007")
		await expectCell(dialog, "B3", "=1+2")
		await expect(dialog.getByRole("button", { name: preview.previewSpreadsheetBold, exact: true })).toBeEnabled()

		// The sheet on show as Excel's "CSV UTF-8".
		const downloading = page.waitForEvent("download")

		await fileMenu(page, dialog, preview.previewSheetDownloadSheetCsvFormat, preview.previewSheetDownloadAs)

		const download = await downloading
		const path = await download.path()
		const bytes = readFileSync(path)

		expect(download.suggestedFilename()).toBe(nameXlsx.replace(/\.xlsx$/, ".csv"))
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
		// Every row ends with a line end, the last too, as Excel and LibreOffice write CSV.
		expect(bytes.subarray(3).toString("utf8")).toBe("Name,Qty\r\nApples,3\r\n007,=1+2\r\nPears,5\r\n")
		await close(page)

		// The CSV stays as it was last saved.
		dialog = await open(page, listbox, nameCsv)
		await expectCell(dialog, "A2", "Apples", LAZY_VIEWER_TIMEOUT_MS)
		await expectCell(dialog, "A4", "")
		await close(page)
	})
})

test("a password-protected workbook's saves store only its sealed package, and its cells never leave as CSV", async ({ page }) => {
	test.slow()

	const canary = trackPasswordCanary(page, WORKBOOK_PASSWORD)
	const cellCanary = trackPasswordCanary(page, CANARY)

	// The stored file comes down as a plain browser download (the service worker's route): no native picker.
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, "showSaveFilePicker")
	})

	await withScratchDirectory(page, "sheet-save-sealed", async ({ listbox, runId }) => {
		const name = `e2e-sheet-save-${runId}-sealed.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: Buffer.from(await encryptedWorkbook("agile")) }], listbox)
		await listbox.getByRole("option", { name }).dblclick()

		const prompt = page.getByRole("dialog", { name: preview.previewDocxPasswordTitle })
		const field = prompt.getByLabel(preview.previewDocxPasswordLabel, { exact: true })

		await expect(field).toBeFocused({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await field.fill(WORKBOOK_PASSWORD)
		await prompt.getByRole("button", { name: preview.previewDocxPasswordSubmit, exact: true }).click()

		const dialog = dialogOf(page)
		const saveButton = dialog.getByRole("button", { name: "Save", exact: true })

		await expectCell(dialog, "A1", "Item", LAZY_VIEWER_TIMEOUT_MS)
		await typeInto(page, dialog, "A2", CANARY)
		await saveButton.click()
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		// No CSV of a protected workbook; autosave is offered as for any workbook.
		await dialog.getByRole("button", { name: preview.previewSheetFileMenu, exact: true }).click()
		await expect(page.getByRole("menuitemcheckbox", { name: preview.previewSheetAutosave })).toBeVisible()
		await page.getByRole("menuitem", { name: preview.previewSheetDownloadAs, exact: true }).click()
		await expect(page.getByRole("menuitem", { name: preview.previewSheetDownloadSheetCsvFormat })).toHaveCount(0)
		await page.keyboard.press("Escape")

		// What the drive now holds: a compound file (the sealed package), holding neither the cell nor the password.
		const downloading = page.waitForEvent("download")

		await dialog.getByRole("button", { name: preview.previewDownloadAction, exact: true }).click()

		const stored = readFileSync(await (await downloading).path())

		expect([...stored.subarray(0, 8)]).toEqual([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

		for (const needle of [CANARY, WORKBOOK_PASSWORD]) {
			expect(stored.includes(Buffer.from(needle, "utf8")), needle).toBe(false)
			expect(stored.includes(Buffer.from(needle, "utf16le")), needle).toBe(false)
		}

		await close(page)
		expect(await storedPassword(page, WORKBOOK_PASSWORD)).toEqual([])
	})

	expect(canary.leaks).toEqual([])
	// The cell's text only ever leaves the page sealed (the SDK encrypts every upload as well).
	expect(cellCanary.leaks.filter(leak => !leak.startsWith("console"))).toEqual([])
})

test("the documents settings hold the autosave switch", async ({ page }) => {
	await bootTo(page, "/settings/advanced")

	// Read only: the setting is the account's, shared with every other test.
	await expect(page.getByText(settings.settingsAdvancedDocumentsDescription, { exact: true })).toBeVisible({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})
	await expect(page.getByRole("switch", { name: "Save automatically" })).toBeVisible()
})

test("each save is what the file opens on after a reload, never announced as made elsewhere", async ({ page }) => {
	test.slow()

	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-save-reload", async ({ listbox, runId }) => {
		const name = `e2e-sheet-save-reload-${runId}.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)

		let previous = "Item"

		for (const value of ["one", "two", "three"]) {
			const dialog = await open(page, listbox, name)

			// Opened at once from the listing restored from disk: the version saved last, no notice of it.
			await expectCell(dialog, "A1", previous, LIVE_WRITE_TIMEOUT_MS)
			await expect(page.getByText("Updated with changes saved elsewhere.")).toHaveCount(0)
			await typeInto(page, dialog, "A1", value)
			await goTo(dialog, "A1")
			await page.keyboard.press(`${mod}+S`)
			await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await close(page)
			await page.reload()
			previous = value
		}

		const dialog = await open(page, listbox, name)

		await expectCell(dialog, "A1", "three", LIVE_WRITE_TIMEOUT_MS)
		await close(page)
	})
})

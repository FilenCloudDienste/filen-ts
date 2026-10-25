import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
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
import { ODS_MIME, ODS_UNTOUCHED_ROW, OTS_MIME, odsFixture, zipEntry } from "./helpers/odsFixtures"
import { preview } from "@/locales/en/preview"

// OpenDocument spreadsheets edited in the spreadsheet viewer against the backend: saved by the idle autosave and by
// Cmd/Ctrl+S as the OpenDocument files they are (mimetype first and stored, rows no edit touched byte for byte), a
// row inserted from the grid menu, reopened with the edits; a template stays a template; a save made elsewhere is
// asked about over unsaved edits; a file opened and closed without an edit is stored as it was.
test.describe.configure({ mode: "default" })

// The idle autosave waits 30 s after the last edit (features/office/lib/officeAutosave.ts AUTOSAVE_IDLE_MS).
const AUTOSAVE_TIMEOUT_MS = 30_000 + LIVE_WRITE_TIMEOUT_MS
const REMOTE_EVENT_TIMEOUT_MS = 30_000

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

async function open(page: Page, listbox: Locator, name: string | RegExp): Promise<Locator> {
	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()

	const dialog = dialogOf(page)

	await expect(dialog.getByRole("grid")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expectCell(dialog, "A1", "Item", LAZY_VIEWER_TIMEOUT_MS)

	return dialog
}

// Escape until the preview is gone: a tooltip the pointer left open takes the first one (Chromium).
async function close(page: Page): Promise<void> {
	await expect(async () => {
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: 15_000 })
}

// The file as stored, downloaded from its row's menu.
async function storedBytes(page: Page, listbox: Locator, name: string): Promise<Buffer> {
	await listbox.getByRole("option", { name }).click({ button: "right" })

	const downloading = page.waitForEvent("download", { timeout: LIVE_WRITE_TIMEOUT_MS })

	await page.getByRole("menuitem", { name: /^Download$/u }).click()

	return readFileSync(await (await downloading).path())
}

function expectOpenDocument(stored: Buffer, mime: string): string {
	const mimetype = zipEntry(stored, "mimetype")

	expect(mimetype?.index).toBe(0)
	expect(mimetype?.method).toBe(0)
	expect(mimetype?.data.toString("ascii")).toBe(mime)

	return zipEntry(stored, "content.xml")?.data.toString("utf8") ?? ""
}

test("an .ods saves itself after an idle pause and on Cmd/Ctrl+S, staying an OpenDocument spreadsheet", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-ods-edit", async ({ listbox, runId }) => {
		const name = `e2e-sheet-ods-${runId}.ods`

		await uploadFiles(page, [{ name, mimeType: ODS_MIME, buffer: odsFixture(ODS_MIME) }], listbox)

		let dialog = await open(page, listbox, name)
		const saveButton = dialog.getByRole("button", { name: preview.previewSaveAction, exact: true })

		// Editable: no view-only note.
		await expect(dialog.getByText(preview.previewSheetReadOnlyOds)).toHaveCount(0)

		// Idle: saved with nothing pressed.
		await typeInto(page, dialog, "B2", "1250")
		await expect(saveButton).toBeVisible()
		await expect(saveButton).toHaveCount(0, { timeout: AUTOSAVE_TIMEOUT_MS })
		await goTo(dialog, "A1")
		await close(page)

		const content = expectOpenDocument(await storedBytes(page, listbox, name), ODS_MIME)

		expect(content).toContain('office:value="1250"')
		expect(content).toContain(ODS_UNTOUCHED_ROW)

		// A row inserted above row 2 from the grid menu (header 20 px, rows 20 px), saved with Cmd/Ctrl+S.
		dialog = await open(page, listbox, name)
		await goTo(dialog, "A2")
		await dialog.getByRole("grid").click({ button: "right", position: { x: 44, y: 20 + 20 + 10 } })
		await page.getByRole("menuitem", { name: preview.previewSpreadsheetInsertRowsAbove_one, exact: true }).click()
		await typeInto(page, dialog, "A2", "Inserted")
		await expect(saveButton).toBeVisible()
		await page.keyboard.press(`${mod}+S`)
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await goTo(dialog, "A1")
		await close(page)

		await page.reload()
		dialog = await open(page, listbox, name)
		await expectCell(dialog, "A2", "Inserted")
		await expectCell(dialog, "B3", "1250")
		// The total's formula reads the rows it read before, with the edit.
		await expectCell(dialog, "B5", "1550")
		await close(page)

		expectOpenDocument(await storedBytes(page, listbox, name), ODS_MIME)
	})

	expect(cspViolations).toEqual([])
})

test("an .ots template saves as a template", async ({ page }) => {
	test.slow()

	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-ots-edit", async ({ listbox, runId }) => {
		const name = `e2e-sheet-ots-${runId}.ots`

		await uploadFiles(page, [{ name, mimeType: OTS_MIME, buffer: odsFixture(OTS_MIME) }], listbox)

		const dialog = await open(page, listbox, name)

		const saveButton = dialog.getByRole("button", { name: preview.previewSaveAction, exact: true })

		await typeInto(page, dialog, "A5", "Template edit")
		// The edit is unsaved once the worker says so: a save asked for before that has nothing to save.
		await expect(saveButton).toBeVisible()
		await page.keyboard.press(`${mod}+S`)
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await goTo(dialog, "A1")
		await close(page)

		expect(expectOpenDocument(await storedBytes(page, listbox, name), OTS_MIME)).toContain("Template edit")
	})
})

test("a save made elsewhere is asked about over unsaved edits to an .ods, which can go into a copy", async ({ page, context }) => {
	test.slow()

	const tabs: Page[] = []

	try {
		await withScratchDirectory(page, "sheet-ods-remote", async ({ listbox, runId, scratchName }) => {
			const name = `e2e-sheet-ods-remote-${runId}.ods`

			await uploadFiles(page, [{ name, mimeType: ODS_MIME, buffer: odsFixture(ODS_MIME) }], listbox)

			const mine = await open(page, listbox, name)
			const other = await context.newPage()

			tabs.push(other)
			await bootTo(other)
			await descendInto(other, (await waitForListingSettled(other)).listbox, scratchName)

			const theirs = await open(other, (await waitForListingSettled(other)).listbox, name)

			await typeInto(other, theirs, "B2", "2000")
			await typeInto(page, mine, "A6", "Mine only")
			await theirs.getByRole("button", { name: preview.previewSaveAction, exact: true }).click()
			await expect(theirs.getByRole("button", { name: preview.previewSaveAction, exact: true })).toHaveCount(0, {
				timeout: LIVE_WRITE_TIMEOUT_MS
			})

			const prompt = page.getByRole("alertdialog", { name: "This file changed elsewhere" })

			await expect(prompt).toBeVisible({ timeout: REMOTE_EVENT_TIMEOUT_MS })
			await prompt.getByRole("button", { name: "Save mine as copy", exact: true }).click()
			await expect(prompt).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await expectCell(mine, "B2", "2000", LAZY_VIEWER_TIMEOUT_MS)
			await expectCell(mine, "A6", "")
			await close(page)

			// The copy beside it is an .ods too, with this tab's edit.
			const copy = await open(page, listbox, /\(conflicted copy .*\)\.ods/)

			await expectCell(copy, "A6", "Mine only", LAZY_VIEWER_TIMEOUT_MS)
			await expectCell(copy, "B2", "1200")
			await close(page)
		})
	} finally {
		for (const tab of tabs) await tab.close()
	}
})

test("an .ods opened and closed without an edit is stored as it was", async ({ page }) => {
	await withScratchDirectory(page, "sheet-ods-untouched", async ({ listbox, runId }) => {
		const name = `e2e-sheet-ods-untouched-${runId}.ods`
		const fixture = odsFixture(ODS_MIME)

		await uploadFiles(page, [{ name, mimeType: ODS_MIME, buffer: fixture }], listbox)
		await open(page, listbox, name)
		await close(page)

		expect((await storedBytes(page, listbox, name)).equals(fixture)).toBe(true)
	})
})

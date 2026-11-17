import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { encodeSingleByte } from "./fixtures/text"
import { preview } from "@/locales/en/preview"

// Saving text in the encoding it was read with, byte for byte (windows-1252, UTF-16 with its mark), a character the
// encoding cannot hold refused with the conversion offered, and Convert to UTF-8 making a file a save would change
// editable. Each leg saves, so each owns a scratch directory.

const LATIN = "Café crème à la carte, déjà vu.\r\nDeuxième ligne : naïve façade.\r\n"
const UTF16 = "Grüße aus Köln\nzweite Zeile\n"

function utf16le(text: string, bom: boolean): Buffer {
	return Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, "utf16le")])
}

async function open(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await listbox.getByRole("option", { name }).dblclick()

	const dialog = page.getByRole("dialog")

	await expect(dialog.locator(".cm-content")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// Types at the very end of the file (its last line is empty: every fixture ends with a line break).
async function typeAtEnd(dialog: Locator, text: string): Promise<void> {
	await dialog.locator(".cm-line").last().click()
	await expect(dialog.locator(".cm-content")).toBeFocused()
	await dialog.page().keyboard.type(text)
}

async function save(dialog: Locator): Promise<void> {
	const saveButton = dialog.getByRole("button", { name: "Save", exact: true })

	await saveButton.click()
	await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
}

async function downloaded(page: Page): Promise<Buffer> {
	const downloading = page.waitForEvent("download")

	await page.getByRole("button", { name: preview.previewDownloadAction, exact: true }).click()

	return readFileSync(await (await downloading).path())
}

test("a windows-1252 and a UTF-16 file save back in their own encoding, byte for byte", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "preview-text-encoding", async ({ listbox, runId }) => {
		const latinName = `e2e-latin-${runId}.txt`
		const utf16Name = `e2e-utf16-${runId}.txt`

		await uploadFiles(
			page,
			[
				{ name: latinName, mimeType: "text/plain", buffer: encodeSingleByte(LATIN, "windows-1252") },
				{ name: utf16Name, mimeType: "text/plain", buffer: utf16le(UTF16, true) }
			],
			listbox
		)

		let dialog = await open(page, listbox, latinName)

		await expect(dialog.getByRole("button", { name: "Encoding: Windows-1252" })).toBeVisible()
		await typeAtEnd(dialog, "ü")
		await save(dialog)
		expect(await downloaded(page)).toEqual(encodeSingleByte(`${LATIN}ü`, "windows-1252"))
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		dialog = await open(page, listbox, utf16Name)

		await expect(dialog.getByRole("button", { name: "Encoding: UTF-16 LE" })).toBeVisible()
		await typeAtEnd(dialog, "ß")
		await save(dialog)
		expect(await downloaded(page)).toEqual(utf16le(`${UTF16}ß`, true))
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})

	expect(cspViolations).toEqual([])
})

test("a character the encoding cannot hold is refused, and Convert to UTF-8 saves it", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "preview-text-convert", async ({ listbox, runId }) => {
		const latinName = `e2e-convert-${runId}.txt`
		const strayName = `e2e-stray-${runId}.txt`
		// UTF-8 with one stray byte: shown read-only, as a save would change it.
		const stray = Buffer.concat([Buffer.from("Grüße, Köln, schön\n", "utf8"), Buffer.from([0xff, 0x0a])])

		await uploadFiles(
			page,
			[
				{ name: latinName, mimeType: "text/plain", buffer: encodeSingleByte(LATIN, "windows-1252") },
				{ name: strayName, mimeType: "text/plain", buffer: stray }
			],
			listbox
		)

		// The refusal names the character and where it is; converting keeps the edit for the next save.
		let dialog = await open(page, listbox, latinName)

		await typeAtEnd(dialog, "☃")
		await dialog.getByRole("button", { name: "Save", exact: true }).click()

		const refusal = page.getByRole("alertdialog", { name: "Can't save in this encoding" })

		await expect(refusal).toContainText("Windows-1252 has no character “☃” (line 3, column 1)")
		await refusal.getByRole("button", { name: "Convert to UTF-8" }).click()
		await expect(dialog.getByRole("button", { name: "Encoding: UTF-8" })).toHaveText("UTF-8 (unsaved)")
		await save(dialog)
		expect(await downloaded(page)).toEqual(Buffer.from(`${LATIN}☃`, "utf8"))
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		// Read-only until converted from the encoding menu; the save then writes UTF-8.
		dialog = await open(page, listbox, strayName)

		await expect(dialog.getByText("Read-only", { exact: true })).toBeVisible()
		await dialog.getByRole("button", { name: "Encoding: UTF-8" }).click()
		await page.getByRole("menuitem", { name: "Convert to UTF-8" }).click()
		await expect(dialog.getByText("Read-only", { exact: true })).toHaveCount(0)
		await save(dialog)
		expect(await downloaded(page)).toEqual(Buffer.from("Grüße, Köln, schön\n�\n", "utf8"))
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})

	expect(cspViolations).toEqual([])
})

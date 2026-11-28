import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, selectAndTrashRow, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { DOCX_FIXTURE_TEXT, DOCX_MIME, docxFixtureBytes } from "./helpers/docxFixtures"
import { openTrash, revealRow } from "./helpers/archive"
import { ENCRYPTED_DOCX_PASSWORD, ENCRYPTED_DOCX_TEXT, encryptedDocxBytes } from "./helpers/docxEncryptedFixtures"
import { trackCspViolations } from "./helpers/csp"
import { storedPassword, trackPasswordCanary } from "./helpers/passwordCanary"
import { preview } from "@/locales/en/preview"
import { downloadDocxPdf, readPdf } from "./helpers/docxPdf"

// Download as ▸ PDF from the Word document's File menu, in a real browser against the backend: the editor's pages with
// an unsaved edit, and a password-protected document whose PDF asks for, checks and keeps its password. The PDFs are
// read back with pdf.js: text, title, the structure tree. Nothing is saved to the drive by the export (it is a local
// download). A drive file opens in the editor; the viewer's export (a read-only archive entry) is docx-a11y.spec.ts's.

test.describe.configure({ mode: "default" })

// The password's key derivation (100,000 SHA-512 rounds) runs once to open and once to check it for the PDF.
const UNLOCK_TIMEOUT_MS = 60_000
const EXPORT_TIMEOUT_MS = 120_000

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text, { exact: false }).first()
}

test("Download as PDF from the editor: the pages as shown, an unsaved edit included, tagged and titled", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "docx-pdf", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-headers.docx`

		await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxFixtureBytes("w3-headers.docx") }], listbox)
		await listbox.getByRole("option", { name }).dblclick()
		await expect(pageText(page, DOCX_FIXTURE_TEXT["w3-headers.docx"])).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({
			timeout: LAZY_VIEWER_TIMEOUT_MS
		})

		// An edit the file does not have yet.
		await pageText(page, DOCX_FIXTURE_TEXT["w3-headers.docx"]).click()
		await page.keyboard.press("End")
		await page.keyboard.type(" unsaved PDF words")

		const downloading = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS })

		await downloadDocxPdf(page)

		const download = await downloading
		const { pdf, text } = await readPdf(await download.path())
		const structure = (await (await pdf.getPage(1)).getStructTree()) as unknown as { role?: string; children?: unknown[] } | null

		expect(download.suggestedFilename()).toBe(name.replace(/\.docx$/, ".pdf"))
		expect(text).toContain(DOCX_FIXTURE_TEXT["w3-headers.docx"])
		expect(text).toContain("unsaved PDF words")
		expect(((await pdf.getMetadata()).info as { Title?: string }).Title).toBeTruthy()
		expect(structure?.children?.length ?? 0).toBeGreaterThan(0)
		expect(cspViolations).toEqual([])
	})
})

test("Download as PDF of a password-protected document: asks the password, refuses a wrong one, encrypts the PDF with it", async ({
	page
}) => {
	test.slow()

	const canary = trackPasswordCanary(page, ENCRYPTED_DOCX_PASSWORD)

	await withScratchDirectory(page, "docx-pdf-encrypted", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-encrypted.docx`

		await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: await encryptedDocxBytes() }], listbox)
		await listbox.getByRole("option", { name }).dblclick()

		const opening = page.getByRole("dialog", { name: preview.previewDocxPasswordTitle })

		await opening.getByLabel(preview.previewDocxPasswordLabel, { exact: true }).fill(ENCRYPTED_DOCX_PASSWORD)
		await opening.getByRole("button", { name: preview.previewDocxPasswordSubmit, exact: true }).click()
		await expect(pageText(page, ENCRYPTED_DOCX_TEXT)).toBeVisible({ timeout: UNLOCK_TIMEOUT_MS })

		await downloadDocxPdf(page)

		const prompt = page.getByRole("dialog", { name: preview.previewOfficePdfPasswordTitle })
		const field = prompt.getByLabel(preview.previewOfficePdfPasswordLabel, { exact: true })

		await field.fill("not the password")
		await prompt.getByRole("button", { name: preview.previewOfficePdfPasswordSubmit, exact: true }).click()
		await expect(prompt.getByText(preview.previewOfficePdfPasswordWrong)).toBeVisible({ timeout: UNLOCK_TIMEOUT_MS })

		const downloading = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS })

		await field.fill(ENCRYPTED_DOCX_PASSWORD)
		await prompt.getByRole("button", { name: preview.previewOfficePdfPasswordSubmit, exact: true }).click()

		const path = await (await downloading).path()

		await expect(readPdf(path)).rejects.toThrow()

		const { text } = await readPdf(path, ENCRYPTED_DOCX_PASSWORD)

		expect(text).toContain(ENCRYPTED_DOCX_TEXT)
		// The password never reached the console, a request or web storage.
		expect(canary.leaks).toEqual([])
		expect(await storedPassword(page, ENCRYPTED_DOCX_PASSWORD)).toEqual([])
	})
})

test("Download as PDF is not offered in the trash", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "docx-pdf-trash", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-trashed.docx`

		await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxFixtureBytes("notes.docx") }], listbox)
		// Through to the committed trash: selectAndTrashRow waits for the row to leave, which it does only once the
		// write landed.
		await selectAndTrashRow(page, listbox, name)

		const trash = await openTrash(page)
		const trashed = trash.getByRole("option", { name })

		await revealRow(trash, trashed, LIVE_WRITE_TIMEOUT_MS)
		await trashed.dblclick()
		await expect(pageText(page, DOCX_FIXTURE_TEXT["notes.docx"])).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(page.getByRole("button", { name: preview.previewDocxFileMenu, exact: true })).toHaveCount(0)
	})
})

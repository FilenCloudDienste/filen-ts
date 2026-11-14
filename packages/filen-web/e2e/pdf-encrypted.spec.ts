import * as mupdf from "mupdf"
import { test, expect } from "./fixtures"
import { LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { closePreview, downloaded, ENGINE_TIMEOUT_MS, openPdf, PDF_MIME, pdfjsRead, protectTab, textPdf } from "./helpers/pdfProtect"
import { preview } from "@/locales/en/preview"

// Password-protected PDFs in the editor: Protect › Protect document sets a password to open (AES-256) that the saved
// file then asks for; an owner-restricted file disables the editing tools until the owner password unlocks it; an RC4
// file is offered the AES-256 upgrade, written by the next save with its passwords kept. Saved files are read back in
// Node by pdf.js and MuPDF. Under the CSP, in every browser.
test.describe.configure({ mode: "default" })

// A password with the separators of MuPDF's option string: it must reach the file as typed.
const PASSWORD = "pä,ss=word"

// The fixture PDF written by MuPDF with `options` (RC4, restrictions).
function encrypted(options: Record<string, string | number>): Buffer {
	const document = new mupdf.PDFDocument(textPdf([["Encrypted page one"], ["Encrypted page two"]]))
	const bytes = Buffer.from(document.saveToBuffer(options).asUint8Array())

	document.destroy()

	return bytes
}

test("sets a password to open that the saved file asks for", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-encrypted-open", async ({ listbox, runId }) => {
		const name = `e2e-pdf-encrypted-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(textPdf([["Protect me"], ["Page two"]])) }], listbox)

		const dialog = await openPdf(page, listbox, name)

		await protectTab(dialog)
		await dialog.getByRole("button", { name: preview.previewPdfSecurityTitle }).click()

		const protect = page.getByRole("dialog", { name: preview.previewPdfSecurityTitle })

		await expect(protect).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await protect.getByRole("radio", { name: preview.previewPdfSecurityModeOpen }).click()
		await protect.getByLabel(preview.previewPdfSecurityPassword, { exact: true }).fill(PASSWORD)
		await protect.getByLabel(preview.previewPdfSecurityConfirm, { exact: true }).fill(PASSWORD)
		await protect.getByRole("button", { name: preview.previewPdfSecurityApply }).click()
		await expect(protect).toBeHidden()

		const save = dialog.getByRole("button", { name: preview.previewPdfSave, exact: true })

		await save.click()
		await expect(save).toBeDisabled({ timeout: LIVE_WRITE_TIMEOUT_MS })

		const bytes = new Uint8Array(await downloaded(page, dialog))

		expect(await pdfjsRead(bytes)).toEqual({ status: "password" })
		expect(await pdfjsRead(bytes, PASSWORD)).toMatchObject({ status: "open", text: "Protect me\nPage two\n" })

		const reopened = mupdf.Document.openDocument(bytes, "application/pdf")

		expect(reopened.getMetaData("encryption")).toBe("Standard V5 R6 256-bit AES")
		expect(reopened.needsPassword()).toBe(true)

		await closePreview(page)
		await listbox.getByRole("option", { name }).dblclick()
		await expect(page.getByText(preview.previewPdfPasswordTitle)).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
	})

	expect(cspViolations).toEqual([])
})

test("keeps an owner-restricted file's tools off until the owner password unlocks them", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-encrypted-owner", async ({ listbox, runId }) => {
		const name = `e2e-pdf-restricted-${runId}.pdf`
		const restricted = encrypted({ encrypt: "aes-256", "user-password": "", "owner-password": "owner pw", permissions: -3904 })

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: restricted }], listbox)

		const dialog = await openPdf(page, listbox, name)

		await protectTab(dialog)
		// Choosing a tool starts the editor, which reads the author's restrictions.
		await dialog.getByRole("button", { name: preview.previewPdfSecurityTitle }).click()
		await expect(dialog.getByText(preview.previewPdfOwnerRestricted)).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await page.keyboard.press("Escape")
		await expect(dialog.getByRole("button", { name: preview.previewPdfRedactArea })).toBeDisabled()

		await dialog.getByRole("button", { name: preview.previewPdfSecurityUnlockAction }).click()

		const unlock = page.getByRole("dialog", { name: preview.previewPdfSecurityUnlockTitle })

		await unlock.getByLabel(preview.previewPdfSecurityUnlockLabel).fill("wrong")
		await unlock.getByRole("button", { name: preview.previewPdfSecurityUnlockAction }).click()
		await expect(unlock.getByText(preview.previewPdfSecurityUnlockWrong)).toBeVisible()
		await unlock.getByLabel(preview.previewPdfSecurityUnlockLabel).fill("owner pw")
		await unlock.getByRole("button", { name: preview.previewPdfSecurityUnlockAction }).click()
		await expect(unlock).toBeHidden()
		await expect(dialog.getByText(preview.previewPdfOwnerRestricted)).toBeHidden()
		await expect(dialog.getByRole("button", { name: preview.previewPdfRedactArea })).toBeEnabled()
	})
})

test("upgrades an RC4 file to AES-256 on save, keeping its password", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-encrypted-rc4", async ({ listbox, runId }) => {
		const name = `e2e-pdf-rc4-${runId}.pdf`
		const rc4 = encrypted({ encrypt: "rc4-128", "user-password": "both", "owner-password": "both", permissions: -4 })

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: rc4 }], listbox)
		await listbox.getByRole("option", { name }).dblclick()
		await page.getByLabel(preview.previewPdfPasswordLabel).fill("both")
		await page.getByRole("button", { name: preview.previewPdfPasswordSubmit }).click()

		const dialog = page.getByRole("dialog").first()

		await expect(dialog.locator("canvas.block").first()).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await protectTab(dialog)
		await dialog.getByRole("button", { name: preview.previewPdfSecurityTitle }).click()

		const protect = page.getByRole("dialog", { name: preview.previewPdfSecurityTitle })

		await expect(protect.getByText(preview.previewPdfSecurityUpgrade)).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await protect.getByRole("button", { name: preview.previewPdfSecurityApply }).click()

		const save = dialog.getByRole("button", { name: preview.previewPdfSave, exact: true })

		await save.click()
		await expect(save).toBeDisabled({ timeout: LIVE_WRITE_TIMEOUT_MS })

		const bytes = new Uint8Array(await downloaded(page, dialog))
		const reopened = mupdf.Document.openDocument(bytes, "application/pdf")

		expect(reopened.getMetaData("encryption")).toBe("Standard V5 R6 256-bit AES")
		expect(await pdfjsRead(bytes, "both")).toMatchObject({ status: "open" })
	})
})

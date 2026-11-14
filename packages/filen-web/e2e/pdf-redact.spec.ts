import * as mupdf from "mupdf"
import { test, expect } from "./fixtures"
import { LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { pdfSyntax } from "./helpers/pdfBytes"
import { closePreview, downloaded, ENGINE_TIMEOUT_MS, openPdf, PDF_MIME, pdfjsRead, protectTab, textPdf } from "./helpers/pdfProtect"
import { preview } from "@/locales/en/preview"

// True redaction in a real browser: Protect › Find & redact marks every match, Apply redactions… applies the marks,
// saves the result as "name (redacted).pdf" (checked by the redaction verifier before anything is uploaded) and leaves
// the original as it was; saved in place instead, the earlier-versions warning offers deleting the old versions. The
// saved files are downloaded and checked in Node: the term is gone from the text and from every decoded stream, and
// the file has one revision.
test.describe.configure({ mode: "default" })

const SECRET = "Classified"
const PAGES = [
	["Agent name: Classified Person", "Public line one"],
	["Classified again on page two", "Public line two"]
] as const

async function findAndMark(page: import("@playwright/test").Page, dialog: import("@playwright/test").Locator): Promise<void> {
	await protectTab(dialog)
	await dialog.getByRole("button", { name: preview.previewPdfRedactFind }).click()
	await dialog.getByLabel(preview.previewPdfFindRedactTermLabel).fill(SECRET)
	await dialog.getByRole("button", { name: preview.previewPdfFindRedactSearch }).click()
	await expect(dialog.getByText("2 matches")).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
	await dialog.getByRole("button", { name: "Mark 2 matches for redaction" }).click()
	await expect(dialog.getByRole("heading", { name: "Marked for redaction (2)" })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
	await dialog.getByRole("button", { name: preview.previewPdfRedactApply }).click()
	await expect(page.getByRole("dialog", { name: preview.previewPdfRedactApplyTitle })).toBeVisible()
}

function expectRedacted(bytes: Uint8Array, text: string): void {
	expect(text).not.toContain(SECRET)
	expect(text).toContain("Public line one")
	expect(pdfSyntax(Buffer.from(bytes))).not.toContain(SECRET)

	const document = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

	expect(document?.countVersions()).toBe(1)
}

test("finds, marks and applies redactions into a verified redacted copy", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-redact-copy", async ({ listbox, runId }) => {
		const name = `e2e-pdf-redact-${runId}.pdf`
		const copy = `e2e-pdf-redact-${runId} (redacted).pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(textPdf(PAGES)) }], listbox)

		const dialog = await openPdf(page, listbox, name)

		await findAndMark(page, dialog)

		const apply = page.getByRole("dialog", { name: preview.previewPdfRedactApplyTitle })

		// A copy by default, its name shown.
		await expect(apply.getByText(copy)).toBeVisible()
		await apply.getByRole("button", { name: preview.previewPdfRedactApplyConfirm }).click()
		await expect(page.getByText(`The redacted copy was saved as ${copy}. This file is unchanged.`)).toBeVisible({
			timeout: LIVE_WRITE_TIMEOUT_MS
		})

		// The original is as it was saved.
		const original = new Uint8Array(await downloaded(page, dialog))
		const originalText = await pdfjsRead(original)

		expect(originalText.status === "open" && originalText.text.includes(SECRET)).toBe(true)

		await closePreview(page)

		const redactedDialog = await openPdf(page, listbox, copy)
		const bytes = new Uint8Array(await downloaded(page, redactedDialog))
		const read = await pdfjsRead(bytes)

		expect(read.status).toBe("open")
		expectRedacted(bytes, read.status === "open" ? read.text : "")
	})

	expect(cspViolations).toEqual([])
})

test("redacts in place and offers deleting the earlier versions that still hold the content", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-redact-in-place", async ({ listbox, runId }) => {
		const name = `e2e-pdf-redact-in-place-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(textPdf(PAGES)) }], listbox)

		const dialog = await openPdf(page, listbox, name)

		await findAndMark(page, dialog)

		const apply = page.getByRole("dialog", { name: preview.previewPdfRedactApplyTitle })

		await apply.getByRole("radio", { name: preview.previewPdfRedactSaveInPlace }).click()
		await apply.getByRole("button", { name: preview.previewPdfRedactApplyConfirm }).click()

		const warning = page.getByRole("alertdialog").filter({ hasText: preview.previewPdfEarlierVersions })

		await expect(warning).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(warning.getByRole("button", { name: preview.previewPdfDeleteEarlierVersions })).toBeEnabled()
		await warning.getByRole("button", { name: "Close" }).click()

		const bytes = new Uint8Array(await downloaded(page, dialog))
		const read = await pdfjsRead(bytes)

		expect(read.status).toBe("open")
		expectRedacted(bytes, read.status === "open" ? read.text : "")
	})
})

import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { pdfSyntax } from "./helpers/pdfBytes"
import { WORKBOOK_PASSWORD, encryptedWorkbook } from "@/tests/encryptedWorkbookFixtures"
import { preview } from "@/locales/en/preview"

// Download as ▸ PDF on the spreadsheet viewer end to end: made in the sheet worker beside the session (its fonts
// fetched from the app's origin under the CSP), the sheet on show as it prints, a local download named after the
// file; the print dialog's Save as PDF with its choices; a password-protected workbook's PDF encrypted with the same
// password. The PDF's pages are counted from its page tree (/Count), its encryption from its trailer.
test.describe.configure({ mode: "default" })

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
// A PDF of a few pages, fonts fetched on first use.
const PDF_TIMEOUT_MS = 60_000

async function xlsxBytes(rows: number): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: "Budget",
					rows: [["Item", "Cost"], ...Array.from({ length: rows }, (_, k) => [`Item ${String(k + 1)}`, (k + 1) * 10])]
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

function dialogOf(page: Page): Locator {
	return page.getByRole("dialog").first()
}

async function open(page: Page, listbox: Locator, name: string): Promise<Locator> {
	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()

	const dialog = dialogOf(page)

	await expect(dialog.getByRole("grid")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// A protected workbook's PDF takes its password, asked for before the export.
async function downloadPdf(page: Page, dialog: Locator, password?: string): Promise<{ name: string; text: string }> {
	await dialog.getByRole("button", { name: preview.previewSheetFileMenu, exact: true }).click()
	await page.getByRole("menuitem", { name: preview.previewSheetDownloadAs, exact: true }).click()

	const downloading = page.waitForEvent("download", { timeout: PDF_TIMEOUT_MS })

	await page.getByRole("menuitem", { name: preview.previewSheetDownloadPdf, exact: true }).click()

	if (password !== undefined) {
		const prompt = page.getByRole("dialog", { name: preview.previewOfficePdfPasswordTitle })

		await prompt.getByLabel(preview.previewOfficePdfPasswordLabel).fill(password)
		await prompt.getByRole("button", { name: preview.previewOfficePdfPasswordSubmit, exact: true }).click()
	}

	const download = await downloading

	return { name: download.suggestedFilename(), text: pdfSyntax(readFileSync(await download.path())) }
}

test("a workbook's sheet downloads as a tagged PDF, from the File menu and from the print dialog", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "sheet-pdf", async ({ listbox, runId }) => {
		const name = `e2e-sheet-pdf-${runId}.xlsx`

		// 120 rows: three Letter pages at 100 %.
		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes(120) }], listbox)

		const dialog = await open(page, listbox, name)
		const pdf = await downloadPdf(page, dialog)

		expect(pdf.name).toBe(name.replace(/\.xlsx$/, ".pdf"))
		expect(pdf.text.startsWith("%PDF-1.7")).toBe(true)
		expect(pdf.text).toMatch(/\/StructTreeRoot/)
		expect(pdf.text).not.toMatch(/\/Encrypt/)

		// The print dialog: the whole workbook, saved as PDF instead of printed.
		await dialog.getByRole("button", { name: preview.previewSheetFileMenu, exact: true }).click()
		await page.getByRole("menuitem", { name: preview.previewSheetPrintMenu }).click()

		const printDialog = page.getByRole("dialog", { name: preview.previewSheetPrint })

		await printDialog.getByRole("combobox", { name: preview.previewSheetPrintWhat }).click()
		await page.getByRole("option", { name: preview.previewSheetPrintWorkbook }).click()

		const downloading = page.waitForEvent("download", { timeout: PDF_TIMEOUT_MS })

		await printDialog.getByRole("button", { name: preview.previewSheetPrintSaveAsPdf }).click()

		const saved = await downloading
		const text = readFileSync(await saved.path()).toString("latin1")

		expect(saved.suggestedFilename()).toBe(name.replace(/\.xlsx$/, ".pdf"))
		expect(text.startsWith("%PDF-1.7")).toBe(true)
		await expect(printDialog).toHaveCount(0)
	})

	expect(cspViolations).toEqual([])
})

test("a password-protected workbook's PDF is encrypted with the same password", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "sheet-pdf-locked", async ({ listbox, runId }) => {
		const name = `e2e-sheet-pdf-locked-${runId}.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: Buffer.from(await encryptedWorkbook("agile")) }], listbox)
		await listbox.getByRole("option", { name }).dblclick()

		const prompt = page.getByRole("dialog", { name: preview.previewDocxPasswordTitle })
		const field = prompt.getByLabel(preview.previewDocxPasswordLabel, { exact: true })

		await expect(field).toBeFocused({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await field.fill(WORKBOOK_PASSWORD)
		await prompt.getByRole("button", { name: preview.previewDocxPasswordSubmit, exact: true }).click()

		const dialog = dialogOf(page)

		await expect(dialog.getByRole("grid")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		const pdf = await downloadPdf(page, dialog, WORKBOOK_PASSWORD)

		expect(pdf.text).toMatch(/\/Encrypt/)
		expect(pdf.text).toMatch(/\/AESV3/)
	})
})

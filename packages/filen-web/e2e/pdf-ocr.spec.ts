import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { scannedPdf } from "@filen/office/testing/ocr"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { preview } from "@/locales/en/preview"

// Tools › Recognise text on a scanned page (an image of text, no text): the dialog finds the scanned page, the English
// model downloads once, the page is recognised, and the saved file's text is found by pdf.js and by MuPDF's search,
// while the page still looks as scanned. Under the CSP.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
// The engine (MuPDF) and the recogniser (Tesseract, its model) load on first use.
const OCR_TIMEOUT_MS = 180_000
const LINES = ["The quick brown fox jumps over the lazy dog.", "Filen recognises scanned pages 12345."]

async function open(page: Page, listbox: Locator, name: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(page.locator("canvas").first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function downloaded(page: Page): Promise<Buffer> {
	const downloading = page.waitForEvent("download")

	await page.getByRole("button", { name: preview.previewDownloadAction, exact: true }).click()

	return readFileSync(await (await downloading).path())
}

async function pdfText(bytes: Buffer): Promise<string> {
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
	const pdf = await task.promise
	const content = await (await pdf.getPage(1)).getTextContent()

	await task.destroy()

	return content.items.map(item => ("str" in item ? item.str : "")).join(" ")
}

function mupdfFinds(bytes: Buffer, word: string): boolean {
	const document = new mupdf.PDFDocument(new Uint8Array(bytes))
	const page = document.loadPage(0)
	const found = page.search(word, "").length > 0

	page.destroy()
	document.destroy()

	return found
}

test("a scanned page becomes searchable", async ({ page }) => {
	test.slow()
	test.setTimeout(OCR_TIMEOUT_MS * 2)

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-ocr", async ({ listbox, runId }) => {
		const name = `e2e-pdf-ocr-${runId}.pdf`
		const scan = Buffer.from(scannedPdf({ lines: LINES, dpi: 300 }))

		expect(await pdfText(scan)).not.toContain("quick")
		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: scan }], listbox)
		await open(page, listbox, name)
		await page.getByRole("tab", { name: preview.previewPdfTabTools }).click()
		await page.getByRole("button", { name: preview.previewPdfOcrMenu }).click()

		const dialog = page.getByRole("dialog", { name: preview.previewPdfOcrTitle })

		await expect(dialog.getByText("1 scanned page will be made searchable.", { exact: false })).toBeVisible({ timeout: OCR_TIMEOUT_MS })
		await dialog.getByRole("button", { name: preview.previewPdfOcrStart }).click()
		await expect(dialog.getByText("1 page is now searchable.")).toBeVisible({ timeout: OCR_TIMEOUT_MS })
		await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
		await expect(page.getByRole("button", { name: preview.previewPdfUndo })).toBeEnabled()

		await page.getByRole("button", { name: preview.previewPdfSave, exact: true }).click()
		await expect(page.getByRole("button", { name: preview.previewPdfSave, exact: true })).toBeDisabled({ timeout: OCR_TIMEOUT_MS })

		const saved = await downloaded(page)
		const text = await pdfText(saved)

		for (const word of ["quick", "brown", "lazy", "Filen", "scanned"]) expect(text).toContain(word)

		expect(mupdfFinds(saved, "recognises")).toBe(true)
	})

	expect(cspViolations).toEqual([])
})

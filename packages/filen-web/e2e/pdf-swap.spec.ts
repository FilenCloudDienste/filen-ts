import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { writePdf } from "../scripts/pdf-fixtures/view/pdfWriter"
import { preview } from "@/locales/en/preview"

// The PDF viewer hands a document to the editor on the first change, silently: typing into a form field swaps from
// pdf.js to MuPDF keeping the page, the zoom and the scroll, the value lands, Undo and Redo step it, and Save makes a
// new version that opens again with the value. Under the CSP, in every browser.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
// The engine worker compiles MuPDF (about 10 MB of wasm) on its first use.
const ENGINE_TIMEOUT_MS = 60_000

// One page with a text field ("name") and some text.
function formPdf(): Uint8Array {
	const content = "BT /Helv 18 Tf 72 760 Td (Swap test) Tj ET\n"

	return writePdf(
		[
			{ dict: "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>" },
			{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
			{
				dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /Helv 4 0 R >> >> /Contents 7 0 R /Annots [5 0 R] >>"
			},
			{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
			{
				dict: "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /TU (Your name) /Rect [72 680 300 700] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>"
			},
			{ dict: "<< /Fields [5 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >>" },
			{ dict: "<< >>", stream: new TextEncoder().encode(content) }
		],
		1
	)
}

async function openPdf(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await listbox.getByRole("option", { name }).dblclick()

	const dialog = page.getByRole("dialog").first()

	await expect(dialog.locator("canvas.block").first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

test("typing into a form field swaps to the editor and saves the value", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-swap", async ({ listbox, runId }) => {
		const name = `e2e-pdf-swap-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(formPdf()) }], listbox)

		const dialog = await openPdf(page, listbox, name)
		const scroller = dialog.locator("[data-preview-surface] > div").first()
		const field = dialog.getByRole("textbox", { name: "Your name" })

		await expect(field).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		// Never the document's own field name, never a password manager's field.
		await expect(field).not.toHaveAttribute("name")
		await expect(field).toHaveAttribute("autocomplete", "off")

		const before = await scroller.evaluate(element => ({ top: element.scrollTop, width: element.scrollWidth }))

		await field.fill("Ada Lovelace")
		await field.press("Enter")

		// The editor took over: Undo is offered, the page kept its place and size.
		const undo = dialog.getByRole("button", { name: preview.previewPdfUndo })

		await expect(undo).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		expect(await scroller.evaluate(element => ({ top: element.scrollTop, width: element.scrollWidth }))).toEqual(before)
		await expect(dialog.locator("canvas.block").first()).toBeVisible()

		await undo.click()
		await expect(field).toHaveValue("")
		await dialog.getByRole("button", { name: preview.previewPdfRedo }).click()
		await expect(field).toHaveValue("Ada Lovelace")

		await dialog.getByRole("button", { name: preview.previewPdfSave, exact: true }).click()
		// Saved: nothing left to save.
		await expect(dialog.getByRole("button", { name: preview.previewPdfSave, exact: true })).toBeDisabled({ timeout: ENGINE_TIMEOUT_MS })
	})

	expect(cspViolations).toEqual([])
})

test("the editor not loading leaves the viewer working and says so", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-swap-fail", async ({ listbox, runId }) => {
		const name = `e2e-pdf-swap-fail-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(formPdf()) }], listbox)
		// The engine's wasm cannot be fetched: as offline on first use, or WebAssembly turned off.
		await page.route(/mupdf-wasm.*\.wasm$/, route => route.abort())

		const dialog = await openPdf(page, listbox, name)
		const field = dialog.getByRole("textbox", { name: "Your name" })

		await field.fill("Ada")
		await field.press("Enter")
		await expect(dialog.getByText(preview.previewPdfEditorUnavailable)).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await expect(dialog.getByRole("button", { name: preview.previewPdfEditorRetry })).toBeVisible()
		await expect(dialog.locator("canvas.block").first()).toBeVisible()
	})
})

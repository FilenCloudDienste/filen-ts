import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { writePdf } from "../scripts/pdf-fixtures/view/pdfWriter"
import { preview } from "@/locales/en/preview"

// Tools › Edit text and Add text: a word of a line is replaced in place (its neighbours and the next line untouched),
// Undo and Redo step it, new text is added on an empty part of the page, and the saved file reads the new words in
// pdf.js. Text drawn as shapes is refused with the notice (the engine tests refuse a replacement that would take
// neighbouring glyphs with it). Under the CSP.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
const ENGINE_TIMEOUT_MS = 60_000
const PAGE = { width: 595, height: 842 }

// Helvetica 12 pt lines on an A4 page: "Hello brave new world" at y 722, "Second line stays" at y 692.
function textPdf(content: string): Uint8Array {
	return writePdf(
		[
			{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
			{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
			{
				dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
			},
			{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
			{ dict: "<< >>", stream: new TextEncoder().encode(content) }
		],
		1
	)
}

const LINES = "BT /F1 12 Tf 72 722 Td (Hello brave new world) Tj ET BT /F1 12 Tf 72 692 Td (Second line stays) Tj ET"
// Glyph-like outlines without text (a converted heading): not editable as text.
const OUTLINES = "0 g 72 400 m 80 430 l 88 400 l h f 90 400 m 98 430 l 106 400 l h f"

async function open(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await listbox.getByRole("option", { name }).dblclick()

	const surface = page.getByRole("region", { name: /Page 1 of 1/u })

	await expect(page.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return surface
}

// A point of the page in PDF user space (y up), clicked where it shows (the tool's layer over the page takes it).
async function clickAt(surface: Locator, x: number, y: number): Promise<void> {
	const box = await surface.boundingBox()

	if (box === null) throw new Error("page not laid out")

	await surface.page().mouse.click(box.x + (x / PAGE.width) * box.width, box.y + ((PAGE.height - y) / PAGE.height) * box.height)
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

test("a word is replaced in place, text is added, and the saved file reads them", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-text", async ({ listbox, runId }) => {
		const name = `e2e-pdf-text-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(textPdf(LINES)) }], listbox)

		const surface = await open(page, listbox, name)

		await page.getByRole("tab", { name: preview.previewPdfTabTools }).click()
		await page.getByRole("button", { name: preview.previewPdfTextEditTool }).click()

		// The editor opens the document; the line under the click is prefilled with its font.
		const editor = page.getByRole("textbox", { name: preview.previewPdfTextEditField })

		await expect(async () => {
			await clickAt(surface, 110, 726)
			await expect(editor).toBeVisible({ timeout: 2_000 })
		}).toPass({ timeout: ENGINE_TIMEOUT_MS })
		await expect(editor).toHaveValue("Hello brave new world")
		await expect(page.getByText("Aa Arimo")).toBeVisible()

		await editor.fill("Hello bold new world")
		await page.getByRole("button", { name: preview.previewPdfTextEditDone }).click()
		await expect(editor).toHaveCount(0, { timeout: ENGINE_TIMEOUT_MS })

		const undo = page.getByRole("button", { name: preview.previewPdfUndo })

		await expect(undo).toBeEnabled()
		await undo.click()
		await page.getByRole("button", { name: preview.previewPdfRedo }).click()

		// Add text on the empty lower half.
		await page.getByRole("button", { name: preview.previewPdfTextAddTool }).click()
		await clickAt(surface, 72, 400)
		await expect(editor).toBeVisible()
		await editor.fill("Added by e2e")
		await page.getByRole("button", { name: preview.previewPdfTextEditDone }).click()
		await expect(editor).toHaveCount(0, { timeout: ENGINE_TIMEOUT_MS })

		await page.getByRole("button", { name: preview.previewPdfSave, exact: true }).click()
		await expect(page.getByRole("button", { name: preview.previewPdfSave, exact: true })).toBeDisabled({ timeout: ENGINE_TIMEOUT_MS })

		const text = await pdfText(await downloaded(page))

		expect(text).toContain("bold")
		expect(text).toContain("Added by e2e")
		expect(text).toContain("Second line stays")
		expect(text).not.toContain("brave")
		expect(text).toContain("Hello")
		expect(text).toContain("world")
	})

	expect(cspViolations).toEqual([])
})

test("text drawn as shapes can't be edited, and the notice says so", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-text-shapes", async ({ listbox, runId }) => {
		const name = `e2e-pdf-text-shapes-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(textPdf(`${LINES} ${OUTLINES}`)) }], listbox)

		const surface = await open(page, listbox, name)

		await page.getByRole("tab", { name: preview.previewPdfTabTools }).click()
		await page.getByRole("button", { name: preview.previewPdfTextEditTool }).click()

		await expect(async () => {
			await clickAt(surface, 80, 410)
			await expect(page.getByText(preview.previewPdfTextEditNotPossible)).toBeVisible({ timeout: 2_000 })
		}).toPass({ timeout: ENGINE_TIMEOUT_MS })
		await expect(page.getByRole("textbox", { name: preview.previewPdfTextEditField })).toHaveCount(0)
		await expect(page.getByRole("button", { name: preview.previewPdfUndo })).toBeDisabled()
	})
})

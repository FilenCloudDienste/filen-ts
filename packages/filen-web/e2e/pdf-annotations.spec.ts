import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { writePdf } from "../scripts/pdf-fixtures/view/pdfWriter"
import { preview } from "@/locales/en/preview"
import { resolveModKey } from "./helpers/modkey"
import { expectPdfSaved, pdfLiveRegion, pdfPageScroller } from "./helpers/pdfSurface"

// Annotations and comments on a PDF: a shape drawn with the pointer (the first change swaps to the editor and is
// replayed into it), a text box placed from the keyboard, a highlight dragged over text, the selection's popover
// (colour, delete), a sticky note written in the Comments panel with a reply and resolved, Undo / Redo, Save, and the
// saved file showing every annotation when it opens again. Under the CSP, in every browser.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
// The engine worker compiles MuPDF (about 10 MB of wasm) on its first use.
const ENGINE_TIMEOUT_MS = 60_000

// One A4 page with a line of text to highlight.
function textPdf(): Uint8Array {
	const content = "BT /Helv 24 Tf 72 720 Td (Highlight this line of text) Tj ET\n"

	return writePdf(
		[
			{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
			{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
			{
				dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /Helv 4 0 R >> >> /Contents 5 0 R >>"
			},
			{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
			{ dict: "<< >>", stream: new TextEncoder().encode(content) }
		],
		1
	)
}

async function openPdf(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await listbox.getByRole("option", { name }).dblclick()

	const dialog = page.getByRole("dialog").first()

	await expect(dialog.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// The first annotation asks for the author's name once (unless the account has one).
async function answerAuthor(page: Page): Promise<void> {
	const field = page.getByRole("textbox", { name: preview.previewOfficeAuthorNameLabel })

	if (await field.isVisible().catch(() => false)) {
		await field.fill("E2E Author")
		await page.getByRole("button", { name: preview.previewOfficeAuthorNameSave }).click()
	}
}

// A point of the first page, as fractions of its box.
async function pagePoint(dialog: Locator, x: number, y: number): Promise<{ x: number; y: number }> {
	const box = await dialog.getByRole("region", { name: /Page 1 of/u }).boundingBox()

	if (box === null) throw new Error("the page is not shown")

	return { x: box.x + box.width * x, y: box.y + box.height * y }
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	await page.mouse.move(from.x, from.y)
	await page.mouse.down()
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
	await page.mouse.move(to.x, to.y, { steps: 4 })
	await page.mouse.up()
}

test("annotates and comments on a PDF, and the saved file keeps it all", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-annotations", async ({ listbox, runId }) => {
		const name = `e2e-pdf-annotations-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(textPdf()) }], listbox)

		const dialog = await openPdf(page, listbox, name)

		// A rectangle (Shapes ▾ › Rectangle), dragged out: the drag that started the editor lands in it.
		await dialog.getByRole("button", { name: preview.previewPdfAnnotToolRectangle }).click()
		await drag(page, await pagePoint(dialog, 0.2, 0.4), await pagePoint(dialog, 0.4, 0.5))
		await answerAuthor(page)
		await expect(dialog.getByRole("button", { name: preview.previewPdfUndo })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })

		const square = dialog.locator('[data-annotation-type="Square"]')

		// Back to selection with the new rectangle selected: its popover.
		await expect(square).toHaveCount(1, { timeout: ENGINE_TIMEOUT_MS })

		const popover = dialog.getByRole("toolbar", { name: preview.previewPdfAnnotPopover })

		await expect(popover).toBeVisible()
		await popover.getByRole("button", { name: preview.previewPdfAnnotDelete }).click()
		await expect(square).toHaveCount(0)
		await dialog.getByRole("button", { name: preview.previewPdfUndo }).click()
		await expect(square).toHaveCount(1)

		// A text box from the keyboard: T on the page, Enter places it, Enter commits the place, then type.
		await pdfPageScroller(dialog).focus()
		await page.keyboard.press("t")
		await page.keyboard.press("Enter")
		await expect(pdfLiveRegion(dialog)).toContainText(preview.previewPdfAnnotToolTextBox)
		await page.keyboard.press("Enter")

		const editor = dialog.getByRole("textbox", { name: preview.previewPdfAnnotTextBoxEditor })

		await expect(editor).toBeFocused()
		await editor.fill("Typed from the keyboard")
		await editor.press(`${await resolveModKey(page)}+Enter`)
		await expect(dialog.locator('[data-annotation-type="FreeText"]')).toHaveCount(1, { timeout: ENGINE_TIMEOUT_MS })

		// A highlight dragged over the line of text (Highlight ▾ is the U tool).
		await pdfPageScroller(dialog).focus()
		await page.keyboard.press("u")
		await drag(page, await pagePoint(dialog, 0.11, 0.135), await pagePoint(dialog, 0.6, 0.135))
		await page.keyboard.press("v")
		await expect(dialog.locator('[data-annotation-type="Highlight"]')).toHaveCount(1, { timeout: ENGINE_TIMEOUT_MS })

		// A sticky note (C), written in the Comments panel, replied to and resolved.
		await pdfPageScroller(dialog).focus()
		await page.keyboard.press("c")
		const note = await pagePoint(dialog, 0.8, 0.2)

		await page.mouse.click(note.x, note.y)

		const panel = dialog.locator("[data-comments-pane]")
		const compose = panel.getByRole("textbox", { name: preview.previewPdfCommentPlaceholder })

		await compose.fill("Please check this page")
		await panel.getByRole("button", { name: preview.previewPdfCommentPost }).click()
		await answerAuthor(page)
		await expect(dialog.locator('[data-annotation-type="Text"]')).toHaveCount(1, { timeout: ENGINE_TIMEOUT_MS })
		await expect(panel.getByText("Please check this page")).toBeVisible()

		const reply = panel.getByRole("textbox", { name: preview.previewPdfCommentReplyPlaceholder })

		await reply.fill("Checked")
		await panel.getByRole("button", { name: preview.previewPdfCommentReply, exact: true }).click()
		await expect(panel.getByText("Checked")).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await panel.getByRole("button", { name: preview.previewPdfCommentResolve }).click()
		await expect(panel.getByRole("button", { name: preview.previewPdfCommentReopen })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })

		// Undo and Redo step the last change (the resolve).
		await dialog.getByRole("button", { name: preview.previewPdfUndo }).click()
		await expect(panel.getByRole("button", { name: preview.previewPdfCommentResolve })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await dialog.getByRole("button", { name: preview.previewPdfRedo }).click()
		await expect(panel.getByRole("button", { name: preview.previewPdfCommentReopen })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })

		await dialog.getByRole("button", { name: preview.previewPdfSave, exact: true }).click()
		await expectPdfSaved(dialog.getByRole("button", { name: preview.previewPdfSave, exact: true }), ENGINE_TIMEOUT_MS)

		// Opened again (pdf.js, before any change): every annotation is there.
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0)

		const reopened = await openPdf(page, listbox, name)

		for (const type of ["Square", "FreeText", "Highlight", "Text"]) {
			await expect(reopened.locator(`[data-annotation-type="${type}"]`)).toHaveCount(1, { timeout: LAZY_VIEWER_TIMEOUT_MS })
		}
	})

	expect(cspViolations).toEqual([])
})

test("Flatten annotations draws them into the page on save", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-annotations-flatten", async ({ listbox, runId }) => {
		const name = `e2e-pdf-flatten-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(textPdf()) }], listbox)

		const dialog = await openPdf(page, listbox, name)

		await dialog.getByRole("button", { name: preview.previewPdfAnnotToolRectangle }).click()
		await drag(page, await pagePoint(dialog, 0.2, 0.4), await pagePoint(dialog, 0.4, 0.5))
		await answerAuthor(page)
		await expect(dialog.locator('[data-annotation-type="Square"]')).toHaveCount(1, { timeout: ENGINE_TIMEOUT_MS })

		await dialog.getByRole("button", { name: preview.previewPdfSaveOptions }).click()
		await page.getByRole("menuitemcheckbox", { name: preview.previewPdfAnnotFlatten }).click()
		await page.keyboard.press("Escape")
		await dialog.getByRole("button", { name: preview.previewPdfSave, exact: true }).click()
		await expectPdfSaved(dialog.getByRole("button", { name: preview.previewPdfSave, exact: true }), ENGINE_TIMEOUT_MS)
		// Drawn into the page: no annotation left to select.
		await expect(dialog.locator('[data-annotation-type="Square"]')).toHaveCount(0)
	})
})

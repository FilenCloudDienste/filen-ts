import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { writePdf } from "../scripts/pdf-fixtures/view/pdfWriter"
import { preview } from "@/locales/en/preview"

// Page organisation in the PDF editor: the pages rail beside the document and the Organise grid of the Pages tab, by
// keyboard only (focus moves with the arrows, Shift extends the selection, Alt+arrows move it, Mod+Alt+[ rotates it,
// Delete deletes it, a polite live region says what happened), then Save makes a new version; Extract opens the pages as
// a new unsaved PDF saved beside this one (or writes one file per page at once); the crop tool crops the current page.
// Under the CSP, in every browser.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
// The engine worker compiles MuPDF (about 10 MB of wasm) on its first use.
const ENGINE_TIMEOUT_MS = 60_000

// Three pages, "Page N" on each.
function threePages(): Uint8Array {
	const pages = [1, 2, 3]

	return writePdf(
		[
			{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
			{ dict: `<< /Type /Pages /Kids [${pages.map(page => `${String(page + 3)} 0 R`).join(" ")}] /Count 3 >>` },
			{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
			...pages.map(page => ({
				dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(page + 6)} 0 R >>`
			})),
			...pages.map(page => ({
				dict: "<< >>",
				stream: new TextEncoder().encode(`BT /F1 24 Tf 72 760 Td (Page ${String(page)}) Tj ET\n`)
			}))
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

async function openOrganise(dialog: Locator): Promise<Locator> {
	await dialog.getByRole("tab", { name: preview.previewPdfTabPages }).click()
	await dialog.getByRole("button", { name: preview.previewPdfPagesOrganise }).click()

	const grid = dialog.getByRole("region", { name: preview.previewPdfPagesOrganise })

	await expect(grid.getByRole("option")).toHaveCount(3, { timeout: ENGINE_TIMEOUT_MS })

	return grid
}

test("organises pages with the keyboard alone and saves them", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-pages", async ({ listbox, runId }) => {
		const name = `e2e-pdf-pages-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(threePages()) }], listbox)

		const dialog = await openPdf(page, listbox, name)
		// The pages rail beside the document opens from the Pages tab (closed until asked) and shows every page.
		const rail = dialog.getByRole("listbox", { name: preview.previewPdfPagesRailLabel }).first()

		await expect(rail).toHaveCount(0)
		await dialog.getByRole("tab", { name: preview.previewPdfTabPages }).click()
		await dialog.getByRole("button", { name: preview.previewPdfPagesRailToggle }).click()
		await expect(rail.getByRole("option")).toHaveCount(3)

		const grid = await openOrganise(dialog)
		const options = grid.getByRole("option")
		const live = grid.locator("[aria-live=polite]")

		// Keyboard only: the first page has focus; Alt+Right moves it after the second.
		await options.first().focus()
		await page.keyboard.press("Alt+ArrowRight")
		await expect(live).toHaveText("Page 1 moved to position 2", { timeout: ENGINE_TIMEOUT_MS })
		await expect(options.nth(1)).toBeFocused()

		// Shift+Right extends the selection to the third page; Mod+Alt+[ turns both a quarter left.
		await page.keyboard.press("Shift+ArrowRight")
		await expect(options.nth(1)).toHaveAttribute("aria-selected", "true")
		await expect(options.nth(2)).toHaveAttribute("aria-selected", "true")
		await page.keyboard.press("ControlOrMeta+Alt+BracketLeft")
		await expect(live).toHaveText("2 pages rotated")

		// Delete deletes the selection; every page cannot go.
		await page.keyboard.press("Delete")
		await expect(live).toHaveText("2 pages deleted")
		await expect(options).toHaveCount(1)
		await page.keyboard.press("Delete")
		await expect(page.getByText(preview.previewPdfPagesLastPage)).toBeVisible()
		await expect(options).toHaveCount(1)

		// Undo brings the pages back.
		await dialog.getByRole("button", { name: preview.previewPdfUndo }).click()
		await expect(options).toHaveCount(3)
		await grid.getByRole("button", { name: preview.previewPdfPagesOrganiseDone }).click()

		await dialog.getByRole("button", { name: preview.previewPdfSave, exact: true }).click()
		await expect(dialog.getByRole("button", { name: preview.previewPdfSave, exact: true })).toBeDisabled({ timeout: ENGINE_TIMEOUT_MS })
		// A save after a delete: the earlier versions still hold the deleted pages (the warning shows only for removals
		// left in the document; the undo restored them here, so none is due).
		await expect(dialog.getByText(preview.previewPdfEarlierVersions)).toHaveCount(0)
	})

	expect(cspViolations).toEqual([])
})

test("extracts pages as a new unsaved PDF, saved beside this one, and deletes them only once it is", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-pages-draft", async ({ listbox, runId }) => {
		const name = `e2e-pdf-draft-${runId}.pdf`
		const base = name.slice(0, -".pdf".length)
		const draftName = `${base} (pages 2-3).pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(threePages()) }], listbox)

		const dialog = await openPdf(page, listbox, name)
		const extractPages = async (range: string, deleteAfter: boolean): Promise<Locator> => {
			await dialog.getByRole("tab", { name: preview.previewPdfTabPages }).click()
			await dialog.getByRole("button", { name: preview.previewPdfPagesExtract }).click()

			const extract = page.getByRole("dialog", { name: preview.previewPdfExtractTitle })

			await extract.getByRole("textbox", { name: preview.previewPdfExtractRangeLabel }).fill(range)

			if (deleteAfter) await extract.getByRole("switch", { name: preview.previewPdfExtractDelete }).click()

			await extract.getByRole("button", { name: preview.previewPdfExtractSubmit }).click()
			await expect(extract).toBeHidden({ timeout: ENGINE_TIMEOUT_MS })

			return page.getByRole("dialog", { name: range === "1" ? `${base} (page 1).pdf` : draftName })
		}

		// Dropped: closing the new PDF asks first; discarding it leaves every page and makes no file.
		const dropped = await extractPages("1", true)

		await expect(dropped.getByText(preview.previewPdfDraftUnsaved)).toBeVisible()
		await expect(dropped.getByRole("region", { name: /Page 1 of 1$/u })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await dropped.getByRole("button", { name: "Close" }).first().click()

		const confirm = page.getByRole("alertdialog", { name: preview.previewPdfDraftDiscardTitle })

		await confirm.getByRole("button", { name: preview.previewPdfDiscardConfirm }).click()
		await expect(dropped).toBeHidden()
		await expect(dialog.getByRole("region", { name: /Page 1 of 3$/u })).toBeVisible()

		// Saved: the new PDF opens with the extracted pages, is saved beside this one, and only then do they go from it.
		const draft = await extractPages("2-3", true)

		await expect(draft.getByRole("region", { name: /Page 1 of 2$/u })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await draft.getByRole("button", { name: preview.previewPdfSave, exact: true }).click()
		await expect(draft).toBeHidden({ timeout: ENGINE_TIMEOUT_MS })
		await expect(page.getByText(`Saved ${draftName}`)).toBeVisible()
		await expect(dialog.getByRole("region", { name: /Page 1 of 1$/u })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })

		// The PDF itself now has a change of its own to save or discard.
		await page.keyboard.press("Escape")
		await page
			.getByRole("alertdialog", { name: preview.previewUnsavedChangesTitle })
			.getByRole("button", { name: /Discard/u })
			.click()
		await expect(listbox.getByRole("option", { name: draftName })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await expect(listbox.getByRole("option", { name: `${base} (page 1).pdf` })).toHaveCount(0)
	})
})

test("extracts one file per page straight away, beside the PDF", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-pages-extract", async ({ listbox, runId }) => {
		const name = `e2e-pdf-extract-${runId}.pdf`
		const base = name.slice(0, -".pdf".length)

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(threePages()) }], listbox)

		const dialog = await openPdf(page, listbox, name)

		await dialog.getByRole("tab", { name: preview.previewPdfTabPages }).click()
		await dialog.getByRole("button", { name: preview.previewPdfPagesExtract }).click()

		const extract = page.getByRole("dialog", { name: preview.previewPdfExtractTitle })

		await extract.getByRole("textbox", { name: preview.previewPdfExtractRangeLabel }).fill("1-2")
		await extract.getByRole("switch", { name: preview.previewPdfExtractSeparate }).click()
		await extract.getByRole("button", { name: preview.previewPdfExtractSubmit }).click()
		await expect(extract).toBeHidden({ timeout: ENGINE_TIMEOUT_MS })
		await page.keyboard.press("Escape")
		await expect(listbox.getByRole("option", { name: `${base} (page 1).pdf` })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await expect(listbox.getByRole("option", { name: `${base} (page 2).pdf` })).toBeVisible()
	})
})

test("crops the current page with the handles", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-pages-crop", async ({ listbox, runId }) => {
		const name = `e2e-pdf-crop-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(threePages()) }], listbox)

		const dialog = await openPdf(page, listbox, name)

		await dialog.getByRole("tab", { name: preview.previewPdfTabTools }).click()
		await dialog.getByRole("button", { name: preview.previewPdfCrop }).click()

		// Keyboard placement: the left edge moves right by 30 points (Shift steps 10), Enter crops this page.
		const left = dialog.getByRole("button", { name: preview.previewPdfCropHandleLeft })

		await left.focus()

		for (let step = 0; step < 3; step++) await page.keyboard.press("Shift+ArrowRight")

		await expect(dialog.getByText(/^Crop 565 by 842 points/)).toBeAttached()
		await page.keyboard.press("Enter")
		await expect(dialog.getByRole("button", { name: preview.previewPdfUndo })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		await expect(dialog.getByRole("toolbar", { name: preview.previewPdfCrop })).toBeHidden()
	})
})

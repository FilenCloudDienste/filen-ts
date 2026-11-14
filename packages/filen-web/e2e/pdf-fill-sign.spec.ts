import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { resolveModKey } from "./helpers/modkey"
import { preview } from "@/locales/en/preview"
import { settings } from "@/locales/en/settings"

// Fill & Sign in a real browser: text and marks placed on a page (by pointer and by keyboard), a signature drawn with
// the pointer (and touch on the mobile WebKit viewport), saved for reuse and offered again in the next document,
// initials typed, and the saved signature deleted in Settings › Office. The saved file is read back by pdf.js. Fixture: @filen/office's
// acroform.pdf (src/scripts/pdfFormFixtures.ts).

test.describe.configure({ mode: "default" })

const FIXTURE = new URL("../../filen-office/src/tests/fixtures/pdfforms/acroform.pdf", import.meta.url)
const PDF_MIME = "application/pdf"
const SWAP_TIMEOUT_MS = 60_000

async function open(page: Page, listbox: Locator, name: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(page.locator("canvas").first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function close(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.locator("canvas")).toHaveCount(0)
}

async function downloaded(page: Page): Promise<Buffer> {
	const downloading = page.waitForEvent("download")

	await page.getByRole("button", { name: preview.previewDownloadAction, exact: true }).click()

	return readFileSync(await (await downloading).path())
}

// Annotation subtypes per page, as pdf.js reads them.
async function annotationTypes(bytes: Buffer): Promise<string[][]> {
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
	const pdf = await task.promise
	const pages: string[][] = []

	for (let index = 1; index <= pdf.numPages; index++) {
		const annotations = (await (await pdf.getPage(index)).getAnnotations()) as { subtype: string }[]

		pages.push(annotations.map(annotation => annotation.subtype).filter(subtype => subtype !== "Widget"))
	}

	await task.destroy()

	return pages
}

// A signature-like scribble across the drawing area, with the mouse or (on a touch viewport) a finger.
async function scribble(page: Page, pad: Locator): Promise<void> {
	const box = await pad.boundingBox()

	if (box === null) throw new Error("drawing area not laid out")

	const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy]
	const points = [at(0.1, 0.6), at(0.25, 0.3), at(0.4, 0.7), at(0.55, 0.3), at(0.7, 0.7), at(0.9, 0.4)]
	const [startX, startY] = points[0] ?? at(0, 0)

	await page.mouse.move(startX, startY)
	await page.mouse.down()

	for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 6 })

	await page.mouse.up()
}

function fillSignTab(page: Page): Locator {
	return page.getByRole("tab", { name: "Fill & Sign" })
}

test("Fill & Sign: text, marks and a drawn signature are saved; the signature is offered again and deletable", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "pdf-fill-sign", async ({ listbox, runId }) => {
		const first = `e2e-${runId}-first.pdf`
		const second = `e2e-${runId}-second.pdf`

		await uploadFiles(
			page,
			[
				{ name: first, mimeType: PDF_MIME, buffer: readFileSync(FIXTURE) },
				{ name: second, mimeType: PDF_MIME, buffer: readFileSync(FIXTURE) }
			],
			listbox
		)

		await open(page, listbox, first)
		await fillSignTab(page).click()

		// While a Fill & Sign tool is active each page is a surface to place on.
		const pageSurface = page.getByRole("application", { name: preview.previewPdfFillPlaceOnPage.replace("{{page}}", "2") })

		await page.getByRole("button", { name: preview.previewPdfFillText }).click()
		await pageSurface.click({ position: { x: 300, y: 120 }, timeout: SWAP_TIMEOUT_MS })
		await page.getByRole("textbox", { name: preview.previewPdfFillTextLabel }).fill("Signed in Berlin")
		await page.keyboard.press("Enter")
		await page.getByRole("button", { name: preview.previewPdfFillCheck }).click()
		await pageSurface.click({ position: { x: 120, y: 220 } })

		// A cross placed from the keyboard: Enter puts it at the page's centre, arrows move it, Enter places it.
		await page.getByRole("button", { name: preview.previewPdfFillCross }).click()
		await pageSurface.focus()
		await page.keyboard.press("Enter")
		await page.keyboard.press("Shift+ArrowRight")
		await page.keyboard.press("Enter")

		// A drawn signature, saved for reuse.
		await page.getByRole("button", { name: preview.previewPdfFillSignature }).click()

		const dialog = page.getByRole("dialog", { name: preview.previewPdfSignatureDialogTitle })
		const pad = dialog.getByRole("img", { name: preview.previewPdfSignaturePad })

		await scribble(page, pad)
		await expect(pad).toHaveAttribute("data-strokes", "1")
		await dialog.getByRole("button", { name: preview.previewPdfSignatureUndoStroke }).click()
		await expect(pad).toHaveAttribute("data-strokes", "0")
		await scribble(page, pad)
		await expect(dialog.getByLabel(preview.previewPdfSignatureSaveForReuse)).toBeChecked()
		await dialog.getByRole("button", { name: preview.previewPdfSignaturePlace }).click()
		await expect(dialog).toHaveCount(0)
		await pageSurface.click({ position: { x: 200, y: 350 }, timeout: SWAP_TIMEOUT_MS })

		// Initials typed.
		await page.getByRole("button", { name: preview.previewPdfFillInitials }).click()

		const initials = page.getByRole("dialog", { name: preview.previewPdfInitialsDialogTitle })

		await initials.getByRole("tab", { name: preview.previewPdfSignatureType }).click()
		await initials.getByLabel(preview.previewPdfInitialsTypeLabel).fill("JD")
		await initials.getByLabel(preview.previewPdfSignatureSaveForReuse).uncheck()
		await initials.getByRole("button", { name: preview.previewPdfSignaturePlace }).click()
		await pageSurface.click({ position: { x: 120, y: 470 } })

		await page.keyboard.press(`${mod}+s`)
		await expect(page.getByRole("button", { name: preview.previewSaveAction, exact: true })).toBeDisabled({
			timeout: LIVE_WRITE_TIMEOUT_MS
		})

		const types = await annotationTypes(await downloaded(page))

		expect(types[1]).toEqual(expect.arrayContaining(["FreeText", "Ink", "Stamp"]))
		// The text, the check mark, the cross and the drawn signature.
		expect(types[1]?.filter(type => type === "Ink").length).toBe(3)
		await close(page)

		// The next document offers the saved signature first.
		await open(page, listbox, second)
		await fillSignTab(page).click()
		await page.getByRole("button", { name: preview.previewPdfFillSignature }).click()

		const again = page.getByRole("dialog", { name: preview.previewPdfSignatureDialogTitle })

		await expect(again.getByRole("button", { name: "Saved signature 1" })).toHaveAttribute("aria-pressed", "true")
		await page.keyboard.press("Escape")
		await close(page)
	})

	// Settings › Office: the saved signature is listed and deleted everywhere.
	await page.goto("/settings/office")
	await expect(page.getByText(settings.settingsOfficePdfSavingNote)).toBeVisible()
	await page.getByRole("button", { name: settings.settingsOfficeSavedSignatures }).click()
	await page.getByRole("button", { name: "Delete signature 1" }).click()
	await expect(page.getByText(settings.settingsOfficeSavedSignaturesNone)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

	expect(cspViolations).toEqual([])
})

test("the signature pad draws with touch on a phone viewport", async ({ page, browserName }) => {
	test.skip(browserName !== "webkit", "touch drawing is checked on mobile WebKit")

	await page.setViewportSize({ width: 390, height: 844 })

	await withScratchDirectory(page, "pdf-fill-sign-touch", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-touch.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: readFileSync(FIXTURE) }], listbox)
		await open(page, listbox, name)
		await fillSignTab(page).click()
		await page.getByRole("button", { name: preview.previewPdfFillSignature }).click()

		const pad = page.getByRole("img", { name: preview.previewPdfSignaturePad })
		const box = await pad.boundingBox()

		if (box === null) throw new Error("drawing area not laid out")

		// A one-finger stroke as pointer events of type "touch" (what the pad reads).
		await pad.dispatchEvent("pointerdown", {
			pointerId: 7,
			pointerType: "touch",
			isPrimary: true,
			clientX: box.x + 20,
			clientY: box.y + 40
		})

		for (let step = 1; step <= 10; step++) {
			await pad.dispatchEvent("pointermove", {
				pointerId: 7,
				pointerType: "touch",
				clientX: box.x + 20 + step * 20,
				clientY: box.y + 40 + (step % 2) * 30
			})
		}

		await pad.dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch" })
		await expect(pad).toHaveAttribute("data-strokes", "1")
		await page.keyboard.press("Escape")
		await close(page)
	})
})

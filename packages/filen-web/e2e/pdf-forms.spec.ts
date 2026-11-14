import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { resolveModKey } from "./helpers/modkey"
import { preview } from "@/locales/en/preview"

// PDF forms in a real browser: every AcroForm widget type filled through the overlay, saved as a new version and read
// back by another parser; the overlay never offers a credential field (a document's "password" field is masked
// read-only text that refuses typing and is never written, autocomplete off, no document-chosen name, no <form>);
// scripts and XFA notices say what does not work. Fixtures are @filen/office's (src/scripts/pdfFormFixtures.ts).

test.describe.configure({ mode: "default" })

const FIXTURES = new URL("../../filen-office/src/tests/fixtures/pdfforms/", import.meta.url)
const PDF_MIME = "application/pdf"
// The first edit swaps in the editor engine (≈10 MB of wasm on a cold cache).
const SWAP_TIMEOUT_MS = 60_000

const fixture = (name: string): Buffer => readFileSync(new URL(name, FIXTURES))

async function open(page: Page, listbox: Locator, name: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(page.locator("canvas").first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function close(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.locator("canvas")).toHaveCount(0)
}

// The saved file as the preview downloads it.
async function downloaded(page: Page): Promise<Buffer> {
	const downloading = page.waitForEvent("download")

	await page.getByRole("button", { name: preview.previewDownloadAction, exact: true }).click()

	return readFileSync(await (await downloading).path())
}

// Each field's value as pdf.js reads it.
async function fieldValues(bytes: Buffer): Promise<Map<string, unknown[]>> {
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
	const pdf = await task.promise
	const values = new Map<string, unknown[]>()

	for (let index = 1; index <= pdf.numPages; index++) {
		for (const annotation of (await (await pdf.getPage(index)).getAnnotations()) as { fieldName?: string; fieldValue?: unknown }[]) {
			if (annotation.fieldName !== undefined)
				values.set(annotation.fieldName, [...(values.get(annotation.fieldName) ?? []), annotation.fieldValue])
		}
	}

	await task.destroy()

	return values
}

test("a PDF form: every field type filled, saved and read back; the overlay is never a credential form", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "pdf-forms", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-form.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: fixture("acroform.pdf") }], listbox)
		await open(page, listbox, name)
		await expect(page.getByText(preview.previewPdfFormBanner)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		const fullName = page.getByRole("textbox", { name: "Full name" })

		await fullName.fill("Jane Doe")
		await expect(fullName).toHaveValue("Jane Doe", { timeout: SWAP_TIMEOUT_MS })

		// The document's password field: masked text, nothing a password manager would offer a login to, and never
		// filled (its value would be written into the file): typing says so.
		const password = page.getByRole("textbox", { name: "Password" })

		await expect(password).toHaveAttribute("type", "text")
		await expect(password).toHaveAttribute("autocomplete", "off")
		await expect(password).toHaveAttribute("data-1p-ignore", "true")
		await expect(password).toHaveAttribute("readonly", "")
		await expect(password).not.toHaveAttribute("name", "password")
		await expect(page.locator("form")).toHaveCount(0)
		await expect(page.locator('[name="password"], #password, input[type="password"]')).toHaveCount(0)
		await password.press("s")
		await expect(page.getByText(preview.previewPdfFormPassword)).toBeVisible()

		await page.getByRole("textbox", { name: "Code" }).fill("AB12CD99")
		await page.getByRole("textbox", { name: "Postal code" }).fill("12345678")
		await page.getByRole("textbox", { name: "Notes" }).fill("line one\nline two")
		await page.getByRole("checkbox", { name: "I agree" }).check()
		await page.getByRole("combobox", { name: "Country" }).selectOption("France")
		// An editable combo box takes its own text.
		await page.getByRole("combobox", { name: "City" }).fill("Hamburg")
		await page.getByRole("listbox", { name: "Toppings" }).selectOption(["Cheese", "Olives"])
		await expect(page.getByRole("textbox", { name: "Read-only" })).toHaveAttribute("readonly", "")

		// The radio group spans both pages: choosing on page 2 unchecks page 1's button.
		const radios = page.getByRole("radio", { name: "Choice" })

		await radios.nth(1).check()
		await expect(radios.nth(0)).not.toBeChecked()

		await page.keyboard.press(`${mod}+s`)
		// The required field was left empty: said, and saved anyway.
		await expect(page.getByText(preview.previewPdfFormRequiredEmpty_one.replace("{{count}}", "1"))).toBeVisible()
		await expect(page.getByRole("textbox", { name: "Required" })).toHaveAttribute("aria-invalid", "true")
		await expect(page.getByRole("button", { name: preview.previewSaveAction, exact: true })).toBeDisabled({
			timeout: LIVE_WRITE_TIMEOUT_MS
		})

		const values = await fieldValues(await downloaded(page))

		expect(values.get("name")).toEqual(["Jane Doe"])
		expect(values.get("password")).toEqual([""])
		expect(values.get("code")).toEqual(["AB12CD"])
		expect(values.get("zip")).toEqual(["12345"])
		expect(values.get("agree")).toEqual(["Yes"])
		expect(values.get("choice")).toEqual(["B", "B"])
		expect(values.get("country")).toEqual([["France"]])
		expect(values.get("city")).toEqual([["Hamburg"]])
		expect(values.get("toppings")).toEqual([["Cheese", "Olives"]])
		await close(page)
	})

	expect(cspViolations).toEqual([])
})

test("forms with scripts or XFA say what doesn't work here", async ({ page }) => {
	test.slow()

	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "pdf-forms-limits", async ({ listbox, runId }) => {
		const names = { calculated: `e2e-${runId}-calculated.pdf`, hybrid: `e2e-${runId}-hybrid.pdf`, xfa: `e2e-${runId}-xfa.pdf` }

		await uploadFiles(
			page,
			[
				{ name: names.calculated, mimeType: PDF_MIME, buffer: fixture("calculated.pdf") },
				{ name: names.hybrid, mimeType: PDF_MIME, buffer: fixture("hybrid-xfa.pdf") },
				{ name: names.xfa, mimeType: PDF_MIME, buffer: fixture("xfa-only.pdf") }
			],
			listbox
		)

		await open(page, listbox, names.calculated)
		await page.getByRole("textbox", { name: "First number" }).fill("2")
		await expect(page.getByText(preview.previewPdfScripts)).toBeVisible({ timeout: SWAP_TIMEOUT_MS })
		await close(page)

		await open(page, listbox, names.xfa)
		await expect(page.getByText(preview.previewPdfXfaOnly)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await close(page)

		// A hybrid form is filled through its AcroForm; the first save asks before dropping the XFA data.
		await open(page, listbox, names.hybrid)
		await page.getByRole("textbox", { name: "Full name" }).fill("From AcroForm")
		await page.keyboard.press(`${mod}+s`)

		const confirm = page.getByRole("alertdialog", { name: preview.previewPdfFormXfaSaveTitle })

		await expect(confirm.getByText(preview.previewPdfFormXfaSaveBody)).toBeVisible()
		await confirm.getByRole("button", { name: preview.previewPdfFormXfaSave, exact: true }).click()
		await expect(confirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		const values = await fieldValues(await downloaded(page))

		expect(values.get("name")).toEqual(["From AcroForm"])
		await close(page)
	})
})

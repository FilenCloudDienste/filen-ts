import { readFileSync } from "node:fs"
import * as mupdf from "mupdf"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { assistantRequests, scriptAssistant } from "./helpers/assistant"
import { preview } from "@/locales/en/preview"

// The assistant's PDF form fill over the scripted model (helpers/assistant.ts): the form banner opens the side panel for
// the page in view, the details matched to the page's labelled empty fields (values the details hold only), the values
// ghosted in their fields, then Fill N fields writes them as one undo step. A widget the document hides (its Hidden
// flag) is never offered, so nothing reaches it unseen. Write lane: the form is uploaded into the test's own scratch
// directory. Fixture: @filen/office's acroform.pdf, its "zip" widget hidden here.
test.describe.configure({ mode: "default" })

const FIXTURE = new URL("../../filen-office/src/tests/fixtures/pdfforms/acroform.pdf", import.meta.url)
const PDF_MIME = "application/pdf"
// The fill starts the editor engine (≈10 MB of wasm on a cold cache).
const SWAP_TIMEOUT_MS = 60_000
const DETAILS = "Jane Doe, 12345 Berlin"

// acroform.pdf with its "Postal code" widget flagged Hidden (annotation flag 1 << 1).
function formWithHiddenField(): Buffer {
	const document = new mupdf.PDFDocument(readFileSync(FIXTURE))

	try {
		const page = document.loadPage(0)
		const zip = page.getWidgets().find(widget => widget.getName() === "zip")

		if (zip === undefined) {
			throw new Error("no zip widget")
		}

		zip.setFlags(zip.getFlags() | (1 << 1))
		page.destroy()

		return Buffer.from(document.saveToBuffer("compress").asUint8Array())
	} finally {
		document.destroy()
	}
}

test("the form fill panel fills the page's labelled fields from the details as one undo step, never a hidden one", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "assistant-form-fill", async ({ listbox, runId }) => {
		const name = `e2e-assistant-form-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: formWithHiddenField() }], listbox)
		await scriptAssistant(page, { form: { "Full name": "Jane Doe", City: "Berlin", "Postal code": "12345" } })
		await listbox.getByRole("option", { name }).dblclick()
		await expect(page.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(page.getByText(preview.previewPdfFormBanner)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		// The hidden widget has no control on the page.
		await expect(page.getByRole("textbox", { name: "Postal code" })).toHaveCount(0)

		await page.getByRole("button", { name: preview.previewPdfFormBannerFill }).click()

		const panel = page.getByRole("complementary", { name: "Fill page 1", exact: true })

		await panel.getByRole("textbox", { name: preview.previewPdfFormFillDetails }).fill(DETAILS)
		await panel.getByRole("button", { name: preview.previewPdfFormFillRun, exact: true }).click()
		await expect(panel.getByText("Will fill (2)")).toBeVisible()
		// The values show ghosted in their fields until they are filled.
		await expect(page.locator("[data-assistant-form-fill-preview]")).toHaveCount(2)

		const asked = (await assistantRequests(page)).filter(request => request.kind === "form").at(-1)

		expect(asked?.last).toContain("Full name")
		expect(asked?.last).not.toContain("Postal code")

		await panel.getByRole("button", { name: "Fill 2 fields", exact: true }).click()
		await expect(panel).toHaveCount(0, { timeout: SWAP_TIMEOUT_MS })

		const fullName = page.getByRole("textbox", { name: "Full name" })
		// City is an editable combo box in the fixture (pdf-forms.spec.ts types into it).
		const city = page.getByRole("combobox", { name: "City" })

		await expect(fullName).toHaveValue("Jane Doe", { timeout: SWAP_TIMEOUT_MS })
		await expect(city).toHaveValue("Berlin")

		// One undo step clears them all.
		await page.getByRole("button", { name: preview.previewPdfUndo, exact: true }).click()
		await expect(fullName).toHaveValue("")
		await expect(city).toHaveValue("")
	})
	expect(cspViolations).toEqual([])
})

import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { preview } from "@/locales/en/preview"

// Signed PDFs in a real browser: the one-line signature status for each state (unchanged, changed in allowed and
// disallowed ways, invalid, can't verify), the Signatures dialog's honest wording, View signed version, and nothing
// at all for an unsigned file. The fixtures are @filen/office's, signed by OpenSSL (src/scripts/pdfSignFixtures.ts).

test.describe.configure({ mode: "default" })

const FIXTURES = new URL("../../filen-office/src/tests/fixtures/pdfsign/", import.meta.url)
const PDF_MIME = "application/pdf"
// The engine worker compiles MuPDF (≈10 MB of wasm) on the first check.
const CHECK_TIMEOUT_MS = 60_000

const fixture = (name: string): Buffer => readFileSync(new URL(name, FIXTURES))

// The banner keys' text up to the first interpolation, enough to tell the states apart.
const lead = (text: string): string => (text.split("{{")[0] ?? text).trim()

function status(page: Page): Locator {
	return page.getByRole("status").filter({ has: page.getByRole("button", { name: preview.previewPdfSignatureDetails, exact: true }) })
}

async function open(page: Page, listbox: Locator, name: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(page.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function close(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("region", { name: /Page 1 of/u })).toHaveCount(0)
}

test("signed PDFs: the signature status says what was checked, never more", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-verify", async ({ listbox, runId }) => {
		const names = {
			unchanged: `e2e-${runId}-approval.pdf`,
			allowed: `e2e-${runId}-filled.pdf`,
			disallowed: `e2e-${runId}-changed.pdf`,
			invalid: `e2e-${runId}-tampered.pdf`,
			unverifiable: `e2e-${runId}-brainpool.pdf`,
			unsigned: `e2e-${runId}-unsigned.pdf`
		}

		await uploadFiles(
			page,
			[
				{ name: names.unchanged, mimeType: PDF_MIME, buffer: fixture("approval-rsa.pdf") },
				{ name: names.allowed, mimeType: PDF_MIME, buffer: fixture("approval-filled.pdf") },
				{ name: names.disallowed, mimeType: PDF_MIME, buffer: fixture("approval-content-changed.pdf") },
				{ name: names.invalid, mimeType: PDF_MIME, buffer: fixture("tampered-in-range.pdf") },
				{ name: names.unverifiable, mimeType: PDF_MIME, buffer: fixture("approval-brainpool.pdf") },
				{ name: names.unsigned, mimeType: PDF_MIME, buffer: fixture("unsigned.pdf") }
			],
			listbox
		)

		// Unchanged: the exact wording, and the dialog's caveats.
		await open(page, listbox, names.unchanged)
		await expect(status(page)).toContainText(lead(preview.previewPdfSignatureBannerUnchanged), { timeout: CHECK_TIMEOUT_MS })
		await expect(status(page)).toContainText("unchanged since signing · signer not verified")
		await status(page).getByRole("button", { name: preview.previewPdfSignatureDetails, exact: true }).click()

		const dialog = page.getByRole("dialog", { name: preview.previewPdfSignaturesTitle })

		await expect(dialog.getByText(preview.previewPdfSignatureSignerNotVerified, { exact: true })).toBeVisible()
		await expect(dialog.getByText(/Time stated by the signer: .*This isn't a trusted timestamp\./)).toBeVisible()
		await expect(dialog.getByText(preview.previewPdfSignatureStateUnchanged, { exact: false })).toBeVisible()
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
		await close(page)

		// Changed in allowed ways, with the signed version one click away.
		await open(page, listbox, names.allowed)
		await expect(status(page)).toContainText("changed after signing, in ways the signer allowed", { timeout: CHECK_TIMEOUT_MS })
		await close(page)

		await open(page, listbox, names.disallowed)
		await expect(status(page)).toContainText("in ways the signer didn't allow", { timeout: CHECK_TIMEOUT_MS })
		await close(page)

		await open(page, listbox, names.invalid)
		await expect(status(page)).toContainText(preview.previewPdfSignatureInvalidDigest, { timeout: CHECK_TIMEOUT_MS })
		await close(page)

		await open(page, listbox, names.unverifiable)
		await expect(status(page)).toContainText(preview.previewPdfSignatureUnverifiableAlgorithm, { timeout: CHECK_TIMEOUT_MS })
		await close(page)

		// Unsigned: no status line at all.
		await open(page, listbox, names.unsigned)
		await expect(page.getByText(preview.previewPdfSignatureChecking)).toHaveCount(0)
		await expect(status(page)).toHaveCount(0)
		await close(page)
	})

	expect(cspViolations).toEqual([])
})

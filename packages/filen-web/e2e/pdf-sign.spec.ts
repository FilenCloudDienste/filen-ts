import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { preview } from "@/locales/en/preview"

// Protect › Sign with certificate: a .p12 from the device unlocks in the signer worker, the signature is dragged onto
// the page, and the save signs it as its last step (checked unchanged before upload). The signature status line then
// shows the new signature; a second signature (another certificate, a legacy 3DES container) keeps the first as
// changed in allowed ways. Signing nothing but the placement never leaves a placeholder: cancelling removes it.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
const SIGN_TIMEOUT_MS = 90_000
const FIXTURES = new URL("../../filen-office/src/tests/fixtures/pdfsign/", import.meta.url)
const fixture = (name: string): Buffer => readFileSync(new URL(name, FIXTURES))
const P12_PASSWORD = "fixture-password"

async function open(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(page.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return page.getByRole("region", { name: /Page 1 of/u })
}

// Signs with `p12`, dragging the signature over the page's box from `from` to `to` (fractions of the page).
async function sign(page: Page, surface: Locator, p12: string, from: [number, number], to: [number, number]): Promise<void> {
	await page.getByRole("tab", { name: preview.previewPdfTabProtect }).click()
	await page.getByRole("button", { name: preview.previewPdfSigningTool }).click()

	const dialog = page.getByRole("dialog", { name: preview.previewPdfSigningTitle })

	await expect(dialog).toBeVisible({ timeout: SIGN_TIMEOUT_MS })
	await dialog.locator('input[type="file"]').setInputFiles({
		name: `${p12}.p12`,
		mimeType: "application/x-pkcs12",
		buffer: fixture(`p12/${p12}.p12`)
	})
	await dialog.getByLabel(preview.previewPdfSigningPassword).fill(P12_PASSWORD)
	await dialog.getByRole("button", { name: preview.previewPdfSigningUnlock }).click()
	await dialog.getByRole("combobox", { name: preview.previewPdfSigningAppearance }).click()
	await page.getByRole("option", { name: preview.previewPdfSigningAppearanceDetails }).click()
	await dialog.getByRole("button", { name: preview.previewPdfSigningPlace }).click()
	await expect(page.getByText(preview.previewPdfSigningPlaceHint)).toBeVisible()

	const box = await surface.boundingBox()

	if (box === null) throw new Error("page not laid out")

	await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
	await page.mouse.down()
	await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 })
	await page.mouse.up()
	await expect(page.getByText(preview.previewPdfSigningSigned)).toBeVisible({ timeout: SIGN_TIMEOUT_MS })
}

test("a certificate signature is placed, signed on save and shown; a second keeps the first", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-sign", async ({ listbox, runId }) => {
		const name = `e2e-pdf-sign-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: fixture("unsigned.pdf") }], listbox)

		const surface = await open(page, listbox, name)
		const status = page.locator('[role="status"][data-state]')

		await sign(page, surface, "rsa2048", [0.5, 0.75], [0.85, 0.85])
		await expect(status).toHaveAttribute("data-state", "unchanged", { timeout: SIGN_TIMEOUT_MS })
		await expect(status).toContainText("rsa2048 signer")

		await sign(page, surface, "legacy-3des", [0.1, 0.75], [0.45, 0.85])
		// The first signature now has a later revision its signer allowed (another signature): the line says so.
		await expect(status).toHaveAttribute("data-state", "changedAllowed", { timeout: SIGN_TIMEOUT_MS })
		await status.getByRole("button", { name: preview.previewPdfSignatureDetails }).click()
		await expect(page.getByRole("dialog").getByText("legacy-3des signer").first()).toBeVisible()
	})

	expect(cspViolations).toEqual([])
})

test("cancelling the placement signs and saves nothing", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "pdf-sign-cancel", async ({ listbox, runId }) => {
		const name = `e2e-pdf-sign-cancel-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: fixture("unsigned.pdf") }], listbox)
		await open(page, listbox, name)
		await page.getByRole("tab", { name: preview.previewPdfTabProtect }).click()
		await page.getByRole("button", { name: preview.previewPdfSigningTool }).click()

		const dialog = page.getByRole("dialog", { name: preview.previewPdfSigningTitle })

		await dialog.locator('input[type="file"]').setInputFiles({
			name: "p256.p12",
			mimeType: "application/x-pkcs12",
			buffer: fixture("p12/p256.p12")
		})
		await dialog.getByLabel(preview.previewPdfSigningPassword).fill(P12_PASSWORD)
		await dialog.getByRole("button", { name: preview.previewPdfSigningUnlock }).click()
		await dialog.getByRole("combobox", { name: preview.previewPdfSigningAppearance }).click()
		await page.getByRole("option", { name: preview.previewPdfSigningAppearanceNameDate }).click()
		await dialog.getByRole("button", { name: preview.previewPdfSigningPlace }).click()
		await page.getByRole("button", { name: preview.previewPdfSigningPlaceCancel }).click()
		await expect(page.getByText(preview.previewPdfSigningPlaceHint)).toHaveCount(0)
		await expect(page.locator('[role="status"][data-state]')).toHaveCount(0)
		await expect(page.getByRole("button", { name: preview.previewPdfSave, exact: true })).toBeDisabled()
	})
})

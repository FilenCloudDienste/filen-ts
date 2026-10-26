import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { DOCX_MIME } from "./helpers/docxFixtures"
import { ENCRYPTED_DOCX_PASSWORD, ENCRYPTED_DOCX_TEXT, encryptedDocxBytes, rightsManagedDocxBytes } from "./helpers/docxEncryptedFixtures"
import { trackCspViolations } from "./helpers/csp"
import { storedPassword, trackPasswordCanary } from "./helpers/passwordCanary"
import { preview } from "@/locales/en/preview"

// Password-protected Word documents in a real browser: a rights-managed one refused without a prompt; an
// encrypted one asking its password (a wrong one says so), opened once given, and
// edited, saved by the idle autosave and by the user without being asked again, and reopened with the same
// password (the stored file is still encrypted). The password never reaches the console, a request or web
// storage (local, session, IndexedDB). The documents are uploaded into the test's own scratch directory (they
// are saved).

test.describe.configure({ mode: "default" })

// The password's key derivation: 100,000 SHA-512 rounds, about 3 s in WebKit on an idle machine.
const UNLOCK_TIMEOUT_MS = 60_000
// The editor's idle autosave waits 30 s after the last edit (features/office/lib/officeAutosave.ts AUTOSAVE_IDLE_MS).
const AUTOSAVE_TIMEOUT_MS = 30_000 + LIVE_WRITE_TIMEOUT_MS

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text, { exact: false }).first()
}

function passwordPrompt(page: Page): Locator {
	return page.getByRole("dialog", { name: preview.previewDocxPasswordTitle })
}

async function unlock(page: Page, password: string): Promise<void> {
	const prompt = passwordPrompt(page)
	const field = prompt.getByLabel(preview.previewDocxPasswordLabel, { exact: true })

	await expect(field).toBeFocused()
	await field.fill(password)
	await prompt.getByRole("button", { name: preview.previewDocxPasswordSubmit, exact: true }).click()
}

async function openLocked(page: Page, listbox: Locator, name: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(passwordPrompt(page)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(passwordPrompt(page).getByText(preview.previewDocxPasswordBody.replace("{{name}}", name))).toBeVisible()
}

async function openUnlocked(page: Page, listbox: Locator, name: string, text: string): Promise<void> {
	await openLocked(page, listbox, name)
	await unlock(page, ENCRYPTED_DOCX_PASSWORD)
	await expect(passwordPrompt(page)).toHaveCount(0, { timeout: UNLOCK_TIMEOUT_MS })
	await expect(pageText(page, text)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxPasswordProtected })).toBeVisible()
}

async function closePreview(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.locator(".fo-docx-page")).toHaveCount(0)
}

test("password-protected documents: refused when rights-managed, asked, unlocked, edited, saved and reopened with the password", async ({
	page
}) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const canary = trackPasswordCanary(page, ENCRYPTED_DOCX_PASSWORD)

	await withScratchDirectory(page, "docx-encrypted", async ({ listbox, runId }) => {
		const encrypted = `e2e-${runId}-encrypted.docx`
		const irm = `e2e-${runId}-irm.docx`

		await uploadFiles(
			page,
			[
				{ name: encrypted, mimeType: DOCX_MIME, buffer: await encryptedDocxBytes() },
				{ name: irm, mimeType: DOCX_MIME, buffer: await rightsManagedDocxBytes() }
			],
			listbox
		)

		// Rights management: the message, never a prompt.
		await listbox.getByRole("option", { name: irm }).dblclick()
		await expect(page.getByText(preview.previewDocxRightsManaged, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(passwordPrompt(page)).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(page.getByText(preview.previewDocxRightsManaged, { exact: true })).toHaveCount(0)

		// A wrong password: the check says so and clears the field for another try.
		await openLocked(page, listbox, encrypted)
		await unlock(page, "not the password")
		await expect(passwordPrompt(page).getByRole("alert")).toHaveText(preview.previewDocxPasswordWrong, { timeout: UNLOCK_TIMEOUT_MS })
		await expect(passwordPrompt(page).getByLabel(preview.previewDocxPasswordLabel, { exact: true })).toHaveValue("")

		// Dismissed, the lock stays with its button to ask again.
		await page.keyboard.press("Escape")
		await expect(passwordPrompt(page)).toHaveCount(0)
		await expect(page.getByText(preview.previewDocxNeedsPassword, { exact: true })).toBeVisible()
		await page.getByRole("button", { name: preview.previewDocxEnterPassword, exact: true }).click()
		await expect(passwordPrompt(page)).toBeVisible()

		await unlock(page, ENCRYPTED_DOCX_PASSWORD)
		await expect(passwordPrompt(page)).toHaveCount(0, { timeout: UNLOCK_TIMEOUT_MS })
		await expect(pageText(page, ENCRYPTED_DOCX_TEXT)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(page.getByRole("button", { name: preview.previewDocxPasswordProtected })).toBeVisible()

		const save = page.getByRole("dialog").getByRole("button", { name: preview.previewSaveAction, exact: true })

		await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({
			timeout: LAZY_VIEWER_TIMEOUT_MS
		})

		// The idle autosave seals with the session's key: nothing asked.
		await pageText(page, ENCRYPTED_DOCX_TEXT).click()
		await page.keyboard.press("End")
		await page.keyboard.type(" autosaved")
		await expect(save).toBeVisible()
		await expect(save).toHaveCount(0, { timeout: AUTOSAVE_TIMEOUT_MS })
		await expect(passwordPrompt(page)).toHaveCount(0)

		// So does a save by the user.
		// The editing area keeps focus through the save: typing goes on where it was.
		await expect(page.locator(".fo-docx-sink [role='textbox']").first()).toBeFocused()
		await page.keyboard.type(" saved")
		await save.click()
		await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(passwordPrompt(page)).toHaveCount(0)
		await closePreview(page)

		// Stored encrypted: asked again, and the edits are there.
		await openUnlocked(page, listbox, encrypted, `${ENCRYPTED_DOCX_TEXT} autosaved saved`)

		await closePreview(page)

		// Reopened, the password is asked again (none is remembered).
		await openLocked(page, listbox, encrypted)
		await page.keyboard.press("Escape")
		await expect(passwordPrompt(page)).toHaveCount(0)
		// A locked document draws no page: its message going is what shows the preview closed.
		await page.keyboard.press("Escape")
		await expect(page.getByText(preview.previewDocxNeedsPassword, { exact: true })).toHaveCount(0)

		expect(await storedPassword(page, ENCRYPTED_DOCX_PASSWORD)).toEqual([])
	})

	expect(canary.leaks).toEqual([])
	expect(cspViolations).toEqual([])
})

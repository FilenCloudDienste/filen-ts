import type { Page } from "@playwright/test"
import { test, expect } from "@playwright/test"

// SDK-free: completePasswordReset() is never called (a real call would hit the live, rate-limited
// API with a made-up token — out of budget for this suite; see auth.spec's login-budget comment).
// Visiting /reset/$token makes no network call of its own (the token is only used at submit time),
// so unlike register.spec there is nothing to intercept just to load the page.
const RESET_TOKEN = "e2e-fake-reset-token"
// Strong tier (see register.spec's tier notes) — strength only needs to clear the weak floor here,
// the specific tier isn't what this file exercises.
const VALID_PASSWORD = "Abcdef@ghi"
const TYPED_CONFIRM_PHRASE = "DELETE ALL MY DATA"

async function gotoReset(page: Page): Promise<void> {
	await page.goto(`/reset/${RESET_TOKEN}`)
	await expect(page.getByText("Reset your password")).toBeVisible()
}

async function fillValidFields(page: Page): Promise<void> {
	await page.getByLabel("Email", { exact: true }).fill("e2e-reset-form@example.com")
	await page.getByLabel("New password", { exact: true }).fill(VALID_PASSWORD)
	await page.getByLabel("Confirm new password", { exact: true }).fill(VALID_PASSWORD)
}

function submitButton(page: Page) {
	return page.getByRole("button", { name: "Reset password", exact: true })
}

test.describe("reset", { tag: "@no-sdk" }, () => {
	test("submitting without a master-keys file opens the skip-keys ceremony at stage 1", async ({ page }) => {
		await gotoReset(page)
		await fillValidFields(page)

		await expect(submitButton(page)).toBeEnabled()
		await submitButton(page).click()

		await expect(page.getByText("Continue without your master keys file?")).toBeVisible()
	})

	test("cancelling stage 1 aborts the whole chain (no fallback to a lesser warning)", async ({ page }) => {
		await gotoReset(page)
		await fillValidFields(page)
		await submitButton(page).click()

		await expect(page.getByText("Continue without your master keys file?")).toBeVisible()
		await page.getByRole("button", { name: "Cancel", exact: true }).click()

		await expect(page.getByText("Continue without your master keys file?")).toHaveCount(0)
		await expect(page.getByText("Are you sure?")).toHaveCount(0)
	})

	test("confirming advances stage1 -> stage2 -> stage3, and cancelling stage 3 still aborts the whole chain", async ({ page }) => {
		await gotoReset(page)
		await fillValidFields(page)
		await submitButton(page).click()

		await expect(page.getByText("Continue without your master keys file?")).toBeVisible()
		await page.getByRole("button", { name: "Continue", exact: true }).click()

		await expect(page.getByText("Are you sure?")).toBeVisible()
		await page.getByRole("button", { name: "Yes, I'm sure", exact: true }).click()

		await expect(page.getByText("There is no way to undo this")).toBeVisible()
		// Cancelling mid-chain (not just at stage 1) proves "any stage aborts" rather than just the
		// trivial first-stage case.
		await page.getByRole("button", { name: "Cancel", exact: true }).click()

		await expect(page.getByText("There is no way to undo this")).toHaveCount(0)
		await expect(page.getByText("Type to confirm")).toHaveCount(0)

		// Re-submitting starts over at stage 1 — no partial progress survives an abort.
		await submitButton(page).click()
		await expect(page.getByText("Continue without your master keys file?")).toBeVisible()
	})

	test("stage 4 arms only on the exact typed phrase and disarms on a near-miss", async ({ page }) => {
		await gotoReset(page)
		await fillValidFields(page)
		await submitButton(page).click()
		await page.getByRole("button", { name: "Continue", exact: true }).click()
		await page.getByRole("button", { name: "Yes, I'm sure", exact: true }).click()
		await page.getByRole("button", { name: "I understand", exact: true }).click()

		await expect(page.getByText("Type to confirm")).toBeVisible()

		const confirm = page.getByRole("button", { name: "Reset password and delete my data", exact: true })
		const phrase = page.getByLabel("Confirmation phrase", { exact: true })

		await expect(confirm).toBeDisabled()

		await phrase.fill(TYPED_CONFIRM_PHRASE.toLowerCase()) // near-miss: wrong case
		await expect(confirm).toBeDisabled()

		await phrase.fill(`${TYPED_CONFIRM_PHRASE} `) // near-miss: trailing space
		await expect(confirm).toBeDisabled()

		await phrase.fill(TYPED_CONFIRM_PHRASE)
		await expect(confirm).toBeEnabled() // armed — never clicked: a real click would call completePasswordReset

		await phrase.fill(`${TYPED_CONFIRM_PHRASE}!`) // typing past the exact match disarms again
		await expect(confirm).toBeDisabled()
	})

	test("choosing a master-keys file shows the imported name; removing it returns to the no-file state", async ({ page }) => {
		await gotoReset(page)

		// The native input is intentionally visually hidden (a styled "Choose file" button drives it) —
		// setInputFiles targets the element directly and does not require it to be visible. An in-memory
		// buffer avoids writing any file to disk for this test.
		await page
			.locator("#master-keys-file")
			.setInputFiles({ name: "master-keys.txt", mimeType: "text/plain", buffer: Buffer.from("e2e-fake-master-keys") })

		await expect(page.getByText("Master keys imported (master-keys.txt)")).toBeVisible()

		// Deliberately NOT combined with a submit click here: with a file chosen, submit calls
		// completePasswordReset directly (no ceremony, no gate) — a real SDK call this suite must
		// never trigger. The direct-vs-ceremony branch itself is a one-line, already-reviewed
		// conditional in resetForm.tsx; its network path is covered by manual QA, not here.
		await page.getByRole("button", { name: "Remove master keys file" }).click()

		await expect(page.getByText("Master keys imported", { exact: false })).toHaveCount(0)
	})
})

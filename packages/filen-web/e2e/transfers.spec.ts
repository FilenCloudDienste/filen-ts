import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Transfers-screen-specific affordances (transferRow.tsx/screens/transfers.tsx) that uploads.spec.ts
// doesn't already cover: a finished row's own Remove control, and the header-wide Clear finished
// action. Net-zero on the shared drive like every other upload spec (scratch directory, trashed in
// finally) — the transfer itself is real (the SDK worker has no fake/dry-run mode), only its target
// directory is disposable.
test.describe("transfers screen", () => {
	test("the rail entry navigates straight to /transfers (P3 — no popover), and a finished row exposes Remove (not Cancel); Clear finished drops it from the list", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-transfers-screen-${runId}`
		const fileName = `e2e-transfers-screen-${runId}.txt`

		await page.goto("/drive")

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await page
				.locator('input[type="file"]')
				.first()
				.setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("e2e transfers screen probe") })

			await expect(listbox.getByRole("option", { name: fileName })).toBeVisible({ timeout: 45_000 })

			// P3 — a plain nav link now (mirrors every other rail entry), not a popover trigger.
			await page
				.getByRole("link", { name: /Transfers/i })
				.first()
				.click()
			await page.waitForURL(/\/transfers$/)

			// Finished row: a "Remove" control, never "Cancel" — cancel only makes sense for a still-active
			// transfer (transferRow.tsx's finished/active branch).
			const removeButton = page.getByRole("button", { name: "Remove", exact: true })
			await expect(removeButton).toBeVisible()
			await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)

			const clearFinished = page.getByRole("button", { name: "Clear finished", exact: true })
			await expect(clearFinished).toBeVisible()
			await clearFinished.click()

			// The row (and its Remove control) is gone, and the screen falls back to its empty state — no
			// finished row survives clearFinished() (useTransfersStore.ts).
			await expect(removeButton).toHaveCount(0)
			await expect(page.getByText("No transfers", { exact: true })).toBeVisible()
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

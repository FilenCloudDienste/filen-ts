import { test, expect } from "./fixtures"
import { bootTo, enterScratchDirectory, openTransfers, trashScratchDirectory, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Transfers-screen-specific affordances (transferRow.tsx/screens/transfers.tsx) that uploads.spec.ts
// doesn't already cover: a finished row's own Remove control, and the header-wide Clear finished
// action. Net-zero on the shared drive like every other upload spec (scratch directory, trashed in
// finally) — the transfer itself is real (the SDK worker has no fake/dry-run mode), only its target
// directory is disposable.
test.describe("transfers screen", () => {
	test("the rail entry navigates straight to /transfers (no popover), and a finished row exposes Remove (not Cancel); Clear finished drops it from the list", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-transfers-screen-${runId}`
		const fileName = `e2e-transfers-screen-${runId}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await page
				.locator('input[type="file"]')
				.first()
				.setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("e2e transfers screen probe") })

			// Cold boot + a real upload round trip, so the write budget rather than a UI-responsiveness one.
			await expect(listbox.getByRole("option", { name: fileName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// A plain nav link now (mirrors every other rail entry), not a popover trigger.
			await openTransfers(page)

			// Finished row: a "Remove" control, never "Cancel" — cancel only makes sense for a still-active
			// transfer (transferRow.tsx's finished/active branch). Remove FIRST: the row's controls render
			// together, so asserting the absence of Cancel before anything proves the row is on screen
			// passes vacuously against a transfers list that has not rendered yet.
			const removeButton = page.getByRole("button", { name: "Remove", exact: true })
			await expect(removeButton).toBeVisible()
			await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)

			// Enabled, not merely visible: screens/transfers.tsx renders this disabled whenever nothing is
			// clearable, and a click on a disabled control is a silent no-op — which would surface only as
			// the row assertion below failing, two steps from the cause.
			const clearFinished = page.getByRole("button", { name: "Clear finished", exact: true })
			await expect(clearFinished).toBeEnabled()
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

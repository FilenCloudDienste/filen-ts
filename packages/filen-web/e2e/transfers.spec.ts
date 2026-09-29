import { test, expect } from "./fixtures"
import { withScratchDirectory, openTransfers, uploadFiles, breadcrumb } from "./helpers/listing"

// Transfers-screen-specific affordances (transferRow.tsx/screens/transfers.tsx) that uploads.spec.ts
// doesn't already cover: a finished row's own Show in directory and Remove controls, and the
// header-wide Clear finished action. Net-zero on the shared drive like every other upload spec (scratch directory, trashed in
// finally) — the transfer itself is real (the SDK worker has no fake/dry-run mode), only its target
// directory is disposable.
test.describe("transfers screen", () => {
	test("the rail entry navigates straight to /transfers (no popover), a finished row reveals its file and exposes Remove (not Cancel); Clear finished drops it from the list", async ({
		page
	}) => {
		await withScratchDirectory(page, "transfers-screen", async ({ listbox, scratchName, runId }) => {
			const fileName = `e2e-transfers-screen-${runId}.txt`

			await uploadFiles(
				page,
				[{ name: fileName, mimeType: "text/plain", buffer: Buffer.from("e2e transfers screen probe") }],
				listbox
			)

			// A plain nav link now (mirrors every other rail entry), not a popover trigger.
			await openTransfers(page)

			// Finished row: a "Remove" control, never "Cancel" — cancel only makes sense for a still-active
			// transfer (transferRow.tsx's finished/active branch). Remove FIRST: the row's controls render
			// together, so asserting the absence of Cancel before anything proves the row is on screen
			// passes vacuously against a transfers list that has not rendered yet.
			const removeButton = page.getByRole("button", { name: "Remove", exact: true })
			await expect(removeButton).toBeVisible()
			await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)

			// "Show in directory" opens the directory the upload landed in, with the file selected.
			const row = page.getByRole("listitem", { name: fileName })
			await row.getByRole("button", { name: "Show in directory", exact: true }).click()
			await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(scratchName, {
				timeout: 30_000
			})
			await expect(listbox.getByRole("option", { name: fileName })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })

			await openTransfers(page)
			await expect(removeButton).toBeVisible()

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
		})
	})
})

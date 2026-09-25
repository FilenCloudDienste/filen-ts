import { test, expect } from "./fixtures"
import {
	bootTo,
	createDirectoryViaDialog,
	descendInto,
	enterScratchDirectory,
	trashScratchDirectory,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"
import { html5DragMove } from "./helpers/dnd"

const ROW_SELECTOR = '[role="option"]'
const BREADCRUMB_LINK_SELECTOR = 'nav[aria-label="Breadcrumb"] a'

test.describe("drive drag-to-move", () => {
	test("drags a file into a directory, then back out via the breadcrumb", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-dnd-${runId}`
		const targetDirName = `target-${runId}`
		const fileName = `dragged-${runId}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			// A sibling directory to drop into.
			await createDirectoryViaDialog(page, targetDirName)

			// A file to drag.
			await page
				.getByRole("main")
				.locator('input[type="file"]')
				.first()
				.setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("drag-to-move probe") })

			const options = listbox.getByRole("option")
			await expect(options).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS }) // target directory + uploaded file

			const fileRow = listbox.getByRole("option", { name: fileName })
			const targetRow = listbox.getByRole("option", { name: targetDirName })
			await expect(fileRow).toBeVisible()
			await expect(targetRow).toBeVisible()

			// 1) Drag the file onto the directory — it leaves the scratch listing (only the directory left).
			// The write budget on the envelope: a drop runs moveItems' per-item runOp, so the row leaving is
			// the live move settling on the account-wide lease, not a React commit. The count guard reads the
			// OPTIMISTIC listing, so it guards the UI, not the server: a move that already LANDED but whose
			// row has not patched yet is still re-dispatched. Harmless — the SDK no-ops or errs on the second
			// one, and the envelope converges on the row leaving either way.
			await expect(async () => {
				if ((await options.count()) > 1) {
					await html5DragMove(page, { selector: ROW_SELECTOR, text: fileName }, { selector: ROW_SELECTOR, text: targetDirName })
				}

				await expect(options).toHaveCount(1, { timeout: 30_000 })
			}).toPass({ timeout: LIVE_WRITE_TIMEOUT_MS })

			await expect(listbox.getByRole("option", { name: targetDirName })).toBeVisible()
			await expect(listbox.getByRole("option", { name: fileName })).toHaveCount(0)

			// 2) Descend into the directory — the file now lives inside it.
			await descendInto(page, listbox, targetDirName)
			const nested = await waitForListingSettled(page)
			const nestedFileRow = nested.listbox.getByRole("option", { name: fileName })
			await expect(nestedFileRow).toBeVisible()

			// 3) Drag it back out onto the scratch ancestor in the breadcrumb — it leaves the nested listing.
			// Same optimistic-listing guard as leg 1, and the same reason it is safe to re-dispatch through.
			const scratchCrumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: scratchName, exact: true })
			await expect(scratchCrumb).toBeVisible()

			await expect(async () => {
				if ((await nestedFileRow.count()) > 0) {
					await html5DragMove(
						page,
						{ selector: ROW_SELECTOR, text: fileName },
						{ selector: BREADCRUMB_LINK_SELECTOR, text: scratchName }
					)
				}

				await expect(nestedFileRow).toHaveCount(0, { timeout: 30_000 })
			}).toPass({ timeout: LIVE_WRITE_TIMEOUT_MS })
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

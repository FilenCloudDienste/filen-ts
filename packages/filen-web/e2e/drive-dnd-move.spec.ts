import { test, expect } from "./fixtures"
import {
	breadcrumb,
	createDirectoryViaDialog,
	descendInto,
	uploadFiles,
	waitForListingSettled,
	withScratchDirectory,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { html5DragMove } from "./helpers/dnd"

const ROW_SELECTOR = '[role="option"]'
const BREADCRUMB_LINK_SELECTOR = 'nav[aria-label="Breadcrumb"] a'

test.describe("drive drag-to-move", () => {
	test("drags a file into a directory, then back out via the breadcrumb", async ({ page }) => {
		await withScratchDirectory(page, "dnd", async ({ listbox, scratchName, runId }) => {
			const targetDirName = `target-${runId}`
			const fileName = `dragged-${runId}.txt`

			// A sibling directory to drop into.
			await createDirectoryViaDialog(page, targetDirName)

			// A file to drag.
			await uploadFiles(page, [{ name: fileName, mimeType: "text/plain", buffer: Buffer.from("drag-to-move probe") }])

			const options = listbox.getByRole("option")
			await expect(options).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS }) // target directory + uploaded file

			const fileRow = listbox.getByRole("option", { name: fileName })
			const targetRow = listbox.getByRole("option", { name: targetDirName })
			await expect(fileRow).toBeVisible()
			await expect(targetRow).toBeVisible()

			// 1) Drag the file onto the directory — it leaves the scratch listing (only the directory left).
			// Dispatched ONCE: html5DragMove asserts the target accepted the drop, and an accepted drop always
			// starts the move. The row leaves only once moveItems' write settles on the account-wide lease, so
			// the wait carries the write budget — a re-dispatch while the first move is still queued behind
			// the lease would only queue a second write behind it.
			await html5DragMove(page, { selector: ROW_SELECTOR, text: fileName }, { selector: ROW_SELECTOR, text: targetDirName })
			await expect(options).toHaveCount(1, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await expect(listbox.getByRole("option", { name: targetDirName })).toBeVisible()
			await expect(listbox.getByRole("option", { name: fileName })).toHaveCount(0)

			// 2) Descend into the directory — the file now lives inside it.
			await descendInto(page, listbox, targetDirName)
			const nested = await waitForListingSettled(page)
			const nestedFileRow = nested.listbox.getByRole("option", { name: fileName })
			await expect(nestedFileRow).toBeVisible()

			// 3) Drag it back out onto the scratch ancestor in the breadcrumb — it leaves the nested listing.
			// Dispatched once and waited out at the write budget, as in leg 1.
			const scratchCrumb = breadcrumb(page).getByRole("link", { name: scratchName, exact: true })
			await expect(scratchCrumb).toBeVisible()

			await html5DragMove(page, { selector: ROW_SELECTOR, text: fileName }, { selector: BREADCRUMB_LINK_SELECTOR, text: scratchName })
			await expect(nestedFileRow).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		})
	})
})

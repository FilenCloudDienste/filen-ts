import type { ElementHandle, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { descendInto, enterScratchDirectory, trashScratchDirectory, waitForListingSettled } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Playwright's mouse cannot synthesize a native HTML5 drag (there is no way to populate a real
// DataTransfer via move+down+up). Drive the exact browser event sequence instead: one shared
// DataTransfer threaded through dragstart → dragenter → dragover → drop → dragend, dispatched on the
// real row/target elements so React's own onDragStart/onDrop handlers (and the module-level payload
// they set/read) run end-to-end. dispatchEvent runs inside the page, so this is as close to a genuine
// drag as automation allows here.
async function html5DragMove(page: Page, source: ElementHandle<Element>, target: ElementHandle<Element>): Promise<void> {
	await page.evaluate(
		([src, tgt]) => {
			const dataTransfer = new DataTransfer()
			const fire = (element: Element, type: string): void => {
				element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
			}

			fire(src, "dragstart")
			fire(tgt, "dragenter")
			fire(tgt, "dragover")
			fire(tgt, "drop")
			fire(src, "dragend")
		},
		[source, target] as const
	)
}

// A row/target element handle for the drag helper — throws (never returns null) so a missing element is
// a real failure surfaced here, honoring strict null handling.
async function handleOf(locator: ReturnType<Page["getByRole"]>): Promise<ElementHandle<Element>> {
	const handle = await locator.elementHandle()

	if (!handle) {
		throw new Error("expected the locator to resolve to a live element")
	}

	return handle
}

test.describe("drive drag-to-move", () => {
	test("drags a file into a directory, then back out via the breadcrumb", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-dnd-${runId}`
		const targetDirName = `target-${runId}`
		const fileName = `dragged-${runId}.txt`

		await page.goto("/drive")

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			// A sibling directory to drop into.
			await page.getByRole("button", { name: "New directory", exact: true }).click()
			const dialog = page.getByRole("dialog")
			await expect(dialog).toBeVisible()
			await page.getByLabel("Name", { exact: true }).fill(targetDirName)
			await page.getByRole("button", { name: "Create", exact: true }).click()
			await expect(dialog).toHaveCount(0)

			// A file to drag.
			await page
				.locator('input[type="file"]')
				.first()
				.setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("drag-to-move probe") })

			const options = listbox.getByRole("option")
			await expect(options).toHaveCount(2, { timeout: 60_000 }) // target directory + uploaded file

			const fileRow = listbox.getByRole("option", { name: fileName })
			const targetRow = listbox.getByRole("option", { name: targetDirName })
			await expect(fileRow).toBeVisible()
			await expect(targetRow).toBeVisible()

			// 1) Drag the file onto the directory — it leaves the scratch listing (only the directory left).
			await html5DragMove(page, await handleOf(fileRow), await handleOf(targetRow))

			await expect(options).toHaveCount(1, { timeout: 30_000 })
			await expect(listbox.getByRole("option", { name: targetDirName })).toBeVisible()
			await expect(listbox.getByRole("option", { name: fileName })).toHaveCount(0)

			// 2) Descend into the directory — the file now lives inside it.
			await descendInto(page, listbox, targetDirName)
			const nested = await waitForListingSettled(page)
			await expect(nested.listbox.getByRole("option", { name: fileName })).toBeVisible()

			// 3) Drag it back out onto the scratch ancestor in the breadcrumb — it leaves the nested listing.
			const nestedFileRow = nested.listbox.getByRole("option", { name: fileName })
			const scratchCrumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: scratchName, exact: true })
			await expect(scratchCrumb).toBeVisible()

			await html5DragMove(page, await handleOf(nestedFileRow), await handleOf(scratchCrumb))

			await expect(nested.listbox.getByRole("option", { name: fileName })).toHaveCount(0, { timeout: 30_000 })
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

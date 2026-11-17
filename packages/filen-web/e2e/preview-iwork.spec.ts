import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { itemRow } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"

// Pages, Numbers and Keynote documents open as the rendering of themselves they carry, under a note that it is only a
// preview; a `.key` is read first, and one that is no package opens nowhere. Reads the shared fixture tree only.

const [REPORT, SLIDES, LEGACY, BARE, KEY_FILE] = FIXTURE_FILES["iwork-documents"]

const FIRST_PAGE_NOTE = (app: string) => `Preview image of the first page. Open in ${app} for the full document.`

async function close(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("dialog")).toHaveCount(0)
}

test("iWork documents show the rendering they carry, and a key file is not taken for one", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "iwork-documents")

	// '13 and later: the first page's image, from the package's own preview.jpg.
	await itemRow(listbox, REPORT).dblclick()
	await expect(page.getByText(FIRST_PAGE_NOTE("Pages"), { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("img", { name: REPORT })).toBeVisible({ timeout: 30_000 })
	await close(page)

	// A .key whose first bytes are a zip is Keynote's.
	await itemRow(listbox, SLIDES).dblclick()
	await expect(page.getByText(FIRST_PAGE_NOTE("Keynote"), { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("img", { name: SLIDES })).toBeVisible({ timeout: 30_000 })
	await close(page)

	// '09: the PDF copy, ahead of the thumbnail beside it.
	await itemRow(listbox, LEGACY).dblclick()
	await expect(page.getByText("Preview copy saved in the document. Open in Numbers for the full document.", { exact: true })).toBeVisible(
		{
			timeout: LAZY_VIEWER_TIMEOUT_MS
		}
	)
	await expect(page.getByRole("region", { name: /Page 1 of 2$/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await close(page)

	// A package without a rendering: its card.
	await itemRow(listbox, BARE).dblclick()
	await expect(page.getByText("No preview inside this file.", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await close(page)

	// A key file under Keynote's extension: read, found no package, and shown as a file nothing previews.
	await itemRow(listbox, KEY_FILE).dblclick()
	await expect(page.getByText("Preview isn't available for this file type yet.", { exact: true })).toBeVisible({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})
	await expect(page.getByText(/Open in Keynote/u)).toHaveCount(0)
	await close(page)

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

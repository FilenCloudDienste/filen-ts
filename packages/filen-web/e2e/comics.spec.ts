import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { itemRow } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { COMIC_PAGES } from "./fixtures/comics"

// The comic reader over the shared fixture tree's books (fixtures/comics.ts): a .cbz, a solid .cbr and a bare .cbt past
// the listing gate, four pages each. Pages turn with Page Down; the counter and each page's name say where the reader
// is. A pure read.

const [CBZ, CBR, CBT] = FIXTURE_FILES.comics

function pageImage(page: Page, number: number) {
	return page.getByRole("img", { name: `Page ${String(number)} of ${String(COMIC_PAGES)}`, exact: true })
}

async function close(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("dialog")).toHaveCount(0)
}

test.describe("comic books", () => {
	test("a .cbz reads page by page, Page Down on the slider turning one page", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const listbox = await gotoFixture(page, "comics")

		await itemRow(listbox, CBZ).dblclick()
		await expect(pageImage(page, 1)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.keyboard.press("PageDown")
		await expect(pageImage(page, 2)).toBeVisible()

		// On the focused slider, Page Down is one page too, and its value is named as a page of the book.
		const slider = page.getByRole("slider")

		await slider.focus()
		await page.keyboard.press("PageDown")
		await expect(pageImage(page, 3)).toBeVisible()
		await expect(slider).toHaveAttribute("aria-valuetext", `Page 3 of ${String(COMIC_PAGES)}`)
		await page.keyboard.press("PageUp")
		await expect(pageImage(page, 2)).toBeVisible()
		await close(page)
		expect(cspViolations).toEqual([])
	})

	test("a solid .cbr asks its cost once, then turns every later page unasked", async ({ page }) => {
		await bootTo(page)

		const listbox = await gotoFixture(page, "comics")

		await itemRow(listbox, CBR).dblclick()
		// The first page is stored first: nothing before it to read, nothing asked.
		await expect(pageImage(page, 1)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.keyboard.press("PageDown")

		const confirm = page.getByRole("alertdialog", { name: "Read part of the archive first?" })

		await expect(confirm).toBeVisible()
		await confirm.getByRole("button", { name: "Open", exact: true }).click()
		await expect(pageImage(page, 2)).toBeVisible()

		for (const turn of [3, 4]) {
			await page.keyboard.press("PageDown")
			await expect(pageImage(page, turn)).toBeVisible()
			await expect(confirm).toHaveCount(0)
		}

		await close(page)
	})

	test("a bare .cbt past the gate lists on Read, and its pages read by range", async ({ page }) => {
		await bootTo(page)

		const listbox = await gotoFixture(page, "comics")

		await itemRow(listbox, CBT).dblclick()
		await page.getByRole("button", { name: "Read", exact: true }).click({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(pageImage(page, 1)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.keyboard.press("PageDown")
		await expect(pageImage(page, 2)).toBeVisible()
		await close(page)
	})
})

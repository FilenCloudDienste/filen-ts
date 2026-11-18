import { test, expect } from "./fixtures"
import { expectRows, openArchive } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { bootTo } from "./helpers/listing"
import { RAR_README_TEXT, rarComicPageText } from "./fixtures/rar"

// RAR archives in the archive browser (fixtures/rar.ts): a RAR 4 with a directory, and a solid RAR 5 comic book, whose
// pages after the first are read after the ones stored before them. A pure read: this spec never extracts.

const [COMIC, STORE] = FIXTURE_FILES["archive-rar"]

test.describe("RAR archives", () => {
	test("a RAR lists, navigates and opens an entry", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-rar")
		const browser = await openArchive(page, listbox, STORE)

		// Small: no gate.
		await expect(browser.gate.browse).toHaveCount(0)
		await expectRows(browser.list, ["docs", "notes.txt"])
		await browser.into("docs")
		await browser.row("readme.txt").dblclick()
		await expect(browser.overlay.getByText(RAR_README_TEXT.trim())).toBeVisible()
		await browser.overlay.getByRole("button", { name: "Back to the archive", exact: true }).click()
		await expectRows(browser.list, ["readme.txt"])
		expect(cspViolations).toEqual([])
	})

	test("a solid comic book's first page opens at once, a later one after its cost is confirmed", async ({ page }) => {
		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-rar")
		const browser = await openArchive(page, listbox, COMIC)

		await expectRows(browser.list, ["page-01.txt", "page-02.txt", "page-03.txt", "page-04.txt"])

		// The first page is stored first: nothing before it to read.
		await browser.row("page-01.txt").dblclick()
		await expect(browser.overlay.getByText(rarComicPageText(1).split("\n")[0] ?? "", { exact: false }).first()).toBeVisible()
		await browser.overlay.getByRole("button", { name: "Back to the archive", exact: true }).click()

		await browser.row("page-03.txt").dblclick()

		const confirm = page.getByRole("alertdialog", { name: "Read part of the archive first?" })

		await expect(confirm).toBeVisible()
		await confirm.getByRole("button", { name: "Open", exact: true }).click()
		await expect(browser.overlay.getByText(rarComicPageText(3).split("\n")[0] ?? "", { exact: false }).first()).toBeVisible()
	})
})

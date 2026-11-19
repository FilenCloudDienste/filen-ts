import { test, expect } from "./fixtures"
import { archivePasswordPrompt, expectRows, openArchive } from "./helpers/archive"
import { NESTED_TEXTS, ZIPCRYPTO_PASSWORD } from "./helpers/archiveFixtures"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { bootTo } from "./helpers/listing"
import { observeEgest } from "./helpers/requests"

// Archives inside an archive (W6 §6.1 A, fixtures in helpers/archiveFixtures.ts): a zip and a tar stored in a zip, and a
// zip deflated in it, each browsed in the outer one's place, the crumbs running on through it. A pure read of the shared fixture tree;
// the public-link case writes, so it lives in archive-surfaces.spec.ts.

const [NESTED] = FIXTURE_FILES["archive-nested"]

test.describe("archives inside an archive", () => {
	test("a zip and a tar in a zip browse in its place, open their files, and lead back to it", async ({ page }) => {
		const cspViolations = trackCspViolations(page)
		const egest = observeEgest(page.context())

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-nested")
		const browser = await openArchive(page, listbox, NESTED)
		const back = browser.overlay.getByRole("button", { name: "Back to the archive", exact: true })

		await expectRows(browser.list, ["trip", "top.txt"])
		await browser.into("trip")
		await expectRows(browser.list, ["inner.tar", "inner.zip", "packed.zip"])

		// A zip stored in the zip: the crumbs run on through the outer archive into it, a glyph at the boundary.
		await browser.into("inner.zip")
		await expect(browser.list).toHaveAccessibleName("Contents of inner.zip")
		await expect(browser.crumbs.getByRole("button")).toHaveText([NESTED, "trip", "inner.zip"])
		await expect(browser.crumbs.locator("[data-archive-boundary]")).toHaveCount(1)
		await expectRows(browser.list, ["day1", "readme.txt"])
		// Nothing is extracted from an archive held in another.
		await expect(browser.overlay.getByText("This archive is inside another. Extract the outer archive to get its files.")).toBeVisible()
		await expect(browser.overlay.getByRole("button", { name: "Extract all", exact: true })).toBeDisabled()

		await browser.row("readme.txt").dblclick()
		await expect(browser.overlay.getByText(NESTED_TEXTS.zip.trim(), { exact: false }).first()).toBeVisible()
		await back.click()
		await expectRows(browser.list, ["day1", "readme.txt"])

		// An outer crumb leads back to the outer archive, at its directory, from the listing it already read.
		const beforeBack = egest.requests()

		await browser.crumbs.getByRole("button", { name: "trip", exact: true }).click()
		await expect(browser.list).toHaveAccessibleName("Contents of trip")
		await expectRows(browser.list, ["inner.tar", "inner.zip", "packed.zip"])
		expect(egest.requests()).toBe(beforeBack)

		// A tar stored in the zip.
		await browser.into("inner.tar")
		await browser.into("notes")
		await browser.row("a.txt").dblclick()
		await expect(browser.overlay.getByText(NESTED_TEXTS.tar.trim(), { exact: false }).first()).toBeVisible()
		await back.click()

		// Back at the inner archive's root leaves it for the directory it was entered from.
		await browser.crumbs.getByRole("button", { name: "inner.tar", exact: true }).click()
		await expect(browser.list).toHaveAccessibleName("Contents of inner.tar")
		await browser.list.focus()
		await page.keyboard.press("Backspace")
		await expect(browser.list).toHaveAccessibleName("Contents of trip")

		// A zip deflated in the zip: inflated, then browsed the same way.
		await browser.into("packed.zip")
		await browser.row("packed.txt").dblclick()
		await expect(browser.overlay.getByText(NESTED_TEXTS.packed.trim(), { exact: false }).first()).toBeVisible()
		await back.click()

		await browser.close()
		expect(cspViolations).toEqual([])
	})
})

const [DEEP, HUGE, LOCKED, IN_TAR_GZ, IN_TAR_ZST] = FIXTURE_FILES["archive-nested-cases"]

test.describe("archives inside an archive: their cases", () => {
	test("a fourth archive deep says why it won't open, and nothing is saved", async ({ page }) => {
		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-nested-cases")
		const browser = await openArchive(page, listbox, DEEP)

		await browser.into("l2.zip")
		await browser.into("l3.zip")
		await browser.row("l4.zip").dblclick()
		await expect(page.getByText("“l4.zip” is nested too deep to open here. Extract the outer archive to open it.")).toBeVisible()
		await expect(browser.list).toHaveAccessibleName("Contents of l3.zip")
		await browser.close()
	})

	test("an inner archive inflating past 256 MiB is confirmed first", async ({ page }) => {
		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-nested-cases")
		const browser = await openArchive(page, listbox, HUGE)

		await browser.row("huge.zip").dblclick()

		const confirm = page.getByRole("alertdialog", { name: "Unpack this archive first?" })

		await expect(confirm).toContainText(/257 MiB/)
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(confirm).toHaveCount(0)
		await expect(browser.list).toHaveAccessibleName(`Contents of ${HUGE}`)
		await browser.close()
	})

	test("an inner archive in an encrypted entry asks the outer archive's password, then opens", async ({ page }) => {
		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-nested-cases")
		const browser = await openArchive(page, listbox, LOCKED)

		await browser.row("inner.zip").dblclick()

		const prompt = archivePasswordPrompt(page)

		await expect(prompt).toContainText(LOCKED)
		await prompt.getByLabel("Password", { exact: true }).fill(ZIPCRYPTO_PASSWORD)
		await prompt.getByRole("button", { name: "Unlock", exact: true }).click()
		await expect(browser.list).toHaveAccessibleName("Contents of inner.zip")
		await browser.row("secret.txt").dblclick()
		await expect(browser.overlay.getByText(NESTED_TEXTS.zip.trim(), { exact: false }).first()).toBeVisible()
		await browser.close()
	})

	test("an inner archive deep in a .tar.gz confirms what reaching it decodes, then opens", async ({ page }) => {
		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-nested-cases")
		const browser = await openArchive(page, listbox, IN_TAR_GZ)

		await browser.row("inner.zip").dblclick()

		const confirm = page.getByRole("alertdialog", { name: "Read part of the archive first?" })

		await confirm.getByRole("button", { name: "Open", exact: true }).click()
		await expect(browser.list).toHaveAccessibleName("Contents of inner.zip")
		await expectRows(browser.list, ["inside.txt"])
		await browser.close()
	})

	test("an inner archive in a .tar.zst, read only front to back, shows the card offering to extract", async ({ page }) => {
		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-nested-cases")
		const browser = await openArchive(page, listbox, IN_TAR_ZST)

		await browser.row("inner.zip").dblclick()
		await expect(browser.overlay.getByText(/can't be opened from inside this archive/)).toBeVisible()
		await expect(browser.overlay.getByRole("button", { name: "Extract to open", exact: true })).toBeVisible()
		await browser.close()
	})
})

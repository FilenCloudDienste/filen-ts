import type { BrowserContext, Page } from "@playwright/test"
import { test, expect, readHarvestedSession, seedSession } from "./fixtures"
import { archivePasswordPrompt, itemRow } from "./helpers/archive"
import { ZIPCRYPTO_PASSWORD } from "./helpers/archiveFixtures"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { BOOT_SETTLE_TIMEOUT_MS, bootTo, LAZY_VIEWER_TIMEOUT_MS, SIGN_IN_HEADING } from "./helpers/listing"
import { menuItemName } from "./helpers/menu"
import { observeEgest } from "./helpers/requests"
import { COMIC_PAGES } from "./fixtures/comics"

// The comic reader over the shared fixture tree's books (fixtures/comics.ts): a .cbz, a solid .cbr and a bare .cbt past
// the listing gate, four pages each. Pages turn with Page Down; the counter and each page's name say where the reader
// is. A pure read.

const [CBZ, CBR, CBT] = FIXTURE_FILES.comics
const [LOCKED] = FIXTURE_FILES["comics-locked"]
// A bare tar's chunks: its 9 MiB of padding after the pages.
const CBT_CHUNKS = 10

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
		const egest = observeEgest(page.context())

		await bootTo(page)

		const listbox = await gotoFixture(page, "comics")

		await itemRow(listbox, CBT).dblclick()
		await page.getByRole("button", { name: "Read", exact: true }).click({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(pageImage(page, 1)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.keyboard.press("PageDown")
		await expect(pageImage(page, 2)).toBeVisible()

		// The listing seeks past the padding and every page is a range of the first chunk: far fewer chunks than the
		// archive has, which reading it front to back would fetch every one of. The positive control: some were fetched.
		expect(egest.requests()).toBeGreaterThan(0)
		expect(egest.requests()).toBeLessThan(CBT_CHUNKS)
		await close(page)
	})

	test("a ZipCrypto comic asks its password, asks again for a wrong one, and reads with the right one", async ({ page }) => {
		await bootTo(page)

		const listbox = await gotoFixture(page, "comics-locked")

		await itemRow(listbox, LOCKED).dblclick()

		const prompt = archivePasswordPrompt(page)

		await expect(prompt).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await prompt.getByLabel("Password", { exact: true }).fill("not-the-password")
		await prompt.getByRole("button", { name: "Unlock", exact: true }).click()
		// Every page read is checked: the wrong password is told, never a garbled page.
		await expect(prompt.getByText(/didn't open/)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(pageImage(page, 1)).toHaveCount(0)
		await prompt.getByLabel("Password", { exact: true }).fill(ZIPCRYPTO_PASSWORD)
		await prompt.getByRole("button", { name: "Unlock", exact: true }).click()
		await expect(pageImage(page, 1)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.keyboard.press("PageDown")
		await expect(pageImage(page, 2)).toBeVisible()
		await close(page)
	})
})

// Seeded once per context, as the logout spec does: a re-seeded reload would bring the session back.
const seededContexts = new WeakSet<BrowserContext>()

async function seedOncePerContext(page: Page, session: string): Promise<void> {
	await seedSession(page, session, context => {
		if (seededContexts.has(context)) {
			return false
		}

		seededContexts.add(context)

		return true
	})
}

test.describe("comic books and sign-out", () => {
	test.use({ injectSession: false })

	test("a sign-out in another tab closes an open comic: nothing of it is read after", async ({ page, context }) => {
		const session = readHarvestedSession()

		test.skip(session === null, "no injected session (e2e credentials not configured)")

		if (session === null) {
			return
		}

		await seedOncePerContext(page, session)
		await bootTo(page)

		const listbox = await gotoFixture(page, "comics")

		await itemRow(listbox, CBZ).dblclick()
		await expect(pageImage(page, 1)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		const other = await context.newPage()

		await seedOncePerContext(other, session)
		await bootTo(other, "/")
		await other.getByRole("button", { name: "Account", exact: true }).click()
		await other
			.getByRole("menu")
			.getByRole("menuitem", { name: menuItemName("Sign out") })
			.click()
		await other.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click()

		// The broadcast reloads the reading tab onto the sign-in form: the comic and the pages it held are gone with it.
		await expect(page.getByText(SIGN_IN_HEADING)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		const egest = observeEgest(context)

		await expect(page.getByRole("dialog")).toHaveCount(0)
		await expect(pageImage(page, 1)).toHaveCount(0)
		expect(egest.requests()).toBe(0)
		await other.close()
	})
})

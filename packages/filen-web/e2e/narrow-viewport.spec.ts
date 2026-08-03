import { test, expect } from "./fixtures"
import { dismissStartupReminders, waitForListingSettled } from "./helpers/listing"
import { gotoSettings } from "./helpers/settings"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// The narrow-viewport shell contract: below the layout breakpoint no module sidebar sits in the shell
// row, the rail's one drawer trigger reaches it, picking a destination closes it again, and both drive
// chrome rows stay inside the card. Chromium-only for the same reason every other authed spec is
// (helpers/firefox.ts).
//
// READ-ONLY BY CONSTRUCTION: this spec only navigates and asserts — no note/chat creates, no uploads,
// nothing to clean up, so it is net-zero against the shared account without a teardown of its own.
test.describe("narrow viewport", () => {
	test.use({ viewport: { width: 390, height: 844 } })

	test("no sidebar sits in the row, the rail's trigger opens it, and the drive chrome rows fit", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		await waitForListingSettled(page)

		// <aside> is unique to the five module sidebars, so "complementary" means exactly "a module
		// sidebar is presented". getByRole ignores the `hidden` subtree the closed drawer keeps mounted.
		await expect(page.getByRole("complementary")).toHaveCount(0)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		// Both drive chrome rows must sit fully inside the viewport, not merely intersect it — the default
		// ratio (> 0) passes on an element clipped against the content card's own overflow.
		await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toBeInViewport({ ratio: 1 })
		await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeInViewport({ ratio: 1 })

		await page.getByRole("button", { name: "Open navigation", exact: true }).click()

		// A sidebar-only destination, never a breadcrumb — proof the panel itself is presented.
		const recents = page.getByRole("link", { name: "Recents", exact: true })
		await expect(recents).toBeVisible()

		await page.keyboard.press("Escape")

		// toBeHidden rather than toHaveCount(0): the closed drawer keeps the panel mounted behind the HTML
		// `hidden` attribute, which satisfies both, and this still holds if that ever changes.
		await expect(recents).toBeHidden()
	})

	test("every settings section is reachable, and picking one closes the drawer", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)

		const sections = ["Account", "Security", "Appearance", "Events", "Billing", "Advanced"]

		for (const label of sections) {
			await expect(page.getByRole("link", { name: label, exact: true })).toBeHidden()
		}

		await page.getByRole("button", { name: "Open navigation", exact: true }).click()

		for (const label of sections) {
			await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible()
		}

		await page.getByRole("link", { name: "Security", exact: true }).click()
		await page.waitForURL(/\/settings\/security$/)

		// The drawer closed itself on the navigation, so neither it nor the panel it hosts is presented.
		await expect(page.getByRole("dialog")).toHaveCount(0)
		await expect(page.getByRole("complementary")).toHaveCount(0)
	})

	test("the drive Name column survives 390px and the secondary columns return at desktop", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")

		const { hasItems } = await waitForListingSettled(page)

		// The Size/Modified header spans live inside the listing's own rendered content, which the empty
		// branch never reaches — there is no column layout to assert on an empty account, so skip rather
		// than fail. Both strings are unique while menus are closed: the sort menu's trigger renders only
		// "Sort by" and its own items live inside a closed dropdown.
		test.skip(!hasItems, "drive root is empty on the shared account — no listing header to assert")

		const size = page.getByText("Size", { exact: true })
		const modified = page.getByText("Modified", { exact: true })

		// toHaveCount(1) first, so a DELETED header cannot produce a false pass on the hidden assertions.
		await expect(size).toHaveCount(1)
		await expect(modified).toHaveCount(1)
		await expect(size).toBeHidden()
		await expect(modified).toBeHidden()

		// 768px is the width the shell itself makes tightest — the sidebar returns to the row there, so the
		// card is at its narrowest just above the breakpoint and Modified must still be out.
		await page.setViewportSize({ width: 768, height: 800 })
		await expect(size).toBeVisible()
		await expect(modified).toBeHidden()

		// Desktop: today's layout, both columns present.
		await page.setViewportSize({ width: 1280, height: 800 })
		await expect(size).toBeVisible()
		await expect(modified).toBeVisible()
	})

	test("the transfers toolbar is fully reachable", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		// goto("/drive") and not goto("/transfers"): the session-injection hook re-seeds and navigates to
		// "/" → /drive on every load, so a hard goto to any other authed route bounces before it renders.
		// The rail click below is a client nav and is unaffected. No listing assertion is wanted here, so
		// the explicit dismissal is the right half of THE RULE (helpers/listing.ts), not
		// waitForListingSettled.
		await page.goto("/drive")
		await dismissStartupReminders(page)

		await page
			.getByRole("link", { name: /Transfers/i })
			.first()
			.click()
		await page.waitForURL(/\/transfers$/)

		// With no active transfers these are disabled but still rendered — which is what keeps this test
		// net-zero. Their accessible names come from the same i18n keys as the labels the narrow layout
		// sheds, so this is also the proof that shedding a label changed no accessible name.
		for (const name of ["Pause all", "Resume all", "Cancel all", "Clear finished"]) {
			const button = page.getByRole("button", { name, exact: true })

			await expect(button).toBeVisible()
			await expect(button).toBeInViewport()
		}
	})
})

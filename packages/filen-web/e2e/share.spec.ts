import { test, expect } from "./fixtures"
import {
	waitForListingSettled,
	dismissStartupReminders,
	enterScratchDirectory,
	createDirectoryViaDialog,
	trashScratchDirectory
} from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Sharing/unsharing are OUTWARD-FACING mutations (a share reaches ANOTHER account; unshare revokes
// real access) and premium-gated, so every test below is render/gate-only — the contact picker is
// exercised only up to its own disabled-submit gate, never actually submitted, and there is no
// net-zero counterpart for a live share. The injected session's own account is free, with zero
// shared items and zero contacts: /shared-in and /shared-out always render empty here, and the
// picker always lands on its empty-contacts state. That also means the block filter and unshare have
// nothing to exercise in-browser on this account (no shared items to filter or unshare, no blocked
// contacts to unblock) — both are covered by unit tests and manual QA instead, not here.
//
// Every test below needs an authenticated listDir call to settle (the shared listings, or /drive
// itself for the picker test), which hangs on Playwright-firefox — see helpers/firefox.ts.

test.describe("sharing", () => {
	test("shared surfaces render and activate from the sidebar", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")

		// The authed shell raises a blocking startup reminder modal that renders the rest of the app
		// inert/aria-hidden until dismissed — while it is open the shell's own nav/sidebar are not in the
		// role tree, so it must be dismissed BEFORE the nav assertion or sidebar clicks below. This test
		// activates the shared surfaces via direct sidebar clicks, never through the listing gate.
		await dismissStartupReminders(page)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		// The e2e injection hook re-seeds the session and navigates to "/" on every hard load (see
		// src/e2e-hooks/index.ts's seedFromSlot), which bounces any OTHER authed route straight back to
		// /drive — reaching either shared surface only ever works via an in-app sidebar click.
		const sidebar = page.getByRole("complementary")

		const sharedInLink = sidebar.getByRole("link", { name: "Shared with me", exact: true })
		await expect(sharedInLink).toBeVisible()
		await sharedInLink.click()
		await page.waitForURL(/\/shared-in$/)

		await waitForListingSettled(page)
		await expect(page.getByText("Couldn't load this directory")).toHaveCount(0)
		await expect(sharedInLink).toHaveAttribute("aria-current", "page")

		const sharedOutLink = sidebar.getByRole("link", { name: "Shared with others", exact: true })
		await expect(sharedOutLink).toBeVisible()
		await sharedOutLink.click()
		await page.waitForURL(/\/shared-out$/)

		await waitForListingSettled(page)
		await expect(page.getByText("Couldn't load this directory")).toHaveCount(0)
		await expect(sharedOutLink).toHaveAttribute("aria-current", "page")
	})

	// The only test in this file that touches live account state — a net-zero scratch directory holding
	// one nested directory, purely so there is something selectable to open the bulk Share action on
	// (the account's /drive root may otherwise be empty). Nested rather than created at root, and torn
	// down from a finally, like every other mutating spec here: a root-level create/trash races
	// drive.spec.ts's own root option-count assertions, and an inline teardown leaks the directory the
	// moment anything above it throws. The picker itself is only ever driven up to its own disabled
	// submit button, then dismissed via Escape — this suite never shares anything for real.
	test("the bulk Share button opens the contact picker; dismissing shares nothing", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-share-${runId}`
		const nestedName = `shared-candidate-${runId}`

		await page.goto("/drive")

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, nestedName)

			const nestedRow = listbox.getByRole("option", { name: nestedName })
			await expect(nestedRow).toBeVisible()

			await nestedRow.click()
			await expect(page.getByText("1 selected", { exact: true })).toBeVisible()

			// Pre-dialog, the bulk bar's own "Share" button is the only one in the DOM — the picker's
			// identically-labeled submit button doesn't exist until the dialog itself opens.
			await page.getByRole("button", { name: "Share", exact: true }).click()

			const dialog = page.getByRole("dialog")
			await expect(dialog).toBeVisible()
			await expect(dialog.getByRole("heading", { name: "Share with contacts", exact: true })).toBeVisible()

			// Terminal render states mirror waitForListingSettled above: this free account has no contacts,
			// so the empty state is what actually renders here, but a populated account's own listbox is
			// asserted too so this test still holds if that ever changes — never a crash either way.
			const noContacts = dialog.getByText("No contacts", { exact: true })
			const contactsListbox = dialog.getByRole("listbox", { name: "Contacts" })
			await expect(noContacts.or(contactsListbox)).toBeVisible()

			// Nothing is selected — the submit stays disabled regardless of whether any contacts rendered.
			const shareSubmit = dialog.getByRole("button", { name: "Share", exact: true })
			await expect(shareSubmit).toBeDisabled()

			// Dismiss without ever pressing the picker's own Share — a live share reaches another account,
			// so this suite never sends one.
			await page.keyboard.press("Escape")
			await expect(dialog).toHaveCount(0)
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

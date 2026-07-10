import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { dismissStartupReminders } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Contact requests, blocks, and removals are OUTWARD-FACING: a request lands in another Filen
// account's inbox, and a block/remove changes another account's own contact list too. Unlike drive's
// create→trash there is no net-zero undo for any of that, so every test below is render/gate-only —
// dialogs are opened and validated up to (never past) their own submit/confirm button, then always
// dismissed via Escape instead. The injected session's own account content (contacts/requests/
// blocked) is real, live, and unknown ahead of time — currently empty — so every test holds
// regardless, gated on `hasContacts` wherever a row is actually needed (see waitForContactsSettled).
//
// Client-nav only: the e2e injection hook (src/e2e-hooks/index.ts, seedFromSlot) re-seeds the session
// on every load and then navigates to "/", which redirects to /drive — a hard goto/reload on any
// OTHER authed route bounces back to /drive before that route's own content ever renders. Reaching
// /contacts is always goto("/drive") (the hook's own target, so it always lands correctly) followed
// by a real in-app click on the rail link — see gotoContacts below, the one path that survives it.
//
// Chromium-only: ContactsList fires two real authenticated reads on mount (useContactsQuery,
// useContactRequestsQuery) — the same worker cross-origin SDK call path drive's listDir hangs on, from
// a different call site but the same root cause (helpers/firefox.ts, FIREFOX_HANG_REASON).

// The one path into /contacts that survives the injection hook's own re-seed-then-navigate (see the
// module doc comment above): goto("/drive") always lands correctly, then a real in-app client-side
// click on the rail link reaches /contacts without ever hard-loading it.
async function gotoContacts(page: Page): Promise<void> {
	await page.goto("/drive")

	// The authed shell raises a blocking startup reminder modal that renders the rest of the app inert/
	// aria-hidden until dismissed — while it is open the shell's own nav/rail are not in the role tree,
	// so it must be dismissed BEFORE the nav assertion or rail click below. This path reaches /contacts
	// via a direct rail click, never through the listing gate that dismisses it.
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	await page.getByRole("link", { name: "Contacts", exact: true }).click()
	await page.waitForURL(/\/contacts$/)
}

// The content region below the search/Add-contact toolbar has exactly one of three terminal states —
// loading skeleton, load error, or settled (the "No contacts" empty state, or >=1 rendered section) —
// mirroring drive.spec.ts's waitForListingSettled: a load error leaves neither settled locator
// visible, which times out here exactly like any other stuck-loading failure, rather than being
// silently treated as fine. Scoped to the <main> landmark so it can never match a heading from the
// icon rail / drive sidebar that render alongside every authed route (including this one).
async function waitForContactsSettled(page: Page): Promise<{ hasContacts: boolean }> {
	const main = page.getByRole("main")
	const empty = main.getByText("No contacts", { exact: true })
	const sectionHeading = main.getByRole("heading", { level: 2 }).first()

	await expect(empty.or(sectionHeading)).toBeVisible()

	return { hasContacts: await sectionHeading.isVisible() }
}

test.describe("contacts", () => {
	test("client-nav to /contacts renders the view and marks the rail link current", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoContacts(page)

		await expect(page.getByRole("searchbox", { name: "Search contacts" })).toBeVisible()
		await waitForContactsSettled(page)
		await expect(page.getByText("Couldn't load contacts", { exact: true })).toHaveCount(0)

		await expect(page.getByRole("link", { name: "Contacts", exact: true })).toHaveAttribute("aria-current", "page")
	})

	test("the add-contact dialog gates an invalid email and is dismissed without ever submitting", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoContacts(page)

		await page.getByRole("button", { name: "Add contact", exact: true }).click()

		const dialog = page.getByRole("dialog")
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole("heading", { name: "Add contact", exact: true })).toBeVisible()

		// Trigger and submit share the exact same label ("Add contact") — the submit button only exists
		// unambiguously once scoped to the dialog itself.
		const emailInput = dialog.getByLabel("Email", { exact: true })
		const submit = dialog.getByRole("button", { name: "Add contact", exact: true })
		await expect(submit).toBeDisabled()

		await emailInput.fill("not-an-email")
		await expect(submit).toBeDisabled()

		await emailInput.fill("e2e-probe@example.com")
		await expect(submit).toBeEnabled()

		// Dismiss without ever pressing submit — a contact request reaches another user's account, so
		// this suite never sends a live one.
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})

	test("the Select toggle renders, gated on whether this account has any contacts or requests", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoContacts(page)
		const { hasContacts } = await waitForContactsSettled(page)

		const selectButton = page.getByRole("button", { name: "Select", exact: true })
		await expect(selectButton).toBeVisible()

		if (!hasContacts) {
			await expect(selectButton).toBeDisabled()
			return
		}

		await expect(selectButton).toBeEnabled()
		await selectButton.click()

		const clearSelection = page.getByRole("button", { name: "Clear selection", exact: true })
		await expect(clearSelection).toBeVisible()
		await expect(page.getByText("0 selected", { exact: true })).toBeVisible()

		// Exit select mode again — a purely local UI toggle, no query or mutation involved.
		await clearSelection.click()
		await expect(selectButton).toBeVisible()
	})

	test("an established contact's destructive row action opens a confirm dialog and dismisses without mutating", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoContacts(page)
		const { hasContacts } = await waitForContactsSettled(page)
		test.skip(!hasContacts, "this account has no contacts, requests, or blocked entries to act on")

		// Only established-contact rows expose the destructive ⋯ menu (Remove/Block) — request/pending/
		// blocked rows use direct, non-destructive icon buttons instead (Accept/Deny, Cancel, Unblock).
		const moreActions = page.getByRole("button", { name: "More actions", exact: true }).first()
		test.skip(!(await moreActions.isVisible()), "no established contact row in this account — the destructive menu is contacts-only")

		await moreActions.click()
		const menu = page.getByRole("menu")
		await expect(menu).toBeVisible()

		await menu.getByRole("menuitem", { name: "Remove", exact: true }).click()

		const confirm = page.getByRole("alertdialog")
		await expect(confirm).toBeVisible()
		await expect(confirm.getByRole("heading", { name: "Remove contact?", exact: true })).toBeVisible()

		// Dismiss without ever pressing the dialog's own "Remove" confirm — removing a contact is
		// outward-facing (it changes the other person's contact list too), so this suite never mutates it.
		await page.keyboard.press("Escape")
		await expect(confirm).toHaveCount(0)
	})
})

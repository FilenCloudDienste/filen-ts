import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { BOOT_SETTLE_TIMEOUT_MS, bootTo } from "./helpers/listing"
import { MOD_KEY } from "./helpers/modkey"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Contact requests, blocks, and removals are OUTWARD-FACING: a request lands in another Filen
// account's inbox, and a block/remove changes another account's own contact list too. Unlike drive's
// create→trash there is no net-zero undo for any of that, so every test below is render/gate-only —
// dialogs are opened and validated up to (never past) their own submit/confirm button, then always
// dismissed via Escape instead. The injected session's own account content (contacts/requests/
// blocked) is real, live, and unknown ahead of time — currently empty — so every test holds
// regardless, gated on `hasContacts` wherever a row is actually needed (see waitForContactsSettled).
//
// Chromium-only: ContactsList fires two real authenticated reads on mount (useContactsQuery,
// useContactRequestsQuery) — the same worker cross-origin SDK call path drive's listDir hangs on, from
// a different call site but the same root cause (helpers/firefox.ts, FIREFOX_HANG_REASON).

// Boot to the shell, then reach /contacts the way a reader does: a real in-app client-side rail click,
// which is itself what the first test below asserts.
async function gotoContacts(page: Page): Promise<void> {
	await bootTo(page)

	await page.getByRole("link", { name: "Contacts", exact: true }).click()
	// The rail's own Contacts entry always passes an explicit `section: "all"` search param (see
	// iconRail.tsx — required by the route's own non-optional search schema), so the landing URL is
	// never bare "/contacts".
	await page.waitForURL(/\/contacts\?section=all$/)
}

// The content region below the search/Add-contact toolbar has exactly one of three terminal states —
// loading skeleton, load error, or settled (the "No contacts" empty state, or >=1 rendered section).
// All three are raced, the same way helpers/listing.ts races the drive listing's: losing to the error
// state throws immediately, carrying the SDK's own decrypted message (contactsList.tsx renders
// errorLabel(...) under the "Couldn't load contacts" title), instead of spending the whole budget and
// reporting a stuck-loading timeout that names nothing. Scoped to the <main> landmark so it can never
// match a heading from the icon rail / drive sidebar that render alongside every authed route.
async function waitForContactsSettled(page: Page): Promise<{ hasContacts: boolean }> {
	const main = page.getByRole("main")
	const empty = main.getByText("No contacts", { exact: true })
	const sectionHeading = main.getByRole("heading", { level: 2 }).first()
	const failed = main.getByText("Couldn't load contacts", { exact: true })

	await expect(empty.or(sectionHeading).or(failed)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

	if (await failed.isVisible().catch(() => false)) {
		// The error branch renders its whole Empty as role="alert" (contactsList.tsx), so the title and
		// the SDK's own reason come back together. .first(): this runs on the failure path, where a
		// strict-mode violation would replace the diagnosis it exists to carry.
		throw new Error(`Contacts settled to its error state: ${await main.getByRole("alert").first().innerText()}`)
	}

	return { hasContacts: await sectionHeading.isVisible() }
}

test.describe("contacts", () => {
	test("client-nav to /contacts renders the view and marks the rail link current", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoContacts(page)

		await expect(page.getByRole("searchbox", { name: "Search contacts" })).toBeVisible()
		// Throws on the load-error state, so reaching here is itself the proof the queries resolved.
		await waitForContactsSettled(page)

		// The stats strip (new, web-only — see contactsList.tsx) renders three count tiles once the
		// queries settle; a render/count-visibility check only, the live counts are unknown ahead of time.
		const statsStrip = page.getByRole("group", { name: "Contacts summary" })
		await expect(statsStrip).toBeVisible()
		await expect(statsStrip.getByText("Contacts", { exact: true })).toBeVisible()
		await expect(statsStrip.getByText("Requests", { exact: true })).toBeVisible()
		await expect(statsStrip.getByText("Blocked", { exact: true })).toBeVisible()

		// Scoped to the rail's own "Filen" nav landmark — the contacts sidebar's own "Contacts" section
		// filter link (see the sidebar test below) shares this exact accessible name, so an unscoped
		// lookup here would be a strict-mode violation (two matches) now that the sidebar exists.
		await expect(page.getByRole("navigation", { name: "Filen" }).getByRole("link", { name: "Contacts", exact: true })).toHaveAttribute(
			"aria-current",
			"page"
		)
	})

	test("the contacts sidebar renders every section filter, defaults to All, and switching updates the active link, URL, and heading", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoContacts(page)
		await waitForContactsSettled(page)

		// The sidebar is the one <aside> (role "complementary") on this route — scoping every lookup
		// below to it avoids colliding with the rail's own "Contacts" entry-point link.
		const sidebar = page.getByRole("complementary")
		const main = page.getByRole("main")

		for (const label of ["All", "Requests", "Pending", "Contacts", "Blocked"]) {
			await expect(sidebar.getByRole("link", { name: label, exact: true })).toBeVisible()
		}

		// gotoContacts already landed on "?section=all" (the rail's own explicit default) — the sidebar's
		// "All" entry is current, and the page's own <h1> reads the generic module title rather than any
		// one section's name.
		await expect(sidebar.getByRole("link", { name: "All", exact: true })).toHaveAttribute("aria-current", "page")
		await expect(main.getByRole("heading", { name: "Contacts", exact: true, level: 1 })).toBeVisible()

		await sidebar.getByRole("link", { name: "Blocked", exact: true }).click()
		await page.waitForURL(/\/contacts\?section=blocked$/)

		await expect(sidebar.getByRole("link", { name: "Blocked", exact: true })).toHaveAttribute("aria-current", "page")
		await expect(sidebar.getByRole("link", { name: "All", exact: true })).not.toHaveAttribute("aria-current", "page")
		await expect(main.getByRole("heading", { name: "Blocked", exact: true, level: 1 })).toBeVisible()

		// Switching back to All re-serializes "?section=all" explicitly — every filter, "all" included,
		// always appears in the URL (see routes/_app/contacts.tsx's own doc comment on why no
		// default-eliding middleware is used here).
		await sidebar.getByRole("link", { name: "All", exact: true }).click()
		await page.waitForURL(/\/contacts\?section=all$/)
		await expect(sidebar.getByRole("link", { name: "All", exact: true })).toHaveAttribute("aria-current", "page")
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

	test("rows are permanently selectable listbox options with a roving Tab stop", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoContacts(page)
		const { hasContacts } = await waitForContactsSettled(page)

		// The selection model converged on the app-wide one: no mode to enter, and the search box is
		// never swapped out for a selection bar. Asserted before the content skip so it holds on an
		// account with no contacts at all.
		//
		// A raw element probe, not getByRole: role queries skip anything under an `aria-hidden` subtree,
		// and Base UI's markOthers stamps exactly that on everything outside an open modal — so with a
		// startup reminder standing, a getByRole absence check passes without ever looking at the shell.
		await expect(page.locator('button:text-is("Select"), button[aria-label="Select"]')).toHaveCount(0)
		await expect(page.getByRole("searchbox", { name: "Search contacts" })).toBeVisible()

		test.skip(!hasContacts, "account has no contacts, requests or blocked users to select")

		// Scoped to ONE section listbox: <main> spans up to four of them and the cursor is per section,
		// so an ArrowDown from the last row of section 1 clamps inside section 1.
		const list = page.getByRole("main").getByRole("listbox").first()
		const options = list.getByRole("option")

		await options.first().click()
		await expect(options.first()).toHaveAttribute("aria-selected", "true")
		// Roving tabindex: the cursor row owns the section's only Tab stop.
		await expect(options.first()).toHaveAttribute("tabindex", "0")

		// Retried, never a one-shot count(): the section's rows render as their query settles, so a bare
		// read taken a beat early silently drops the multi-select leg below without ever failing.
		const hasSecondRow = await options
			.nth(1)
			.waitFor({ state: "visible", timeout: 10_000 })
			.then(() => true)
			.catch(() => false)

		if (hasSecondRow) {
			await expect(options.nth(1)).toHaveAttribute("tabindex", "-1")

			await page.keyboard.press("ArrowDown")
			await expect(options.nth(1)).toBeFocused()
			await expect(options.nth(1)).toHaveAttribute("tabindex", "0")
			// The cursor moved; the selection did not.
			await expect(options.first()).toHaveAttribute("aria-selected", "true")

			await options.nth(1).click({ modifiers: [MOD_KEY] })
			await expect(page.getByText("2 selected", { exact: true })).toBeVisible()
		}

		// Escape clears — a purely local UI reset, no query or mutation involved.
		await page.keyboard.press("Escape")
		await expect(options.first()).toHaveAttribute("aria-selected", "false")
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
		// Retried, never isVisible(): that reads the DOM as it stands and never waits, so a section whose
		// rows had not painted yet SKIPPED this test silently instead of running it.
		const moreActions = page.getByRole("button", { name: "More actions", exact: true }).first()
		const hasEstablishedContact = await moreActions
			.waitFor({ state: "visible", timeout: 10_000 })
			.then(() => true)
			.catch(() => false)

		test.skip(!hasEstablishedContact, "no established contact row in this account — the destructive menu is contacts-only")

		await moreActions.click()
		const menu = page.getByRole("menu")
		await expect(menu).toBeVisible()

		// Message is the row menu's first (non-destructive) entry, ahead of Remove/Block. Render-only:
		// clicking it would create a real chat with this live contact (outward-facing, same as Remove/Block
		// below), so this suite only confirms it's offered, never activates it.
		await expect(menu.getByRole("menuitem", { name: "Message", exact: true })).toBeVisible()

		await menu.getByRole("menuitem", { name: "Remove", exact: true }).click()

		// Scoped to THIS confirm's own title rather than "an alertdialog": the startup account reminders
		// are alertdialogs too and mount asynchronously, so a bare role lookup is a strict-mode hazard,
		// can aim the Escape below at the wrong dialog, and makes the toHaveCount(0) at the end fail on a
		// confirm that did close.
		const confirm = page.getByRole("alertdialog").filter({ has: page.getByRole("heading", { name: "Remove contact?", exact: true }) })
		await expect(confirm).toBeVisible()

		// Dismiss without ever pressing the dialog's own "Remove" confirm — removing a contact is
		// outward-facing (it changes the other person's contact list too), so this suite never mutates it.
		await page.keyboard.press("Escape")
		await expect(confirm).toHaveCount(0)
	})
})

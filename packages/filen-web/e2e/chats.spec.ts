import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { dismissStartupReminders } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Chats shell smoke + C2 conversation-action affordances: the rail entry navigates to /chats, the
// contextual sidebar renders, the empty-conversation state shows on the zero-contacts FREE account, the
// index/thread route shows its select prompt, and the New chat button opens the contact picker up to
// (never past) its own disabled submit. Net-zero — nothing is created (createChat is UI-gated on picking
// a contact, and the shared account has zero contacts, so no real conversation can exist; the composer
// sends nothing this wave). Menus on an actual conversation row need a conversation this account can
// never have — that coverage is unit-level (chatMenu.test.ts, chatsActions.test.ts, chatsParticipants.
// test.ts, chatsMessageMenu.test.ts).
//
// Client-nav only (same constraint as contacts.spec.ts / notes.spec.ts): the injection hook re-seeds and
// navigates to "/" → /drive on every load, so a hard goto to /chats bounces back before it renders. The
// one path into /chats is goto("/drive") then a real in-app rail click.
//
// Chromium-only: the ChatsSidebar fires an authenticated read (listChats) on mount — the same cross-origin
// worker SDK path that hangs on Playwright-firefox (helpers/firefox.ts).
test.describe.configure({ mode: "serial" })

async function gotoChats(page: Page): Promise<void> {
	await page.goto("/drive")

	// The authed shell raises a blocking startup reminder modal that renders the rest of the app inert until
	// dismissed — it must go before the rail is in the role tree for the click below.
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	await page.getByRole("link", { name: "Chats", exact: true }).click()
	await page.waitForURL(/\/chats(\/|$)/)
}

test.describe("chats", () => {
	test("rail entry navigates to /chats and renders the contextual sidebar", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		await expect(page.getByRole("link", { name: "Chats", exact: true })).toHaveAttribute("aria-current", "page")
		await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeVisible()
	})

	test("the empty-conversation state renders on the zero-contacts account", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		// listChats() on the clean account returns [] → the empty copy. The sidebar (complementary) resolves
		// to a terminal state (empty copy OR at least one conversation row) — never a permanent spinner.
		const sidebar = page.getByRole("complementary")
		const emptyState = sidebar.getByText("No conversations yet", { exact: true })

		await expect(emptyState.or(sidebar.getByRole("link").first())).toBeVisible()
	})

	test("the index route shows the select prompt (no auto-selected conversation)", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		// Chats does not auto-redirect into a thread (unlike notes) — the main card shows the select prompt,
		// and the URL stays on bare /chats.
		await expect(page).toHaveURL(/\/chats$/)
		await expect(page.getByText("Select a conversation", { exact: true })).toBeVisible()
	})

	// The one thing about conversation CREATION confidently e2e-provable on the zero-contacts account
	// (synthesis §4): the picker opens, settles on its own terminal state (this account's empty-contacts
	// copy; a populated listbox is asserted too so this test still holds if that ever changes — mirrors
	// share.spec.ts's own hasContacts-agnostic pattern), and is dismissed via Escape WITHOUT ever
	// selecting a contact. createChat is UI-gated on a non-empty selection (the submit stays disabled),
	// so this path never calls it — net-zero, no conversation exists afterward.
	test("the New chat button opens the contact picker; dismissing creates nothing", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		await page.getByRole("button", { name: "New chat", exact: true }).click()

		const dialog = page.getByRole("dialog")
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole("heading", { name: "New chat", exact: true })).toBeVisible()

		// Terminal render state only, either is acceptable (see the test's own doc comment above) — proves
		// the picker settled instead of hanging on a stuck loading skeleton.
		const noContacts = dialog.getByText("No contacts", { exact: true })
		const contactsListbox = dialog.getByRole("listbox", { name: "Contacts" })
		await expect(noContacts.or(contactsListbox)).toBeVisible()

		// Nothing is selected — the submit stays disabled regardless of whether any contacts rendered.
		const createSubmit = dialog.getByRole("button", { name: "Create", exact: true })
		await expect(createSubmit).toBeDisabled()

		// Dismiss without ever selecting a contact — createChat is never called.
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)

		// Still on the bare index route — nothing changed.
		await expect(page).toHaveURL(/\/chats$/)
	})
})

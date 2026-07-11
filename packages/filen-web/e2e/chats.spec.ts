import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { dismissStartupReminders } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Chats shell smoke + C2 conversation-action affordances + the C3 send-outbox proof: the rail entry
// navigates to /chats, the contextual sidebar renders, the empty-conversation state shows on the
// zero-contacts FREE account, the index/thread route shows its select prompt, and the New chat button
// opens the contact picker up to (never past) its own disabled submit. The UI-driven surface stays
// net-zero (createChat is UI-gated on picking a contact the shared account doesn't have). The outbox
// tests DO create real conversations — via a zero-participant self-chat (createChat([]), backend-
// accepted) renamed "e2e-chat-<ts>" for sweepability — and delete them in a leak-guarded teardown, so
// the account is left net-zero. Menus on an actual conversation row are covered unit-level.
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

// Leak guard: any conversation created during `body` that survives it (a failed teardown) is swept by
// diffing the account's chat-uuid set before/after — serial mode guarantees any new uuid belongs to the
// running test. Mirrors notes.spec's withNoteLeakGuard; the "e2e-chat-" name prefix is the cleanup-setup
// backstop for a body that dies before it even learns its uuid.
async function withChatLeakGuard(page: Page, body: () => Promise<void>): Promise<void> {
	const before = new Set(await page.evaluate(() => window.__filenE2E.listTestChatUuids()))

	try {
		await body()
	} finally {
		try {
			const after = await page.evaluate(() => window.__filenE2E.listTestChatUuids())

			for (const uuid of after) {
				if (!before.has(uuid)) {
					await page.evaluate(id => window.__filenE2E.deleteTestChatByUuid(id), uuid)
				}
			}
		} catch {
			// Page already gone — the real failure stays the reported one.
		}
	}
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

	// The send outbox's crown-jewel proof, reachable on the zero-contacts account via a self-chat
	// (createChat([]), backend-accepted). Drives the outbox transport through the test hook (no composer
	// UI this wave) rather than through a keystroke. OFFLINE while enqueuing so the durable-persist is
	// observable BEFORE any send, then reconnects and asserts the reconnect trigger delivers it.
	test("the send outbox persists a message to disk and delivers it on reconnect (self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		await withChatLeakGuard(page, async () => {
			const uuid = await page.evaluate(() => window.__filenE2E.createTestSelfChat())
			const text = `outbox-${String(Date.now())}`

			// Enqueue while OFFLINE: the send can't fire, so the durable persist is observable on its own.
			await page.context().setOffline(true)

			const flushed = await page.evaluate(([u, t]) => window.__filenE2E.enqueueTestChatMessage(u, t), [uuid, text] as const)
			expect(flushed).toBe(true)

			// The message is durable on disk (OPFS) BEFORE any send — the survives-window-close guarantee.
			await expect.poll(() => page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)).toContain(text)

			// Reconnect: the outbox's onlineManager trigger flushes the queue → the send commits.
			await page.context().setOffline(false)

			await expect
				.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
				.toContain(text)

			await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid)
		})
	})

	// Kill-path: enqueue → kill the tab before the send can complete → reopen → replay-on-launch sends it
	// → the server has EXACTLY ONE copy (the temporal commit-boundary dedupe held). Asserts both delivery
	// and count. Enqueues OFFLINE so the ONLY delivery path is the post-reload replay (the send never
	// fires pre-kill), which is exactly what proves durability + at-least-once + the dedupe bound.
	test("kill-path: a queued send survives a tab reload and replays exactly once", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		await withChatLeakGuard(page, async () => {
			const uuid = await page.evaluate(() => window.__filenE2E.createTestSelfChat())
			const text = `killpath-${String(Date.now())}`

			// Enqueue offline: persisted to disk, never sent before the kill.
			await page.context().setOffline(true)

			await page.evaluate(([u, t]) => window.__filenE2E.enqueueTestChatMessage(u, t), [uuid, text] as const)

			await expect.poll(() => page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)).toContain(text)

			// Kill the tab. A fresh page + fresh outbox: the only way the message can now reach the server
			// is the replay of the durable queue on the reloaded shell.
			await page.context().setOffline(false)
			await page.reload()
			await dismissStartupReminders(page)
			await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

			// Replay delivered it...
			await expect
				.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
				.toContain(text)

			// ...exactly once — the commit-boundary dedupe (dequeue-on-commit) held, no duplicate.
			const texts = await page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid)
			expect(texts.filter(t => t === text)).toHaveLength(1)

			await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid)
		})
	})

	// The FULL UI path (composer → outbox → confirmed → reply → edit), on the zero-contacts account via a
	// self-chat. Opens the conversation by clicking its sidebar row (client-nav; the hook seeds the list
	// cache so the row is present), then drives real keystrokes: type + Enter renders the optimistic bubble
	// and the outbox commits it (asserted by a fresh server read); a menu reply renders its reply-to line;
	// a menu edit stamps the edited marker.
	async function openSelfChatThread(page: Page): Promise<string> {
		const uuid = await page.evaluate(() => window.__filenE2E.createTestSelfChat())

		// The seeded row (named "e2e-chat-…") appears in the sidebar; click it to open the thread.
		const row = page.getByRole("complementary").getByRole("link", { name: /e2e-chat-/ })
		await expect(row).toBeVisible({ timeout: 30_000 })
		await row.click()
		await page.waitForURL(new RegExp(`/chats/${uuid}`))

		// Wait for the composer to be interactive before returning: the thread is a lazily-loaded route
		// chunk, and a caller that drops connectivity (the kill-path) inside that load window would fail the
		// pending fetch and bounce the page to a browser error screen. A real user likewise has the thread
		// open — composer visible — before losing connection.
		await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 })

		return uuid
	}

	async function sendViaComposer(page: Page, text: string): Promise<void> {
		const input = page.getByRole("textbox", { name: "Message" })
		await input.click()
		await input.fill(text)
		await input.press("Enter")
	}

	test("composer: type + Enter delivers through the outbox, then reply + edit render (self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		await withChatLeakGuard(page, async () => {
			const uuid = await openSelfChatThread(page)
			const text = `ui-send-${String(Date.now())}`

			// Scope every message-body locator to the thread pane: once the outbox commits, the ChatsSidebar
			// row's last-message preview (in the complementary landmark) renders the SAME text, so an unscoped
			// getByText would resolve to two nodes and trip Playwright's strict mode.
			const thread = page.getByRole("main")

			await sendViaComposer(page, text)

			// Optimistic bubble is painted immediately...
			await expect(thread.getByText(text, { exact: true })).toBeVisible()
			// ...and the outbox commits it (fresh server read) — the "Sending…" marker clears on commit.
			await expect
				.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
				.toContain(text)
			await expect(thread.getByText("Sending…", { exact: true })).toHaveCount(0)

			// Reply via the message context menu → the reply chip → a reply that renders its reply-to line.
			await thread.getByText(text, { exact: true }).click({ button: "right" })
			await page.getByRole("menuitem", { name: "Reply", exact: true }).click()

			const replyText = `ui-reply-${String(Date.now())}`
			await sendViaComposer(page, replyText)

			await expect(thread.getByText(replyText, { exact: true })).toBeVisible()
			await expect(thread.getByText(/Replying to/).first()).toBeVisible()
			await expect
				.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
				.toContain(replyText)

			// Edit that reply via the menu → the edited body + the (edited) marker.
			await expect(thread.getByText("Sending…", { exact: true })).toHaveCount(0)
			await thread.getByText(replyText, { exact: true }).click({ button: "right" })
			await page.getByRole("menuitem", { name: "Edit", exact: true }).click()

			const editedText = `ui-edited-${String(Date.now())}`
			const input = page.getByRole("textbox", { name: "Message" })
			await input.fill(editedText)
			await input.press("Enter")

			await expect(thread.getByText(editedText, { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(thread.getByText("(edited)", { exact: true }).first()).toBeVisible()

			await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid)
		})
	})

	// Kill-path THROUGH THE UI: type + Enter while offline (the composer enqueues + persists, never sends),
	// kill the tab, reopen → replay-on-launch delivers it EXACTLY ONCE. Same guarantee as the hook-driven
	// kill-path, proven end-to-end from a real keystroke.
	test("composer kill-path: an offline send survives a reload and replays exactly once (self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		await withChatLeakGuard(page, async () => {
			const uuid = await openSelfChatThread(page)
			const text = `ui-killpath-${String(Date.now())}`

			await page.context().setOffline(true)
			await sendViaComposer(page, text)

			// Persisted to disk (OPFS) before any send — the survives-window-close guarantee, from a keystroke.
			await expect.poll(() => page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)).toContain(text)

			// Kill the tab; only the durable-queue replay on reload can now reach the server.
			await page.context().setOffline(false)
			await page.reload()
			await dismissStartupReminders(page)
			await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

			await expect
				.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
				.toContain(text)

			const texts = await page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid)
			expect(texts.filter(t => t === text)).toHaveLength(1)

			await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid)
		})
	})
})

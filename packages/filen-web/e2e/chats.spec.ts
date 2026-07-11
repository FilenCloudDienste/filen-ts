import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { dismissStartupReminders } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Chats shell smoke + C2 conversation-action affordances + the C3 send-outbox proof + C6 embeds. The rail
// entry navigates to /chats, the contextual sidebar renders, the empty-conversation state shows on the
// zero-contacts FREE account, the index/thread route shows its select prompt, and the New chat button
// opens the contact picker up to (never past) its own disabled submit — those four tests create nothing
// (createChat is UI-gated on picking a contact the shared account doesn't have).
//
// ONE-CHAT DISCIPLINE (C7 restructure): `conversations/create` is a hot, long-window rate limit on the
// shared account, and every send/kill-path/composer/embeds proof below needs a REAL conversation to run
// against. Rather than each test minting (and deleting) its own self-chat — 5 creates + 5 deletes per full
// run — this file creates exactly ONE zero-participant self-chat (`createChat([])`, backend-accepted,
// renamed "e2e-chat-<ts>" for sweepability) in a dedicated serial-mode SETUP test, every test after it
// reuses that same conversation (no test deletes mid-file), and a TEARDOWN test at the end removes it.
// That's 1 create + 1 delete for the whole file — a ~4x cut in create pressure. Message-body assertions
// throughout are scoped to a unique per-test timestamped string (`outbox-<ts>`, `ui-send-<ts>`, …), so
// accumulating history in the shared conversation across tests never makes an assertion ambiguous; none
// of them ever asserted an absolute message count to begin with (the closest, the kill-path's
// `.toHaveLength(1)` dedupe check, filters by that same unique string first).
//
// The setup test follows a 2-attempt rule: one create attempt, and — only if that one throws — a single
// documented backoff then one more attempt. If both fail (the limiter is hot), `sharedChatUuid` stays
// undefined and every dependent test below cascades a documented skip; the shell/dialog tests above are
// unaffected (they never touch a real conversation).
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

// The one shared self-chat this file creates, set by the setup test below and read by every test after
// it. Stays undefined when both create attempts are rate-limited — the cascade-skip signal.
let sharedChatUuid: string | undefined

// Guard/throw-helper (never a bare non-null assertion): every caller sits behind a
// `test.skip(sharedChatUuid === undefined, …)` at its own top, so by the time this runs the value is
// always set — the throw only fires if that invariant is ever broken by a future edit.
function requireSharedChatUuid(): string {
	if (sharedChatUuid === undefined) {
		throw new Error("sharedChatUuid is unavailable — the calling test should have been skipped")
	}

	return sharedChatUuid
}

const CHAT_CREATE_BACKOFF_MS = 5_000

async function tryCreateSharedChat(page: Page): Promise<string | undefined> {
	try {
		return await page.evaluate(() => window.__filenE2E.createTestSelfChat())
	} catch {
		return undefined
	}
}

function sharedChatRow(page: Page) {
	return page.getByRole("complementary").getByRole("link", { name: /e2e-chat-/ })
}

// Proves the chats-list query cache is warm (the real listChats() the sidebar fired on mount resolved and
// included the shared chat) BEFORE a caller drops connectivity — the offline hook-driven tests need the
// cache-first lookup in enqueueTestChatMessage to hit, since a cache miss would otherwise fall back to a
// network read that can't succeed offline.
async function waitForSharedChatRow(page: Page): Promise<void> {
	await expect(sharedChatRow(page)).toBeVisible({ timeout: 30_000 })
}

// Opens the shared conversation via a real sidebar-row click (client-nav; the row only renders once the
// warm cache from waitForSharedChatRow settles) and waits for the composer before returning: the thread is
// a lazily-loaded route chunk, and a caller that drops connectivity inside that load window would fail the
// pending fetch and bounce to a browser error screen.
async function openSharedChatThread(page: Page, uuid: string): Promise<void> {
	await waitForSharedChatRow(page)
	await sharedChatRow(page).click()
	await page.waitForURL(new RegExp(`/chats/${uuid}`))
	await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 })
}

async function sendViaComposer(page: Page, text: string): Promise<void> {
	const input = page.getByRole("textbox", { name: "Message" })
	await input.click()
	await input.fill(text)
	await input.press("Enter")
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
		// to a terminal state (empty copy OR at least one conversation row) — never a permanent spinner. Runs
		// BEFORE the setup test below creates the shared chat, so this still exercises the true zero-state;
		// the .or() keeps it resilient either way (mirrors share.spec.ts's own account-state-agnostic style).
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

	// SETUP — the one and only createChat this file ever calls. Every test below reuses its uuid; none of
	// them deletes it (the teardown test at the end of this describe block is the one delete).
	test("setup: creates the one shared self-chat every test below reuses", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		sharedChatUuid = await tryCreateSharedChat(page)

		if (sharedChatUuid === undefined) {
			// Single documented backoff, then one more attempt — the 2-attempt rule. conversations/create is a
			// hot, long-window limiter on the shared account; this is the ONLY retry this file ever performs.
			await page.waitForTimeout(CHAT_CREATE_BACKOFF_MS)
			sharedChatUuid = await tryCreateSharedChat(page)
		}

		test.skip(
			sharedChatUuid === undefined,
			"conversations/create stayed blocked after 2 attempts — every test below cascades this documented skip"
		)
	})

	// The send outbox's crown-jewel proof, against the shared self-chat. Drives the outbox transport through
	// the test hook (no composer UI this leg — that's the "composer kill-path" test below) rather than
	// through a keystroke. OFFLINE while enqueuing so the durable-persist is observable BEFORE any send,
	// then reconnects and asserts the reconnect trigger delivers it.
	test("the send outbox persists a message to disk and delivers it on reconnect (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()
		const text = `outbox-${String(Date.now())}`

		await gotoChats(page)
		await waitForSharedChatRow(page)

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
	})

	// Kill-path: enqueue → kill the tab before the send can complete → reopen → replay-on-launch sends it
	// → the server has EXACTLY ONE copy (the temporal commit-boundary dedupe held). Asserts both delivery
	// and count (filtered by this test's own unique text — relative, not an absolute conversation count).
	// Enqueues OFFLINE so the ONLY delivery path is the post-reload replay (the send never fires pre-kill),
	// which is exactly what proves durability + at-least-once + the dedupe bound.
	test("kill-path: a queued send survives a tab reload and replays exactly once (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()
		const text = `killpath-${String(Date.now())}`

		await gotoChats(page)
		await waitForSharedChatRow(page)

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
	})

	// The FULL UI path (composer → outbox → confirmed → reply → edit), against the shared self-chat. Opens
	// the conversation by clicking its sidebar row (client-nav; waitForSharedChatRow proves the list cache
	// is warm), then drives real keystrokes: type + Enter renders the optimistic bubble and the outbox
	// commits it (asserted by a fresh server read); a menu reply renders its reply-to line; a menu edit
	// stamps the edited marker.
	test("composer: type + Enter delivers through the outbox, then reply + edit render (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()
		const text = `ui-send-${String(Date.now())}`

		await gotoChats(page)
		await openSharedChatThread(page, uuid)

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
	})

	// Kill-path THROUGH THE UI: type + Enter while offline (the composer enqueues + persists, never sends),
	// kill the tab, reopen → replay-on-launch delivers it EXACTLY ONCE. Same guarantee as the hook-driven
	// kill-path, proven end-to-end from a real keystroke, against the shared self-chat.
	test("composer kill-path: an offline send survives a reload and replays exactly once (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()
		const text = `ui-killpath-${String(Date.now())}`

		await gotoChats(page)
		await openSharedChatThread(page, uuid)

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
	})

	// C6 embeds — the ONE e2e-provable slice (synthesis §4/wave-spec §6): a real Filen public-link CARD
	// resolution needs a premium account to actually own a link (the shared account is FREE), so this
	// proves the two things reachable without one, in the SAME shared self-chat/thread: (1) a
	// syntactically-valid but NON-EXISTENT Filen public-link url degrades gracefully — the card renders from
	// the URL'S OWN PARTS (its uuid) rather than hanging or erroring, since getLinkedFile rejects for a link
	// nobody owns; (2) the sender-only "Disable embed" menu entry (gated on classification alone, not
	// resolution success — embeds.logic.ts's hasEmbeds is pure/offline) collapses the card back to a plain
	// link. Direct image/video embed RENDERING has no CORS-safe external host reachable from this harness
	// (queries/chatMessageLinks.ts's own honest browser-SSRF-posture comment) — that leg's classification +
	// resolution logic is covered unit-level only (chatsEmbeds.test.ts, chatsMessageLinks.test.ts), not e2e.
	test("embeds: a Filen-shaped public link renders a degraded card, then Disable embed collapses it (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()

		await gotoChats(page)
		await openSharedChatThread(page, uuid)

		const thread = page.getByRole("main")

		// A syntactically-valid Filen file-link shape (drive/components/linkDialog.logic.ts's own
		// FILE_PUBLIC_LINK_URL_PREFIX) pointing at a uuid nobody owns — getLinkedFile rejects, so the
		// card can only ever render from the url's own parts (no name resolves).
		const linkUuid = crypto.randomUUID()
		const embedUrl = `https://app.filen.io/#/d/${linkUuid}%23${"a".repeat(24)}`

		await sendViaComposer(page, embedUrl)

		// The plain link (MessageContent's own auto-link render) is always present regardless of embed
		// resolution — this is what a failed/disabled embed degrades TO.
		await expect(thread.getByRole("link", { name: embedUrl })).toBeVisible()

		// The card degrades to the raw uuid (FilenLinkCard's own fallback) + its "Filen file" subtitle —
		// proves it rendered from URL PARTS, not a hung/blank state, without ever resolving a name.
		await expect(thread.getByText(linkUuid, { exact: true })).toBeVisible({ timeout: 15_000 })
		await expect(thread.getByText("Filen file", { exact: true })).toBeVisible()

		await expect
			.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
			.toContain(embedUrl)

		// The menu's "Disable embed" entry is sender-only AND confirmed-only (messageMenu.logic.ts) — wait
		// for the UI's own reconciliation (not just the server read above) before opening the menu, same
		// gate the composer test waits on before its own reply/edit menu actions.
		await expect(thread.getByText("Sending…", { exact: true })).toHaveCount(0)

		// Sender-only menu entry, confirm-free — collapses the card back to just the plain link.
		await thread.getByText(linkUuid, { exact: true }).click({ button: "right" })
		await page.getByRole("menuitem", { name: "Disable embed", exact: true }).click()

		await expect(thread.getByText("Filen file", { exact: true })).toHaveCount(0)
		await expect(thread.getByText(linkUuid, { exact: true })).toHaveCount(0)
		await expect(thread.getByRole("link", { name: embedUrl })).toBeVisible()
	})

	// Realtime receive (messageNew live-render + sidebar update + the typing indicator) needs a SECOND,
	// DIFFERENT participant to originate foreign events — the whole point of the socket path is another
	// user's action reaching this one. The shared e2e account is FREE and zero-contacts, so the only
	// conversation obtainable here is a zero-participant SELF-chat: a second session on the same account is
	// the SAME user, so its messages self-reconcile through the own-message dedup and its typing signals are
	// self-filtered (visibleTypingUsers drops own senderId) — neither is observable as a foreign event.
	// Compounded by the HOT create-limiter on this account, this flow is not provable end-to-end here. The
	// realtime handlers + typing state machine are fully covered unit-level (chatsSocketHandlers.test.ts);
	// the `sendTestTypingSignal` hook is the seam a two-user harness would drive once one exists.
	test.skip("realtime: page B's message + typing reach page A live (needs a second distinct user)", async () => {
		// Intentionally empty — documented skip (see the block comment above). Unit coverage stands.
	})

	// TEARDOWN — the one and only delete this file performs, best-effort. The cleanup-setup project's own
	// "e2e-chat-" name-prefix sweep (e2e/setup/cleanup.setup.ts) is the backstop for a run that dies before
	// reaching this test.
	test("teardown: deletes the shared self-chat", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "no shared chat was created this run — nothing to tear down")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()

		await gotoChats(page)

		try {
			await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid)
		} catch {
			// Best-effort, same rationale as every other teardown in this suite — the prefix sweep backstops it.
		}
	})
})

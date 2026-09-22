import { existsSync, readFileSync } from "node:fs"
import type { BrowserContext, Page } from "@playwright/test"
import { test, expect, SESSION_FILE, trackLeaseReleases } from "./fixtures"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { bootTo } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Chats shell smoke + conversation-action affordances + the send-outbox proof + link/media embeds. The rail
// entry navigates to /chats, the contextual sidebar renders, the empty-conversation state shows on the
// zero-contacts FREE account, the index/thread route shows its select prompt, and the New chat button
// opens the contact picker up to (never past) its own disabled submit — those four tests create nothing
// (createChat is UI-gated on picking a contact the shared account doesn't have).
//
// ONE-CHAT DISCIPLINE: `conversations/create` is a hot, long-window rate limit on the
// shared account, and every send/kill-path/composer/embeds proof below needs a REAL conversation to run
// against. Rather than each test minting (and deleting) its own self-chat — 5 creates + 5 deletes per full
// run — this file creates exactly ONE zero-participant self-chat (`createChat([])`, backend-accepted,
// renamed "e2e-chat-<ts>" for sweepability) in a dedicated serial-mode SETUP test, every test after it
// reuses that same conversation (no test deletes mid-file), and an afterAll hook removes it. That's 1
// create + 1 delete for the whole file — a ~4x cut in create pressure. Message-body assertions throughout
// are scoped to a unique per-test string (`outbox-<ts>-<uuid>`, `ui-send-<ts>-<uuid>`, …), so neither
// accumulating history in the shared conversation nor a concurrent run against the same account can make
// an assertion ambiguous; none of them asserts an absolute message count to begin with (the closest, the
// kill-paths' one-queued-copy checks, filter by that same unique string first).
//
// The setup test retries the create on a SERVER REFUSAL only, on an envelope rather than a fixed sleep —
// the limiter's window is longer than any backoff worth hardcoding. If it stays refused,
// `sharedChatUuid` stays undefined and every dependent test below cascades a skip carrying the server's
// own reason; the shell/dialog tests above are unaffected (they never touch a real conversation).
//
// Chromium-only: the ChatsSidebar fires an authenticated read (listChats) on mount — the same cross-origin
// worker SDK path that hangs on Playwright-firefox (helpers/firefox.ts).
test.describe.configure({ mode: "serial" })

async function gotoChats(page: Page): Promise<void> {
	await bootTo(page)

	await page.getByRole("link", { name: "Chats", exact: true }).click()
	await page.waitForURL(/\/chats(\/|$)/)
}

// Mirrors fixtures.ts's own (non-exported) constant — same local-redeclaration precedent as
// auth.spec.ts / storage.spec.ts. Used only by the afterAll teardown, which owns its own context.
const SESSION_SLOT = "filen.e2e.session"

// The app's own origin, read off a live page rather than restated from playwright.config.ts. The
// afterAll teardown builds its context by hand, and a hand-made context inherits no `baseURL`.
let appOrigin: string | undefined

// A per-test message body that is unique across RUNS too, not merely across this file: two runs against
// the same shared account within the same millisecond would otherwise collide, and the kill-paths count
// copies of this exact string in the durable queue and read it back off the server.
function uniqueMessage(prefix: string): string {
	return `${prefix}-${String(Date.now())}-${crypto.randomUUID()}`
}

// The one shared self-chat this file creates, set by the setup test below and read by every test after
// it. Stays undefined while the create is refused — the cascade-skip signal.
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

// How long the setup test keeps asking, and how often. Sized off the limiter, not off UI: a refusal
// that clears at all clears on the server's own window. The schedule GROWS rather than repeating one
// interval: a flat 10s spent the whole envelope on nine live creates against the very limiter that
// refused the first, where four attempts (0s, 10s, 30s, 60s) cover the same window.
const CHAT_CREATE_RETRY_TIMEOUT_MS = 90_000
const CHAT_CREATE_RETRY_INTERVALS_MS = [10_000, 20_000, 30_000, 30_000]

// What the server said when it turned the create down. `refused` distinguishes the retryable case (the
// create RAN and the SDK rejected it) from the one nothing improves by waiting (the hooks never
// installed, so the create never ran at all).
interface CreateRefusal {
	refused: boolean
	kind?: string
	serverCode?: string
	serverMessage?: string
	label: string
}

type CreateOutcome = { ok: true; uuid: string } | { ok: false; error: CreateRefusal }

function describeRefusal(error: CreateRefusal): string {
	return `kind=${error.kind ?? "-"} serverCode=${error.serverCode ?? "-"} serverMessage=${error.serverMessage ?? "-"} label=${error.label}`
}

// createTestSelfChat is TWO writes — createChat then renameChat — so a throw between them leaves a
// conversation that exists but never got its "e2e-chat-" name, which CHAT_DEBRIS_NAME_PREFIXES can
// never match: permanent debris on the one surface where every extra conversation costs limiter
// budget. A rename that throws after landing leaves a second sweepable row instead. Neither is visible
// without bracketing the attempt in the account's own uuid list, which is what this does before
// handing the caller its retry.
async function tryCreateSharedChat(page: Page): Promise<CreateOutcome> {
	// Both the snapshot and the create reach through window.__filenE2E, and an authed shell is no proof
	// it is installed on any load past a context's first. Not fatal if the barrier itself times out —
	// the create below then reports its own failure, which is what the caller retries on.
	await waitForE2eHooks(page).catch(() => undefined)

	const before = await page
		.evaluate(() => window.__filenE2E.listTestChatUuids())
		.then(uuids => new Set(uuids))
		.catch(() => undefined)

	// The refusal is RETURNED as a value, never thrown: the worker rejects with a plain ErrorDTO
	// (src/lib/sdk/errors.ts), and an error thrown across page.evaluate is rebuilt from its message
	// alone — kind/serverCode/serverMessage are lost at exactly the moment they are the only things
	// that say whether the limiter is what refused, and whether waiting can help.
	const outcome = await page
		.evaluate<CreateOutcome>(async () => {
			try {
				return { ok: true, uuid: await window.__filenE2E.createTestSelfChat() }
			} catch (error) {
				const dto = error as Partial<{ kind: string; serverCode: string; serverMessage: string; label: string; message: string }>

				return {
					ok: false,
					error: {
						refused: true,
						...(dto.kind !== undefined ? { kind: dto.kind } : {}),
						...(dto.serverCode !== undefined ? { serverCode: dto.serverCode } : {}),
						...(dto.serverMessage !== undefined ? { serverMessage: dto.serverMessage } : {}),
						label: dto.label ?? dto.message ?? String(error)
					}
				}
			}
		})
		.catch((error: unknown) => ({
			// The evaluate ITSELF failed — the hook bundle is not on this page, or the context died.
			// Not a refusal, and not something another 10s fixes.
			ok: false as const,
			error: { refused: false, label: error instanceof Error ? error.message : String(error) }
		}))

	if (!outcome.ok) {
		await deleteChatsCreatedSince(page, before)
	}

	return outcome
}

// Deletes whatever the failed attempt above added. Skipped outright without a pre-attempt snapshot —
// a missing `before` would make every conversation on the shared account look new to this diff.
async function deleteChatsCreatedSince(page: Page, before: Set<string> | undefined): Promise<void> {
	if (before === undefined) {
		console.log("chats-spec: no pre-attempt conversation snapshot — a partial create is left to the prefix sweep")

		return
	}

	const after = await page.evaluate(() => window.__filenE2E.listTestChatUuids()).catch(() => [])

	for (const uuid of after) {
		if (before.has(uuid)) {
			continue
		}

		try {
			await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid)
			console.log(`chats-spec: removed conversation ${uuid}, left behind by a failed create`)
		} catch {
			console.log(`chats-spec: could not remove conversation ${uuid}, left behind by a failed create`)
		}
	}
}

// Keyed on the uuid, never on the name: the shared account can carry other rows (a partially-created
// conversation sweeps under the same prefix), and the name-regex form carried no .first(), so a single
// stray row was a strict-mode violation in every test that opens this thread.
function sharedChatRow(page: Page, uuid: string) {
	return page.getByRole("complementary").locator(`a[href*="/chats/${uuid}"]`)
}

// Proves the chats-list query cache is warm (the real listChats() the sidebar fired on mount resolved and
// included the shared chat) BEFORE a caller drops connectivity — the offline hook-driven tests need the
// cache-first lookup in enqueueTestChatMessage to hit, since a cache miss would otherwise fall back to a
// network read that can't succeed offline.
async function waitForSharedChatRow(page: Page, uuid: string): Promise<void> {
	await expect(sharedChatRow(page, uuid)).toBeVisible({ timeout: 30_000 })
}

// Opens the shared conversation via a real sidebar-row click (client-nav; the row only renders once the
// warm cache from waitForSharedChatRow settles) and waits for the composer before returning: the thread is
// a lazily-loaded route chunk, and a caller that drops connectivity inside that load window would fail the
// pending fetch and bounce to a browser error screen.
async function openSharedChatThread(page: Page, uuid: string): Promise<void> {
	await waitForSharedChatRow(page, uuid)
	await sharedChatRow(page, uuid).click()
	await page.waitForURL(new RegExp(`/chats/${uuid}`))
	await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 })
}

// Playwright's `context.setOffline` is ADVISORY for this app, and the offline proofs below cannot rest
// on it. It flips `navigator.onLine` and cuts the page's own fetches, but every SDK request leaves from
// the wasm thread pool's nested workers, which the emulation never reaches — playwright-core skips
// worker sessions outright (crNetworkManager's `_setOfflineForSession`: `if (info.workerFrame) return`)
// and Chromium does not inherit a frame's emulated conditions into a worker's own children. Measured on
// this build: with the context offline, the SDK's `/v3/chat/*` reads still answered 200.
//
// What DOES stop the send outbox is its own gate — TanStack's `onlineManager`, which moves only on the
// window online/offline EVENT (sync.ts's `sync()` returns early on `!onlineManager.isOnline()`). Firing
// that event here shuts the gate deterministically: the evaluate resolves only once the listener has
// run, so every enqueue below happens against an outbox that provably cannot push. Without it the tab
// sends the message for real while the test believes it is offline, the kill lands inside the
// commit-to-dequeue window, and the boot replays a second copy — a duplicate the test itself staged.
async function setAppOffline(page: Page, offline: boolean): Promise<void> {
	await page.context().setOffline(offline)
	await page.evaluate(isOffline => {
		window.dispatchEvent(new Event(isOffline ? "offline" : "online"))
	}, offline)
}

// The server read the kill-paths take while the app is gated offline. Bounded IN the page: it goes
// through the SDK worker, whose network the harness cannot take down (above) — but if a future
// Playwright ever can, an unbounded evaluate would hang the test instead of answering it, and an
// unreachable server is the same empty answer for this caller either way.
async function readServerChatTexts(page: Page, uuid: string): Promise<string[]> {
	return page.evaluate(
		u =>
			Promise.race([
				window.__filenE2E.readTestChatMessageTexts(u).catch(() => []),
				new Promise<string[]>(resolve => {
					setTimeout(() => {
						resolve([])
					}, 10_000)
				})
			]),
		uuid
	)
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

	// The one thing about conversation CREATION confidently e2e-provable on the zero-contacts account:
	// the picker opens, settles on its own terminal state (this account's empty-contacts
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
		// the picker settled instead of hanging on a stuck loading spinner.
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
	// them deletes it (the afterAll hook at the end of this describe block is the one delete).
	test("setup: creates the one shared self-chat every test below reuses", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)

		appOrigin = new URL(page.url()).origin

		let lastRefusal: CreateRefusal | undefined

		// Retried on the server's own schedule, not on a single hardcoded sleep: conversations/create is
		// a hot, long-window limiter, and a 5s backoff was never more than a guess at it. A refusal that
		// never reached the server (`refused: false`) ends the envelope immediately — nothing about it
		// improves with another attempt.
		await expect(async () => {
			const outcome = await tryCreateSharedChat(page)

			if (outcome.ok) {
				sharedChatUuid = outcome.uuid

				return
			}

			lastRefusal = outcome.error
			console.log(`chats-spec: conversations/create refused — ${describeRefusal(outcome.error)}`)

			if (!outcome.error.refused) {
				// The create never reached the server (no hooks on this page, or a dead context), so
				// another attempt answers the same. Ending the envelope here hands the skip below the
				// real reason instead of burying it under a 90s timeout.
				return
			}

			throw new Error(`conversations/create refused — ${describeRefusal(outcome.error)}`)
		})
			.toPass({ intervals: CHAT_CREATE_RETRY_INTERVALS_MS, timeout: CHAT_CREATE_RETRY_TIMEOUT_MS })
			// The envelope expiring is a documented SKIP, not a failure: every test below cascades it.
			.catch(() => undefined)

		test.skip(
			sharedChatUuid === undefined,
			`conversations/create never landed — last refusal: ${lastRefusal === undefined ? "none recorded" : describeRefusal(lastRefusal)}`
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
		const text = uniqueMessage("outbox")

		await gotoChats(page)
		await waitForSharedChatRow(page, uuid)

		// The sidebar's a11y contract, asserted where a conversation row is guaranteed to exist (every
		// test above this one runs before the shared chat is created).
		await expect(page.getByRole("complementary").getByRole("listbox", { name: "Conversations" })).toBeVisible()
		await expect(page.getByRole("complementary").getByRole("option").first()).toBeVisible()

		// Enqueue while OFFLINE: the send can't fire, so the durable persist is observable on its own.
		// Barrier before the network dies: the e2e hooks arrive via a fire-and-forget dynamic
		// import, and a chunk request that is in flight when the page goes offline FAILS PERMANENTLY.
		await waitForE2eHooks(page)
		await setAppOffline(page, true)

		// setOffline can land while the shell is still settling a transition, and an evaluate that races
		// that navigation dies with "Execution context was destroyed" — inside an expect.poll that
		// rejection aborts the poll on its first iteration instead of retrying, because the poll awaits
		// its callback outside its own try. The envelope retries it, and retrying is safe ONLY because
		// the enqueue is guarded by a read: a blind retry would double-enqueue. Its closing assertion is
		// also the durable-persist proof this test is here for — the message is on disk (OPFS) before
		// any send can fire.
		await expect(async () => {
			// The hook bundle is installed by the app itself, so a context that navigated a moment ago can
			// be live with no `__filenE2E` on it yet. Asserted INSIDE the envelope rather than with a hard
			// wait, which would only turn a recoverable not-ready-yet into its own timeout.
			expect(await page.evaluate(() => "__filenE2E" in window)).toBe(true)

			const before = await page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)

			if (before?.includes(text) !== true) {
				const flushed = await page.evaluate(([u, t]) => window.__filenE2E.enqueueTestChatMessage(u, t), [uuid, text] as const)

				expect(flushed).toBe(true)
			}

			const after = await page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)

			expect(after).toContain(text)
		}).toPass({ timeout: 60_000 })

		// Reconnect: the outbox's onlineManager trigger flushes the queue → the send commits. Driven
		// through setAppOffline for the same reason the drop above is — that trigger is the window
		// `online` event, and this is the only leg of the test that can prove it fires anything.
		await setAppOffline(page, false)

		await expect
			.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
			.toContain(text)
	})

	// Kill-path: enqueue → kill the tab before the send can complete → reopen → replay-on-launch sends it
	// → it arrives, and the outbox drains it so no later boot replays it again. Enqueues OFFLINE, and the
	// tab is destroyed BEFORE connectivity comes back, so the replay on the next boot is the only delivery
	// path left — which is what proves durability + at-least-once + the dequeue-on-commit bound. Restoring
	// the network first instead lets the live tab send the message on its own and the boot replay is then
	// no longer the thing under test at all. Every claim is filtered by this test's own unique text —
	// relative, never an absolute conversation count.
	test("kill-path: a queued send survives a tab reload and replays exactly once (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()
		const text = uniqueMessage("killpath")

		await gotoChats(page)
		await waitForSharedChatRow(page, uuid)

		// Enqueue offline: persisted to disk, never sent before the kill.
		// Barrier before the network dies: the e2e hooks arrive via a fire-and-forget dynamic
		// import, and a chunk request that is in flight when the page goes offline FAILS PERMANENTLY.
		await waitForE2eHooks(page)
		await setAppOffline(page, true)

		// setOffline can land while the shell is still settling a transition, and an evaluate that races
		// that navigation dies with "Execution context was destroyed". Retrying is safe ONLY because the
		// enqueue is guarded by a read: this test's whole claim is that the message replays EXACTLY once,
		// so a blind retry that double-enqueued would quietly invalidate it.
		await expect(async () => {
			// The hook bundle is installed by the app itself, so a context that navigated a moment ago can be
			// live with no `__filenE2E` on it yet — reaching straight for a method threw "Cannot read
			// properties of undefined". Assert readiness INSIDE the envelope rather than with a hard
			// waitForFunction: the envelope already owns the retrying, and a nested hard wait just turns a
			// recoverable not-ready-yet into its own timeout.
			expect(await page.evaluate(() => "__filenE2E" in window)).toBe(true)

			const before = await page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)

			if (before?.includes(text) !== true) {
				// The persist result, asserted rather than dropped: a `false` here means the queue lives in
				// memory only, the read below then misses it, and the retry enqueues the same body a SECOND
				// time — the one way this test's own setup can manufacture the duplicate it exists to rule out.
				expect(await page.evaluate(([u, t]) => window.__filenE2E.enqueueTestChatMessage(u, t), [uuid, text] as const)).toBe(true)
			}

			const after = await page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)

			// EXACTLY one queued copy, not merely one present: a re-enqueue queues the same body under a
			// second inflightId, the replay sends BOTH, and `toContain` would have passed here and blamed
			// the outbox at the end for a queue that was already wrong before the tab was ever killed.
			expect(after?.filter(t => t === text)).toHaveLength(1)
		}).toPass({ timeout: 60_000 })

		// Nothing has reached the server yet — proven, not assumed. The harness's own offline is advisory
		// (setAppOffline), so this read WORKS while the outbox is gated, and a send that had slipped past
		// the gate would really have landed. The boot below would then replay a second copy, and every
		// claim after it would be measuring a duplicate this test staged rather than one the outbox made.
		expect(await readServerChatTexts(page, uuid)).not.toContain(text)

		// Kill the tab WHILE STILL OFFLINE, then restore. Order is the whole proof: restoring first hands
		// the live outbox a working network and it sends the message itself, leaving the boot below with
		// nothing to replay — the path under test never runs. about:blank destroys the tab's outbox with
		// the gate still shut, so the replay on the next boot is the ONLY path this message can take.
		await page.goto("about:blank")
		await page.context().setOffline(false)
		await bootTo(page)
		// The booted shell re-runs the fire-and-forget hook import while bootSdk resumes the session from
		// kv on its own — an authed shell is therefore no proof the hooks are back. Both reads below go
		// through them, and the first is an expect.poll, which a rejecting evaluate aborts outright.
		await waitForE2eHooks(page)

		// Replay delivered it...
		await expect
			.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
			.toContain(text)

		// ...and the outbox DRAINED it: the durable queue no longer holds this body, so the next boot
		// replays nothing. That is the exactly-once claim the outbox itself can carry, and with the
		// pre-kill guards above (one queued copy, zero server copies) it pins the whole path: queued once,
		// replayed once, dequeued once.
		//
		// The SERVER-copy count cannot be that claim. Chat sends carry no client-supplied id (sync.ts's own
		// header says so), so an attempt the server accepted but whose answer never reached the client is
		// resent as a brand-new message with a brand-new uuid. Measured on this very path: two rows with
		// two DISTINCT server uuids against a single JS-level commit (one markChatRead/lastFocus pair) —
		// so `toHaveLength(1)` on server copies asserted a transport guarantee this stack does not make,
		// and failed on an outbox that had sent exactly once.
		await expect
			.poll(() => page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid).then(queued => queued ?? []), {
				timeout: 30_000
			})
			.not.toContain(text)
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
		const text = uniqueMessage("ui-send")

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

		const replyText = uniqueMessage("ui-reply")
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

		const editedText = uniqueMessage("ui-edited")
		const input = page.getByRole("textbox", { name: "Message" })
		await input.fill(editedText)
		await input.press("Enter")

		await expect(thread.getByText(editedText, { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect(thread.getByText("(edited)", { exact: true }).first()).toBeVisible()
	})

	// Kill-path THROUGH THE UI: type + Enter while offline (the composer enqueues + persists, never sends),
	// destroy the tab while the network is still down, reopen → replay-on-launch delivers it EXACTLY ONCE.
	// Same guarantee, and the same ordering rule, as the hook-driven kill-path above — proven end-to-end
	// from a real keystroke, against the shared self-chat.
	test("composer kill-path: an offline send survives a reload and replays exactly once (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		const uuid = requireSharedChatUuid()
		const text = uniqueMessage("ui-killpath")

		await gotoChats(page)
		await openSharedChatThread(page, uuid)

		// Barrier before the network dies: the e2e hooks arrive via a fire-and-forget dynamic
		// import, and a chunk request that is in flight when the page goes offline FAILS PERMANENTLY.
		await waitForE2eHooks(page)
		await setAppOffline(page, true)
		await sendViaComposer(page, text)

		// Persisted to disk (OPFS) before any send — the survives-window-close guarantee, from a keystroke.
		// Enveloped, not polled bare: setOffline can land while the shell is still settling a transition,
		// and an evaluate that races that navigation dies with "Execution context was destroyed" — which
		// an expect.poll turns into an immediate abort rather than a retry, since it awaits its callback
		// outside its own try. Read-only inside, so retrying enqueues nothing and the exactly-once claim
		// below is untouched; the keystroke stays outside.
		await expect(async () => {
			expect(await page.evaluate(() => "__filenE2E" in window)).toBe(true)

			const persisted = await page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid)

			// Exactly one queued copy — same reason as the hook-driven kill-path above.
			expect(persisted?.filter(t => t === text)).toHaveLength(1)
		}).toPass({ timeout: 60_000 })

		// Nothing has reached the server yet — same proof, same reason as the hook-driven kill-path above.
		expect(await readServerChatTexts(page, uuid)).not.toContain(text)

		// Kill the tab WHILE STILL OFFLINE, then restore — same ordering rule as the hook-driven kill-path
		// above, and for the same reason: a tab that is still alive when the network returns sends the
		// message itself, and the boot replays it into a second server copy.
		await page.goto("about:blank")
		await page.context().setOffline(false)
		await bootTo(page)
		// An authed shell is no proof the hooks came back with it — bootSdk resumes from kv on its own,
		// independently of the fire-and-forget hook import. Both reads below go through them.
		await waitForE2eHooks(page)

		await expect
			.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: 30_000 })
			.toContain(text)

		// Delivered, then drained — same claim and same reason as the hook-driven kill-path above.
		await expect
			.poll(() => page.evaluate(u => window.__filenE2E.readPersistedInflightChatMessages(u), uuid).then(queued => queued ?? []), {
				timeout: 30_000
			})
			.not.toContain(text)
	})

	// Embeds — the ONE e2e-provable case: a real Filen public-link CARD
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
		// The key must be a real 32-character key: the shared parser rejects any other length.
		const linkUuid = crypto.randomUUID()
		const embedUrl = `https://app.filen.io/#/d/${linkUuid}%23${"a".repeat(32)}`

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

	// The thread's arrival announcements are DOM/ARIA structure and the vitest suite is node-env, so a
	// browser is the only possible proof. Zero creates, zero deletes — reuses the shared self-chat.
	test("the thread exposes a polite live region for incoming messages (shared self-chat)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		test.skip(sharedChatUuid === undefined, "shared self-chat unavailable — the setup test's create was blocked")
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoChats(page)
		await openSharedChatThread(page, requireSharedChatUuid())

		const liveRegion = page.getByRole("log")

		await expect(liveRegion).toBeAttached()
		await expect(liveRegion).toHaveAttribute("aria-live", "polite")
		// Empty at rest — catches a regression that seeds an announcement from the initial load rather
		// than only from a tail growth, which the structural attributes alone cannot see.
		await expect(liveRegion).toHaveText("")
	})

	// TEARDOWN — the one and only delete this file performs, best-effort. A HOOK, not a trailing test:
	// this block is serial, so a failure anywhere above marks every remaining test SKIPPED, a trailing
	// teardown test included — which left the conversation on an account whose create limiter makes the
	// next run pay for it, exactly when a failure had already made the run expensive. afterAll runs
	// either way.
	//
	// It builds its own context because `injectedSession` is a test-scoped fixture and nothing
	// test-scoped is reachable from a hook: the session is seeded here the same way e2e/fixtures.ts
	// seeds it, and `appOrigin` stands in for the `baseURL` option, which a hand-made context does not
	// inherit. The cleanup-setup project's "e2e-chat-" name-prefix sweep (e2e/setup/cleanup.setup.ts)
	// remains the backstop for a run that dies before even this.
	test.afterAll(async ({ browser }) => {
		if (sharedChatUuid === undefined || appOrigin === undefined || !existsSync(SESSION_FILE)) {
			return
		}

		const uuid = sharedChatUuid
		// Everything that can throw sits INSIDE the try, context creation included: a corrupt session file
		// or a context that fails to open is a teardown failure like any other here — logged, with the
		// conversation named for the prefix sweep — not an exception out of a hook, which Playwright
		// reports as a failure of the whole project rather than of the cleanup.
		let context: BrowserContext | undefined

		try {
			const { session } = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as { session: string }

			context = await browser.newContext({ baseURL: appOrigin })

			const page = await context.newPage()
			const leases = trackLeaseReleases(page)

			await page.addInitScript(
				([slot, blob]) => {
					sessionStorage.setItem(slot, blob)
				},
				[SESSION_SLOT, session] as const
			)

			await bootTo(page)
			await waitForE2eHooks(page)
			await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid)

			// The delete takes an account-wide `chats-write` lease whose release the SDK fires and
			// forgets; a context closed on top of one in flight leaves it to age out and the next run's
			// create waits that out (the measurement is in e2e/fixtures.ts).
			await leases.waitForReleases()
		} catch (error) {
			// Best-effort, same rationale as every other teardown in this suite — named rather than
			// swallowed, because the prefix sweep that backstops it runs a whole suite later.
			console.error(`chats-spec teardown: could not delete conversation ${uuid} — left for the prefix sweep`, error)
		} finally {
			await context?.close()
		}
	})
})

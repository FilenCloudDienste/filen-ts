import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import { OPEN_OVERLAY_SELECTOR } from "@/lib/keymap/dialogGuard"

// Startup account reminders (master-keys export, storage over limit) are BLOCKING modal alertdialogs
// the authed shell raises once per page LOAD, keys before storage — while open they render the rest of
// the app inert/aria-hidden. THE RULE for every authed spec: no shell interaction or landmark
// assertion before either waitForListingSettled (which calls this first) or an explicit
// dismissStartupReminders on that page — and again after every reload/new page, which re-arms the
// reminders. The "already handled" guard lives in a window flag rather than a WeakSet<Page> ON
// PURPOSE: a reload re-arms the reminders but keeps the same Page object, so a WeakSet would wrongly
// suppress the second dismissal — the window flag clears on reload exactly as the reminders do. First
// pass per load: dismiss never exports keys, so the keys reminder deterministically re-appears for the
// e2e account and is bounded-waited for; storage only fires when over limit, so it is a non-blocking
// snapshot after keys closes. Later same-load calls read the flag and return immediately.
export async function dismissStartupReminders(page: Page): Promise<void> {
	const handled = await page
		.evaluate(() => Boolean((window as unknown as { __e2eRemindersHandled?: boolean }).__e2eRemindersHandled))
		.catch(() => false)

	if (handled) {
		return
	}

	const keysDismiss = page.getByRole("alertdialog").getByRole("button", { name: "Remind me later", exact: true })
	let settledClean: boolean

	try {
		await keysDismiss.click({ timeout: 15_000 })
		settledClean = true
	} catch {
		// Either the reminder never showed (keys already exported) or the authed boot outran the wait.
		// Those are not the same thing, and only the first may latch the flag: a reminder that mounts
		// just after this gets no second chance, and Base UI's markOthers then stamps the whole shell
		// aria-hidden — after which every getByRole on this page matches NOTHING, far from the cause.
		settledClean =
			(await page
				.locator(OPEN_OVERLAY_SELECTOR)
				.count()
				.catch(() => 1)) === 0
	}

	// Waited for, not snapshotted: the storage dialog mounts after the keys one closes, and a one-shot
	// isVisible can lose that race and leave it standing for the rest of the load.
	const storageDismiss = page.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true })

	await storageDismiss.click({ timeout: STORAGE_REMINDER_TIMEOUT_MS }).catch(() => undefined)

	if (!settledClean) {
		return
	}

	await page
		.evaluate(() => {
			;(window as unknown as { __e2eRemindersHandled?: boolean }).__e2eRemindersHandled = true
		})
		.catch(() => undefined)
}

// Resolves once the listing has settled to one of its THREE terminal render states for the CURRENT
// directory: rows, empty, or a load error. All three are raced rather than only the first two —
// emptyState.tsx renders the error variant under its own `listing-error` testid (a deliberately
// DIFFERENT id from the empty variant's, see its comment there), so waiting only on listbox-or-empty
// turned every failed listing query into a bare 15s timeout that named nothing. Losing to the error
// state throws immediately instead, carrying the SDK's own decrypted message (emptyState.tsx renders
// errorLabel(props.error) into the description) — the one string that says WHY the directory did not
// load. The empty state is matched by its stable testid, NOT its copy: every listing variant renders
// its own bespoke empty title ("Nothing here yet" is only the drive variant's), so a copy-based match
// can never settle an empty shared-in/links/trash surface. Returns the listbox locator and whether
// it actually has content, so callers can gate content-dependent assertions on real account state.
// `settleTimeoutMs` exists for the debris sweep, not for tests. A root carrying a large backlog of
// leaked scratch directories renders slower than the expect default allows, so the sweep — the one
// thing that drains that backlog — would time out on exactly the state it exists to repair, leaving
// the account to degrade further every run. Recovery has to tolerate what an assertion should not.
export async function waitForListingSettled(
	page: Page,
	settleTimeoutMs?: number
): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	await dismissStartupReminders(page)

	const listbox = page.getByRole("listbox", { name: "Directory contents" })
	const empty = page.getByTestId("listing-empty")
	const failed = page.getByTestId("listing-error")

	await expect(listbox.or(empty).or(failed)).toBeVisible(settleTimeoutMs === undefined ? undefined : { timeout: settleTimeoutMs })

	if (await failed.isVisible().catch(() => false)) {
		throw new Error(`Listing settled to its error state: ${await failed.innerText()}`)
	}

	return { listbox, hasItems: await listbox.isVisible() }
}

// Ceiling for a wait that closes on a live ACCOUNT WRITE rather than on UI responsiveness. Every
// create/rename/move/trash serialises on the SDK's account-wide drive lock, whose acquisition under
// contention is a poll lottery with no useful bound — a write queued behind a sibling worker's write
// (or behind a lease left by a context torn down mid-write) routinely outlives the 10s expect default,
// and in a setup step that turns into a burnt test plus scratch debris on the shared account.
// Assertions that are genuinely about UI responsiveness keep the tight default.
export const LIVE_WRITE_TIMEOUT_MS = 60_000

// Settle budget for the first listing after a full document load, where the wait covers a COLD BOOT
// (wasm init, the SDK's thread pool, OPFS open) rather than UI responsiveness — the same cost
// playwright.config.ts sizes its navigationTimeout for. The expect default is right everywhere the
// app is already running and wrong here, which on a loaded CI runner reads as a listing that never
// rendered.
export const BOOT_SETTLE_TIMEOUT_MS = 30_000

// Bounded poll for a create that landed after its attempt gave up. Short: it only has to outlast the
// restored snapshot's background refetch, not a write.
const ADOPT_POLL_TIMEOUT_MS = 15_000

// The storage reminder mounts only after the keys one closes, and only when the account is over its
// limit — so this waits briefly rather than snapshotting, and costs that much only when it is absent.
const STORAGE_REMINDER_TIMEOUT_MS = 3_000

// Budget for re-driving the menu/confirm interaction alone — no live write is in flight while this
// retries, so it is sized off UI responsiveness rather than off the lease.
const INTERACTION_RETRY_TIMEOUT_MS = 40_000

// A DIAGNOSTIC must never spend the budget of the thing it is diagnosing, so the probes below are
// pinned instead of inheriting the 15s actionTimeout: isDisabled WAITS for its element (unlike
// isVisible, which answers from the DOM as it stands), and the commonest failure here has the dialog
// already CLOSED — newDirectory.tsx closes it on success, so a create that lands server-side just
// after the pinned row wait gave up leaves both probes matching nothing at all.
const DIALOG_PROBE_TIMEOUT_MS = 2_000

// Snapshot of the create dialog's own state, for the failure message when the outcome never lands.
// These are the three things visible at the moment of failure and none of them reach the report
// otherwise: newDirectory.tsx's handleSubmit KEEPS THE DIALOG OPEN on error and only raises
// toast.error(errorLabel(...)), so the toast text is the sole carrier of the reason; and while the
// SDK call is still in flight inputDialog.tsx disables the name input and the X close button. "Still
// open, still pending" and "still open, rejected" are therefore distinguishable — but only if
// something reads them.
async function describeCreateDialog(page: Page, dialog: Locator): Promise<string> {
	const visible = await dialog.isVisible().catch(() => false)
	// Scoped to the dialog rather than the page: #input-dialog-value is inputDialog.tsx's fixed field
	// id, so it is NOT unique once a second InputDialog is mounted (previewOverlay.tsx renders its own
	// rename prompt from the same primitive).
	const inputDisabled = await dialog
		.locator("#input-dialog-value")
		.isDisabled({ timeout: DIALOG_PROBE_TIMEOUT_MS })
		.catch(() => null)
	const closeDisabled = await dialog
		.getByRole("button", { name: "Close", exact: true })
		.isDisabled({ timeout: DIALOG_PROBE_TIMEOUT_MS })
		.catch(() => null)
	const toasts = await page
		.locator("[data-sonner-toast]")
		.allInnerTexts()
		.catch(() => [])

	return `dialog visible: ${String(visible)}, name input disabled: ${String(inputDisabled)}, close disabled: ${String(closeDisabled)}, toasts: ${JSON.stringify(toasts)}`
}

// The "New directory" dialog round trip, shared by every spec that needs a directory to exist.
// .first(): an EMPTY writable listing renders a second identical "New directory" button inside its
// empty-state "+ Add" affordance (it deliberately reuses the toolbar's own controls), so on an empty
// listing this name matches two buttons. The toolbar's is always first in DOM order (the card header
// precedes the listing body), so .first() is the toolbar button either way.
//
// Closes on the ROW, not on the dialog: newDirectory.tsx keeps the dialog open on error, so "the
// dialog went away" is unsatisfiable on the exact failure this helper exists to report and could only
// ever expire. `listbox` scopes the row lookup to the caller's own listing when it holds one (a
// nested listing's rows and the root's are both "Directory contents"); `expectRow: false` is for the
// one caller that creates a name the display filter deliberately hides, where no row is ever coming.
export async function createDirectoryViaDialog(
	page: Page,
	name: string,
	listbox?: Locator,
	options?: { expectRow?: boolean; writeTimeoutMs?: number }
): Promise<void> {
	await page.getByRole("button", { name: "New directory", exact: true }).first().click()

	// Filtered by its own heading: previewOverlay.tsx composes Base UI's dialog Popup directly, whose
	// role defaults to "dialog" too, so a bare getByRole("dialog") can resolve to the preview surface
	// — or to both at once, which is a strict-mode violation rather than a useful failure.
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New directory", exact: true }) })

	await expect(dialog).toBeVisible()
	await dialog.getByLabel("Name", { exact: true }).fill(name)
	await dialog.getByRole("button", { name: "Create", exact: true }).click()

	const row = (listbox ?? page.getByRole("listbox", { name: "Directory contents" })).getByRole("option", { name })

	try {
		if (options?.expectRow === false) {
			// No row is coming, so the dialog closing is the only outcome signal left — and it closes on
			// the live write itself, hence the write budget rather than the 10s below.
			await expect(dialog).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		} else {
			await expect(row).toBeVisible({ timeout: options?.writeTimeoutMs ?? LIVE_WRITE_TIMEOUT_MS })
			// Only meaningful AFTER the row: the dialog closes on success and stays open on error, so
			// reaching here with it still open means the create landed but the dialog is wedged. Short
			// budget because the write has demonstrably already settled by this point.
			await expect(dialog).toHaveCount(0, { timeout: 10_000 })
		}
	} catch (cause) {
		throw new Error(`createDirectoryViaDialog("${name}") failed — ${await describeCreateDialog(page, dialog)}`, { cause })
	}
}

// Every data-mutating authed spec nests its fixture file(s) inside a per-test scratch directory rather
// than creating them at /drive's root — this suite runs fullyParallel (playwright.config.ts), and a
// root-level create/trash races root-level reads from another spec: drive.spec.ts's own "selection"
// test snapshots the root listbox's option COUNT, then asserts a select-all against it — a TOCTOU a
// concurrent create/trash at root can break, and this exact interference already reproduced live once
// as a flaky drive.spec.ts failure. Nesting confines every count-shifting moment to the two around the
// scratch directory itself (create, final trash) instead of one pair per fixture file.
// A scratch create is the FIRST write a spec makes, and it is the one that meets a `drive-write` lease
// left behind by something that died holding it — a crashed test, a killed CI runner, a cancelled
// workflow. No SDK change can remove that case: a process that dies never releases anything, so the
// lease always has to age out on its own (TTL 30s, refreshed every 15s by a live holder).
//
// Waiting it out is the wrong strategy, and not because 30s is long. The SDK probes for the lock on a
// fibonacci backoff capped at 30s — 0, .25, .5, 1, 1.75, 3, 5, 8.25, 13.5, 22, 35.75, 58, 88s — so once
// past the early attempts it is BLIND for 22s, then 30s at a stretch. A lease that frees at 40s is not
// noticed until 58s; one that frees at 60s, not until 88s. Sitting on a longer timeout mostly buys
// blindness.
//
// A reload is what actually helps: a fresh page is a fresh SDK client whose backoff restarts at zero,
// so it probes immediately instead of inside someone else's 30s gap. Hence retry-with-reload rather
// than a bigger budget. Bounded rather than open-ended (the count is SCRATCH_CREATE_ATTEMPTS below):
// a lease that outlives a run of fresh probes is not transient, and the failure should say so rather
// than hide in a longer wait.
//
// The budgets are what they are because the whole loop AND the caller's teardown have to fit inside one
// test, with room left over: a test the HARNESS kills never releases the lease it holds, while one that
// fails on an assertion's own pin unwinds cleanly, so every wait on this path has to be able to expire
// before the lane's own ceiling does. A failing attempt costs 15s (dismissStartupReminders' own click
// wait, re-armed by every reload, so it recurs on every attempt rather than being paid once) + 3s (the
// storage reminder wait) + 10s (listing settle) + 45s (the pinned create wait) + 4s (the two dialog
// probes above) = 77s, plus 15s for the adopt poll on attempts 2 and up. So the loop's ceiling is
// 77s + 2 x 92s + 2 x 15s reload = 291s. That counts only the PINNED waits: createDirectoryViaDialog's
// button click, name fill and Create click each inherit the 15s actionTimeout and its dialog
// toBeVisible the 10s expect default, another 55s per attempt if they were all to expire. All of the
// 291s is reachable on a run that still PASSES, since the loop retries — so the lane ceiling has to
// clear it with the teardown on top. playwright.config.ts's chromium-write note carries the rest of
// that arithmetic.
//
// The per-attempt wait is sized to OUTLAST a hold, not to duck under the SDK's 22s backoff blind spot.
// That earlier sizing answered sibling starvation, which the lane's single worker has since made
// impossible: the only hold left is an orphaned lease's own 30s TTL, and 45s rides that out where 15s
// abandoned a create that was going to land. Abandoning is not free — it costs a reload, a re-boot and
// a re-settle before the next probe, so a create merely slower than the budget was paying ~24s twice
// over to reach the same directory. Three attempts, because an attempt now outlives the longest hold
// there is; a lease that survives three of them is not transient and the failure should say so.
const SCRATCH_CREATE_ATTEMPTS = 3
const SCRATCH_CREATE_ATTEMPT_TIMEOUT_MS = 45_000
// Pinned below the 30s navigationTimeout default: this only has to reach the document's load event, and
// the app's own boot is waited for by the listing settle at the top of the next attempt.
const SCRATCH_CREATE_RELOAD_TIMEOUT_MS = 15_000

async function createScratchDirectoryWithRetry(
	page: Page,
	name: string
): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	let lastError: unknown

	for (let attempt = 1; attempt <= SCRATCH_CREATE_ATTEMPTS; attempt++) {
		try {
			// Inside the try, not before it: waitForListingSettled throws on the listing's error state, and
			// a listing that failed to load is exactly what a reload fixes — outside, that throw would skip
			// the retry machinery entirely and fail on attempt 1.
			const settled = await waitForListingSettled(page)

			// A create that wedged on the lease is NOT cancelled by throwing the document away — it may
			// still land, and the backend is idempotent by name under a parent, so re-driving the dialog
			// would queue a second write behind the first and lengthen the very hold this loop is waiting
			// out. If the previous attempt's row is here, adopt it instead of writing again.
			// Polled, not a one-shot count: queries/client.ts persists listings, so after a reload the root
			// renders instantly from the restored snapshot and refetches behind it — reading once sees the
			// state from BEFORE the wedged create and adopts nothing, which is the amplification this
			// check exists to prevent.
			const landed =
				attempt > 1 &&
				(await expect
					.poll(() => settled.listbox.getByRole("option", { name }).count(), { timeout: ADOPT_POLL_TIMEOUT_MS })
					.toBeGreaterThan(0)
					.then(() => true)
					.catch(() => false))

			if (landed) {
				console.warn(`enterScratchDirectory: create "${name}" landed late — adopting it instead of retrying the write`)

				return settled
			}

			// A SHORT budget per attempt, deliberately far below LIVE_WRITE_TIMEOUT_MS. Waiting longer here
			// buys almost nothing — the SDK's lock backoff goes blind for 22s, then 30s at a stretch, so a
			// client that missed its window sits idle rather than probing — while a reload starts a fresh
			// client that probes immediately.
			await createDirectoryViaDialog(page, name, settled.listbox, { writeTimeoutMs: SCRATCH_CREATE_ATTEMPT_TIMEOUT_MS })

			return settled
		} catch (error) {
			lastError = error

			if (attempt === SCRATCH_CREATE_ATTEMPTS) {
				break
			}

			// A full reload, not just a retried click: the pending create dialog holds the app modal and
			// inert (undismissable by design while pending), so nothing else on the page is reachable
			// until the document is thrown away — and throwing it away is precisely what resets the
			// backoff. The SAME name is safe to reuse here, unlike the fixtures root: a create that lands
			// late under this name makes the row this helper is waiting for, and descendInto follows it.
			console.warn(`enterScratchDirectory: create "${name}" attempt ${String(attempt)} did not land — reloading and retrying`)

			// Swallowed: this is the loop's own recovery step, and letting it throw would discard both
			// lastError (the real create failure) and every remaining attempt. A reload that did not
			// land simply leaves the next attempt's settle to produce the real diagnosis.
			await page.reload({ timeout: SCRATCH_CREATE_RELOAD_TIMEOUT_MS }).catch(() => undefined)
		}
	}

	throw new Error(
		`enterScratchDirectory could not create "${name}" in ${String(SCRATCH_CREATE_ATTEMPTS)} attempts, each on a fresh page — the account's drive-write lease looks held by something still alive, not merely orphaned`,
		{ cause: lastError }
	)
}

export async function enterScratchDirectory(
	page: Page,
	name: string
): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	// The listing virtualizes its rows (directoryListing.tsx's useVirtualizer, keyed by item uuid) —
	// on a long/shared listing a row sorted well below the fold may not be mounted in the DOM at all, so
	// a locator that depends on finding a SPECIFIC named row (descendInto's row below,
	// trashScratchDirectory's row) can silently miss it. A generously tall viewport makes the scroll
	// container's height exceed any realistic item count's total row height, so the virtualizer renders
	// every row in one pass for the rest of this test — simpler and more robust here than driving
	// synthetic scroll/wheel events against an unknown scroll container to hunt for one row.
	await page.setViewportSize({ width: 1280, height: 8000 })

	const { listbox } = await createScratchDirectoryWithRetry(page, name)

	await descendInto(page, listbox, name)

	return waitForListingSettled(page)
}

// Double-click descent into a directory row, hardened for the shared live account. Retried until the
// URL actually changes: a freshly created row can shift position between the double-click's two
// clicks (the optimistic insert settles against the confirming refetch while parallel specs churn the
// same listing), in which case the two clicks land on different rows and no navigation happens. Then
// gated on the breadcrumb showing the target name: the URL flips before React commits the new listing
// render (router navigations are transition-wrapped), so under CPU load the OLD view — old
// upload-input props included — can linger past the URL change, and an upload fired in that window
// lands in the previous directory. The breadcrumb renders from the same committed tree as the
// toolbar's inputs, so its name is the commit barrier.
export async function descendInto(page: Page, listbox: ReturnType<Page["getByRole"]>, name: string): Promise<void> {
	const row = listbox.getByRole("option", { name })
	await expect(row).toBeVisible()

	const before = page.url()

	try {
		await expect(async () => {
			await row.dblclick()
			await page.waitForURL(url => url.toString() !== before, { timeout: 3000 })
		}).toPass({ timeout: 30_000 })
	} catch (cause) {
		// The retry envelope reports nothing but "timed out" on its own, and the two failure shapes it
		// hides need opposite fixes — so count the rows before rethrowing.
		const matched = await row.count()
		const options = await listbox.getByRole("option").count()

		throw new Error(
			`descendInto("${name}") never left ${before} — ${String(matched)} row(s) matched the name, listing has ${String(options)} option(s). Zero matches means the row was never created or sorts outside the virtualizer's render window; one match means the dblclick landed but resolved no directory target.`,
			{ cause }
		)
	}

	await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText(name, { exact: true })).toBeVisible()
	await waitForListingSettled(page)
}

// Every bulk/action toast here is transient (default 4s duration, no persistent reminder survives past
// dismissStartupReminders), so waiting the stack out is strictly more robust than clicking each toast's
// own dismiss button — a stack several deep would need one click per toast, each racing its own
// auto-expiry. The floating selection bar (bulkActionBar.tsx) and Sonner's default viewport both anchor
// bottom-right, so a toast still fading can sit directly over the bar's own buttons and swallow the
// click. Generous timeout: this can be several toasts deep under parallel-spec load, each observed
// independently rather than assumed to expire in lockstep. A stack that never drains is almost always
// an error toast a write raised — its text is the actual diagnosis, so it is read back on timeout
// instead of being discarded with the locator.
async function waitForToastsClear(page: Page): Promise<void> {
	const toasts = page.locator("[data-sonner-toast]")

	try {
		await expect(toasts).toHaveCount(0, { timeout: 20_000 })
	} catch (cause) {
		throw new Error(`Toasts never cleared: ${JSON.stringify(await toasts.allInnerTexts())}`, { cause })
	}
}

// Selects then removes exactly ONE row by name through the bulk bar (whose buttons are icon-only, so
// the label is their accessible name) — the whole select → toolbar-click → confirm sequence retried as
// a single unit against a FRESHLY re-resolved row locator each attempt. A row captured once outside the
// retry can go from visible to "element is not stable"/detached mid-sequence when the listing reorders
// underneath it (a concurrent spec's own root-level mutation, or the background refetch
// waitForListingSettled's own doc comment describes) — re-querying `listbox.getByRole` inside the
// callback is what actually recovers, the same shape as descendInto's own toPass above.
//
// Only the confirm wait is pinned: it closes on a live account write, so it gets LIVE_WRITE_TIMEOUT_MS
// rather than the 10s expect default — a slow-but-succeeding removal must not trip a retry whose next
// attempt then finds the row already gone. Every other step falls back to the standard budgets
// (expect's config default, actions' own) rather than tight hardcoded ones, which left too little slack
// for a single attempt once waitForToastsClear's own up-to-20s wait was in the mix. The outer envelope
// is sized off the confirm wait so a caller's own override (e.g. drive-search.spec.ts's nested-tree 30s)
// still gets real headroom around it instead of being silently capped by a fixed outer ceiling — and it
// is a HARD ceiling on this whole helper, not merely on the gaps between attempts: toPass races each
// attempt against its deadline (playwright-core's raceAgainstDeadline) rather than letting an in-flight
// one run past it, so a lane budget only ever has to hold confirmTimeoutMs + 40s here.
//
// The confirm closing is NOT the outcome, but it IS the write: useDriveDialogHost's runBulkDialogAction
// keeps the dialog open and pending for the whole bulk operation and then closes it either way, toasting
// whatever failed — so a server-side rejection (which leaves the item exactly where it was) closed it too
// and this reported success. The row disappearing is the only proof the write landed, so that is what the
// attempt now ends on, at the plain expect default rather than the write budget: trashItems patches the
// row out of the listing query cache BEFORE its own promise resolves, so once the confirm is gone the
// disappearance is a React commit, not a round trip. That also makes the "already gone" early return
// load-bearing rather than defensive: once the confirm's action has been clicked, an attempt that dies on
// a slow close-wait may still have completed the write, and the retry after it would otherwise fail on a
// row that is correctly absent. Gating that return on the click (rather than checking on entry) keeps the
// FIRST attempt waiting for a row the listing simply hasn't rendered yet instead of reporting a phantom
// success.
async function selectAndConfirmRowAction(
	page: Page,
	listbox: ReturnType<Page["getByRole"]>,
	name: string | RegExp,
	actionLabel: string,
	confirmTimeoutMs: number
): Promise<void> {
	const row = listbox.getByRole("option", { name })
	// Filtered by its own action button rather than taken as THE alertdialog on the page: a startup
	// reminder is an alertdialog too and can pop asynchronously (this helper runs from teardowns and
	// from the debris sweep, both long after the initial dismissal), which would make a bare role
	// lookup either a strict-mode violation or a click on the wrong dialog. The title differs per
	// caller ("Move to trash?" vs the permanent-delete one) but the action button is `actionLabel` by
	// construction, so the filter needs nothing the caller has not already passed.
	const confirm = page.getByRole("alertdialog").filter({ has: page.getByRole("button", { name: actionLabel, exact: true }) })
	let confirmed = false

	// ONLY the interaction retries, and only until the confirm has been clicked. Everything after that
	// point is the live write, and re-driving the UI there would issue a SECOND one: writes serialise on
	// the account-wide drive-write lease, so a duplicate does not race the first, it queues behind it and
	// extends the hold that every other worker's create is already waiting on. A teardown that thrashed
	// the lock this way starved the next test's creates for the rest of the run.
	await expect(async () => {
		if (confirmed) {
			// Wait the in-flight write out rather than issuing another; only once the confirm has closed
			// is it settled. Still showing the row then means the server REJECTED it (runBulkDialogAction
			// closes either way and toasts the failure), and a rejected write is not in flight — so that
			// one, unlike a slow one, is safe to drive again.
			await expect(confirm).toHaveCount(0, { timeout: confirmTimeoutMs })

			if ((await row.count()) === 0) {
				return
			}

			confirmed = false
		}

		await expect(row).toBeVisible()
		await row.click()
		await waitForToastsClear(page)
		await page.getByRole("button", { name: actionLabel, exact: true }).click()
		await expect(confirm).toBeVisible()
		await confirm.getByRole("button", { name: actionLabel, exact: true }).click()
		confirmed = true
	}).toPass({ timeout: INTERACTION_RETRY_TIMEOUT_MS })

	// Awaited ONCE, never retried. useDriveDialogHost's runBulkDialogAction holds the confirm open and
	// pending for the whole bulk operation and closes it either way, so the close IS the write settling
	// — at the write budget, because acquiring the lease is unbounded under contention. Only then is the
	// row's disappearance a React commit: trashItems patches the listing cache after its SDK call
	// resolves (features/drive/lib/actions.ts), which is already done by the time the confirm closes.
	await expect(confirm).toHaveCount(0, { timeout: confirmTimeoutMs })
	await expect(row).toHaveCount(0)
}

// Exported for the debris sweep in setup/cleanup.setup.ts, which hits the row churn above by
// construction (it runs against a listing that, by definition, still has rows left to remove).
export async function selectAndTrashRow(
	page: Page,
	listbox: ReturnType<Page["getByRole"]>,
	name: string,
	confirmTimeoutMs?: number
): Promise<void> {
	await selectAndConfirmRowAction(page, listbox, name, "Trash", confirmTimeoutMs ?? LIVE_WRITE_TIMEOUT_MS)
}

// /trash's own bulk action. IRREVERSIBLE — the only caller is the trash debris sweep, which selects one
// row at a time by a name it has already matched against isScratchDebrisName. Anchored to the row's OWN
// name rather than the substring match the trash path uses: a row's accessible name concatenates its
// size/date columns (see firstMatchingRowName), so `exact` cannot be used, and a bare substring would
// also accept a row whose name merely CONTAINS a debris name — which for a permanent delete would mean
// destroying an item the predicate never approved.
export async function selectAndDeleteTrashRow(page: Page, listbox: ReturnType<Page["getByRole"]>, name: string): Promise<void> {
	const ownName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)

	await selectAndConfirmRowAction(page, listbox, ownName, "Delete permanently", LIVE_WRITE_TIMEOUT_MS)
}

// One Escape closes exactly ONE layer. Base UI's dismiss handler stands down for any popup that still
// has an open child (useDismiss's hasBlockingChild), so a preview overlay with its own item menu open —
// or with the confirm dialog that menu raises — needs one press per layer. Bounded rather than looped
// to exhaustion: the deepest stack the app can build is a dialog over a menu over the preview, and a
// layer that outlives four presses is not one Escape is ever going to clear.
const OVERLAY_DISMISS_ATTEMPTS = 4

// Clears every layer stacked over the listing, and reports whether it managed to. This is a hard
// PRECONDITION for the sidebar click below, not tidiness: an open Base UI modal marks the whole
// app-shell root `aria-hidden="true"` (FloatingFocusManager's markOthers), and Playwright's role engine
// skips aria-hidden subtrees — so while one is open the sidebar's "Cloud Drive" link is not merely
// covered, it does not EXIST for getByRole, and a click on it can only ever expire against a locator
// that matches nothing. The layers are probed through the app's own raw attribute selector rather than
// getByRole for that same reason: a role-based probe is blinded by the very state it is measuring.
export async function dismissOverlays(page: Page): Promise<boolean> {
	const layers = page.locator(OPEN_OVERLAY_SELECTOR)

	for (let attempt = 0; attempt < OVERLAY_DISMISS_ATTEMPTS; attempt++) {
		await page.keyboard.press("Escape")

		// Counted after the press, so the common case (nothing open, the press a harmless no-op) costs
		// exactly one press plus one count and returns.
		if ((await layers.count().catch(() => 1)) === 0) {
			return true
		}
	}

	return false
}

// Failure-proof companion to enterScratchDirectory above — called from every test's own finally, so
// the scratch directory (and everything created/uploaded into it) is trashed even when an assertion
// above throws. That is also why NOTHING here may throw, the TRASH ITSELF INCLUDED: a throw in a finally
// supersedes the error the test body raised, so one that escaped would delete the real failure and
// report this one in its place. A failed trash is not swallowed, it is REPORTED — console.error naming
// the directory, which is both the loud signal and the handoff to the next run's "e2e-" debris sweep —
// because the alternative (letting it throw) hides the test's own failure AND skips that naming.
// `confirmTimeoutMs` overrides the confirm-dialog wait for a caller whose scratch directory holds more
// than the usual flat handful (drive-search.spec.ts's nested tree is the one caller that sets it).
export async function trashScratchDirectory(page: Page, name: string, confirmTimeoutMs?: number): Promise<void> {
	// The navigation back to root, the settle and the row wait all sit inside the first guard, and for the
	// same reason: none of them failing means anything is wrong with the TEST, only that there is nothing
	// here to remove. Settling is what throws when the root listing itself comes back in its error state,
	// and it has to be caught here rather than propagate out of the caller's finally.
	//
	// The row wait then polls rather than checking once. waitForListingSettled only proves SOME listbox
	// is showing, not that it reflects the scratch directory just created: React Query serves this root
	// query key's LAST-cached result instantly (queries/client.ts's staleTime 0 still triggers a
	// background refetch, but never blocks the already-cached render) — root was cached once already, at
	// this test's own initial goto, before the scratch directory existed. A one-shot visibility check
	// races that background refetch and reliably loses under load; polling rides it out.
	//
	// Either way the directory may still exist on the live account with nothing left to remove it, so
	// name it for the next run's debris sweep instead of losing it silently.
	let listbox: ReturnType<Page["getByRole"]>

	try {
		if (!(await dismissOverlays(page))) {
			// A dialog whose SDK mutation never settled is undismissable by design (Escape is blocked while
			// pending), and its modality makes the whole app inert — nothing here can reach the chrome
			// again while it stands. Only a reload kills that state; the scratch sweep afterwards works
			// exactly as usual. Reached only once Escape has demonstrably failed, so the common path never
			// pays for a fresh app boot.
			await page.goto("/drive")
			await dismissStartupReminders(page)
		}

		// Retried until the URL proves the route actually changed. A sidebar click can silently fail to
		// commit under suite load — menus.spec.ts documents the same thing for its own nav — and every
		// caller reaches here from INSIDE its scratch directory, so an uncommitted click leaves this
		// looking for a root row while still in the child listing. That read as "not reachable, leaked"
		// and returned without trashing, which leaked the directory for real.
		await expect(async () => {
			await page.getByRole("complementary").getByRole("link", { name: "Cloud Drive", exact: true }).click()
			await expect(page).toHaveURL(/\/drive$/, { timeout: 5_000 })
		}).toPass({ timeout: 30_000 })

		listbox = (await waitForListingSettled(page)).listbox

		await expect(listbox.getByRole("option", { name })).toBeVisible({ timeout: 15_000 })
	} catch (error) {
		console.error(
			`trashScratchDirectory: "${name}" is not reachable in the root listing — leaked, left for the next run's sweep`,
			error
		)

		return
	}

	try {
		await selectAndTrashRow(page, listbox, name, confirmTimeoutMs)
	} catch (error) {
		// Distinct from the case above, and worth telling apart in the log: the row WAS there and the
		// account still would not take the write — a rejection, or a lease that outlived the retry
		// envelope, rather than a scratch directory that was never created.
		console.error(`trashScratchDirectory: "${name}" would not trash — leaked, left for the next run's sweep`, error)
	}
}

// Reads the first VISIBLE row's item name that satisfies `predicate`, straight off the live DOM rather
// than a cached snapshot — the debris sweep re-calls this every round specifically so a reorder between
// rounds just yields a different row next time, never a stale one. The row's accessible name also
// carries its size/date columns (see driveRow.tsx), so this reads the name span directly rather than
// the full accessible name a `{ name }` locator filter would substring-match against. Excludes
// `.sr-only` spans: list view's name span is already the row's first span (driveRow.tsx), but grid
// view's favorited badge renders an `.sr-only` label span BEFORE the tile's name span (driveTile.tsx) —
// without the exclusion, a favorited item's "first span" would be that badge, not its name.
export async function firstMatchingRowName(
	listbox: ReturnType<Page["getByRole"]>,
	predicate: (name: string) => boolean
): Promise<string | null> {
	const names = await listbox
		.getByRole("option")
		.evaluateAll(rows => rows.map(row => row.querySelector("span:not(.sr-only)")?.textContent ?? ""))

	return names.find(predicate) ?? null
}

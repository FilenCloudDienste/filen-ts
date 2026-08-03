import type { Page } from "@playwright/test"
import { expect } from "../fixtures"

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

	try {
		await keysDismiss.click({ timeout: 15_000 })
	} catch {
		// Keys already exported (or reminder otherwise not shown) — nothing to dismiss.
	}

	const storageDismiss = page.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true })

	if (await storageDismiss.isVisible().catch(() => false)) {
		await storageDismiss.click()
	}

	await page
		.evaluate(() => {
			;(window as unknown as { __e2eRemindersHandled?: boolean }).__e2eRemindersHandled = true
		})
		.catch(() => undefined)
}

// Resolves once the listing has settled to one of its two terminal render states for the CURRENT
// directory — there is no third: a query error would leave neither locator visible (the error state
// carries its own distinct testid), which is a real, actionable failure like any other timeout here.
// The empty state is matched by its stable testid, NOT its copy: every listing variant renders its
// own bespoke empty title ("Nothing here yet" is only the drive variant's), so a copy-based match
// can never settle an empty shared-in/links/trash surface. Returns the listbox locator and whether
// it actually has content, so callers can gate content-dependent assertions on real account state.
export async function waitForListingSettled(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	await dismissStartupReminders(page)

	const listbox = page.getByRole("listbox", { name: "Directory contents" })
	const empty = page.getByTestId("listing-empty")

	await expect(listbox.or(empty)).toBeVisible()

	return { listbox, hasItems: await listbox.isVisible() }
}

// Ceiling for a wait that closes on a live ACCOUNT WRITE rather than on UI responsiveness. Every
// create/rename/move/trash serialises on the SDK's account-wide drive lock, whose acquisition under
// contention is a poll lottery with no useful bound — a write queued behind a sibling worker's write
// (or behind a lease left by a context torn down mid-write) routinely outlives the 15s expect default,
// and in a setup step that turns into a burnt test plus scratch debris on the shared account.
// Assertions that are genuinely about UI responsiveness keep the tight default.
const LIVE_WRITE_TIMEOUT_MS = 60_000

// The "New directory" dialog round trip, shared by every spec that needs a directory to exist.
// .first(): an EMPTY writable listing renders a second identical "New directory" button inside its
// empty-state "+ Add" affordance (it deliberately reuses the toolbar's own controls), so on an empty
// listing this name matches two buttons. The toolbar's is always first in DOM order (the card header
// precedes the listing body), so .first() is the toolbar button either way.
export async function createDirectoryViaDialog(page: Page, name: string): Promise<void> {
	await page.getByRole("button", { name: "New directory", exact: true }).first().click()

	const dialog = page.getByRole("dialog")

	await expect(dialog).toBeVisible()
	await page.getByLabel("Name", { exact: true }).fill(name)
	await page.getByRole("button", { name: "Create", exact: true }).click()
	await expect(dialog).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
}

// Every data-mutating authed spec nests its fixture file(s) inside a per-test scratch directory rather
// than creating them at /drive's root — this suite runs fullyParallel (playwright.config.ts), and a
// root-level create/trash races root-level reads from another spec: drive.spec.ts's own "selection"
// test snapshots the root listbox's option COUNT, then asserts a select-all against it — a TOCTOU a
// concurrent create/trash at root can break, and this exact interference already reproduced live once
// as a flaky drive.spec.ts failure. Nesting confines every count-shifting moment to the two around the
// scratch directory itself (create, final trash) instead of one pair per fixture file.
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

	const { listbox } = await waitForListingSettled(page)

	await createDirectoryViaDialog(page, name)
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

	await expect(async () => {
		await row.dblclick()
		await page.waitForURL(url => url.toString() !== before, { timeout: 3000 })
	}).toPass({ timeout: 30_000 })

	await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText(name, { exact: true })).toBeVisible()
	await waitForListingSettled(page)
}

// Every bulk/action toast here is transient (default 4s duration, no persistent reminder survives past
// dismissStartupReminders), so waiting the stack out is strictly more robust than clicking each toast's
// own dismiss button — a stack several deep would need one click per toast, each racing its own
// auto-expiry. The floating selection bar (bulkActionBar.tsx) and Sonner's default viewport both anchor
// bottom-right, so a toast still fading can sit directly over the bar's own buttons and swallow the
// click. Generous timeout: this can be several toasts deep under parallel-spec load, each observed
// independently rather than assumed to expire in lockstep.
async function waitForToastsClear(page: Page): Promise<void> {
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 20_000 })
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
// rather than the 15s expect default — a slow-but-succeeding removal must not trip a retry whose next
// attempt then finds the row already gone. Every other step falls back to the standard budgets
// (expect's config default, actions' own) rather than tight hardcoded ones, which left too little slack
// for a single attempt once waitForToastsClear's own up-to-20s wait was in the mix. The outer envelope
// is sized off the confirm wait so a caller's wider override (e.g. drive-search.spec.ts's nested-tree
// 30s) still gets real headroom around it instead of being silently capped by a fixed outer ceiling.
async function selectAndConfirmRowAction(
	page: Page,
	listbox: ReturnType<Page["getByRole"]>,
	name: string | RegExp,
	actionLabel: string,
	confirmTimeoutMs: number
): Promise<void> {
	await expect(async () => {
		const row = listbox.getByRole("option", { name })
		await expect(row).toBeVisible()
		await row.click()
		await waitForToastsClear(page)
		await page.getByRole("button", { name: actionLabel, exact: true }).click()

		const confirm = page.getByRole("alertdialog")
		await expect(confirm).toBeVisible()
		await confirm.getByRole("button", { name: actionLabel, exact: true }).click()
		await expect(confirm).toHaveCount(0, { timeout: confirmTimeoutMs })
	}).toPass({ timeout: confirmTimeoutMs + 40_000 })
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

// Failure-proof companion to enterScratchDirectory above — called from every test's own finally, so
// the scratch directory (and everything created/uploaded into it) is trashed even when an assertion
// above throws. Escape first: authed specs may leave an overlay open (preview overlay, a confirm
// dialog) close enough to the sidebar to risk covering its own "Cloud Drive" link, and dismissing an
// already-closed one is a harmless no-op. `confirmTimeoutMs` lets a caller whose scratch directory
// holds a larger subtree (e.g. drive-search.spec.ts's nested tree) widen the confirm-dialog wait past
// the default.
export async function trashScratchDirectory(page: Page, name: string, confirmTimeoutMs?: number): Promise<void> {
	await page.keyboard.press("Escape")

	// A dialog whose SDK mutation never settled is undismissable by design (Escape is blocked while
	// pending), and its modality makes the whole app inert — the sidebar click below would starve.
	// Only a reload kills that stuck state; the scratch sweep afterwards works exactly as usual.
	const stuckDialog = page.getByRole("dialog").first()
	if (await stuckDialog.isVisible().catch(() => false)) {
		const closeDisabled = await stuckDialog
			.getByRole("button", { name: "Close", exact: true })
			.isDisabled()
			.catch(() => false)
		if (closeDisabled) {
			await page.goto("/drive")
			await dismissStartupReminders(page)
		}
	}

	await page.getByRole("complementary").getByRole("link", { name: "Cloud Drive", exact: true }).click()

	const { listbox } = await waitForListingSettled(page)

	// waitForListingSettled only proves SOME listbox is showing, not that it reflects the scratch
	// directory just created: React Query serves this root query key's LAST-cached result instantly
	// (queries/client.ts's staleTime 0 still triggers a background refetch, but never blocks the
	// already-cached render) — root was cached once already, at this test's own initial goto, before
	// the scratch directory existed. A one-shot visibility check races that background refetch and
	// reliably loses under load; polling rides it out. A genuine timeout (the scratch directory never
	// made it into the listing at all, e.g. enterScratchDirectory itself failed before creating it) is
	// the one case there is nothing to trash.
	try {
		await expect(listbox.getByRole("option", { name })).toBeVisible({ timeout: 15_000 })
	} catch {
		return
	}

	await selectAndTrashRow(page, listbox, name, confirmTimeoutMs)
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

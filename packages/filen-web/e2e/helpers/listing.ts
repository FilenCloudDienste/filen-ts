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
// directory — there is no third: a query error would leave neither locator visible, which is a real,
// actionable failure like any other timeout here. Returns the listbox locator and whether it actually
// has content, so callers can gate content-dependent assertions on real, live account state.
export async function waitForListingSettled(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	await dismissStartupReminders(page)

	const listbox = page.getByRole("listbox", { name: "Directory contents" })
	const empty = page.getByText("Nothing here yet")

	await expect(listbox.or(empty)).toBeVisible()

	return { listbox, hasItems: await listbox.isVisible() }
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
	// a locator that depends on finding a SPECIFIC named row (this function's own scratchRow below,
	// trashScratchDirectory's row) can silently miss it. A generously tall viewport makes the scroll
	// container's height exceed any realistic item count's total row height, so the virtualizer renders
	// every row in one pass for the rest of this test — simpler and more robust here than driving
	// synthetic scroll/wheel events against an unknown scroll container to hunt for one row.
	await page.setViewportSize({ width: 1280, height: 8000 })

	const { listbox } = await waitForListingSettled(page)

	await page.getByRole("button", { name: "New directory", exact: true }).click()
	const dialog = page.getByRole("dialog")
	await expect(dialog).toBeVisible()
	await page.getByLabel("Name", { exact: true }).fill(name)
	await page.getByRole("button", { name: "Create", exact: true }).click()
	await expect(dialog).toHaveCount(0)

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

// Sonner (src/components/ui/sonner.tsx) renders no close affordance and every bulk/action toast here
// is transient (default 4s duration, no persistent reminder survives past dismissStartupReminders) —
// so waiting out the stack is strictly more robust than hunting for a dismiss button that doesn't
// exist. The floating selection bar (bulkActionBar.tsx) and Sonner's default viewport both anchor
// bottom-right, so a toast still fading can sit directly over the bar's own buttons and swallow the
// click. Generous timeout: this can be several toasts deep under parallel-spec load, each observed
// independently rather than assumed to expire in lockstep.
async function waitForToastsClear(page: Page): Promise<void> {
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 20_000 })
}

// Selects then trashes exactly ONE row by name — the whole select → toolbar-click → confirm sequence
// retried as a single unit against a FRESHLY re-resolved row locator each attempt. A row captured once
// outside the retry can go from visible to "element is not stable"/detached mid-sequence when the root
// listing reorders underneath it (a concurrent spec's own root-level mutation, or the background
// refetch waitForListingSettled's own doc comment describes) — re-querying `listbox.getByRole` inside
// the callback is what actually recovers, the same shape as descendInto's own toPass above. Exported for
// the debris sweep in setup/cleanup.setup.ts, which hits this exact churn by construction (it runs
// against a root that, by definition, still has rows left to remove).
//
// No per-step timeout overrides inside the callback: they fall back to the same budgets the
// pre-toPass version of this sequence relied on (expect's config default of 15s, and actions' own
// default — unbounded, i.e. bounded only by the enclosing test's timeout) rather than a tight
// hardcoded 5s each, which left too little slack for a single attempt (let alone a retry) once
// waitForToastsClear's own up-to-20s wait was in the mix. The outer envelope is sized off
// confirmTimeoutMs so a caller's wider override (e.g. drive-search.spec.ts's nested-tree 30s) still
// gets real headroom around it instead of being silently capped by a fixed outer ceiling.
export async function selectAndTrashRow(
	page: Page,
	listbox: ReturnType<Page["getByRole"]>,
	name: string,
	confirmTimeoutMs?: number
): Promise<void> {
	const envelopeTimeoutMs = Math.max(60_000, (confirmTimeoutMs ?? 0) + 40_000)

	await expect(async () => {
		const row = listbox.getByRole("option", { name })
		await expect(row).toBeVisible()
		await row.click()
		await waitForToastsClear(page)
		await page.getByRole("button", { name: "Trash", exact: true }).click()

		const confirm = page.getByRole("alertdialog")
		await expect(confirm).toBeVisible()
		await confirm.getByRole("button", { name: "Trash", exact: true }).click()
		await expect(confirm).toHaveCount(0, confirmTimeoutMs === undefined ? undefined : { timeout: confirmTimeoutMs })
	}).toPass({ timeout: envelopeTimeoutMs })
}

// Failure-proof companion to enterScratchDirectory above — called from every test's own finally, so
// the scratch directory (and everything created/uploaded into it) is trashed even when an assertion
// above throws. Escape first: authed specs may leave a popover/overlay open (Transfers popover,
// preview overlay) close enough to the sidebar to risk covering its own "Cloud Drive" link, and
// dismissing an already-closed one is a harmless no-op. `confirmTimeoutMs` lets a caller whose scratch
// directory holds a larger subtree (e.g. drive-search.spec.ts's nested tree) widen the confirm-dialog
// wait past the default.
export async function trashScratchDirectory(page: Page, name: string, confirmTimeoutMs?: number): Promise<void> {
	await page.keyboard.press("Escape")
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

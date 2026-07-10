import type { Page } from "@playwright/test"
import { expect } from "../fixtures"

// Resolves once the listing has settled to one of its two terminal render states for the CURRENT
// directory — there is no third: a query error would leave neither locator visible, which is a real,
// actionable failure like any other timeout here. Returns the listbox locator and whether it actually
// has content, so callers can gate content-dependent assertions on real, live account state.
export async function waitForListingSettled(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
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
	const row = listbox.getByRole("option", { name })

	// waitForListingSettled only proves SOME listbox is showing, not that it reflects the scratch
	// directory just created: React Query serves this root query key's LAST-cached result instantly
	// (queries/client.ts's staleTime 0 still triggers a background refetch, but never blocks the
	// already-cached render) — root was cached once already, at this test's own initial goto, before
	// the scratch directory existed. A one-shot visibility check races that background refetch and
	// reliably loses under load; polling rides it out. A genuine timeout (the scratch directory never
	// made it into the listing at all, e.g. enterScratchDirectory itself failed before creating it) is
	// the one case there is nothing to trash.
	try {
		await expect(row).toBeVisible({ timeout: 15_000 })
	} catch {
		return
	}

	await row.click()
	await page.getByRole("button", { name: "Trash", exact: true }).click()

	const confirm = page.getByRole("alertdialog")
	await expect(confirm).toBeVisible()
	await confirm.getByRole("button", { name: "Trash", exact: true }).click()
	await expect(confirm).toHaveCount(0, confirmTimeoutMs === undefined ? undefined : { timeout: confirmTimeoutMs })
}

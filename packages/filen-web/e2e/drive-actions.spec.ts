import { test, expect } from "./fixtures"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import {
	waitForListingSettled,
	bootTo,
	clickSidebarLink,
	descendInto,
	createDirectoryViaDialog,
	enterScratchDirectory,
	LIVE_WRITE_TIMEOUT_MS,
	BOOT_SETTLE_TIMEOUT_MS,
	trashScratchDirectory
} from "./helpers/listing"
import { MOD_KEY } from "./helpers/modkey"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Serial, not parallel: the account is shared LIVE state, and the last test creates/selects/trashes/
// restores real items by name — running it alongside this file's own other tests (which each select
// "the first option" in the SAME listing) risks one test's transient item becoming another's "first
// option". Config-level fullyParallel still races this file against OTHER spec files' own reads of
// the same account; that residual cross-file window is accepted, not solved, here.
test.describe.configure({ mode: "serial" })

test.describe("drive bulk actions", () => {
	test("selecting an item floats the bulk-action bar; clear-selection dismisses it", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		const { listbox, hasItems } = await waitForListingSettled(page)
		test.skip(!hasItems, "drive root has no items in this account — nothing to select")

		// Enabled, not merely visible: every non-writable listing variant still RENDERS this button, just
		// disabled (directoryListing.tsx's writeDisabled — menus.spec.ts asserts that state directly), so a
		// visibility check would pass on a dead control and prove nothing about this listing being writable.
		await expect(page.getByRole("button", { name: "New directory", exact: true }).first()).toBeEnabled()

		await listbox.getByRole("option").first().click()

		// The floating selection bar appears; the toolbar stays put — the two coexist.
		await expect(page.getByRole("button", { name: "Clear selection", exact: true })).toBeVisible()
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "New directory", exact: true }).first()).toBeEnabled()

		// Trash is never gated by undecryptable — always present for a /drive selection regardless of
		// what this unknown account's first item happens to be.
		await expect(page.getByRole("button", { name: "Trash", exact: true })).toBeVisible()
		// No bulk color surface exists (mobile parity) — proven live, not just by the closed BulkActionId
		// union at the type level.
		await expect(page.getByRole("button", { name: "Color", exact: true })).toHaveCount(0)

		await page.getByRole("button", { name: "Clear selection", exact: true }).click()

		await expect(page.getByText("1 selected", { exact: true })).toHaveCount(0)
		await expect(page.getByRole("button", { name: "New directory", exact: true }).first()).toBeEnabled()
		await expect(page.getByRole("button", { name: "Clear selection", exact: true })).toHaveCount(0)
	})

	test("the bulk Move button opens the destination picker without moving anything", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		const { listbox, hasItems } = await waitForListingSettled(page)
		test.skip(!hasItems, "drive root has no items in this account — nothing to select")

		await listbox.getByRole("option").first().click()

		// Asserted, not gated on a one-shot isVisible(): Move is only ever withheld for an undecryptable
		// item, which is a broken account row rather than a shape this test should quietly pass over —
		// and reading visibility once against a bulk bar that is still mounting skips a healthy run.
		const moveButton = page.getByRole("button", { name: "Move", exact: true })
		await expect(moveButton).toBeVisible()

		await moveButton.click()

		const dialog = page.getByRole("dialog")
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole("heading", { name: "Select destination", exact: true })).toBeVisible()

		// "Move here" can only ever assert the offline arm: this picker opened on the drive root, which is
		// where the selected item already lives, so isMoveNoOp (moveTargetDialog.logic.ts) keeps the
		// confirm disabled online too — it can never be the re-enable probe. The in-picker create button
		// (gated on `pending` alone before this pass) is the control whose state tracks connectivity.
		// Filtered by its FolderPlusIcon: the picker's own directory rows are plain <button>s carrying
		// their directory name, so a live account whose drive root happens to hold a directory literally
		// named "New directory" would strict-mode-violate a name-only locator. lucide-react stamps every
		// icon with `lucide-<kebab-name>`, and no row renders that icon. Both locators are scoped to
		// `dialog`, so the toolbar's own identically-named button behind the modal can never match.
		const createButton = dialog
			.getByRole("button", { name: "New directory", exact: true })
			.filter({ has: page.locator("svg.lucide-folder-plus") })
		await expect(createButton).toBeEnabled()

		// useIsOnline reads TanStack's onlineManager, which tracks the window online/offline events this
		// flag fires (precedent: chats.spec.ts). The picker's listing query stays `success` off the warm
		// cache while offline, so the confirm's own status arm never confounds the assertion.
		// Barrier before the network dies: the e2e hooks arrive via a fire-and-forget dynamic
		// import, and a chunk request that is in flight when the page goes offline FAILS PERMANENTLY.
		await waitForE2eHooks(page)
		await page.context().setOffline(true)
		await expect(createButton).toBeDisabled()
		await expect(dialog.getByRole("button", { name: "Move here", exact: true })).toBeDisabled()

		await page.context().setOffline(false)
		await expect(createButton).toBeEnabled()

		// Dismiss without ever pressing "Move here" — this test never mutates the live account.
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})

	// Copy replaced the shared-in-only Import: it is offered on owned items too, as a submenu whose
	// first entry opens the destination picker. Opening the menus mutates nothing.
	test("the per-item menu offers Copy (and no Import) on an owned /drive item", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		const { listbox, hasItems } = await waitForListingSettled(page)
		test.skip(!hasItems, "drive root has no items in this account — nothing to open a menu on")

		await listbox.getByRole("option").first().getByRole("button", { name: "More actions", exact: true }).click()

		const menu = page.getByRole("menu").first()
		await expect(menu).toBeVisible()
		await expect(menu.getByRole("menuitem", { name: "Import", exact: true })).toHaveCount(0)

		await menu.getByRole("menuitem", { name: "Copy", exact: true }).click()
		await expect(page.getByRole("menuitem", { name: "Choose destination…", exact: true }).last()).toBeVisible()
		await expect(page.getByRole("menuitem", { name: "Copy here", exact: true }).first()).toBeVisible()

		await page.keyboard.press("Escape")
		await page.keyboard.press("Escape")
		await expect(page.getByRole("menu")).toHaveCount(0)
	})

	test("the bulk Trash button opens the trash confirm; dismissing leaves the item selected and in place", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		const { listbox, hasItems } = await waitForListingSettled(page)
		test.skip(!hasItems, "drive root has no items in this account — nothing to select")

		await listbox.getByRole("option").first().click()
		await page.getByRole("button", { name: "Trash", exact: true }).click()

		// Scoped by title, never a bare role: a startup account reminder is an alertdialog too and can pop
		// asynchronously, which would make an unscoped lookup a strict-mode violation rather than a useful
		// failure. Base UI wires the accessible name from the dialog's own title (confirmDialog.tsx).
		const dialog = page.getByRole("alertdialog", { name: "Move to trash?" })
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole("heading", { name: "Move to trash?", exact: true })).toBeVisible()

		// Dismiss without ever pressing the dialog's own "Trash" confirm — this test never mutates the
		// live account. The selection survives a cancelled confirm (only a HANDLED outcome prunes it).
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
	})

	// The only test in this file that touches live account state — a fully-cleaning round trip (create
	// → verify → bulk-favorite SET → bulk-unfavorite SET → bulk-trash → verify gone → trash-variant
	// gating + the NEW bulk-restore confirm → restore → verify back → re-trash). Every mutation here
	// targets items this test itself created, so it never risks a REAL account item, and it ends in
	// Trash — recoverable, not permanently destroyed — the one exception the wider e2e convention (never
	// seed/mutate fixture data) allows. Runs unconditionally (create manufactures its own content, so
	// there's nothing to skip for an empty account) whenever chromium + a session are available.
	//
	// The two test items live INSIDE a scratch directory (not at /drive's root) for the whole test,
	// only surfacing at root for their own create/final-trash — this file's OTHER tests, and any
	// concurrently-running spec (e.g. drive.spec.ts's own root-level item-count assertions), read the
	// ROOT listing; nesting confines every count-shifting moment below to the two around the scratch
	// directory itself, instead of the ~8 a flat, root-level create/trash/restore/re-trash cycle for
	// two items would otherwise produce. (First written flat: this exact interference reproduced
	// live as a flaky drive.spec.ts "selection" test failure under this suite's fullyParallel config.)
	test("net-zero round trip: create, bulk-favorite, bulk-trash, verify trash-variant gating, bulk-restore confirm, re-trash", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		// Same tall-viewport workaround as enterScratchDirectory (listing.ts): both the root and the
		// trash listing virtualize their rows, and the shared account's /trash has accumulated enough
		// leftover directories from prior runs of this very test that a freshly-trashed row can sort
		// below the virtualizer's render window and never mount, making a name-based row locator miss it
		// entirely. A tall viewport makes the scroll container exceed any realistic item count's total
		// row height so every row renders for the rest of this test.
		await page.setViewportSize({ width: 1280, height: 8000 })

		const suffix = crypto.randomUUID()
		const scratchName = `e2e-bulk-actions-${suffix}`
		const nameA = `e2e-bulk-actions-${suffix}-a`
		const nameB = `e2e-bulk-actions-${suffix}-b`

		await bootTo(page)

		// Through the shared helper rather than create-then-descend by hand: this is the run's FIRST
		// write, the one that meets a `drive-write` lease left behind by anything that died holding it,
		// and the helper is where the retry-with-reload for that lives (see listing.ts). Descending is a
		// real double-click in there too — an in-app client-side route change, same as drive.spec.ts's
		// own subdirectory-navigation test. Everything below this point, until the final cleanup, stays
		// inside the scratch directory and never touches the root listing again.
		// The scratch root is trashed in-body below as the test's own final assertion. This bracket is
		// for every path that never reaches it: without it a failure anywhere in the ~150 lines between
		// here and there left e2e-bulk-actions-<uuid> at the ACCOUNT ROOT permanently, plus up to two
		// children — and this is the test that actually failed on CI, so the account has been paying for
		// it. The flag is set from the PROVEN removal, never from calling the helper:
		// trashScratchDirectory swallows its own failure by design (it logs and returns), so
		// "I called it" and "it worked" are different facts.
		let trashed = false

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, nameA, listbox)
			await createDirectoryViaDialog(page, nameB, listbox)

			const rowA = listbox.getByRole("option", { name: nameA })
			const rowB = listbox.getByRole("option", { name: nameB })
			await expect(rowA).toBeVisible()
			await expect(rowB).toBeVisible()
			await expect(rowA.getByText("Favorited")).toHaveCount(0) // fresh directories start unfavorited

			// Bulk-favorite is a SET: with neither favorited, the button reads "Favorite" and applies TRUE
			// to both, not a per-item flip.
			await rowA.click()
			await rowB.click({ modifiers: [MOD_KEY] })
			await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

			// The write budget on all four badge assertions, not the expect default: bulk favorite runs through
			// runBulkFavorite with no dialog of its own (bulkActionBar.tsx), so the badge appearing/disappearing IS
			// the live write settling on the account-wide lease rather than a React commit after one.
			await page.getByRole("button", { name: "Favorite", exact: true }).click()
			await expect(rowA.getByText("Favorited")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(rowB.getByText("Favorited")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// Re-select (a successful bulk favorite prunes the selection) and SET back to unfavorited —
			// nets out to the exact pre-test state.
			await rowA.click()
			await rowB.click({ modifiers: [MOD_KEY] })
			await page.getByRole("button", { name: "Unfavorite", exact: true }).click()
			await expect(rowA.getByText("Favorited")).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(rowB.getByText("Favorited")).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			// Bulk-trash both.
			await rowA.click()
			await rowB.click({ modifiers: [MOD_KEY] })
			await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

			await page.getByRole("button", { name: "Trash", exact: true }).click()
			const trashConfirm = page.getByRole("alertdialog", { name: "Move to trash?" })
			await expect(trashConfirm).toBeVisible()
			await trashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
			// The write budget, not the expect default: runBulkDialogAction holds this open and pending for the
			// whole trash, so its close is the live write settling on the account-wide lease.
			await expect(trashConfirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await expect(rowA).toHaveCount(0)
			await expect(rowB).toHaveCount(0)

			// Trash variant: both items are visible there, gated to Restore/Delete-permanently only — no
			// Favorite/Move surface (mirrors the /drive gating table, inverted). An in-app sidebar-link
			// click (not page.goto) keeps this a client-side route change on the SAME already-booted app
			// instance — goto's full reload re-runs the whole boot/re-auth sequence, which raced the
			// listTrash() fetch against the just-completed trash write when this was first written.
			await clickSidebarLink(page, "Trash", /\/trash$/)
			const trashListing = await waitForListingSettled(page)
			const trashRowA = trashListing.listbox.getByRole("option", { name: nameA })
			const trashRowB = trashListing.listbox.getByRole("option", { name: nameB })
			await expect(trashRowA).toBeVisible()
			await expect(trashRowB).toBeVisible()

			// Toolbar's own Empty trash trigger: present because the trash listing is non-empty. Opens the
			// already-wired typed-confirm dialog and dismisses without ever typing the match phrase — this
			// spec must never actually empty the shared account's trash.
			await page.getByRole("button", { name: "Empty trash", exact: true }).click()
			const emptyTrashConfirm = page.getByRole("alertdialog", { name: "Empty trash?" })
			await expect(emptyTrashConfirm).toBeVisible()
			await expect(emptyTrashConfirm.getByRole("heading", { name: "Empty trash?", exact: true })).toBeVisible()
			await page.keyboard.press("Escape")
			await expect(emptyTrashConfirm).toHaveCount(0)
			await expect(trashRowA).toBeVisible()
			await expect(trashRowB).toBeVisible()

			await trashRowA.click()
			await trashRowB.click({ modifiers: [MOD_KEY] })
			await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

			await expect(page.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0)
			await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveCount(0)
			await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
			await expect(page.getByRole("button", { name: "Delete permanently", exact: true })).toBeVisible()

			// Destructive confirms open with Cancel focused — a blind Enter must never fire an irreversible
			// delete. Opened and dismissed; this suite never permanently deletes anything.
			await page.getByRole("button", { name: "Delete permanently", exact: true }).click()
			// Scoped by title like every other confirm here — which also makes this the one assertion that the
			// permanent-delete confirm is the dialog that opened, since no heading check follows it.
			const deleteConfirm = page.getByRole("alertdialog", { name: "Delete permanently?" })
			await expect(deleteConfirm).toBeVisible()
			await expect(deleteConfirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
			await page.keyboard.press("Escape")
			await expect(deleteConfirm).toHaveCount(0)

			// Bulk restore CONFIRMS — the one behavior this task adds (a single item's own restore, from the
			// per-item menu, stays direct/unconfirmed; only the bulk path opens this dialog).
			await page.getByRole("button", { name: "Restore", exact: true }).click()
			const restoreConfirm = page.getByRole("alertdialog", { name: "Restore items?" })
			await expect(restoreConfirm).toBeVisible()
			await expect(restoreConfirm.getByRole("heading", { name: "Restore items?", exact: true })).toBeVisible()
			// The preserved half of the same tier rule: a reversible confirm still opens on its confirm button.
			await expect(restoreConfirm.getByRole("button", { name: "Restore", exact: true })).toBeFocused()
			await restoreConfirm.getByRole("button", { name: "Restore", exact: true }).click()
			// The write budget, not the expect default: runBulkDialogAction holds this open for the whole
			// restore, so its close is the live write settling on the account-wide lease, not a UI beat.
			await expect(restoreConfirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await expect(trashRowA).toHaveCount(0)
			await expect(trashRowB).toHaveCount(0)

			// restoreItems restores each item to its OWN previous parent — the scratch directory, not root
			// — so getting back to them means re-descending, not just returning to /drive.
			await clickSidebarLink(page, "Cloud Drive", /\/drive$/)
			const rootAfterRestore = await waitForListingSettled(page)
			await descendInto(page, rootAfterRestore.listbox, scratchName)

			const restoredListing = await waitForListingSettled(page)
			const restoredRowA = restoredListing.listbox.getByRole("option", { name: nameA })
			const restoredRowB = restoredListing.listbox.getByRole("option", { name: nameB })
			await expect(restoredRowA).toBeVisible()
			await expect(restoredRowB).toBeVisible()

			// Re-trash both inner items, leaving the scratch directory empty.
			await restoredRowA.click()
			await restoredRowB.click({ modifiers: [MOD_KEY] })
			await page.getByRole("button", { name: "Trash", exact: true }).click()
			const innerFinalTrashConfirm = page.getByRole("alertdialog", { name: "Move to trash?" })
			await expect(innerFinalTrashConfirm).toBeVisible()
			await innerFinalTrashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
			await expect(innerFinalTrashConfirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(restoredRowA).toHaveCount(0)
			await expect(restoredRowB).toHaveCount(0)

			// Final cleanup: trash the now-empty scratch directory itself — the only other root-level
			// mutation this test makes, ending everything in Trash (recoverable, net-zero on the live
			// account: nothing permanent was created or destroyed).
			await clickSidebarLink(page, "Cloud Drive", /\/drive$/)
			const rootBeforeFinalCleanup = await waitForListingSettled(page)
			const finalScratchRow = rootBeforeFinalCleanup.listbox.getByRole("option", { name: scratchName })
			await expect(finalScratchRow).toBeVisible()

			await finalScratchRow.click()
			await page.getByRole("button", { name: "Trash", exact: true }).click()
			const scratchTrashConfirm = page.getByRole("alertdialog", { name: "Move to trash?" })
			await expect(scratchTrashConfirm).toBeVisible()
			await scratchTrashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
			await expect(scratchTrashConfirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			// A reload (not just re-checking the same live query-client state) before this LAST assertion —
			// the app's queries refetch on window focus (queries/client.ts: staleTime 0 +
			// refetchOnWindowFocus), and Playwright's own multi-worker automation can shift OS-level window
			// focus across concurrently-running pages; a refetch that happens to land against a moment the
			// backend hasn't fully caught up with the just-issued trash can overwrite the correct optimistic
			// removal with a stale "still there" read on THIS page, without anything ever being wrong
			// server-side. A fresh boot re-fetches once, for real, independent of that page's prior state.
			await page.reload()
			const rootAfterFinalCleanup = await waitForListingSettled(page, BOOT_SETTLE_TIMEOUT_MS)
			await expect(rootAfterFinalCleanup.listbox.getByRole("option", { name: scratchName })).toHaveCount(0)

			trashed = true
		} finally {
			if (!trashed) {
				await trashScratchDirectory(page, scratchName)
			}
		}
	})
})

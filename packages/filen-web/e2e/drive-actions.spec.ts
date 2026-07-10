import { test, expect } from "./fixtures"
import { waitForListingSettled } from "./helpers/listing"
import { MOD_KEY } from "./helpers/modkey"

// Mirrors drive.spec.ts's own FIREFOX_HANG_REASON — every test below needs the SAME authenticated
// listDir call to settle before it can do anything, and that hangs indefinitely on Playwright-firefox
// under COI (see drive.spec.ts's own comment for the live-verified root cause).
const FIREFOX_HANG_REASON = "drive listing needs an authenticated listDir call, which hangs indefinitely on Playwright-firefox under COI"

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

		await page.goto("/drive")
		const { listbox, hasItems } = await waitForListingSettled(page)
		test.skip(!hasItems, "drive root has no items in this account — nothing to select")

		await expect(page.getByRole("button", { name: "New directory", exact: true })).toBeVisible()

		await listbox.getByRole("option").first().click()

		// The floating selection bar appears; the toolbar stays put — the two coexist.
		await expect(page.getByRole("button", { name: "Clear selection", exact: true })).toBeVisible()
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "New directory", exact: true })).toBeVisible()

		// Trash is never gated by undecryptable — always present for a /drive selection regardless of
		// what this unknown account's first item happens to be.
		await expect(page.getByRole("button", { name: "Trash", exact: true })).toBeVisible()
		// No bulk color surface exists (mobile parity) — proven live, not just by the closed BulkActionId
		// union at the type level.
		await expect(page.getByRole("button", { name: "Color", exact: true })).toHaveCount(0)

		await page.getByRole("button", { name: "Clear selection", exact: true }).click()

		await expect(page.getByText("1 selected", { exact: true })).toHaveCount(0)
		await expect(page.getByRole("button", { name: "New directory", exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Clear selection", exact: true })).toHaveCount(0)
	})

	test("the bulk Move button opens the destination picker without moving anything", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		const { listbox, hasItems } = await waitForListingSettled(page)
		test.skip(!hasItems, "drive root has no items in this account — nothing to select")

		await listbox.getByRole("option").first().click()

		const moveButton = page.getByRole("button", { name: "Move", exact: true })
		test.skip(!(await moveButton.isVisible()), "the first item in this account is undecryptable — Move is gated off")

		await moveButton.click()

		const dialog = page.getByRole("dialog")
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole("heading", { name: "Select destination", exact: true })).toBeVisible()

		// Dismiss without ever pressing "Move here" — this test never mutates the live account.
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})

	test("the bulk Trash button opens the trash confirm; dismissing leaves the item selected and in place", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		const { listbox, hasItems } = await waitForListingSettled(page)
		test.skip(!hasItems, "drive root has no items in this account — nothing to select")

		await listbox.getByRole("option").first().click()
		await page.getByRole("button", { name: "Trash", exact: true }).click()

		const dialog = page.getByRole("alertdialog")
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

		const suffix = crypto.randomUUID()
		const scratchName = `e2e-bulk-actions-${suffix}`
		const nameA = `e2e-bulk-actions-${suffix}-a`
		const nameB = `e2e-bulk-actions-${suffix}-b`

		async function createDirectory(name: string): Promise<void> {
			await page.getByRole("button", { name: "New directory", exact: true }).click()
			const dialog = page.getByRole("dialog")
			await expect(dialog).toBeVisible()
			await page.getByLabel("Name", { exact: true }).fill(name)
			await page.getByRole("button", { name: "Create", exact: true }).click()
			await expect(dialog).toHaveCount(0)
		}

		await page.goto("/drive")
		const { listbox: rootListbox } = await waitForListingSettled(page)

		await createDirectory(scratchName)
		const scratchRow = rootListbox.getByRole("option", { name: scratchName })
		await expect(scratchRow).toBeVisible()

		// Descend via a real double-click (an in-app client-side route change, same as drive.spec.ts's
		// own subdirectory-navigation test) — everything below this point, until the final cleanup,
		// stays inside the scratch directory and never touches the root listing again.
		await scratchRow.dblclick()
		const { listbox } = await waitForListingSettled(page)

		await createDirectory(nameA)
		await createDirectory(nameB)

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

		await page.getByRole("button", { name: "Favorite", exact: true }).click()
		await expect(rowA.getByText("Favorited")).toBeVisible()
		await expect(rowB.getByText("Favorited")).toBeVisible()

		// Re-select (a successful bulk favorite prunes the selection) and SET back to unfavorited —
		// nets out to the exact pre-test state.
		await rowA.click()
		await rowB.click({ modifiers: [MOD_KEY] })
		await page.getByRole("button", { name: "Unfavorite", exact: true }).click()
		await expect(rowA.getByText("Favorited")).toHaveCount(0)
		await expect(rowB.getByText("Favorited")).toHaveCount(0)

		// Bulk-trash both.
		await rowA.click()
		await rowB.click({ modifiers: [MOD_KEY] })
		await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

		await page.getByRole("button", { name: "Trash", exact: true }).click()
		const trashConfirm = page.getByRole("alertdialog")
		await expect(trashConfirm).toBeVisible()
		await trashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
		await expect(trashConfirm).toHaveCount(0)

		await expect(rowA).toHaveCount(0)
		await expect(rowB).toHaveCount(0)

		// Trash variant: both items are visible there, gated to Restore/Delete-permanently only — no
		// Favorite/Move surface (mirrors the /drive gating table, inverted). An in-app sidebar-link
		// click (not page.goto) keeps this a client-side route change on the SAME already-booted app
		// instance — goto's full reload re-runs the whole boot/re-auth sequence, which raced the
		// listTrash() fetch against the just-completed trash write when this was first written.
		await page.getByRole("complementary").getByRole("link", { name: "Trash", exact: true }).click()
		const trashListing = await waitForListingSettled(page)
		const trashRowA = trashListing.listbox.getByRole("option", { name: nameA })
		const trashRowB = trashListing.listbox.getByRole("option", { name: nameB })
		await expect(trashRowA).toBeVisible()
		await expect(trashRowB).toBeVisible()

		await trashRowA.click()
		await trashRowB.click({ modifiers: [MOD_KEY] })
		await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

		await expect(page.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0)
		await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveCount(0)
		await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Delete permanently", exact: true })).toBeVisible()

		// Bulk restore CONFIRMS — the one behavior this task adds (a single item's own restore, from the
		// per-item menu, stays direct/unconfirmed; only the bulk path opens this dialog).
		await page.getByRole("button", { name: "Restore", exact: true }).click()
		const restoreConfirm = page.getByRole("alertdialog")
		await expect(restoreConfirm).toBeVisible()
		await expect(restoreConfirm.getByRole("heading", { name: "Restore items?", exact: true })).toBeVisible()
		await restoreConfirm.getByRole("button", { name: "Restore", exact: true }).click()
		await expect(restoreConfirm).toHaveCount(0)

		await expect(trashRowA).toHaveCount(0)
		await expect(trashRowB).toHaveCount(0)

		// restoreItems restores each item to its OWN previous parent — the scratch directory, not root
		// — so getting back to them means re-descending, not just returning to /drive.
		await page.getByRole("complementary").getByRole("link", { name: "Cloud Drive", exact: true }).click()
		const rootAfterRestore = await waitForListingSettled(page)
		const scratchRowAfterRestore = rootAfterRestore.listbox.getByRole("option", { name: scratchName })
		await expect(scratchRowAfterRestore).toBeVisible()
		await scratchRowAfterRestore.dblclick()

		const restoredListing = await waitForListingSettled(page)
		const restoredRowA = restoredListing.listbox.getByRole("option", { name: nameA })
		const restoredRowB = restoredListing.listbox.getByRole("option", { name: nameB })
		await expect(restoredRowA).toBeVisible()
		await expect(restoredRowB).toBeVisible()

		// Re-trash both inner items, leaving the scratch directory empty.
		await restoredRowA.click()
		await restoredRowB.click({ modifiers: [MOD_KEY] })
		await page.getByRole("button", { name: "Trash", exact: true }).click()
		const innerFinalTrashConfirm = page.getByRole("alertdialog")
		await expect(innerFinalTrashConfirm).toBeVisible()
		await innerFinalTrashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
		await expect(innerFinalTrashConfirm).toHaveCount(0)
		await expect(restoredRowA).toHaveCount(0)
		await expect(restoredRowB).toHaveCount(0)

		// Final cleanup: trash the now-empty scratch directory itself — the only other root-level
		// mutation this test makes, ending everything in Trash (recoverable, net-zero on the live
		// account: nothing permanent was created or destroyed).
		await page.getByRole("complementary").getByRole("link", { name: "Cloud Drive", exact: true }).click()
		const rootBeforeFinalCleanup = await waitForListingSettled(page)
		const finalScratchRow = rootBeforeFinalCleanup.listbox.getByRole("option", { name: scratchName })
		await expect(finalScratchRow).toBeVisible()

		await finalScratchRow.click()
		await page.getByRole("button", { name: "Trash", exact: true }).click()
		const scratchTrashConfirm = page.getByRole("alertdialog")
		await expect(scratchTrashConfirm).toBeVisible()
		await scratchTrashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
		await expect(scratchTrashConfirm).toHaveCount(0)

		// A reload (not just re-checking the same live query-client state) before this LAST assertion —
		// the app's queries refetch on window focus (queries/client.ts: staleTime 0 +
		// refetchOnWindowFocus), and Playwright's own multi-worker automation can shift OS-level window
		// focus across concurrently-running pages; a refetch that happens to land against a moment the
		// backend hasn't fully caught up with the just-issued trash can overwrite the correct optimistic
		// removal with a stale "still there" read on THIS page, without anything ever being wrong
		// server-side. A fresh boot re-fetches once, for real, independent of that page's prior state.
		await page.reload()
		const rootAfterFinalCleanup = await waitForListingSettled(page)
		await expect(rootAfterFinalCleanup.listbox.getByRole("option", { name: scratchName })).toHaveCount(0)
	})
})

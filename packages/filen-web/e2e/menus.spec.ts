import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	waitForListingSettled,
	bootTo,
	clickSidebarLink,
	enterScratchDirectory,
	trashScratchDirectory,
	descendInto,
	createDirectoryViaDialog,
	LIVE_WRITE_TIMEOUT_MS,
	BOOT_SETTLE_TIMEOUT_MS
} from "./helpers/listing"
import { MOD_KEY } from "./helpers/modkey"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { drive as driveDict } from "@/locales/en/drive"

// The unit layer (itemMenu.test.ts / bulkActionBar.test.ts) proves the descriptor LIST a given
// item/variant/selection is gated to; it cannot prove the RENDERED menu actually carries those
// entries, in that order, when a real right-click opens it — that needs a browser. This file is the
// browser-side counterpart: it opens the real context menu / bulk bar and reads back menuitem text.
//
// Every expected sequence below is an ID list — the SAME id sequence the unit tests already pin for
// each variant/type (itemMenu.logic.ts's driveItemActions / bulkActionBar.logic.ts's
// driveBulkActions) — never a hand-typed English string. Each id is resolved to its rendered label
// through ACTION_DEFS + the real English "drive" catalog, so a copy-edited label can never desync
// silently from what this file asserts.
type ActionId = keyof typeof ACTION_DEFS

function labelFor(id: ActionId): string {
	return driveDict[ACTION_DEFS[id].labelKey]
}

function labelsFor(ids: ActionId[]): string[] {
	return ids.map(labelFor)
}

// Drive-variant directory (itemMenu.test.ts's own "drive variant, directory" case): color, no versions.
const DIRECTORY_MENU_IDS: ActionId[] = [
	"rename",
	"move",
	"copy",
	"favorite",
	"color",
	"info",
	"download",
	"share",
	"publicLink",
	"copyLink",
	"trash"
]
// Drive-variant file (itemMenu.test.ts's own "drive variant, file" case): versions, no color.
const FILE_MENU_IDS: ActionId[] = [
	"rename",
	"move",
	"copy",
	"favorite",
	"versions",
	"info",
	"download",
	"share",
	"publicLink",
	"copyLink",
	"trash"
]
// Trash variant, either type (itemMenu.test.ts's own "trash variant" case) — the maximally-reduced set.
const TRASH_MENU_IDS: ActionId[] = ["restore", "deletePermanently", "info"]
// Bulk bar, plain drive-variant selection (bulkActionBar.test.ts's own "drive variant" case) — no
// color/versions id exists in the bulk builder at all, per-type or not.
const BULK_MENU_IDS: ActionId[] = ["favorite", "move", "copy", "share", "download", "trash"]

test.describe.configure({ mode: "serial" })

// Right-clicks `name`'s row, asserts the open context menu's menuitem sequence against `ids`, then
// closes it — one retried unit so a transient miss (row not yet settled after the previous step)
// doesn't need its own bespoke retry.
async function assertRowContextMenu(page: Page, listbox: Locator, name: string, ids: ActionId[]): Promise<void> {
	const row = listbox.getByRole("option", { name })
	await expect(row).toBeVisible()
	await row.click({ button: "right" })

	const menu = page.getByRole("menu")
	await expect(menu).toBeVisible()
	// Array form is a whole-string, in-order match per element — no "exact" option needed/available.
	await expect(menu.getByRole("menuitem")).toHaveText(labelsFor(ids))

	await page.keyboard.press("Escape")
	await expect(menu).toHaveCount(0)
}

test.describe("context menus", () => {
	// The one test in this file that touches live account state — a net-zero round trip inside a
	// single scratch directory (enterScratchDirectory/trashScratchDirectory, mirrors every other
	// data-mutating drive spec's convention). Everything below stays nested inside it except the
	// trash/restore leg, which necessarily visits the flat /trash listing — trashing the scratch
	// directory itself in the `finally` sweeps up its contents (nested or restored back into it)
	// regardless of where this test's own assertions stop.
	test("a file row, a directory row, the bulk bar, and the trash-variant menu render exactly the gated entries, in order", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-menus-${runId}`
		const dirName = `e2e-menus-${runId}-dir`
		const fileBaseName = `e2e-menus-${runId}-file`
		const fileName = `${fileBaseName}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, dirName, listbox)

			// .first(): the fresh scratch directory starts empty, so its empty-state "+ Add" affordance
			// renders a second identical Upload trigger; the toolbar's is always first in DOM order.
			await page.getByRole("button", { name: "Upload", exact: true }).first().click()
			const uploadMenu = page.getByRole("menu")
			await expect(uploadMenu).toBeVisible()
			await uploadMenu.getByRole("menuitem", { name: "New text file", exact: true }).click()

			const fileDialog = page.getByRole("heading", { name: "New text file", exact: true })
			await expect(fileDialog).toBeVisible()
			await page.getByLabel("Name", { exact: true }).fill(fileBaseName)
			await page.getByRole("button", { name: "Create", exact: true }).click()

			// The editor opening IS the outcome (createTextFile.ts patches the listing by this point,
			// before any save) — this test never types into it, just proves creation landed and closes
			// the overlay to reach the row underneath. Assert that FIRST: the dialog closing is a side
			// effect of the same live write, and asserting it on the suite's UI-responsiveness budget
			// made a slow-but-successful create look like a failure. It closes on a live create+upload,
			// so it gets the write budget.
			await expect(page.locator(".cm-content")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(fileDialog).toHaveCount(0, { timeout: 10_000 })
			await page.keyboard.press("Escape")
			// The preview overlay is modal and marks the rest of the page aria-hidden while it stands, so
			// every role-based lookup below is unreachable until it is proven gone.
			await expect(page.getByRole("dialog")).toHaveCount(0)

			const dirRow = listbox.getByRole("option", { name: dirName })
			const fileRow = listbox.getByRole("option", { name: fileName })
			await expect(dirRow).toBeVisible()
			await expect(fileRow).toBeVisible()

			// 1. Per-type context-menu completeness, right-click only — the RENDERED menu, not the
			// descriptor list a unit test already trusts.
			await assertRowContextMenu(page, listbox, dirName, DIRECTORY_MENU_IDS)
			await assertRowContextMenu(page, listbox, fileName, FILE_MENU_IDS)

			// 1b. This e2e account is free-tier (public links are a paid feature) — a REAL, live proof
			// that the link dialog's premium gate renders instead of the link form (link CREATION itself
			// is not provable on this account; the gate state is). Opened from the item menu's own
			// "Public link" entry, same reachable path a real user takes.
			await fileRow.click({ button: "right" })
			const linkMenu = page.getByRole("menu")
			await expect(linkMenu).toBeVisible()
			await linkMenu.getByRole("menuitem", { name: labelFor("publicLink"), exact: true }).click()

			// Scoped by its own title: the preview overlay is a role="dialog" too (previewOverlay.tsx), so a
			// bare role lookup can resolve to the wrong surface — or to both at once.
			const linkDialog = page.getByRole("dialog", { name: driveDict.driveLinkDialogTitle })
			await expect(linkDialog).toBeVisible()
			await expect(linkDialog.getByText(driveDict.driveLinkPremiumRequiredTitle, { exact: true })).toBeVisible()
			// The Upgrade action is a router Link styled with buttonVariants (a real <a>, not a <button>) — its
			// accessible role is "link", carrying the billing-settings href.
			await expect(linkDialog.getByRole("link", { name: driveDict.driveLinkUpgradeAction, exact: true })).toBeVisible()
			await page.keyboard.press("Escape")
			await expect(linkDialog).toHaveCount(0)

			// 2. Bulk-selection bar: order asserted by on-screen x-position (left-to-right = render
			// order) rather than a container selector, since the bar exposes no stable role/label of
			// its own to scope a locator to.
			await dirRow.click()
			await fileRow.click({ modifiers: [MOD_KEY] })
			await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

			const expectedBulkLabels = labelsFor(BULK_MENU_IDS)
			const bulkButtons = await Promise.all(
				expectedBulkLabels.map(async label => {
					const button = page.getByRole("button", { name: label, exact: true })
					await expect(button).toBeVisible()
					const box = await button.boundingBox()
					return { label, x: box === null ? Number.POSITIVE_INFINITY : box.x }
				})
			)
			const renderOrder = [...bulkButtons].sort((a, b) => a.x - b.x).map(entry => entry.label)
			expect(renderOrder).toEqual(expectedBulkLabels)
			// No color/versions button ever renders in the bulk bar — neither id exists in
			// driveBulkActions at all, per-type or not (unlike the per-item menu above).
			await expect(page.getByRole("button", { name: "Color", exact: true })).toHaveCount(0)
			await expect(page.getByRole("button", { name: "Versions", exact: true })).toHaveCount(0)

			// 2b. Right-clicking a row that is PART of the current 2+ selection opens the BULK menu — the
			// same descriptor set the bar above renders, from the same builder.
			await fileRow.click({ button: "right" })
			const bulkContextMenu = page.getByRole("menu")
			await expect(bulkContextMenu).toBeVisible()
			await expect(bulkContextMenu.getByRole("menuitem")).toHaveText(expectedBulkLabels)
			await page.keyboard.press("Escape")
			await expect(bulkContextMenu).toHaveCount(0)

			// Collapse the selection back to ONE row (a plain click replaces the selection), so the OTHER
			// row is now unselected — right-clicking it must retarget the selection to it and open the
			// single-item menu. FILE_MENU_IDS is the exact set the per-type leg above already asserted for
			// this same row, so a failed retarget would show up as the bulk set instead.
			await dirRow.click()
			await fileRow.click({ button: "right" })
			const retargetedMenu = page.getByRole("menu")
			await expect(retargetedMenu).toBeVisible()
			await expect(retargetedMenu.getByRole("menuitem")).toHaveText(labelsFor(FILE_MENU_IDS))
			await page.keyboard.press("Escape")
			await expect(retargetedMenu).toHaveCount(0)

			await page.getByRole("button", { name: "Clear selection", exact: true }).click()
			await expect(page.getByText("1 selected", { exact: true })).toHaveCount(0)

			// 3. Trash-variant menu: trash the DIRECTORY via its own context menu (proving Trash is
			// reachable from the right-click surface too, not just the toolbar/bulk bar), then read
			// the reduced menu back on the /trash listing, then restore — net-zero, it lands back in
			// the scratch directory it came from (restoreItems restores to the original parent),
			// where the `finally` below sweeps it up regardless.
			await dirRow.click({ button: "right" })
			const trashMenu = page.getByRole("menu")
			await expect(trashMenu).toBeVisible()
			await trashMenu.getByRole("menuitem", { name: labelFor("trash"), exact: true }).click()

			// Scoped by title, never a bare role: a startup account reminder is an alertdialog too and can
			// pop asynchronously, which would make this both a strict-mode hazard and an unreachable
			// toHaveCount(0) below. Base UI wires the accessible name from the title (confirmDialog.tsx).
			const trashConfirm = page.getByRole("alertdialog", { name: driveDict.driveTrashConfirmTitle })
			await expect(trashConfirm).toBeVisible()
			await trashConfirm.getByRole("button", { name: labelFor("trash"), exact: true }).click()
			// The write budget, not the expect default: this dialog stays open and pending for the whole
			// trash, so its close is the live write settling on the account-wide lease.
			await expect(trashConfirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			// runBulkDialogAction closes that confirm on a server-side rejection too, reporting the
			// difference only as a toast (bulkToast.ts) — read it back so a rejected trash names itself
			// here instead of surfacing as a bare row count below. A single-item bulk can only fail
			// wholesale, so the rejection copy is fully determined.
			const trashFailureToast = driveDict.driveBulkActionCompleteWithFailures_other
				.replace("{{count}}", "0")
				.replace("{{failed}}", "1")
			await expect(page.locator("[data-sonner-toast]").filter({ hasText: trashFailureToast })).toHaveCount(0, { timeout: 5_000 })

			// On the live page: trashItems patches the row out only after the write succeeded, and a refetch
			// already in flight replays that patch (queries/drive.ts's patchListing). A reload proved less, not
			// more — the persisted snapshot it restores holds only successful reads, never patches, so the
			// pre-create listing it rendered could pass on its own — and unloading with the trash's lease
			// release in flight orphaned the lease. The /trash leg below is the server-side proof.
			await expect(dirRow).toHaveCount(0)

			// Retried until the route commits, then the trash-only Empty-trash trigger is required before
			// anything else is touched. It renders once the cold listTrash has landed non-empty, and a trash
			// holding every recent run's debris is slow to read — hence the boot budget.
			await clickSidebarLink(page, "Trash", /\/trash$/)
			const trashListing = await waitForListingSettled(page)
			await expect(page.getByRole("button", { name: "Empty trash", exact: true })).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

			// /trash's filter box is a purely LOCAL name filter — directoryListing.tsx routes every
			// non-"drive" variant to it — applied before virtualization, so it collapses this shared
			// account's several hundred leftover rows to the one row this test just trashed. It resets on
			// navigation, so nothing has to put it back.
			await page.getByRole("searchbox", { name: "Search", exact: true }).fill(dirName)

			const trashedDirRow = trashListing.listbox.getByRole("option", { name: dirName })
			await expect(trashedDirRow).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

			await assertRowContextMenu(page, trashListing.listbox, dirName, TRASH_MENU_IDS)

			await trashedDirRow.click({ button: "right" })
			const restoreMenu = page.getByRole("menu")
			await expect(restoreMenu).toBeVisible()
			// "restore" runs "direct" (itemMenu.logic.ts) — no confirm dialog, unlike bulk restore.
			await restoreMenu.getByRole("menuitem", { name: labelFor("restore"), exact: true }).click()
			// With no confirm to close, the row leaving the trash listing IS the live write — hence the
			// write budget rather than the expect default, which only ever covers a React commit.
			await expect(trashedDirRow).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await clickSidebarLink(page, "Cloud Drive", /\/drive$/)
			const rootAfterRestore = await waitForListingSettled(page)
			await descendInto(page, rootAfterRestore.listbox, scratchName)
			const restoredListing = await waitForListingSettled(page)
			await expect(restoredListing.listbox.getByRole("option", { name: dirName })).toBeVisible()
		} finally {
			// Sweeps the whole scratch subtree — the nested directory and the file, restored or not,
			// in whichever state the test stopped in.
			await trashScratchDirectory(page, scratchName)
		}
	})

	// The links/shared-in/shared-out surfaces are read-only-mutation-wise on this FREE e2e account
	// (share.spec.ts's own comment: zero shared items, zero contacts) — with no row to right-click, a
	// per-item menu simply cannot render there. What CAN be proven live is the write-gating a
	// per-item Move descriptor would otherwise need: the toolbar's New directory/Upload stay
	// present-but-disabled (directoryListing.tsx's writeDisabled, uniform across every non-"drive"
	// variant), and no Move surface is reachable anywhere on the page.
	test("links + shared-root surfaces: toolbar write-gating stands in for a per-item menu on empty listings", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)

		async function assertWriteGated(linkName: string, urlPattern: RegExp): Promise<void> {
			await clickSidebarLink(page, linkName, urlPattern)
			await waitForListingSettled(page)

			// The outgoing surface's own toolbar can linger in the DOM for a frame while the route
			// transition commits, briefly matching each name twice (an observed intermittent strict-mode
			// failure on this exact hop) — waiting for the count to settle to exactly one pins the
			// assertion to the destination surface before the strict single-match assertions run.
			const newDirectory = page.getByRole("button", { name: "New directory", exact: true })
			const upload = page.getByRole("button", { name: "Upload", exact: true })

			await expect(newDirectory).toHaveCount(1)
			await expect(upload).toHaveCount(1)
			await expect(newDirectory).toBeDisabled()
			await expect(upload).toBeDisabled()
			// No Move descriptor is reachable from this page at all — neither a per-item menu (the
			// account has nothing to open one on) nor any other surface.
			await expect(page.getByText(labelFor("move"), { exact: true })).toHaveCount(0)
		}

		await assertWriteGated("Links", /\/links$/)
		await assertWriteGated("Shared with me", /\/shared-in$/)
		await assertWriteGated("Shared with others", /\/shared-out$/)
	})
})

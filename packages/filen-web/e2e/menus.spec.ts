import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	waitForListingSettled,
	dismissStartupReminders,
	enterScratchDirectory,
	trashScratchDirectory,
	descendInto
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
const FILE_MENU_IDS: ActionId[] = ["rename", "move", "favorite", "versions", "info", "download", "share", "publicLink", "copyLink", "trash"]
// Trash variant, either type (itemMenu.test.ts's own "trash variant" case) — the maximally-reduced set.
const TRASH_MENU_IDS: ActionId[] = ["restore", "deletePermanently", "info"]
// Bulk bar, plain drive-variant selection (bulkActionBar.test.ts's own "drive variant" case) — no
// color/versions id exists in the bulk builder at all, per-type or not.
const BULK_MENU_IDS: ActionId[] = ["favorite", "move", "share", "download", "trash"]

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
		test.setTimeout(120_000)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-menus-${runId}`
		const dirName = `e2e-menus-${runId}-dir`
		const fileBaseName = `e2e-menus-${runId}-file`
		const fileName = `${fileBaseName}.txt`

		await page.goto("/drive")

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await page.getByRole("button", { name: "New directory", exact: true }).click()
			const dirDialog = page.getByRole("dialog")
			await expect(dirDialog).toBeVisible()
			await page.getByLabel("Name", { exact: true }).fill(dirName)
			await page.getByRole("button", { name: "Create", exact: true }).click()
			await expect(dirDialog).toHaveCount(0)

			await page.getByRole("button", { name: "Upload", exact: true }).click()
			const uploadMenu = page.getByRole("menu")
			await expect(uploadMenu).toBeVisible()
			await uploadMenu.getByRole("menuitem", { name: "New text file", exact: true }).click()

			const fileDialog = page.getByRole("heading", { name: "New text file", exact: true })
			await expect(fileDialog).toBeVisible()
			await page.getByLabel("Name", { exact: true }).fill(fileBaseName)
			await page.getByRole("button", { name: "Create", exact: true }).click()
			await expect(fileDialog).toHaveCount(0)

			// The editor opens automatically (createTextFile.ts already patched the listing by this
			// point, before any save) — this test never types into it, just proves creation landed and
			// closes the overlay to reach the row underneath.
			await expect(page.locator(".cm-content")).toBeVisible({ timeout: 30_000 })
			await page.keyboard.press("Escape")

			const dirRow = listbox.getByRole("option", { name: dirName })
			const fileRow = listbox.getByRole("option", { name: fileName })
			await expect(dirRow).toBeVisible()
			await expect(fileRow).toBeVisible()

			// 1. Per-type context-menu completeness, right-click only — the RENDERED menu, not the
			// descriptor list a unit test already trusts.
			await assertRowContextMenu(page, listbox, dirName, DIRECTORY_MENU_IDS)
			await assertRowContextMenu(page, listbox, fileName, FILE_MENU_IDS)

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

			await page.getByRole("button", { name: "Clear selection", exact: true }).click()
			await expect(page.getByText("2 selected", { exact: true })).toHaveCount(0)

			// 3. Trash-variant menu: trash the DIRECTORY via its own context menu (proving Trash is
			// reachable from the right-click surface too, not just the toolbar/bulk bar), then read
			// the reduced menu back on the /trash listing, then restore — net-zero, it lands back in
			// the scratch directory it came from (restoreItems restores to the original parent),
			// where the `finally` below sweeps it up regardless. The directory (not the file) is the
			// one taken through /trash's flat root listing: sortDriveItems partitions directories
			// before files unconditionally (sort.ts), and this shared account's /trash holds far more
			// leftover directories than the render window below — a trashed FILE can sit arbitrarily
			// far past every one of them and never mount, a trashed DIRECTORY only competes with its
			// own partition.
			await dirRow.click({ button: "right" })
			const trashMenu = page.getByRole("menu")
			await expect(trashMenu).toBeVisible()
			await trashMenu.getByRole("menuitem", { name: labelFor("trash"), exact: true }).click()

			const trashConfirm = page.getByRole("alertdialog")
			await expect(trashConfirm).toBeVisible()
			await trashConfirm.getByRole("button", { name: labelFor("trash"), exact: true }).click()
			await expect(trashConfirm).toHaveCount(0)
			await expect(dirRow).toHaveCount(0)

			// Within the directories partition, default name-ascending order can still bury a fresh
			// row under alphabetically-earlier debris — sorting by upload date (descending) puts THIS
			// test's own just-trashed directory at or near the top of its partition instead, since
			// nothing else in the account was uploaded more recently.
			await page.getByRole("complementary").getByRole("link", { name: "Trash", exact: true }).click()
			const trashListing = await waitForListingSettled(page)

			await page.getByRole("button", { name: "Sort by", exact: true }).click()
			const sortMenu = page.getByRole("menu")
			await expect(sortMenu).toBeVisible()
			await sortMenu.getByRole("menuitemradio", { name: "Upload date", exact: true }).click()
			await page.getByRole("menuitemradio", { name: "Descending", exact: true }).click()
			await page.keyboard.press("Escape")
			await expect(sortMenu).toHaveCount(0)

			const trashedDirRow = trashListing.listbox.getByRole("option", { name: dirName })
			await expect(trashedDirRow).toBeVisible({ timeout: 15_000 })

			await assertRowContextMenu(page, trashListing.listbox, dirName, TRASH_MENU_IDS)

			await trashedDirRow.click({ button: "right" })
			const restoreMenu = page.getByRole("menu")
			await expect(restoreMenu).toBeVisible()
			// "restore" runs "direct" (itemMenu.logic.ts) — no confirm dialog, unlike bulk restore.
			await restoreMenu.getByRole("menuitem", { name: labelFor("restore"), exact: true }).click()
			await expect(trashedDirRow).toHaveCount(0)

			await page.getByRole("complementary").getByRole("link", { name: "Cloud Drive", exact: true }).click()
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

		await page.goto("/drive")
		await dismissStartupReminders(page)

		const sidebar = page.getByRole("complementary")

		async function assertWriteGated(linkName: string, urlPattern: RegExp): Promise<void> {
			await sidebar.getByRole("link", { name: linkName, exact: true }).click()
			await page.waitForURL(urlPattern)
			await waitForListingSettled(page)

			await expect(page.getByRole("button", { name: "New directory", exact: true })).toBeDisabled()
			await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeDisabled()
			// No Move descriptor is reachable from this page at all — neither a per-item menu (the
			// account has nothing to open one on) nor any other surface.
			await expect(page.getByText(labelFor("move"), { exact: true })).toHaveCount(0)
		}

		await assertWriteGated("Links", /\/links$/)
		await assertWriteGated("Shared with me", /\/shared-in$/)
		await assertWriteGated("Shared with others", /\/shared-out$/)
	})
})

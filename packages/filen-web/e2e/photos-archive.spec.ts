import type { Locator, Page } from "@playwright/test"
import { test, expect, readFixtureManifest, settleLeases } from "./fixtures"
import { namePattern, openSubmenu, selectionBar, waitForCompressDialog } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES } from "./helpers/fixtures"
import { PNG_BYTES } from "./helpers/fixtureBytes"
import { expectJobCard, hideJobCards, stopAllJobs } from "./helpers/jobs"
import {
	bootTo,
	createDirectoryViaDialog,
	descendInto,
	dismissOverlays,
	enterScratchDirectory,
	openPhotos,
	trashScratchDirectory,
	uploadFiles,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { setAppOffline } from "./helpers/offline"

// Compress from Photos: the tile menu, the selection bar, the options dialog with a mixed selection and
// with Afterwards, and the gates (no Extract anywhere in Photos, Compress off while offline). Photos only
// ever compresses: what it makes lands in the Cloud Drive tree beside the photos, or where the dialog
// says, so every submit here goes to the scratch directory and none to the drive root.

const OFFLINE_TITLE = "Unavailable while offline"

// Picks the photos root down `path` from the drive root in the chooser ("Choose directory" on a fresh
// context, which has no root yet), and returns the grid once it shows `expectTiles` tiles.
async function choosePhotosRoot(page: Page, path: readonly string[], expectTiles: number): Promise<Locator> {
	await openPhotos(page)
	await page.getByRole("button", { name: "Choose directory", exact: true }).click()

	// Scoped by its title: the preview overlay is a dialog too.
	const chooser = page.getByRole("dialog", { name: "Choose a photos directory" })

	await expect(chooser).toBeVisible()

	for (const directory of path) {
		await chooser.getByRole("button", { name: namePattern(directory) }).dblclick()
		await expect(chooser.getByRole("navigation", { name: "Breadcrumb" }).getByText(directory, { exact: true })).toBeVisible()
	}

	const confirm = chooser.getByRole("button", { name: "Choose this directory", exact: true })

	await expect(confirm).toBeEnabled()
	await confirm.click()
	await expect(chooser).toHaveCount(0)

	const grid = page.getByRole("listbox", { name: "Photos grid" })

	// The photos listing walks the root first, a network read.
	await expect(grid.getByRole("option")).toHaveCount(expectTiles, { timeout: 45_000 })

	return grid
}

function tileOf(grid: Locator, name: string): Locator {
	return grid.locator(`[title="${name}"]`)
}

// A tile's "More actions" menu (revealed on hover, so hovered first).
async function openTileMenu(page: Page, tile: Locator): Promise<Locator> {
	await tile.hover()
	await tile.getByRole("button", { name: "More actions", exact: true }).click()

	const menu = page.getByRole("menu").first()

	await expect(menu).toBeVisible()

	return menu
}

// Adds tiles to the selection with the toggle modifier (a plain click on a tile opens the viewer).
async function selectTiles(tiles: readonly Locator[]): Promise<void> {
	for (const tile of tiles) {
		await tile.click({ modifiers: ["ControlOrMeta"] })
		await expect(tile).toHaveAttribute("aria-selected", "true")
	}
}

async function clearSelection(page: Page, grid: Locator): Promise<void> {
	await page.getByRole("button", { name: "Clear selection", exact: true }).click()
	await expect(grid.locator('[role="option"][aria-selected="true"]')).toHaveCount(0)
}

test.describe.configure({ mode: "default" })

test.describe("photos compress", () => {
	test("compresses from the tile menu, the selection bar and the options dialog, naming and placing each archive", async ({ page }) => {
		const cspViolations = trackCspViolations(page)
		const runId = crypto.randomUUID()
		const scratchName = `e2e-ph-${runId}`
		const subName = `sub-${runId}`
		const photoA = `e2e-ph-a-${runId}.png`
		const photoB = `e2e-ph-b-${runId}.png`
		const photoC = `e2e-ph-c-${runId}.png`
		const png = (name: string) => ({ name, mimeType: "image/png", buffer: PNG_BYTES })

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, subName, listbox)
			await uploadFiles(page, [png(photoA), png(photoB)], listbox)
			await descendInto(page, listbox, subName)
			await uploadFiles(page, [png(photoC)], listbox)

			// The scratch directory as the photos root: its two photos and the one in its subdirectory.
			const grid = await choosePhotosRoot(page, [scratchName], 3)
			const [tileA, tileB, tileC] = [tileOf(grid, photoA), tileOf(grid, photoB), tileOf(grid, photoC)]

			// ---- P1: tile menu Compress ▸ ZIP, named after the photo, saved beside it ----
			const menu = await openTileMenu(page, tileA)

			await expect(menu.getByRole("menuitem", { name: "Extract", exact: true })).toHaveCount(0)
			await openSubmenu(page, "Compress")
			await page.getByRole("menuitem", { name: "ZIP (.zip)", exact: true }).click()
			await expectJobCard(page, `Compressed 1 item into e2e-ph-a-${runId}.zip`, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)

			// ---- P2: two photos of one directory, bar Compress ▸ 7-Zip, named after that directory ----
			await selectTiles([tileA, tileB])
			await expect(selectionBar(page).getByRole("button", { name: "Extract", exact: true })).toHaveCount(0)
			await selectionBar(page).getByRole("button", { name: "Compress", exact: true }).click()
			await page.getByRole("menuitem", { name: "7-Zip (.7z)", exact: true }).click()
			await expectJobCard(page, `Compressed 2 items into ${scratchName}.7z`, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)
			await clearSelection(page, grid)

			// ---- P3: photos of two directories: named "Photos", saved in Cloud Drive unless moved ----
			await selectTiles([tileA, tileC])
			await selectionBar(page).getByRole("button", { name: "Compress", exact: true }).click()
			await page.getByRole("menuitem", { name: "More options…", exact: true }).click()

			const mixed = await waitForCompressDialog(page)

			// ZIP named, not left to the format the last preset ran with.
			await mixed.format(/^ZIP/)
			await expect(mixed.nameInput).toHaveValue("Photos")
			await expect(mixed.saveIn).toHaveText("Cloud Drive")
			// Never submitted at the root: redirected into the scratch directory first.
			await mixed.changeDestination([scratchName])
			await expect(mixed.saveIn).toHaveText(scratchName)
			await mixed.submit()
			await expect(mixed.dialog).toHaveCount(0)
			await expectJobCard(page, "Compressed 2 items into Photos.zip", LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)
			await clearSelection(page, grid)

			// ---- P4: More options with "Move the originals to the trash": the photo leaves the grid ----
			await openTileMenu(page, tileB)
			await openSubmenu(page, "Compress")
			await page.getByRole("menuitem", { name: "More options…", exact: true }).click()

			const single = await waitForCompressDialog(page)

			await single.format(/^ZIP/)
			await expect(single.nameInput).toHaveValue(`e2e-ph-b-${runId}`)
			await single.afterwards("Move the originals to the trash")
			await single.submit()
			await expect(single.dialog).toHaveCount(0)
			await expectJobCard(page, `Compressed 1 item into e2e-ph-b-${runId}.zip`, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)
			// Trashed after the archive was checked; the server's echo drops it from the photos listing.
			await expect(tileB).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(grid.getByRole("option")).toHaveCount(2)

			// ---- every archive in the scratch directory, the trashed photo gone from it ----
			await settleLeases(page)
			await bootTo(page)

			const root = await waitForListingSettled(page)

			await descendInto(page, root.listbox, scratchName)

			for (const name of [`e2e-ph-a-${runId}.zip`, `${scratchName}.7z`, "Photos.zip", `e2e-ph-b-${runId}.zip`, photoA]) {
				await expect(root.listbox.getByRole("option", { name: namePattern(name) })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			}

			await expect(root.listbox.getByRole("option", { name: namePattern(photoB) })).toHaveCount(0)

			expect(cspViolations).toEqual([])
		} finally {
			await stopAllJobs(page)
			await trashScratchDirectory(page, scratchName)
		}
	})

	// Over the shared read-only fixture tree's two PNGs: picking a photos root is a local preference, and
	// nothing below ever runs a compress (the entries are only looked at), so this test writes nothing.
	test("offers Compress but never Extract in the viewer's menu, and switches Compress off while offline", async ({ page }) => {
		const cspViolations = trackCspViolations(page)
		const [imageA, imageB] = FIXTURE_FILES["preview-image"]

		await bootTo(page)

		try {
			const grid = await choosePhotosRoot(page, [readFixtureManifest().fixtureRoot, "preview-image"], 2)
			const [tileA, tileB] = [tileOf(grid, imageA), tileOf(grid, imageB)]

			// ---- P5: the viewer's item menu ----
			await tileA.click()

			const overlay = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Next file", exact: true }) })

			await expect(page.getByRole("img", { name: imageA })).toBeVisible({ timeout: 30_000 })
			await overlay.getByRole("button", { name: "More actions", exact: true }).click()

			const menu = page.getByRole("menu").first()

			await expect(menu.getByRole("menuitem", { name: "Compress", exact: true })).toBeVisible()
			await expect(menu.getByRole("menuitem", { name: "Extract", exact: true })).toHaveCount(0)
			await expect(menu.getByRole("menuitem", { name: "Move", exact: true })).toHaveCount(0)
			// Opened to prove it is the Compress submenu, never clicked: a preset would write into the fixture tree.
			await openSubmenu(page, "Compress")
			await expect(page.getByRole("menuitem", { name: "ZIP (.zip)", exact: true })).toBeVisible()
			await expect(page.getByRole("menuitem", { name: "More options…", exact: true })).toBeVisible()
			await dismissOverlays(page)
			await expect(overlay).toHaveCount(0)

			// ---- P6: offline, the bar's Compress and the tile menu's are off, with the reason ----
			await selectTiles([tileA, tileB])
			await expect(selectionBar(page).getByRole("button", { name: "Extract", exact: true })).toHaveCount(0)
			await setAppOffline(page, true)

			const barCompress = selectionBar(page).getByRole("button", { name: "Compress", exact: true })

			await expect(barCompress).toBeDisabled()
			await expect(barCompress).toHaveAttribute("title", OFFLINE_TITLE)
			await clearSelection(page, grid)

			const tileMenu = await openTileMenu(page, tileB)
			const tileCompress = tileMenu.getByRole("menuitem", { name: "Compress", exact: true })

			await expect(tileCompress).toHaveAttribute("aria-disabled", "true")
			await expect(tileCompress).toHaveAttribute("title", OFFLINE_TITLE)
			await expect(tileMenu.getByRole("menuitem", { name: "Extract", exact: true })).toHaveCount(0)
			await dismissOverlays(page)
		} finally {
			await setAppOffline(page, false)
		}

		expect(cspViolations).toEqual([])
	})
})

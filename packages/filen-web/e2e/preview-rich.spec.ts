import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { archiveBrowser, itemRow, previewOverlay } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { RICH_FONT_FAMILY, RICH_SQLITE_ENTRY } from "./fixtures/rich"

// The rich viewers on files of the shared fixture tree: what each shows, read from the file alone (no request leaves
// the app and Filen's hosts).

const [FONT_TTF, FONT_WOFF2] = FIXTURE_FILES["rich-fonts"]
const [APP_DB, WAL_DB, NOT_DB] = FIXTURE_FILES["rich-sqlite"]
const [DB_ARCHIVE] = FIXTURE_FILES["rich-sqlite-archive"]

async function closePreview(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(previewOverlay(page)).toHaveCount(0)
}

// The database viewer's users table, its integrity checked by itself (the file is under 256 MiB, read whole once), and
// the first data row's first cell in the selection bar after one step down the grid.
async function expectDatabase(page: Page, dialog: Locator): Promise<void> {
	// The list is by name: `audit` is selected first.
	await dialog.getByRole("button", { name: "users", exact: true }).click({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("Checked", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText(/70,000 rows|≥ 50,000 rows/)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await dialog.getByLabel("Table rows").click()
	await page.keyboard.press("ArrowDown")
	await expect(dialog.getByText("users.id, row 1", { exact: true })).toBeVisible()
	// Views and virtual tables are listed with their SQL and never run.
	await dialog.getByRole("button", { name: "notes", exact: true }).click()
	await expect(dialog.getByText("Virtual table — not browsed.")).toBeVisible()
	await dialog.getByRole("button", { name: "recent", exact: true }).click()
	await expect(dialog.getByText("View — its SQL is shown, it is not run.")).toBeVisible()
}

test("a font opens as a specimen, its glyphs and its names", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "rich-fonts")

	await itemRow(listbox, FONT_TTF).dblclick()

	const dialog = previewOverlay(page)

	await expect(dialog.getByText(`${RICH_FONT_FAMILY} · Regular · TrueType`, { exact: false })).toBeVisible({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})
	await expect(dialog.getByText("The quick brown fox jumps over the lazy dog").first()).toBeVisible()

	// The face is registered under its own family and really loaded.
	expect(
		await page.evaluate(() => [...document.fonts].some(face => face.family.includes("filen-preview-") && face.status === "loaded"))
	).toBe(true)

	await dialog.getByRole("textbox", { name: "Preview text" }).fill("Hamburgefonstiv")
	await expect(dialog.getByText("Hamburgefonstiv")).toHaveCount(6)

	await dialog.getByRole("tab", { name: "Glyphs" }).click()
	await expect(dialog.getByTitle("U+0041", { exact: true })).toBeVisible()

	await dialog.getByRole("tab", { name: "Info" }).click()
	await expect(dialog.getByText("PostScript name")).toBeVisible()
	await expect(dialog.getByText("Arimo-Regular", { exact: true })).toBeVisible()

	await closePreview(page)

	// The face goes with the viewer.
	expect(await page.evaluate(() => [...document.fonts].some(face => face.family.includes("filen-preview-")))).toBe(false)

	// A variable WOFF2 (brotli: the JavaScript decoder on Chromium, the platform's elsewhere) gets its axes.
	await itemRow(listbox, FONT_WOFF2).dblclick()
	await expect(dialog.getByText("WOFF2", { exact: false }).first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("Variable axes")).toBeVisible()
	await expect(dialog.getByRole("slider").first()).toBeVisible()

	await closePreview(page)

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("a SQLite database is browsed read-only, from the drive and from an archive", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	let listbox = await gotoFixture(page, "rich-sqlite")
	const dialog = previewOverlay(page)

	await itemRow(listbox, APP_DB).dblclick()
	await expectDatabase(page, dialog)
	await closePreview(page)

	// A WAL-mode file reads as rollback mode, and says what it cannot show.
	await itemRow(listbox, WAL_DB).dblclick()
	await expect(dialog.getByText("Changes still in the WAL file are not shown.")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await closePreview(page)

	// A .db opens as a database only once its head says so.
	await itemRow(listbox, NOT_DB).dblclick()
	await expect(dialog.getByText("Preview isn't available for this file type yet.")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await closePreview(page)

	listbox = await gotoFixture(page, "rich-sqlite-archive")
	await itemRow(listbox, DB_ARCHIVE).dblclick()

	const browser = archiveBrowser(page)

	await expect(browser.row(RICH_SQLITE_ENTRY)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await browser.row(RICH_SQLITE_ENTRY).dblclick()
	await expectDatabase(page, browser.overlay)
	await browser.close()

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

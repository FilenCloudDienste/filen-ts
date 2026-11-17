import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { archiveBrowser, itemRow, previewOverlay } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { RICH_FONT_FAMILY, RICH_SQLITE_ENTRY } from "./fixtures/rich"
import { RICH_CUBE_TRIANGLES, RICH_MODEL_ENTRY, RICH_MODELS_PASSWORD } from "./fixtures/richModels"
import { WORKER_WEBGL } from "./helpers/workerWebgl"
import { drawnPixels } from "./helpers/canvasPixels"

// The rich viewers on files of the shared fixture tree: what each shows, read from the file alone (no request leaves
// the app and Filen's hosts).

const [FONT_TTF, FONT_WOFF2] = FIXTURE_FILES["rich-fonts"]
const [APP_DB, WAL_DB, NOT_DB] = FIXTURE_FILES["rich-sqlite"]
const [DB_ARCHIVE] = FIXTURE_FILES["rich-sqlite-archive"]
const [RIDE, PLACES_KML, PLACES_KMZ, AREA] = FIXTURE_FILES["rich-geo"]
const [CUBE_STL, MESH_OBJ, , , MODEL_GLB, PRINT_3MF] = FIXTURE_FILES["rich-models"]
const [LONE_OBJ] = FIXTURE_FILES["rich-models-lone"]
const [MODELS_ZIP, MODELS_LOCKED_ZIP] = FIXTURE_FILES["rich-models-archive"]

async function closePreview(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(previewOverlay(page)).toHaveCount(0)
}

// The database viewer's users table, its integrity checked by itself (the file is under 256 MiB, read whole once), and
// the first two data rows' first cells in the selection bar as the keyboard walks the grid.
async function expectDatabase(page: Page, dialog: Locator): Promise<void> {
	// The list is by name: `audit` is selected first.
	await dialog.getByRole("button", { name: "users", exact: true }).click({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("Checked", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText(/70,000 rows|≥ 50,000 rows/)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	// A click selects the cell under the pointer, wherever the grid has scrolled to. Mod+Home then goes to the first cell
	// below the frozen header row, as Excel does with frozen panes: the first data row.
	await dialog.getByLabel("Table rows").click()
	await page.keyboard.press("ControlOrMeta+Home")
	await expect(dialog.getByText("users.id, row 1", { exact: true })).toBeVisible()
	await page.keyboard.press("ArrowDown")
	await expect(dialog.getByText("users.id, row 2", { exact: true })).toBeVisible()
	// Views and virtual tables are listed with their SQL and never run.
	await dialog.getByRole("button", { name: "notes", exact: true }).click()
	await expect(dialog.getByText("Virtual table — not browsed.")).toBeVisible()
	await dialog.getByRole("button", { name: "recent", exact: true }).click()
	await expect(dialog.getByText("View — its SQL is shown, it is not run.")).toBeVisible()
}

test("a font opens as a specimen, its glyphs and its names", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

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
	expect(cspBlocked).toEqual([])
})

test("a SQLite database is browsed read-only, from the drive and from an archive", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

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
	expect(cspBlocked).toEqual([])
})

test("a track is plotted from the file alone, with its figures, profile and references never fetched", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "rich-geo")
	const dialog = previewOverlay(page)

	await itemRow(listbox, RIDE).dblclick()
	await expect(dialog.getByText(/↑ \d+ m ↓ \d+ m/)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText(/120 points · 1 waypoint/)).toBeVisible()
	await expect(dialog.getByLabel("Track plot")).toBeVisible()
	// The track, its markers and the scale bar are drawn (the worker draws on demand, a frame after the load).
	await expect.poll(() => drawnPixels(dialog.getByLabel("Track plot")), { timeout: LAZY_VIEWER_TIMEOUT_MS }).toBeGreaterThan(200)
	await expect(dialog.getByRole("slider", { name: "Elevation profile" })).toBeVisible()

	// The source is the file's text, read-only.
	await dialog.getByRole("button", { name: "Source", exact: true }).click()
	await expect(dialog.getByText("Morning ride")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await dialog.getByRole("button", { name: "Plot", exact: true }).click()
	await expect(dialog.getByLabel("Track plot")).toBeVisible()
	await closePreview(page)

	for (const name of [PLACES_KML, PLACES_KMZ]) {
		await itemRow(listbox, name).dblclick()
		await expect(dialog.getByText("2 network references not loaded")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(dialog.getByLabel("Track plot")).toBeVisible()
		await closePreview(page)
	}

	await itemRow(listbox, AREA).dblclick()
	await expect(dialog.getByText(/5 points · 1 waypoint/)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await closePreview(page)

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

// A model drawn in the 3D worker, its figures in the information panel; where the engine gives a worker no WebGL, the
// card saying so, with View source for a text format.
async function expectModel(
	dialog: Locator,
	webgl: boolean,
	figures: { triangles: number; textures?: number; text: boolean }
): Promise<void> {
	if (!webgl) {
		await expect(dialog.getByText("This browser can't display 3D models here.")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(dialog.getByRole("button", { name: "View source", exact: true })).toHaveCount(figures.text ? 1 : 0)

		return
	}

	await expect(dialog.getByLabel("3D model", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByRole("button", { name: "Info", exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	// The model is drawn into the worker's canvas.
	await expect
		.poll(() => drawnPixels(dialog.getByLabel("3D model", { exact: true })), { timeout: LAZY_VIEWER_TIMEOUT_MS })
		.toBeGreaterThan(200)
	await dialog.getByRole("button", { name: "Info", exact: true }).click()

	const panel = dialog.getByRole("complementary")

	await expect(panel.getByText("Triangles", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(panel.getByText(String(figures.triangles), { exact: true }).first()).toBeVisible()

	if (figures.textures !== undefined) {
		await expect(panel.getByText("Textures", { exact: true })).toBeVisible()
	}

	await expect(dialog.getByText(/referenced files? not loaded/)).toHaveCount(0)
}

test("a 3D model is drawn in a worker from its own files, and references outside them never fetched", async ({
	page,
	context,
	browserName
}) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })
	const webgl = WORKER_WEBGL[browserName]

	await bootTo(page)

	let listbox = await gotoFixture(page, "rich-models")
	const dialog = previewOverlay(page)

	await itemRow(listbox, CUBE_STL).dblclick()
	await expectModel(dialog, webgl, { triangles: RICH_CUBE_TRIANGLES, text: false })
	await closePreview(page)

	// The MTL and its texture beside the OBJ are found; its source is a button away.
	await itemRow(listbox, MESH_OBJ).dblclick()
	await expectModel(dialog, webgl, { triangles: 2, textures: 1, text: true })
	await dialog.getByRole("button", { name: "View source", exact: true }).click()
	await expect(dialog.getByText("mtllib rich-mesh.mtl")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await closePreview(page)

	// Draco geometry and an embedded texture (the decoders served from 'self'), and a 3MF's mesh.
	await itemRow(listbox, MODEL_GLB).dblclick()
	await expectModel(dialog, webgl, { triangles: RICH_CUBE_TRIANGLES, textures: 1, text: false })
	await closePreview(page)
	await itemRow(listbox, PRINT_3MF).dblclick()
	await expectModel(dialog, webgl, { triangles: RICH_CUBE_TRIANGLES, text: false })
	await closePreview(page)

	listbox = await gotoFixture(page, "rich-models-lone")
	await itemRow(listbox, LONE_OBJ).dblclick()

	if (webgl) {
		await expect(dialog.getByText("1 referenced file not loaded")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await dialog.getByRole("button", { name: "Info", exact: true }).click()
		await expect(dialog.getByRole("complementary").getByText("rich-lone.mtl", { exact: true })).toBeVisible()
	} else {
		await expectModel(dialog, webgl, { triangles: 2, text: true })
	}

	await closePreview(page)

	// An archive's entry finds its MTL beside it and its texture in a subdirectory of the archive, an encrypted one with
	// the password the entry took.
	listbox = await gotoFixture(page, "rich-models-archive")

	for (const archive of [MODELS_ZIP, MODELS_LOCKED_ZIP]) {
		await itemRow(listbox, archive).dblclick()

		const browser = archiveBrowser(page)

		await expect(browser.row(RICH_MODEL_ENTRY)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await browser.row(RICH_MODEL_ENTRY).dblclick()

		// The entry's password gate opens its prompt at once (its button shows only once the prompt is dismissed).
		if (archive === MODELS_LOCKED_ZIP) {
			await browser.unlock(RICH_MODELS_PASSWORD)
		}

		await expectModel(browser.overlay, webgl, { triangles: 2, textures: 1, text: true })
		await browser.close()
	}

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

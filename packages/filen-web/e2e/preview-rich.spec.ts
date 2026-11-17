import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { itemRow } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { RICH_FONT_FAMILY } from "./fixtures/rich"

// The rich viewers on files of the shared fixture tree: what each shows, read from the file alone (no request leaves
// the app and Filen's hosts).

const [FONT_TTF, FONT_WOFF2] = FIXTURE_FILES["rich-fonts"]

async function closePreview(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("dialog")).toHaveCount(0)
}

test("a font opens as a specimen, its glyphs and its names", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "rich-fonts")

	await itemRow(listbox, FONT_TTF).dblclick()

	const dialog = page.getByRole("dialog")

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

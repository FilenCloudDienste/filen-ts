import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { DOCX_FIXTURE_TEXT } from "./helpers/docxFixtures"
import { trackCspViolations } from "./helpers/csp"
import { preview } from "@/locales/en/preview"

// Every document the DOCX editing specs work on opens in the editor in a real browser: the editing toolbar
// shows and the page draws the document's text. Read-only: nothing is typed, so nothing is saved.

test("opens every DOCX editing fixture in the editor, no CSP console errors", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const { rows } = await openFixtureRows(page, "docx-edit")
	const toolbar = page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })

	for (const [index, name] of FIXTURE_FILES["docx-edit"].entries()) {
		const row = rows[index]

		if (row === undefined) {
			throw new Error(`no row for ${name}`)
		}

		await row.dblclick()
		await expect(toolbar).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(page.locator(".fo-docx-page").getByText(DOCX_FIXTURE_TEXT[name]).first()).toBeVisible({
			timeout: LAZY_VIEWER_TIMEOUT_MS
		})

		await page.keyboard.press("Escape")
		await expect(toolbar).toHaveCount(0)
	}

	expect(cspViolations).toEqual([])
})

import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { ODS_MIME, odsFixture } from "./helpers/odsFixtures"
import { activeCell, expectCell, goTo, openFromListing } from "./helpers/sheet"
import { assistantRequests, scriptAssistant } from "./helpers/assistant"
import { preview } from "@/locales/en/preview"
import { assistant } from "@/locales/en/assistant"

// The spreadsheet formula bar's ✨ over the scripted model (helpers/assistant.ts): the ask, the formula the model
// wrote checked and calculated by the sheet's engine without writing a cell, its result for the active cell, and
// Insert putting it into the entry for Enter to write. Write lane: the workbook is uploaded into the test's own
// scratch directory (the read tree holds no spreadsheet), and the cell edit may autosave there.
test.describe.configure({ mode: "default" })

// odsFixture's "Budget": B2 1200 (Rent), B3 300 (Food).
const FORMULA = "=SUM(B2:B3)"

test("the formula helper writes a checked formula, shows its result and inserts it into the cell", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "assistant-formula", async ({ listbox, runId }) => {
		const name = `e2e-assistant-formula-${runId}.ods`

		await uploadFiles(page, [{ name, mimeType: ODS_MIME, buffer: odsFixture(ODS_MIME) }], listbox)
		await scriptAssistant(page, { formula: FORMULA })

		const dialog = await openFromListing(page, listbox, name)

		await expectCell(dialog, "A1", "Item", LAZY_VIEWER_TIMEOUT_MS)
		await goTo(dialog, "D2")

		await dialog.getByRole("button", { name: assistant.assistantFormulaOpen, exact: true }).click()

		const helper = page.locator("[data-assistant-formula]")

		await expect(helper).toBeVisible()
		await helper.getByRole("textbox", { name: assistant.assistantFormulaAskLabel, exact: true }).fill("total cost of rent and food")
		await helper.getByRole("button", { name: assistant.assistantFormulaWrite, exact: true }).click()

		// The engine's value for D2, never one the model stated; nothing written to the cell yet.
		await expect(helper.locator("[data-assistant-formula-text]")).toHaveText(FORMULA)
		await expect(helper.getByRole("status")).toHaveText(/^Result for D2: 1[^0-9]?500$/)
		await expect(activeCell(dialog)).toHaveText("")
		expect((await assistantRequests(page)).filter(request => request.kind === "formula").length).toBeGreaterThanOrEqual(1)

		await helper.getByRole("button", { name: assistant.assistantFormulaInsert, exact: true }).click()
		await expect(helper).toHaveCount(0)
		// Insert only fills the entry and leaves focus in it; Enter writes it, as any cell edit.
		await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-sheet-editor]") !== null)).toBe(true)
		await expect(dialog.locator("textarea[data-sheet-editor]").first()).toHaveValue(FORMULA)
		await page.keyboard.press("Enter")

		await expectCell(dialog, "D2", "1500")
		await expect(dialog.getByRole("textbox", { name: preview.previewSpreadsheetCellContents })).toHaveValue(FORMULA)
		await page.keyboard.press("Escape")
	})
	expect(cspViolations).toEqual([])
})

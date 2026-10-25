import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { DOCX_FIXTURE_TEXT } from "./helpers/docxFixtures"
import { ribbonButton, ribbonTab } from "./helpers/ribbon"
import { preview } from "@/locales/en/preview"

// Equations in the DOCX editor in a real browser: a new one typed as LaTeX from the Insert menu, its preview
// painted as typed and an error shown inline, and one of the document opened by a press on it and changed.
// Nothing is saved: the document is only changed in the page.

const NAME = "w3-equations.docx"

async function openDocument(page: Page): Promise<Locator> {
	await bootTo(page)

	const { rows } = await openFixtureRows(page, "docx-edit")
	const row = rows[FIXTURE_FILES["docx-edit"].indexOf(NAME)]

	if (row === undefined) {
		throw new Error(`no row for ${NAME}`)
	}

	await row.dblclick()

	const toolbar = page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })

	await expect(toolbar).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.locator(".fo-docx-page").getByText(DOCX_FIXTURE_TEXT[NAME]).first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return toolbar
}

async function newEquation(page: Page): Promise<Locator> {
	await page.getByText(DOCX_FIXTURE_TEXT[NAME]).first().click()
	await page.keyboard.press("End")
	await ribbonTab(page, preview.previewOfficeRibbonTabInsert)
	await (await ribbonButton(page, page, preview.previewDocxRibbonSymbols, preview.previewDocxEquationInsert)).click()

	const popover = page.getByRole("dialog", { name: preview.previewDocxEquationInsertTitle })

	await expect(popover).toBeVisible()

	return popover
}

test("inserts an equation typed as LaTeX, previewed as typed; an error shows inline", async ({ page }) => {
	await openDocument(page)
	const equations = page.locator(".fo-docx-page .fo-docx-math")

	await expect(equations).toHaveCount(2, { timeout: LAZY_VIEWER_TIMEOUT_MS })

	let popover = await newEquation(page)
	const field = popover.getByLabel(preview.previewDocxEquationLatex)

	await field.fill("\\frac{1}")
	await expect(popover.getByRole("alert")).toBeVisible()
	await page.keyboard.press("Escape")
	await expect(popover).toHaveCount(0)

	popover = await newEquation(page)
	await popover.getByLabel(preview.previewDocxEquationLatex).fill("\\frac{1}{x}+\\sqrt{2}")
	await expect(popover.getByRole("img", { name: preview.previewDocxEquationPreview }).locator("mfrac")).toHaveCount(1)
	await popover.getByRole("button", { name: preview.previewDocxEquationInsertAction }).click()
	await expect(popover).toHaveCount(0)
	await expect(equations).toHaveCount(3, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(equations.locator("mfrac")).toHaveCount(2)
})

test("edits an equation pressed on the page", async ({ page }) => {
	await openDocument(page)

	const equations = page.locator(".fo-docx-page .fo-docx-math")

	await expect(equations).toHaveCount(2, { timeout: LAZY_VIEWER_TIMEOUT_MS })

	// A press where the user sees the equation: the page's text layer lies over it, so an element click
	// (which needs the equation itself under the pointer) never lands.
	const box = await equations.first().boundingBox()

	if (box === null) {
		throw new Error("the equation has no box")
	}

	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

	const popover = page.getByRole("dialog", { name: preview.previewDocxEquationEdit })
	const field = popover.getByLabel(preview.previewDocxEquationLatex)

	await expect(field).toHaveValue("a^2+b^2")
	await field.fill("a^2+b^2=c^2")
	await field.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
	await expect(popover).toHaveCount(0)
	await expect(equations.first()).toContainText("c", { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(equations).toHaveCount(2)
})

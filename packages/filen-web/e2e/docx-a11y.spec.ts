import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows, type FixtureScenario } from "./helpers/fixtures"
import { archiveBrowser } from "./helpers/archive"
import { DOCX_FIXTURE_TEXT, DOCX_PICTURE_ALT, DOCX_VIEWER_TEXT, type DocxFixtureName } from "./helpers/docxFixtures"
import { preview } from "@/locales/en/preview"

// What a screen reader is told about the DOCX surfaces that are not text: the comment balloons (viewer and
// editor), a picture's handles, a field's chip and a content control's popover, asserted as roles and
// accessible names. Read-only: presses select, open and close; nothing is typed or saved.

test.describe.configure({ mode: "default" })

// Wide enough for the balloon column beside the page at 100 %.
const WIDE = { width: 1600, height: 900 }
const AUTHOR = "E2E Reviewer"

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text).first()
}

// The painted line holding `text` (a label and the control after it).
function lineWith(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page .fo-docx-line").filter({ hasText: text }).first()
}

async function clickCenter(page: Page, locator: Locator): Promise<void> {
	const box = await locator.boundingBox()

	if (box === null) {
		throw new Error("not on the page")
	}

	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

// The end of a line's text: the control after its label.
async function clickEnd(locator: Locator): Promise<void> {
	const box = await locator.locator(".fo-docx-run").last().boundingBox()

	if (box === null) {
		throw new Error("no text on the line")
	}

	await locator.page().mouse.click(box.x + box.width - 4, box.y + box.height / 2)
}

async function openRow(page: Page, scenario: FixtureScenario, name: string): Promise<void> {
	await bootTo(page)

	const { rows } = await openFixtureRows(page, scenario)
	const files: readonly string[] = FIXTURE_FILES[scenario]
	const row = rows[files.indexOf(name)]

	if (row === undefined) {
		throw new Error(`no row for ${name}`)
	}

	await page.setViewportSize(WIDE)
	await row.dblclick()
}

async function openInEditor(page: Page, scenario: "docx-edit" | "docx-notes-picture", name: DocxFixtureName): Promise<void> {
	await openRow(page, scenario, name)
	await expect(pageText(page, DOCX_FIXTURE_TEXT[name])).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

// A document in the drive opens in the editor; the viewer's are read from the fixture zip.
test("viewer balloons and pictures: a named comments landmark, each balloon named by its author, a named picture", async ({ page }) => {
	await openRow(page, "docx-viewer", "viewer-archive.zip")

	const browser = archiveBrowser(page)

	await expect(browser.row("viewer-review.docx")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await browser.row("viewer-review.docx").dblclick()
	await expect(pageText(page, DOCX_VIEWER_TEXT["viewer-review.docx"])).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	const column = page.getByRole("complementary", { name: preview.previewDocxComments })

	await expect(column).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(column.getByLabel(`Comment by ${AUTHOR}`, { exact: true }).first()).toBeVisible()
	// The picture is an image named by its alternative text (wp:docPr@descr).
	await expect(page.getByRole("img", { name: DOCX_PICTURE_ALT, exact: true })).toBeVisible()
})

test.describe("editor", () => {
	test("comment balloons: a named comments landmark, every control in a balloon named", async ({ page }) => {
		await openInEditor(page, "docx-edit", "w3-comments.docx")

		const column = page.getByRole("complementary", { name: preview.previewDocxComments })
		const balloon = page.locator("article[data-balloon^='c:']").first()

		await expect(column).toBeAttached()
		await expect(balloon).toBeVisible()
		await balloon.click()
		await expect(page.getByRole("article", { name: `Comments by ${AUTHOR}` })).toBeVisible()
		await expect(balloon.getByRole("button", { name: preview.previewDocxCommentActions }).first()).toBeVisible()
		await expect(balloon.getByRole("button", { name: preview.previewDocxReplyPlaceholder })).toBeVisible()
	})

	test("picture handles: kept from the accessibility tree, the Picture tab's group named", async ({ page }) => {
		await openInEditor(page, "docx-notes-picture", "described-picture.docx")

		const picture = page.locator(".fo-docx-page image").first()

		await expect(picture).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		// The input view carries the picture's name (the pages are hidden from assistive technology).
		await expect(page.getByRole("img", { name: DOCX_PICTURE_ALT, exact: true })).toBeAttached()
		// The page's text layer is over it: a press where it is drawn.
		await clickCenter(page, picture)

		const handles = page.locator("[data-docx-object-handles]")

		// A layer around absolutely placed handles (it has no box of its own).
		await expect(handles).toBeAttached()
		await expect(handles.locator("[data-fo-handle]")).toHaveCount(8)
		// Pointer handles only: nothing of them in the accessibility tree; the ribbon's Picture tab is the keyboard's way.
		expect(await handles.ariaSnapshot()).toBe("")
		await page.getByRole("tab", { name: preview.previewDocxPictureGroup, exact: true }).click()
		await expect(page.getByRole("group", { name: preview.previewDocxPictureGroup })).toBeVisible()
	})

	test("field chip: a named toolbar of named buttons", async ({ page }) => {
		await openInEditor(page, "docx-edit", "w3-toc.docx")
		await pageText(page, "No table of contents entries found.").click()

		const chip = page.getByRole("toolbar", { name: preview.previewDocxFieldChip })

		await expect(chip).toBeVisible()
		await expect(chip.getByRole("button", { name: preview.previewDocxUpdateToc })).toBeVisible()
	})

	test("content control popovers: a named list of options, a labelled date field", async ({ page }) => {
		await openInEditor(page, "docx-edit", "w3-forms.docx")

		await clickEnd(lineWith(page, "Colour: Red"))

		const popover = page.locator("[data-docx-control-popover]")

		await expect(popover).toBeVisible()
		// A dialog named for what it does (no title on this control), holding a named list of options.
		await expect(page.getByRole("dialog", { name: preview.previewDocxControlChoose, exact: true })).toBeVisible()

		const list = popover.getByRole("listbox", { name: preview.previewDocxControlItems })

		await expect(list).toBeVisible()
		await expect(list.getByRole("option", { name: "Red" })).toHaveAttribute("aria-selected", "true")
		await expect(list.getByRole("option", { name: "Green" })).toHaveAttribute("aria-selected", "false")
		await page.keyboard.press("Escape")
		await expect(popover).toHaveCount(0)

		await clickEnd(lineWith(page, "Date: 1/1/2026"))
		await expect(popover).toBeVisible()
		await expect(page.getByRole("dialog", { name: preview.previewDocxControlDate, exact: true })).toBeVisible()
		await expect(popover.getByLabel(preview.previewDocxControlDateLabel, { exact: true })).toBeVisible()
		await page.keyboard.press("Escape")
		await expect(popover).toHaveCount(0)
	})
})

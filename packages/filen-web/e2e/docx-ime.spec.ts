import type { CDPSession, Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { DOCX_FIXTURE_TEXT, type DocxFixtureName } from "./helpers/docxFixtures"
import { trackCspViolations } from "./helpers/csp"
import { ribbonButton, ribbonCommands, ribbonTab } from "./helpers/ribbon"
import { preview } from "@/locales/en/preview"

// IME composition in the DOCX editor with track changes on, through Chromium's input method protocol (CDP
// Input.imeSetComposition / insertText): in a table cell, a footnote and an endnote the composed text lands
// once, as one tracked insertion the change card names; in a comment's reply field it is the reply's text and
// no change of the document. Reads the shared fixture tree: autosave is off for these pages and every
// document is closed discarding its edits, so nothing is saved.
//
// Chromium only: Firefox and WebKit have no protocol to drive an input method.

test.describe.configure({ mode: "default" })

// Wide enough for the balloon column beside the page at 100 %.
const WIDE = { width: 1600, height: 900 }
const AUTHOR = "E2E Reviewer"
// features/office/lib/officeAutosave.ts's E2E_AUTOSAVE_KEY: an E2E build reads it before the app loads.
const AUTOSAVE_KEY = "filen-e2e-docx-autosave"

test.beforeEach(async ({ page, browserName }) => {
	test.skip(browserName !== "chromium", "IME composition is driven through CDP, which is Chromium's")

	await page.context().addInitScript(key => {
		sessionStorage.setItem(key, "off")
	}, AUTOSAVE_KEY)
})

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text).first()
}

async function openDocument(page: Page, scenario: "docx-edit" | "docx-notes-picture", name: DocxFixtureName): Promise<void> {
	await bootTo(page)

	const { rows } = await openFixtureRows(page, scenario)
	const files: readonly string[] = FIXTURE_FILES[scenario]
	const row = rows[files.indexOf(name)]

	if (row === undefined) {
		throw new Error(`no row for ${name}`)
	}

	await page.setViewportSize(WIDE)
	await row.dblclick()
	await expect(pageText(page, DOCX_FIXTURE_TEXT[name])).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

// Closed with its edits thrown away: the unsaved prompt shows, which is also the proof nothing was saved.
async function closeDiscarding(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await page
		.getByRole("alertdialog", { name: preview.previewUnsavedChangesTitle })
		.getByRole("button", { name: preview.previewDiscardAction })
		.click()
	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
}

// The account may have no author name yet: the first change that records one asks for it, and waits for it.
// `made`: the change went through (with a name already given, nothing is asked).
async function giveNameIfAsked(page: Page, made: () => Promise<boolean>): Promise<void> {
	const dialog = page.getByRole("dialog", { name: preview.previewOfficeAuthorNameTitle })

	await expect.poll(async () => (await dialog.isVisible()) || (await made())).toBe(true)

	if (await dialog.isVisible()) {
		await dialog.getByRole("textbox", { name: preview.previewOfficeAuthorNameLabel }).fill(AUTHOR)
		await dialog.getByRole("button", { name: preview.previewOfficeAuthorNameSave }).click()
		await expect(dialog).toHaveCount(0)
	}
}

// Track changes on, from the Review tab.
async function trackChanges(page: Page): Promise<void> {
	await ribbonTab(page, preview.previewOfficeRibbonTabReview)
	const pressed = ribbonCommands(page).getByRole("button", { name: preview.previewDocxTrackChanges, exact: true, pressed: true })

	await (await ribbonButton(page, page, preview.previewDocxRibbonTracking, preview.previewDocxTrackChanges)).click()
	await giveNameIfAsked(page, () => pressed.isVisible())
	await expect(pressed).toBeVisible()
}

// Clicks just inside the end of `text` on the page.
async function caretAtEndOf(page: Page, text: string): Promise<void> {
	await pageText(page, text).scrollIntoViewIfNeeded()

	const box = await pageText(page, text).boundingBox()

	if (box === null) {
		throw new Error(`"${text}" is not on the page`)
	}

	await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
}

// The painted line holding `text`.
function lineWith(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page .fo-docx-line").filter({ hasText: text }).first()
}

// Into a note from its reference in the body, as a reader does: the body first (the caret may be in another
// note, which one click in the body leaves, a note being edited beside the body), then a press on the
// reference, whose chip goes to the note.
async function caretInNote(page: Page, reference: string, text: string): Promise<void> {
	await caretAtEndOf(page, "After the notes.")
	await lineWith(page, DOCX_FIXTURE_TEXT["notes.docx"])
		.locator(".fo-docx-run")
		.filter({ hasText: new RegExp(`^${reference}$`) })
		.first()
		.click()
	await page
		.getByRole("toolbar", { name: preview.previewDocxFieldChip })
		.getByRole("button", { name: preview.previewDocxNoteGoTo })
		.click()
	// In the note's story, the caret with it, before End moves along the note's line.
	await expect(page.locator(".fo-docx-editor")).toHaveAttribute("data-fo-story", /^(footnote|endnote)$/)
	await expect(page.locator(".fo-docx-sink [role='textbox']:focus")).toHaveCount(1)
	await page.keyboard.press("End")
	await expect(pageText(page, text)).toBeVisible()
}

// A composition in steps, then committed.
async function compose(cdp: CDPSession, steps: readonly string[], committed: string): Promise<void> {
	for (const step of steps) {
		await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length })
	}

	await cdp.send("Input.insertText", { text: committed })
}

// The committed text is on the page once, right after `beside` in its line, nothing of the composition is left
// anywhere, and the caret stepped back into it shows the change card of one insertion holding it.
async function expectTrackedOnce(page: Page, composing: string, committed: string, beside: string): Promise<void> {
	await expect(page.locator(".fo-docx-page").getByText(committed)).toHaveCount(1)
	await expect(lineWith(page, beside)).toContainText(`${beside}${committed}`)
	await expect(page.locator(".fo-docx-page")).not.toContainText(composing)

	await page.keyboard.press("ArrowLeft")

	const card = page.getByRole("dialog", { name: /^Change by / })

	await expect(card).toContainText(preview.previewDocxChangeInserted)
	await expect(card).toContainText(committed)
}

test("in a table cell: one tracked insertion", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await openDocument(page, "docx-edit", "w3-tables.docx")
	await trackChanges(page)
	await caretAtEndOf(page, "B1")

	const cdp = await page.context().newCDPSession(page)

	await compose(cdp, ["ひ", "ひょ", "ひょう"], "表")
	await expect(pageText(page, "表")).toBeVisible()
	await expectTrackedOnce(page, "ひ", "表", "B1")
	await closeDiscarding(page)

	expect(cspViolations).toEqual([])
})

test("in a footnote and an endnote: one tracked insertion each", async ({ page }) => {
	await openDocument(page, "docx-notes-picture", "notes.docx")
	await trackChanges(page)

	const cdp = await page.context().newCDPSession(page)

	for (const [reference, note, committed] of [
		["1", "Footnote fixture text", "脚注"],
		["i", "Endnote fixture text", "文末"]
	] as const) {
		await caretInNote(page, reference, note)
		await compose(cdp, ["き", "きゃ"], committed)
		await expectTrackedOnce(page, "き", committed, note)
		await expect(lineWith(page, "After the notes.")).not.toContainText(committed)
	}

	// One click in the body leaves the note, where Escape closes the document.
	await caretAtEndOf(page, "After the notes.")
	await closeDiscarding(page)
})

test("in a comment's reply field: the reply's text, no change of the document", async ({ page }) => {
	await openDocument(page, "docx-edit", "w3-comments.docx")
	await trackChanges(page)

	const balloon = page.locator("article[data-balloon^='c:']").first()

	await balloon.click()
	await balloon.getByRole("button", { name: preview.previewDocxReplyPlaceholder }).click()

	const field = balloon.getByRole("textbox", { name: preview.previewDocxReplyPlaceholder })

	await expect(field).toBeFocused()

	const cdp = await page.context().newCDPSession(page)

	await compose(cdp, ["へ", "へん", "へんしん"], "返信")
	await expect(field).toHaveText("返信")
	await balloon.getByRole("button", { name: preview.previewDocxCommentReply, exact: true }).click()
	await expect(balloon).toContainText("返信")
	await expect(page.locator(".fo-docx-page").getByText("返信")).toHaveCount(0)

	// Nothing in the document was changed while tracking.
	await ribbonTab(page, preview.previewOfficeRibbonTabReview)
	await expect(await ribbonButton(page, page, preview.previewDocxRibbonChanges, preview.previewDocxNextChange)).toBeDisabled()
	await pageText(page, DOCX_FIXTURE_TEXT["w3-comments.docx"]).click()
	await closeDiscarding(page)
})

import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { DOCX_FIXTURE_TEXT, DOCX_MIME, docxFixtureBytes, type DocxFixtureName } from "./helpers/docxFixtures"
import { trackCspViolations } from "./helpers/csp"
import { ribbonButton, ribbonCommands, ribbonTab } from "./helpers/ribbon"
import { preview } from "@/locales/en/preview"

// Comments and tracked changes in the DOCX editor in a real browser: a comment composed, replied to and
// resolved in its margin balloon (and composed in the popover where the margin has no room), track changes
// switched on with typing recorded and the changes accepted and rejected, and (Chromium, through CDP) IME
// composition recorded as one tracked insertion. Each document is uploaded into the test's own scratch
// directory.

test.describe.configure({ mode: "default" })
// Wide enough for the balloon column beside the page at 100 %; set again once in the scratch directory (entering
// one makes the viewport tall for the listing).
const WIDE = { width: 1600, height: 900 }
const NARROW = { width: 700, height: 900 }

const AUTHOR = "E2E Reviewer"

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text).first()
}

async function upload(page: Page, listbox: Locator, runId: string, fixture: DocxFixtureName): Promise<string> {
	const name = `e2e-${runId}-${fixture}`

	await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxFixtureBytes(fixture) }], listbox)

	return name
}

async function openDocument(page: Page, listbox: Locator, name: string, marker: string, viewport = WIDE): Promise<void> {
	await page.setViewportSize(viewport)
	await listbox.getByRole("option", { name }).dblclick()
	await expect(pageText(page, marker)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function closeDocumentDiscarding(page: Page): Promise<void> {
	await page.keyboard.press("Escape")

	const discard = page
		.getByRole("alertdialog", { name: preview.previewUnsavedChangesTitle })
		.getByRole("button", { name: preview.previewDiscardAction })

	if (await discard.isVisible().catch(() => false)) {
		await discard.click()
	}

	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
}

// The account may have no author name yet: the first change that records one asks for it.
async function giveNameIfAsked(page: Page): Promise<void> {
	const dialog = page.getByRole("dialog", { name: preview.previewOfficeAuthorNameTitle })

	if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
		await dialog.getByRole("textbox", { name: preview.previewOfficeAuthorNameLabel }).fill(AUTHOR)
		await dialog.getByRole("button", { name: preview.previewOfficeAuthorNameSave }).click()
		await expect(dialog).toHaveCount(0)
	}
}

// Track changes switched on from the Review tab (the first change it records may ask for the author's name).
async function trackChanges(page: Page): Promise<void> {
	await ribbonTab(page, preview.previewOfficeRibbonTabReview)

	const track = await ribbonButton(page, page, preview.previewDocxRibbonTracking, preview.previewDocxTrackChanges)

	await track.click()
	await giveNameIfAsked(page)
	await expect(ribbonCommands(page).getByRole("button", { name: preview.previewDocxTrackChanges, exact: true })).toHaveAttribute(
		"aria-pressed",
		"true"
	)
}

// A Review tab command: a button of its group, or an entry of the Reject dropdown.
async function review(page: Page, group: string, button: string, item?: string): Promise<void> {
	await ribbonTab(page, preview.previewOfficeRibbonTabReview)
	await (await ribbonButton(page, page, group, button)).click()

	if (item !== undefined) {
		await page.getByRole("menuitem", { name: item, exact: true }).click()
	}
}

test("comments: composed, replied to and resolved in the margin", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "docx-review-comments", async ({ listbox, runId }) => {
		const name = await upload(page, listbox, runId, "w3-comments.docx")
		const balloons = page.locator("article[data-balloon^='c:']")

		await openDocument(page, listbox, name, DOCX_FIXTURE_TEXT["w3-comments.docx"])
		await expect(balloons).toHaveCount(1)
		await expect(balloons.first()).toContainText("A fixture comment.")

		// A new comment on a word of the second paragraph, composed in a balloon beside it.
		await pageText(page, "second").dblclick()
		await review(page, preview.previewOfficeRibbonComments, preview.previewDocxNewComment)
		await page.getByRole("textbox", { name: preview.previewDocxCommentPlaceholder }).fill("Composed in the margin")
		await page.getByRole("button", { name: preview.previewDocxCommentPost, exact: true }).click()
		await giveNameIfAsked(page)
		await expect(balloons).toHaveCount(2)

		const added = balloons.filter({ hasText: "Composed in the margin" })

		await expect(added).toHaveCount(1)

		// Its reply field, then its ⋯ menu.
		await added.click()
		await added.getByRole("button", { name: preview.previewDocxReplyPlaceholder }).click()
		await added.getByRole("textbox", { name: preview.previewDocxReplyPlaceholder }).fill("A reply")
		await added.getByRole("button", { name: preview.previewDocxCommentReply, exact: true }).click()
		await expect(added).toContainText("A reply")
		await added.getByRole("button", { name: preview.previewDocxCommentActions }).first().click()
		await page.getByRole("menuitem", { name: preview.previewDocxCommentResolve }).click()
		await expect(added).toContainText(preview.previewDocxCommentResolved)

		await closeDocumentDiscarding(page)
	})

	expect(cspViolations).toEqual([])
})

test.describe("without room for balloons", () => {
	test("comments open from their marker and are composed in a popover", async ({ page }) => {
		await withScratchDirectory(page, "docx-review-narrow", async ({ listbox, runId }) => {
			const name = await upload(page, listbox, runId, "w3-comments.docx")

			await openDocument(page, listbox, name, DOCX_FIXTURE_TEXT["w3-comments.docx"], NARROW)
			await expect(page.locator("article[data-balloon]")).toHaveCount(0)
			const marker = page.getByRole("button", { name: new RegExp(`^Comment by `) }).first()

			await marker.click()
			await expect(page.getByText("A fixture comment.")).toBeVisible()
			// Closed from its marker (Escape is the editor's to close it with).
			await marker.click()
			await expect(page.getByText("A fixture comment.")).toHaveCount(0)

			await pageText(page, "second").dblclick()
			await review(page, preview.previewOfficeRibbonComments, preview.previewDocxNewComment)
			await page.getByRole("textbox", { name: preview.previewDocxCommentPlaceholder }).fill("From the popover")
			await page.getByRole("button", { name: preview.previewDocxCommentPost, exact: true }).click()
			await giveNameIfAsked(page)
			await expect(page.getByRole("textbox", { name: preview.previewDocxCommentPlaceholder })).toHaveCount(0)

			// Next to the fixture's, the new comment shares its marker (markers this close are one).
			await marker.click()
			await expect(page.getByText("From the popover")).toBeVisible()
			await marker.click()

			await closeDocumentDiscarding(page)
			// The scratch directory is left from the wide layout (the sidebar folds away this narrow).
			await page.setViewportSize(WIDE)
		})
	})
})

test("track changes: switched on, typing recorded, changes accepted and rejected", async ({ page }) => {
	await withScratchDirectory(page, "docx-review-track", async ({ listbox, runId }) => {
		const name = await upload(page, listbox, runId, "w3-tracked.docx")

		await openDocument(page, listbox, name, DOCX_FIXTURE_TEXT["w3-tracked.docx"])
		await trackChanges(page)

		// Typed while tracking: an insertion the change card names.
		await pageText(page, "An untracked paragraph.").click()
		await page.keyboard.press("End")
		await page.keyboard.type(" Typed while tracking")
		await expect(pageText(page, "Typed while tracking")).toBeVisible()

		// From the start of the first paragraph, the next change is the fixture's insertion: its card accepts it.
		await pageText(page, DOCX_FIXTURE_TEXT["w3-tracked.docx"]).click()
		await page.keyboard.press("Home")
		await review(page, preview.previewDocxRibbonChanges, preview.previewDocxNextChange)

		const card = page.getByRole("dialog", { name: /^Change by / })

		await expect(card).toContainText(preview.previewDocxChangeInserted)
		await card.getByRole("button", { name: preview.previewDocxAccept, exact: true }).click()
		await expect(card).toHaveCount(0)

		// The rest rejected: what was typed goes, the fixture's deletion comes back, no change is left to step to.
		await review(page, preview.previewDocxRibbonChanges, preview.previewDocxRibbonReject, preview.previewDocxRejectAll)
		await expect(pageText(page, "Typed while tracking")).toHaveCount(0)
		await expect(pageText(page, "inserted")).toBeVisible()
		await expect(pageText(page, "deleted")).toBeVisible()

		await ribbonTab(page, preview.previewOfficeRibbonTabReview)
		await expect(await ribbonButton(page, page, preview.previewDocxRibbonChanges, preview.previewDocxNextChange)).toBeDisabled()
		await pageText(page, "inserted").click()

		await closeDocumentDiscarding(page)
	})
})

test("IME composition while tracking is one tracked insertion (Chromium)", async ({ page, browserName }) => {
	test.skip(browserName !== "chromium", "CDP input is Chromium's")

	await withScratchDirectory(page, "docx-review-ime", async ({ listbox, runId }) => {
		const name = await upload(page, listbox, runId, "w3-tracked.docx")

		await openDocument(page, listbox, name, DOCX_FIXTURE_TEXT["w3-tracked.docx"])
		await trackChanges(page)
		await pageText(page, "An untracked paragraph.").click()
		await page.keyboard.press("End")

		const cdp = await page.context().newCDPSession(page)

		await cdp.send("Input.imeSetComposition", { text: "かん", selectionStart: 2, selectionEnd: 2 })
		await cdp.send("Input.imeSetComposition", { text: "かんじ", selectionStart: 3, selectionEnd: 3 })
		await cdp.send("Input.insertText", { text: "漢字" })
		await expect(pageText(page, "漢字")).toBeVisible()

		// The caret moved back into it: its card names the composed text, recorded once composition ended.
		await page.keyboard.press("Home")
		await page.keyboard.press("End")
		await expect(page.getByRole("dialog", { name: /^Change by / })).toContainText("漢字")

		await closeDocumentDiscarding(page)
	})
})

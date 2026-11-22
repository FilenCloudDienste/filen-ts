import type { Locator, Page } from "@playwright/test"
import { blankPptx } from "@filen/office/core/templates"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { assistantRequests, scriptAssistant } from "./helpers/assistant"
import { preview } from "@/locales/en/preview"
import { assistant } from "@/locales/en/assistant"

// The assistant's slide edits over the scripted model (helpers/assistant.ts): a selection in the body being edited
// rewritten from Alt+J (Accept is one step of the deck's own undo), a whole text box rewritten from the slide's
// context menu (Accept all: one undo takes every box back), and speaker notes drafted for a slide without notes (Accept
// adds them as one step, undo takes them away). Write lane: the deck is uploaded into the test's own scratch directory,
// and its edits may autosave there.
test.describe.configure({ mode: "default" })

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
const TITLE = "Quarterly results are up"
const REWRITTEN = "Quarterly results improved"

function canvas(page: Page): Locator {
	return page.locator("[data-fo-slide-canvas]")
}

// A line of the slide as painted (the body being edited paints its own page in the same way).
function slideLine(page: Page, text: string): Locator {
	return canvas(page).locator(".fo-docx-line").filter({ hasText: text }).first()
}

// The slide's object layer: Tab selects the next object, Enter edits its text with all of it selected.
function objectLayer(page: Page): Locator {
	return page.getByRole("application", { name: preview.previewPptxCanvasLabel, exact: true })
}

function undoButton(page: Page): Locator {
	return page.getByRole("button", { name: preview.previewPptxRibbonUndo, exact: true }).first()
}

// A deck whose title slide's title reads TITLE (its subtitle empty), uploaded and opened in the editor.
async function openDeck(page: Page, listbox: Locator, runId: string): Promise<void> {
	const name = `e2e-assistant-slides-${runId}.pptx`

	await uploadFiles(page, [{ name, mimeType: PPTX_MIME, buffer: Buffer.from(await blankPptx({ title: TITLE })) }], listbox)

	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()
	await expect(slideLine(page, TITLE)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(objectLayer(page)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

// The title selected as an object (the first object in z-order).
async function selectTitle(page: Page): Promise<void> {
	await objectLayer(page).focus()
	await page.keyboard.press("Tab")
}

function resultPopover(page: Page): Locator {
	return page.locator("[data-assistant-transform]")
}

test("Alt+J rewrites the selected text of the body being edited, as one undo step", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "assistant-slides-selection", async ({ listbox, runId }) => {
		await openDeck(page, listbox, runId)
		await scriptAssistant(page, { transform: REWRITTEN })
		await selectTitle(page)
		// Enter: the title's text, all of it selected.
		await page.keyboard.press("Enter")
		await expect(page.locator("[data-fo-text-editor]")).toBeVisible()
		await page.keyboard.press("Alt+j")

		const menu = page.getByRole("menu", { name: assistant.assistantTransformOpen })

		await menu.getByRole("menuitem", { name: assistant.assistantTransformRewrite, exact: true }).click()

		const popover = resultPopover(page)
		const accept = popover.getByRole("button", { name: assistant.assistantTransformAccept })

		await expect(popover).toContainText(REWRITTEN)
		await expect(accept).toBeEnabled()
		await accept.click()
		await expect(popover).toHaveCount(0)
		await expect(slideLine(page, REWRITTEN)).toBeVisible()
		expect((await assistantRequests(page)).filter(request => request.kind === "transform").at(-1)?.last).toContain(TITLE)

		// One step of the deck's undo takes the replacement back.
		await undoButton(page).click()
		await expect(slideLine(page, TITLE)).toBeVisible()
		await expect(slideLine(page, REWRITTEN)).toHaveCount(0)
	})
	expect(cspViolations).toEqual([])
})

test("the slide's Assistant menu rewrites a selected text box; one undo restores it", async ({ page }) => {
	await withScratchDirectory(page, "assistant-slides-boxes", async ({ listbox, runId }) => {
		await openDeck(page, listbox, runId)
		await scriptAssistant(page, { transform: REWRITTEN })
		await selectTitle(page)
		// The context menu key opens the slide's menu at the selected object.
		await page.keyboard.press("Shift+F10")
		await page.getByRole("menuitem", { name: assistant.assistantMenuAssistant, exact: true }).click()
		await page.getByRole("menuitem", { name: assistant.assistantTransformRewrite, exact: true }).click()

		const popover = resultPopover(page)
		const acceptAll = popover.getByRole("button", { name: assistant.assistantShapeTransformAcceptAll })

		await expect(popover).toContainText(TITLE)
		await expect(popover).toContainText(REWRITTEN)
		await expect(acceptAll).toBeEnabled()
		await acceptAll.click()
		await expect(popover).toHaveCount(0)
		await expect(slideLine(page, REWRITTEN)).toBeVisible()

		await undoButton(page).click()
		await expect(slideLine(page, TITLE)).toBeVisible()
		await expect(slideLine(page, REWRITTEN)).toHaveCount(0)
	})
})

test("a slide without notes drafts them from its text; Accept adds them and undo takes them away", async ({ page }) => {
	const notes = "Our results are up this quarter. Thank you all."

	await withScratchDirectory(page, "assistant-slides-notes", async ({ listbox, runId }) => {
		await openDeck(page, listbox, runId)
		await scriptAssistant(page, { notes })

		const show = page.getByRole("button", { name: preview.previewPptxNotesShow, exact: true })

		if (await show.isVisible()) {
			await show.click()
		}

		await page.getByRole("button", { name: assistant.assistantNotesDraft }).click()

		const draft = page.locator("[data-assistant-notes-draft]")
		const accept = draft.getByRole("button", { name: assistant.assistantTransformAccept })

		await expect(draft).toContainText(notes)
		await expect(accept).toBeEnabled()
		await accept.click()
		await expect(draft).toHaveCount(0)
		await expect(page.getByText(notes)).toBeVisible()
		expect((await assistantRequests(page)).filter(request => request.kind === "notes").at(-1)?.last).toContain(TITLE)

		// One undo step: the notes the draft made go again.
		await undoButton(page).click()
		await expect(page.getByText(notes)).toHaveCount(0)
		await expect(page.getByText(preview.previewPptxNotesAdd)).toBeVisible()
	})
})

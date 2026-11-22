import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { openFixtureRows } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest } from "./helpers/requests"
import {
	assistantComposer,
	assistantConversation,
	assistantPanel,
	assistantRequests,
	scriptAssistant,
	sendAssistantMessage,
	waitForAssistantTurnEnd
} from "./helpers/assistant"

// The assistant beside an open preview, read-only: the shared fixture tree's two-page PDF ("Page One", "Page Two"),
// the scripted model (helpers/assistant.ts) in place of the on-device one. The preview's ✨ toggle moves the panel into
// the overlay as a pane; Escape closes the pane first and the preview only on the next press; the pane's chip names the
// open document, and a read of it goes through the open viewer's engine, with nothing downloaded again.
//
// Not covered here: the trash preview (no pane) needs a trashed item, a write, so it lives in the write lane; a chat's
// or a note's linked file (no pane either) needs a chat or note holding a link, which this read-only lane cannot make.

const PDF_NAME = "preview-pdf.pdf"

function previewToggle(page: Page) {
	return page.locator("#assistant-preview-toggle")
}

// The pane's slot inside the preview overlay (PreviewAssistantPane).
function previewPane(page: Page) {
	return page.locator("#assistant-preview-host").getByRole("complementary", { name: "Assistant", exact: true })
}

function firstPage(page: Page) {
	return page.getByRole("region", { name: /Page 1 of 2/u })
}

async function openPdf(page: Page): Promise<void> {
	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-pdf-pages")

	await row.dblclick()
	await expect(firstPage(page)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

test.describe("assistant in a preview", () => {
	test("the ✨ toggle shows the pane inside the preview, and Escape closes the pane before the preview", async ({ page }) => {
		test.setTimeout(300_000)

		const cspViolations = trackCspViolations(page)

		await openPdf(page)
		await scriptAssistant(page)

		const toggle = previewToggle(page)

		await expect(toggle).toBeVisible()
		await expect(toggle).toHaveAttribute("aria-pressed", "false")
		await expect(previewPane(page)).toHaveCount(0)

		// Shown and hidden from the preview's own header.
		await toggle.click()
		await expect(previewPane(page)).toBeVisible()
		await expect(toggle).toHaveAttribute("aria-pressed", "true")
		await toggle.click()
		await expect(previewPane(page)).toHaveCount(0)
		await expect(toggle).toHaveAttribute("aria-pressed", "false")

		// Opened again, focus lands in the composer; Escape there closes the pane and leaves the preview open.
		await toggle.click()
		await expect(assistantComposer(page)).toBeFocused()
		await page.keyboard.press("Escape")
		await expect(previewPane(page)).toHaveCount(0)
		await expect(firstPage(page)).toBeVisible()
		await expect(toggle).toHaveAttribute("aria-pressed", "false")

		// The next Escape closes the preview, and its toggle goes with it.
		await page.keyboard.press("Escape")
		await expect(firstPage(page)).toHaveCount(0)
		await expect(toggle).toHaveCount(0)

		expect(cspViolations).toEqual([])
	})

	test("the chip names the open PDF and a read of its page downloads nothing again", async ({ page, context }) => {
		test.setTimeout(300_000)

		const cspViolations = trackCspViolations(page)
		const egest = observeEgest(context)

		await openPdf(page)
		await scriptAssistant(page)
		await previewToggle(page).click()
		await expect(previewPane(page)).toBeVisible()

		const chip = assistantPanel(page).getByRole("status").filter({ hasText: "Asking about" })

		await expect(chip).toContainText(PDF_NAME)

		// Whatever opening the PDF fetched has finished by now (a two-page PDF of a few hundred bytes, drawn).
		const beforeRead = egest.requests()

		await scriptAssistant(page, {
			route: "files read",
			steps: [[{ name: "read_document", args: { handle: `{{handle:${PDF_NAME}}}`, part: "pages", from: 1, to: 1 } }]],
			extract: "The first page says Page One.",
			reply: "The first page says Page One."
		})
		await sendAssistantMessage(page, "What does the first page of this PDF say?")
		await waitForAssistantTurnEnd(page)

		await expect(assistantConversation(page).getByText("The first page says Page One.")).toBeVisible()

		// The read reached the model as the page's own text, read by the open viewer's engine.
		const requests = await assistantRequests(page)
		const extract = requests.filter(request => request.kind === "extract")

		expect(extract.length, JSON.stringify(requests.map(request => request.kind))).toBeGreaterThan(0)
		expect(extract.some(request => request.last.includes("Page One"))).toBe(true)
		expect(extract.some(request => request.last.includes("Page Two"))).toBe(false)

		// And nothing went to the download hosts for it.
		expect(egest.requests()).toBe(beforeRead)

		expect(cspViolations).toEqual([])
	})
})

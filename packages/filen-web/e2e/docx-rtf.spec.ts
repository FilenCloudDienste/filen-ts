import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { preview } from "@/locales/en/preview"

// RTF documents in the docx viewer and editor, in a real browser against the backend: read in the RTF worker,
// edited as the package they read as, saved as RTF by the lossless writer (the file stays RTF, untouched
// paragraphs keep their bytes), reopened with the edit; an autosave and a save after a second edit alike.

test.describe.configure({ mode: "default" })

const RTF_MIME = "application/rtf"
const MARKER = "Second paragraph of the RTF fixture"

// A small RTF document: a styled heading, two paragraphs (one with bold and a non-ASCII word), a table.
function rtfFixture(): Buffer {
	const text =
		"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}{\\colortbl;\\red192\\green0\\blue0;}" +
		"{\\stylesheet{\\s0 Normal;}{\\s1\\b\\fs32 heading 1;}}" +
		"\\pard\\plain\\s1\\b\\fs32 RTF fixture heading\\par\n" +
		"\\pard\\plain\\f0\\fs24 First paragraph with {\\b bold} text and a caf\\'e9.\\par\n" +
		`\\pard\\plain\\f1\\fs22\\cf1 ${MARKER}\\par\n` +
		"\\trowd\\trgaph108\\trleft-108\\cellx3000\\cellx6000\\pard\\plain\\intbl Cell A1\\cell Cell B1\\cell\\row\n" +
		"\\pard\\plain\\f0\\fs24 Last paragraph.\\par\n}"

	return Buffer.from(text, "latin1")
}

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text, { exact: false }).first()
}

async function openDocument(page: Page, listbox: Locator, name: string, marker: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(pageText(page, marker)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function closeDocument(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
}

async function save(page: Page): Promise<void> {
	const button = page.getByRole("dialog").getByRole("button", { name: preview.previewSaveAction, exact: true })

	await button.click()
	await expect(button).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
}

// The file as stored, downloaded from its row's menu.
async function storedBytes(page: Page, listbox: Locator, name: string): Promise<Buffer> {
	await listbox.getByRole("option", { name }).click({ button: "right" })

	const downloading = page.waitForEvent("download", { timeout: LIVE_WRITE_TIMEOUT_MS })

	await page.getByRole("menuitem", { name: /^Download$/u }).click()

	return readFileSync(await (await downloading).path())
}

test("an RTF document: edited in the docx editor, saved as RTF, reopened with the edit, other paragraphs byte for byte", async ({
	page
}) => {
	test.slow()

	await withScratchDirectory(page, "docx-rtf", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-fixture.rtf`
		const fixture = rtfFixture()

		await uploadFiles(page, [{ name, mimeType: RTF_MIME, buffer: fixture }], listbox)
		await openDocument(page, listbox, name, MARKER)

		// Typed at the start of the marker paragraph, and the marker made bold.
		await pageText(page, MARKER).click()
		await page.keyboard.press("Home")
		await page.keyboard.type("Edited in Filen: ")
		await save(page)
		await closeDocument(page)

		const stored = await storedBytes(page, listbox, name)
		const text = stored.toString("latin1")

		// Still RTF, the edit in it, the paragraphs the edit did not touch exactly as they were.
		expect(text.startsWith("{\\rtf1")).toBe(true)
		expect(text).toContain("Edited in Filen: ")
		expect(text).toContain("\\pard\\plain\\f0\\fs24 First paragraph with {\\b bold} text and a caf\\'e9.\\par\n")
		expect(text).toContain(
			"\\trowd\\trgaph108\\trleft-108\\cellx3000\\cellx6000\\pard\\plain\\intbl Cell A1\\cell Cell B1\\cell\\row\n"
		)

		// Reopened: the edit shows; a second edit is saved over the first.
		await openDocument(page, listbox, name, "Edited in Filen")
		await pageText(page, "Last paragraph.").click()
		await page.keyboard.press("End")
		await page.keyboard.type(" Second save.")
		await save(page)
		await closeDocument(page)
		await openDocument(page, listbox, name, "Second save.")
		await expect(pageText(page, "Edited in Filen")).toBeVisible()
		await closeDocument(page)
	})
})

test("an RTF document opened and closed without an edit is stored as it was", async ({ page }) => {
	await withScratchDirectory(page, "docx-rtf-untouched", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-untouched.rtf`
		const fixture = rtfFixture()

		await uploadFiles(page, [{ name, mimeType: RTF_MIME, buffer: fixture }], listbox)
		await openDocument(page, listbox, name, MARKER)
		await closeDocument(page)

		expect((await storedBytes(page, listbox, name)).equals(fixture)).toBe(true)
	})
})

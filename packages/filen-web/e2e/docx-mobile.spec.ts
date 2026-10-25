import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, toasts, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { DOCX_FIXTURE_TEXT, DOCX_MIME, docxFixtureBytes, type DocxFixtureName } from "./helpers/docxFixtures"
import { trackCspViolations } from "./helpers/csp"
import { common } from "@/locales/en/common"
import { ribbonButton, ribbonTab } from "./helpers/ribbon"
import { preview } from "@/locales/en/preview"

// The DOCX editor's Mobile view in a real browser at a phone's width: it shows by itself, the text is edited
// in place (typing, an IME composition, the app's own spelling marks, the browser's off), comments and tracked
// changes show inline, the ⋯ menu switches back to pages, and a save keeps what was typed. Each document is
// uploaded into the test's own scratch directory.

test.describe.configure({ mode: "default" })
const PHONE = { width: 390, height: 844 }
// The width the scratch directory is trashed at: its sidebar link shows only on a wider window.
const DESKTOP = { width: 1280, height: 800 }

test.use({ viewport: PHONE })

function reflowText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-reflow-doc").getByText(text).first()
}

async function upload(page: Page, listbox: Locator, runId: string, fixture: DocxFixtureName): Promise<string> {
	const name = `e2e-${runId}-${fixture}`

	await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxFixtureBytes(fixture) }], listbox)

	return name
}

// A scratch directory's `body` on a phone, the window wide again after it (failed or not) for the trash.
function onPhone(
	page: Page,
	body: (scratch: { listbox: Locator; runId: string }) => Promise<void>
): (scratch: { listbox: Locator; runId: string }) => Promise<void> {
	return async scratch => {
		try {
			await body(scratch)
		} finally {
			await page.setViewportSize(DESKTOP)
		}
	}
}

// The upload's notifications dismissed: at a phone's width they cover the editor's menus.
async function dismissToasts(page: Page): Promise<void> {
	// Not those already on their way out.
	const shown = toasts(page).and(page.locator(':not([data-removed="true"])'))

	while ((await shown.count()) > 0) {
		await shown.first().hover()
		await shown.first().getByRole("button", { name: common.toastDismiss }).click()
	}

	await expect(toasts(page)).toHaveCount(0)
}

// Opens `name` from the listing: at this width the editor shows it in Mobile view.
async function openDocument(page: Page, listbox: Locator, name: string, marker: string): Promise<void> {
	await dismissToasts(page)
	// The scratch directory makes the window tall for its listing: a phone's again before the editor opens.
	await page.setViewportSize(PHONE)
	await listbox.getByRole("option", { name }).dblclick()
	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(reflowText(page, marker)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.locator(".fo-docx-page")).toHaveCount(0)
}

async function closeDocument(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
}

test("Mobile view: shown by itself on a phone, typing, IME and spelling in place, kept by a save", async ({ page, browserName }) => {
	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(
		page,
		"docx-mobile",
		onPhone(page, async ({ listbox, runId }) => {
			const fixture = "w3-tables.docx"
			const marker = DOCX_FIXTURE_TEXT[fixture]
			const name = await upload(page, listbox, runId, fixture)

			await openDocument(page, listbox, name, marker)

			const view = page.locator(".fo-docx-reflow-doc").first()

			// The browser's spellcheck is off: the app's own marks show instead.
			await expect(view).toHaveAttribute("spellcheck", "false")
			await expect(view).toHaveAttribute("contenteditable", "true")

			// Typing at the end of the marker's paragraph.
			await reflowText(page, marker).click()
			await page.keyboard.press("End")
			await page.keyboard.type(" mobile speling")
			await expect(reflowText(page, `${marker} mobile speling`)).toBeVisible()
			// A word is not marked while it is being typed: the caret leaves it (Home and End move along the line,
			// on a Mac's Safari too).
			await page.keyboard.press("Home")
			await expect(page.locator('.fo-docx-reflow-mark[data-fo-mark="spelling"]', { hasText: "speling" })).toBeVisible({
				timeout: LIVE_WRITE_TIMEOUT_MS
			})
			await page.keyboard.press("End")

			// An IME composition (Chromium's input method protocol): composed text lands once committed.
			if (browserName === "chromium") {
				const cdp = await page.context().newCDPSession(page)

				await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 })
				await cdp.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 })
				await cdp.send("Input.insertText", { text: "日本" })
				await expect(reflowText(page, `${marker} mobile speling日本`)).toBeVisible()
				await cdp.detach()
			}

			const save = page.getByRole("dialog").getByRole("button", { name: preview.previewSaveAction, exact: true })

			await save.click()
			await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await closeDocument(page)

			// Opened again: what was typed was saved.
			await openDocument(page, listbox, name, `${marker} mobile speling`)
			await closeDocument(page)
		})
	)

	expect(cspViolations).toEqual([])
})

test("Mobile view: tables fit the screen, the View tab's switch goes to pages and back, the choice kept", async ({ page }) => {
	await withScratchDirectory(
		page,
		"docx-mobile-switch",
		onPhone(page, async ({ listbox, runId }) => {
			const fixture = "w3-tables.docx"
			const marker = DOCX_FIXTURE_TEXT[fixture]
			const name = await upload(page, listbox, runId, fixture)
			// The View tab's switch.
			const mobileView = async (): Promise<Locator> => {
				await ribbonTab(page, preview.previewOfficeRibbonTabView)

				return ribbonButton(page, page, preview.previewDocxRibbonViews, preview.previewDocxMobileView)
			}

			await openDocument(page, listbox, name, marker)

			// A table is an HTML table in a box of the screen's width.
			const table = page.locator(".fo-docx-reflow-table").first()

			await expect(table.locator("td").first()).toBeVisible()
			expect(await table.evaluate(element => element.clientWidth <= window.innerWidth)).toBe(true)

			await reflowText(page, "A1").click()
			const toPages = await mobileView()

			await expect(toPages).toHaveAttribute("aria-pressed", "true")
			await toPages.click()

			// Pages, the same document.
			await expect(page.locator(".fo-docx-page").getByText("A1", { exact: true }).first()).toBeVisible({
				timeout: LAZY_VIEWER_TIMEOUT_MS
			})
			await expect(page.locator(".fo-docx-reflow")).toHaveCount(0)

			// The user's choice holds through width crossings: back to Mobile view only from the switch.
			await page.setViewportSize({ width: 1200, height: 800 })
			await page.setViewportSize({ width: 360, height: 800 })
			await expect(page.locator(".fo-docx-page").first()).toBeVisible()
			await expect(page.locator(".fo-docx-reflow")).toHaveCount(0)
			const toMobile = await mobileView()

			await expect(toMobile).toHaveAttribute("aria-pressed", "false")
			await toMobile.click()
			await expect(page.locator(".fo-docx-reflow")).toBeVisible()
			await expect(reflowText(page, "A1")).toBeVisible()

			await closeDocument(page)
		})
	)
})

test("Mobile view: comments highlighted and tracked changes inline", async ({ page }) => {
	await withScratchDirectory(
		page,
		"docx-mobile-review",
		onPhone(page, async ({ listbox, runId }) => {
			const comments = await upload(page, listbox, runId, "w3-comments.docx")
			const tracked = await upload(page, listbox, runId, "w3-tracked.docx")

			await openDocument(page, listbox, comments, DOCX_FIXTURE_TEXT["w3-comments.docx"])
			// The commented text (the range's empty start and end marks are highlighted too, with no width).
			await expect(page.locator(".fo-docx-reflow-comment", { hasText: DOCX_FIXTURE_TEXT["w3-comments.docx"] })).toBeVisible()
			await closeDocument(page)

			await openDocument(page, listbox, tracked, DOCX_FIXTURE_TEXT["w3-tracked.docx"])
			await expect(
				page.locator(".fo-docx-reflow ins.fo-docx-reflow-ins, .fo-docx-reflow del.fo-docx-reflow-del").first()
			).toBeAttached()
			await closeDocument(page)
		})
	)
})

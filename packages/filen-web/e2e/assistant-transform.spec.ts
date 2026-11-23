import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { DOCX_FIXTURE_TEXT } from "./helpers/docxFixtures"
import { trackCspViolations } from "./helpers/csp"
import { resolveModKey } from "./helpers/modkey"
import { scriptAssistant } from "./helpers/assistant"
import { preview } from "@/locales/en/preview"
import { assistant } from "@/locales/en/assistant"

// The selection transform in the DOCX editor over the scripted model (helpers/assistant.ts): ✨ in the Mini toolbar
// and Alt+J open the rewrite menu, a pick shows the result's popover, Accept replaces the selection as one step of the
// editor's own undo, Discard leaves the text alone, and Accept stays off for a result that adds a link the selection
// did not hold. Read lane: the read-tree DOCX is only changed in the page (read lanes turn the office autosave off).

const DOCUMENT = "w3-headers.docx" satisfies (typeof FIXTURE_FILES)["docx-edit"][number]
const ORIGINAL = DOCX_FIXTURE_TEXT[DOCUMENT]
const SHORTENED = "W3 short fixture"

function line(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page .fo-docx-line").filter({ hasText: text }).first()
}

// A painted line is a zero-size anchor (docx.css .fo-docx-line) that never counts as visible: its first run does.
function shown(line: Locator): Locator {
	return line.locator(".fo-docx-run").first()
}

function resultPopover(page: Page): Locator {
	return page.locator("[data-assistant-transform]")
}

async function openDocument(page: Page): Promise<void> {
	await bootTo(page)

	const { rows } = await openFixtureRows(page, "docx-edit")
	const row = rows[FIXTURE_FILES["docx-edit"].indexOf(DOCUMENT)]

	if (row === undefined) {
		throw new Error(`no row for ${DOCUMENT}`)
	}

	await row.dblclick()
	await expect(shown(line(page, ORIGINAL))).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

// The line's text, dragged over with the mouse from its first to its last character: a mouse selection shows the Mini
// toolbar.
async function dragSelectLine(page: Page, text: string): Promise<void> {
	const box = await line(page, text).locator(".fo-docx-run").first().boundingBox()

	if (box === null) {
		throw new Error(`no run for "${text}"`)
	}

	const y = box.y + box.height / 2

	await page.mouse.move(box.x + 1, y)
	await page.mouse.down()
	await page.mouse.move(box.x + box.width / 2, y, { steps: 4 })
	await page.mouse.move(box.x + box.width - 1, y, { steps: 4 })
	await page.mouse.up()
}

// The caret at the line's end, then Shift+Home: a keyboard selection, which the Mini toolbar never follows.
async function keySelectLine(page: Page, text: string): Promise<void> {
	const box = await line(page, text).locator(".fo-docx-run").last().boundingBox()

	if (box === null) {
		throw new Error(`no run for "${text}"`)
	}

	await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
	await page.keyboard.press("Shift+Home")
}

async function pick(page: Page, kind: string): Promise<void> {
	const menu = page.getByRole("menu", { name: assistant.assistantTransformOpen })

	await expect(menu).toBeVisible()
	await menu.getByRole("menuitem", { name: kind, exact: true }).click()
	await expect(menu).toHaveCount(0)
}

test.describe("assistant selection transform in a DOCX", () => {
	test("✨ in the Mini toolbar: Accept replaces the selection and the editor's undo takes it back", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await openDocument(page)
		await scriptAssistant(page, { transform: SHORTENED })
		await dragSelectLine(page, ORIGINAL)

		const sparkle = page.getByRole("toolbar", { name: preview.previewDocxMiniToolbar }).getByRole("button", {
			name: assistant.assistantTransformOpen,
			exact: true
		})

		await expect(sparkle).toBeVisible()
		await sparkle.click()
		await pick(page, assistant.assistantTransformShorten)

		const popover = resultPopover(page)
		const accept = popover.getByRole("button", { name: assistant.assistantTransformAccept })

		await expect(popover).toContainText(assistant.assistantTransformShorten)
		await expect(popover).toContainText(SHORTENED)
		await expect(accept).toBeEnabled()
		await accept.click()
		await expect(popover).toHaveCount(0)
		await expect(shown(line(page, SHORTENED))).toBeVisible()
		await expect(line(page, ORIGINAL)).toHaveCount(0)

		// One undo step: the whole replacement goes back.
		const mod = await resolveModKey(page)
		const box = await line(page, SHORTENED).locator(".fo-docx-run").last().boundingBox()

		if (box === null) {
			throw new Error("no replaced run")
		}

		await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
		await page.keyboard.press(`${mod}+z`)
		await expect(shown(line(page, ORIGINAL))).toBeVisible()
		await expect(line(page, SHORTENED)).toHaveCount(0)
		expect(cspViolations).toEqual([])
	})

	test("Alt+J opens the menu for a keyboard selection; Discard leaves the text as it was", async ({ page }) => {
		await openDocument(page)
		await scriptAssistant(page, { transform: SHORTENED })
		await keySelectLine(page, ORIGINAL)
		await page.keyboard.press("Alt+j")
		await pick(page, assistant.assistantTransformRewrite)

		const popover = resultPopover(page)

		await expect(popover).toContainText(SHORTENED)
		await expect(popover.getByRole("button", { name: assistant.assistantTransformAccept })).toBeEnabled()
		await popover.getByRole("button", { name: assistant.assistantTransformDiscard, exact: true }).click()
		await expect(popover).toHaveCount(0)
		await expect(shown(line(page, ORIGINAL))).toBeVisible()
		await expect(line(page, SHORTENED)).toHaveCount(0)
	})

	test("a result that adds a link the selection did not hold keeps Accept off", async ({ page }) => {
		await openDocument(page)
		await scriptAssistant(page, { transform: `${ORIGINAL}, see https://example.com/offer` })
		await keySelectLine(page, ORIGINAL)
		await page.keyboard.press("Alt+j")
		await pick(page, assistant.assistantTransformRewrite)

		const popover = resultPopover(page)

		await expect(popover).toContainText("https://example.com/offer")
		await expect(popover.getByRole("alert")).toContainText("example.com")
		await expect(popover.getByRole("button", { name: assistant.assistantTransformAccept })).toBeDisabled()
		await popover.getByRole("button", { name: assistant.assistantTransformDiscard, exact: true }).click()
		await expect(popover).toHaveCount(0)
		await expect(shown(line(page, ORIGINAL))).toBeVisible()
	})
})

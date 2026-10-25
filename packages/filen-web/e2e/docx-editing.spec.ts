import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { DOCX_FIXTURE_TEXT, DOCX_MIME, docxFixtureBytes, svgPictureBytes, type DocxFixtureName } from "./helpers/docxFixtures"
import { trackCspViolations } from "./helpers/csp"
import { ribbonButton, ribbonCommands, ribbonTab } from "./helpers/ribbon"
import { preview } from "@/locales/en/preview"

// The DOCX editor's editing UI in a real browser: the Table group and a column border dragged on the page, a
// header edited from its chip, content controls filled in where they are, and character formatting that a
// save keeps. Each document is uploaded into the test's own scratch directory (they are edited and saved).

test.describe.configure({ mode: "default" })

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text, { exact: true }).first()
}

// The x (screen) of the painted vertical table border nearest `x` on the line at `y`: the pages draw borders
// as thin boxes.
async function borderNear(page: Page, x: number, y: number): Promise<number> {
	const found = await page.evaluate(
		({ wantX, wantY }) => {
			let best: number | null = null

			for (const element of document.querySelectorAll(".fo-docx-page *")) {
				const box = element.getBoundingClientRect()

				if (box.width <= 0 || box.width > 2 || box.height < 8 || wantY < box.top || wantY > box.bottom) continue

				const middle = box.left + box.width / 2

				if (best === null || Math.abs(middle - wantX) < Math.abs(best - wantX)) best = middle
			}

			return best
		},
		{ wantX: x, wantY: y }
	)

	if (found === null || Math.abs(found - x) > 12) {
		throw new Error(`no table border near ${String(x)}`)
	}

	return found
}

// The painted line holding `text` (a label and the control after it: "Agree: ☐").
function lineWith(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page .fo-docx-line").filter({ hasText: text }).first()
}

// Clicks the end of a line's text (the control after its label).
async function clickEnd(locator: Locator): Promise<void> {
	const box = await locator.locator(".fo-docx-run").last().boundingBox()

	if (box === null) {
		throw new Error("no text on the line")
	}

	await locator.page().mouse.click(box.x + box.width - 4, box.y + box.height / 2)
}

// Opens `name` from the listing in the editor, once it can be edited.
async function openDocument(page: Page, listbox: Locator, name: string, marker: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(pageText(page, marker)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function closeDocument(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
}

async function upload(page: Page, listbox: Locator, runId: string, fixtures: readonly DocxFixtureName[]): Promise<Record<string, string>> {
	const names = Object.fromEntries(fixtures.map(fixture => [fixture, `e2e-${runId}-${fixture}`]))

	await uploadFiles(
		page,
		fixtures.map(fixture => ({ name: names[fixture] ?? fixture, mimeType: DOCX_MIME, buffer: docxFixtureBytes(fixture) })),
		listbox
	)

	return names
}

test("tables: the Table tab's commands and a column border dragged on the page", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "docx-editing-tables", async ({ listbox, runId }) => {
		const names = await upload(page, listbox, runId, ["w3-tables.docx", "w3-rtl-table.docx"])
		const tableTab = page.getByRole("tab", { name: preview.previewDocxTableGroup, exact: true })

		await openDocument(page, listbox, names["w3-tables.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-tables.docx"])
		await expect(tableTab).toHaveCount(0)
		await pageText(page, "A1").click()
		await expect(tableTab).toBeVisible()

		// A row below the caret's.
		await tableTab.click()
		await (await ribbonButton(page, page, preview.previewDocxRibbonRowsColumns, preview.previewDocxTableRowBelow)).click()
		await expect(tableTab).toBeVisible()

		// The border between the first two columns, dragged right: the second column's text moves with it.
		const a1 = await pageText(page, "A1").boundingBox()
		const b1Before = await pageText(page, "B1").boundingBox()

		if (a1 === null || b1Before === null) {
			throw new Error("no cell text on the page")
		}

		const y = b1Before.y + b1Before.height / 2
		const borderX = await borderNear(page, b1Before.x, y)

		await page.mouse.move(borderX, y)
		await page.mouse.down()
		await page.mouse.move(borderX + 30, y, { steps: 4 })
		await expect(page.getByRole("separator", { name: preview.previewDocxTableBorderGuide })).toBeVisible()
		await page.mouse.move(borderX + 60, y, { steps: 4 })
		await page.mouse.up()
		await expect.poll(async () => (await pageText(page, "B1").boundingBox())?.x ?? 0).toBeGreaterThan(b1Before.x + 40)

		// The context menu offers the table's rows and columns; deleting the table takes its text away.
		await pageText(page, "A1").click({ button: "right" })
		await page.getByRole("menuitem", { name: preview.previewDocxTableDelete }).click()
		await expect(pageText(page, "A1")).toHaveCount(0)
		await expect(tableTab).toHaveCount(0)
		await closeDocumentDiscarding(page)

		// Right to left: the border's column is the one on its right, a drag to the left widens it.
		await openDocument(page, listbox, names["w3-rtl-table.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-rtl-table.docx"])

		const rtlA1 = await pageText(page, "A1").boundingBox()
		const rtlB1 = await pageText(page, "B1").boundingBox()

		if (rtlA1 === null || rtlB1 === null) {
			throw new Error("no cell text on the page")
		}

		// A1 is the rightmost cell; the border between it and B1 is its left one.
		expect(rtlA1.x).toBeGreaterThan(rtlB1.x)

		const rtlY = rtlA1.y + rtlA1.height / 2
		const rtlBorder = await borderNear(page, rtlA1.x, rtlY)

		await page.mouse.move(rtlBorder, rtlY)
		await page.mouse.down()
		await page.mouse.move(rtlBorder - 30, rtlY, { steps: 4 })
		await expect(page.getByRole("separator", { name: preview.previewDocxTableBorderGuide })).toBeVisible()
		await page.mouse.move(rtlBorder - 60, rtlY, { steps: 4 })
		await page.mouse.up()
		// A1 grew to the left (a drag to the left widens a right-to-left table's column): its text starts further left.
		await expect.poll(async () => (await pageText(page, "A1").boundingBox())?.x ?? Infinity).toBeLessThan(rtlA1.x - 40)
		await closeDocumentDiscarding(page)
	})

	expect(cspViolations).toEqual([])
})

// Closes an edited document without saving it (the overlay asks).
async function closeDocumentDiscarding(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await page
		.getByRole("alertdialog", { name: preview.previewUnsavedChangesTitle })
		.getByRole("button", { name: preview.previewDiscardAction })
		.click()
	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
}

test("keyboard: Tab moves through a table's cells and adds a row from the last, and changes a list's level", async ({ page }) => {
	await withScratchDirectory(page, "docx-editing-tab", async ({ listbox, runId }) => {
		const names = await upload(page, listbox, runId, ["w3-tables.docx"])
		const x = async (text: string): Promise<number> => (await pageText(page, text).boundingBox())?.x ?? Number.NaN

		await openDocument(page, listbox, names["w3-tables.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-tables.docx"])

		// The editing area says how Tab works there and how to leave it.
		const textbox = page.locator(".fo-docx-sink [role='textbox']").first()

		await expect(textbox).toHaveAccessibleDescription(preview.previewDocxEditorKeys)

		// Tab selects the next cell's content (typing replaces it), Shift+Tab the previous one's; focus stays.
		await pageText(page, "A1").click()
		await page.keyboard.press("Tab")
		await page.keyboard.type("x")
		await expect(pageText(page, "x")).toBeVisible()
		await expect(pageText(page, "B1")).toHaveCount(0)
		await page.keyboard.press("Shift+Tab")
		await page.keyboard.type("y")
		await expect(pageText(page, "y")).toBeVisible()
		await expect(pageText(page, "A1")).toHaveCount(0)

		// From the last cell, a new row.
		await pageText(page, "C2").click()
		await page.keyboard.press("Tab")
		await page.keyboard.type("new")
		await expect(pageText(page, "new")).toBeVisible()
		expect((await pageText(page, "new").boundingBox())?.y ?? 0).toBeGreaterThan((await pageText(page, "A2").boundingBox())?.y ?? 0)

		// A bulleted paragraph: Tab at its start takes it a level down, Shift+Tab back.
		await pageText(page, "After the table.").click()
		await ribbonTab(page, preview.previewOfficeRibbonTabHome)
		await (await ribbonButton(page, page, preview.previewDocxRibbonParagraph, preview.previewDocxBulletList)).click()
		await page.keyboard.press("Home")

		const level0 = await x("After the table.")

		await page.keyboard.press("Tab")
		await expect.poll(() => x("After the table.")).toBeGreaterThan(level0 + 10)
		await page.keyboard.press("Shift+Tab")
		await expect.poll(() => x("After the table.")).toBe(level0)

		// Escape leaves the editor (the host asks about the changes).
		await closeDocumentDiscarding(page)
	})
})

// The ribbon at a phone's width in page view: its tab row scrolls, its command row fits (what does not goes into the
// overflow menu, which is in it and opens).
async function expectRibbonFits(page: Page): Promise<void> {
	const row = ribbonCommands(page)
	const more = row.getByRole("button", { name: preview.previewOfficeRibbonMore, exact: true })
	const width = page.viewportSize()?.width ?? 0

	await expect.poll(() => row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)

	const box = await row.boundingBox()

	expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true)

	if ((await more.count()) > 0) {
		const at = await more.boundingBox()

		expect(at !== null && at.x >= 0 && at.x + at.width <= width).toBe(true)
		await more.click()
		await expect(page.locator("[data-ribbon-popup]")).toBeVisible()
		await more.click()
		await expect(page.locator("[data-ribbon-popup]")).toHaveCount(0)
	}
}

// Pages instead of Mobile view, from the View tab's switch.
async function showPages(page: Page): Promise<void> {
	await ribbonTab(page, preview.previewOfficeRibbonTabView)
	await (await ribbonButton(page, page, preview.previewDocxRibbonViews, preview.previewDocxMobileView)).click()
}

test("ribbon: fits a phone's width in page view, the overflow menu in reach", async ({ page }) => {
	await withScratchDirectory(page, "docx-editing-toolbar", async ({ listbox, runId }) => {
		const names = await upload(page, listbox, runId, ["w3-tables.docx"])
		const viewport = page.viewportSize() ?? { width: 1280, height: 800 }

		await openDocument(page, listbox, names["w3-tables.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-tables.docx"])

		try {
			// A phone's width shows Mobile view: pages chosen from the View tab.
			await page.setViewportSize({ width: 390, height: 800 })
			await expect(page.locator(".fo-docx-reflow")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await showPages(page)
			await expect(pageText(page, "A1")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await ribbonTab(page, preview.previewOfficeRibbonTabHome)

			for (const width of [390, 360, 320]) {
				await page.setViewportSize({ width, height: 800 })
				await expectRibbonFits(page)
			}

			// On the Table tab too.
			await pageText(page, "A1").click()
			await ribbonTab(page, preview.previewDocxTableGroup)

			for (const width of [320, 360, 390]) {
				await page.setViewportSize({ width, height: 800 })
				await expectRibbonFits(page)
			}
		} finally {
			await page.setViewportSize(viewport)
		}

		await pageText(page, "A1").click()
		await closeDocument(page)
	})
})

test("ribbon: a pressed picture's tab fits a phone's width", async ({ page }) => {
	await withScratchDirectory(page, "docx-editing-toolbar-picture", async ({ listbox, runId }) => {
		const names = await upload(page, listbox, runId, ["w3-tables.docx"])
		const viewport = page.viewportSize() ?? { width: 1280, height: 800 }
		const picture = page.locator(".fo-docx-page image").first()
		const pictureTab = page.getByRole("tab", { name: preview.previewDocxPictureGroup, exact: true })

		await openDocument(page, listbox, names["w3-tables.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-tables.docx"])
		await clickEnd(lineWith(page, DOCX_FIXTURE_TEXT["w3-tables.docx"]))

		const chooser = page.waitForEvent("filechooser")

		await ribbonTab(page, preview.previewOfficeRibbonTabInsert)
		await (await ribbonButton(page, page, preview.previewOfficeRibbonIllustrations, preview.previewDocxInsertPicture)).click()
		await page.getByRole("menuitem", { name: preview.previewDocxPictureFromDevice, exact: true }).click()
		await (await chooser).setFiles({ name: "w3-picture.svg", mimeType: "image/svg+xml", buffer: svgPictureBytes() })
		await expect(picture).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		try {
			// Pages at a phone's width, chosen from the View tab.
			await page.setViewportSize({ width: 390, height: 800 })
			await expect(page.locator(".fo-docx-reflow")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await showPages(page)
			await expect(picture).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			// The page's text layer is over it: a press where it is drawn.
			const box = await picture.boundingBox()

			if (box === null) {
				throw new Error("no picture on the page")
			}

			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
			await expect(pictureTab).toBeVisible()
			await pictureTab.click()

			for (const width of [390, 360, 320]) {
				await page.setViewportSize({ width, height: 800 })
				await expectRibbonFits(page)
			}

			// Delete picture deletes it, wherever the row put it.
			await (await ribbonButton(page, page, preview.previewDocxPictureGroup, preview.previewDocxPictureDelete)).click()
			await expect(page.locator(".fo-docx-page image")).toHaveCount(0)
			await expect(pictureTab).toHaveCount(0)
		} finally {
			await page.setViewportSize(viewport)
		}

		// The picture inserted and deleted: the document as it was saved, nothing to ask.
		await pageText(page, DOCX_FIXTURE_TEXT["w3-tables.docx"]).click()
		await closeDocument(page)
	})
})

test("headers: edited from the chip, its toggles, and Close back to the body", async ({ page }) => {
	await withScratchDirectory(page, "docx-editing-headers", async ({ listbox, runId }) => {
		const names = await upload(page, listbox, runId, ["w3-headers.docx"])

		await openDocument(page, listbox, names["w3-headers.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-headers.docx"])
		await pageText(page, "W3 header text").dblclick()

		// One section: the chip names the header only.
		const chip = page.getByRole("group", { name: preview.previewDocxHeaderChipOnly, exact: true })

		await expect(chip).toBeVisible()
		await chip.getByRole("button", { name: preview.previewDocxHeaderOptions }).click()
		await page.getByRole("menuitemcheckbox", { name: preview.previewDocxHeaderDifferentFirst }).click()
		// The first page shows its own header now: the chip says so.
		await expect(page.getByRole("group", { name: preview.previewDocxHeaderChipFirstOnly, exact: true })).toBeVisible()
		await page.getByRole("button", { name: preview.previewDocxHeaderCloseHeader, exact: true }).click()
		await expect(page.locator("[data-docx-header-chip]")).toHaveCount(0)
		await closeDocumentDiscarding(page)
	})
})

test("forms: a checkbox ticked, a dropdown item and a date chosen where the controls are", async ({ page }) => {
	await withScratchDirectory(page, "docx-editing-forms", async ({ listbox, runId }) => {
		const names = await upload(page, listbox, runId, ["w3-forms.docx"])

		await openDocument(page, listbox, names["w3-forms.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-forms.docx"])

		await clickEnd(lineWith(page, "Agree: ☐"))
		await expect(lineWith(page, "Agree:")).toContainText("☒")

		await clickEnd(lineWith(page, "Colour: Red"))
		await page.getByRole("option", { name: "Green" }).click()
		await expect(lineWith(page, "Colour:")).toContainText("Green")

		// An entry added in the list's own popover is one to choose.
		await clickEnd(lineWith(page, "Colour:"))
		await page.getByRole("button", { name: preview.previewDocxControlItemsEdit }).click()
		await page.getByRole("textbox", { name: preview.previewDocxDropdownItem }).fill("Blue")
		await page.getByRole("button", { name: preview.previewDocxDropdownAdd, exact: true }).click()
		await expect(page.getByRole("option", { name: "Blue" })).toBeVisible()
		// The field keeps focus for the next entry; Escape closes the popover only.
		await expect(page.getByRole("textbox", { name: preview.previewDocxDropdownItem })).toBeFocused()
		await page.keyboard.press("Escape")
		await expect(page.locator("[data-docx-control-popover]")).toHaveCount(0)
		await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toBeVisible()

		await clickEnd(lineWith(page, "Date: 1/1/2026"))
		// The popover itself is named "Pick a date" (or the control's title): the field by its exact label in it.
		const datePopover = page.locator("[data-docx-control-popover]")

		await datePopover.getByLabel(preview.previewDocxControlDateLabel, { exact: true }).fill("2026-10-13")
		await datePopover.getByRole("button", { name: preview.previewDocxControlDateSet }).click()
		await expect(lineWith(page, "Date:")).toContainText("10/13/2026")

		// Saved, the controls keep what was chosen.
		const save = page.getByRole("dialog").getByRole("button", { name: preview.previewSaveAction, exact: true })

		await save.click()
		await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await closeDocument(page)
		await openDocument(page, listbox, names["w3-forms.docx"] ?? "", DOCX_FIXTURE_TEXT["w3-forms.docx"])
		await expect(lineWith(page, "Agree:")).toContainText("☒")
		await expect(lineWith(page, "Colour:")).toContainText("Green")
		await expect(lineWith(page, "Date:")).toContainText("10/13/2026")
		await closeDocument(page)
	})
})

test("format: character formatting from the ribbon, kept by a save", async ({ page }) => {
	await withScratchDirectory(page, "docx-editing-format", async ({ listbox, runId }) => {
		const names = await upload(page, listbox, runId, ["w3-tables.docx"])
		const marker = DOCX_FIXTURE_TEXT["w3-tables.docx"]
		const moreFormatting = page.getByRole("button", { name: preview.previewDocxMoreFormatting })

		await openDocument(page, listbox, names["w3-tables.docx"] ?? "", marker)
		await pageText(page, marker).click({ clickCount: 3 })
		await moreFormatting.click()
		await page.getByRole("menuitemcheckbox", { name: preview.previewDocxDoubleStrikethrough }).click()
		await moreFormatting.click()
		await expect(page.getByRole("menuitemcheckbox", { name: preview.previewDocxDoubleStrikethrough })).toHaveAttribute(
			"aria-checked",
			"true"
		)
		await page.keyboard.press("Escape")

		const save = page.getByRole("dialog").getByRole("button", { name: preview.previewSaveAction, exact: true })

		await save.click()
		await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await closeDocument(page)

		await openDocument(page, listbox, names["w3-tables.docx"] ?? "", marker)
		await pageText(page, marker).click()
		await moreFormatting.click()
		await expect(page.getByRole("menuitemcheckbox", { name: preview.previewDocxDoubleStrikethrough })).toHaveAttribute(
			"aria-checked",
			"true"
		)
		await page.keyboard.press("Escape")
		await closeDocument(page)
	})
})

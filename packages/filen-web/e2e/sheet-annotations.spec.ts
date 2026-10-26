import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { withScratchDirectory, LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { preview } from "@/locales/en/preview"

// Notes, threaded comments and hyperlinks on the office engine end to end: a note
// added from the grid's menu and shown on hover, a comment thread started and replied to, a web link inserted with
// Ctrl/Cmd+K (Ctrl/Cmd+click asks before an untrusted domain opens) and a link to another sheet followed. Saved and
// reopened, so what it checks is the file the drive now holds.
test.describe.configure({ mode: "default" })

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const AUTHOR = "E2E Sheet Author"
// Where a cell's middle is at 100 %: a 32 px row header, 64 px columns, a 20 px column header and 20 px rows.
const ROW_HEADER = 32
const COL_WIDTH = 64
const HEADER = 20
const ROW_HEIGHT = 20

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: "Budget",
					rows: [
						["Item", "Cost"],
						["Rent", 1200],
						["Food", 300],
						["", ""],
						["", ""]
					]
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

function nameBox(dialog: Locator): Locator {
	return dialog.getByRole("textbox", { name: preview.previewSheetNameBox })
}

async function goTo(dialog: Locator, ref: string): Promise<void> {
	const box = nameBox(dialog)

	await box.click()
	await box.fill(ref)
	await box.press("Enter")
	await expect(box).toHaveValue(ref)
	await expect(dialog.getByRole("grid")).toBeFocused()
}

// A cell's middle in the grid, 0-based.
function at(row: number, col: number): { x: number; y: number } {
	return { x: ROW_HEADER + col * COL_WIDTH + COL_WIDTH / 2, y: HEADER + row * ROW_HEIGHT + ROW_HEIGHT / 2 }
}

async function gridMenu(dialog: Locator, row: number, col: number): Promise<void> {
	await dialog.getByRole("grid").click({ button: "right", position: at(row, col) })
}

async function hover(page: Page, dialog: Locator, row: number, col: number): Promise<void> {
	const box = await dialog.getByRole("grid").boundingBox()

	if (box === null) throw new Error("no grid")

	const point = at(row, col)

	await page.mouse.move(box.x + point.x, box.y + point.y)
}

// The account may have no author name yet: the first note or comment asks for it. Settled once either the question
// or `next` (what opens without it) shows.
async function giveNameIfAsked(page: Page, next: Locator): Promise<void> {
	const ask = page.getByRole("dialog", { name: preview.previewOfficeAuthorNameTitle })

	await expect(ask.or(next).first()).toBeVisible()

	if (await ask.isVisible()) {
		await ask.getByRole("textbox", { name: preview.previewOfficeAuthorNameLabel }).fill(AUTHOR)
		await ask.getByRole("button", { name: preview.previewOfficeAuthorNameSave }).click()
		await expect(ask).toHaveCount(0)
	}
}

// Playwright's Chromium reports a Windows user agent (the page follows links with Ctrl), and a macOS host turns a
// Ctrl+click into a right-click as well: the grid's menu that opens then is closed again.
async function closeStrayMenu(page: Page): Promise<void> {
	const menu = page.getByRole("menu")

	// isVisible never waits: a menu that opens a moment later would be missed.
	const opened = await menu.waitFor({ state: "visible", timeout: 1000 }).then(
		() => true,
		() => false
	)

	if (opened) {
		await menu.press("Escape")
		await expect(menu).toHaveCount(0)
	}
}

async function open(dialog: Locator, row: Locator): Promise<void> {
	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()
	await expect(nameBox(dialog)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByRole("tab", { name: "Budget" })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function close(page: Page, dialog: Locator): Promise<void> {
	await expect(async () => {
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: 15_000 })
}

async function saveAndClose(page: Page, dialog: Locator, mod: string): Promise<void> {
	const save = dialog.getByRole("button", { name: "Save", exact: true })

	await expect(save).toBeVisible()
	await goTo(dialog, "D10")
	await page.keyboard.press(`${mod}+S`)
	await expect(save).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
	await close(page, dialog)
}

test("a note, a comment thread and links: added, shown, followed, saved and read back", async ({ page }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()
	const mod = await resolveModKey(page)

	await withScratchDirectory(page, "sheet-annotations", async ({ listbox, runId }) => {
		const name = `e2e-sheet-annotations-${runId}.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)

		const row = listbox.getByRole("option", { name })

		await open(dialog, row)

		// A note on B2 from the grid's menu: its text starts with the author's line.
		await goTo(dialog, "B2")
		await gridMenu(dialog, 1, 1)
		await page.getByRole("menuitem", { name: preview.previewSheetNoteInsert, exact: true }).click()

		const noteField = dialog.getByRole("textbox", { name: preview.previewSheetNoteText })

		await giveNameIfAsked(page, noteField)

		await expect(noteField).toBeFocused()
		await page.keyboard.type("Check the rent")
		await dialog.getByRole("button", { name: preview.previewSheetNoteSave, exact: true }).click()
		await expect(noteField).toHaveCount(0)

		// A comment on A3, then a reply.
		await goTo(dialog, "A3")
		await gridMenu(dialog, 2, 0)
		await page.getByRole("menuitem", { name: preview.previewSheetCommentNew, exact: true }).click()

		const commentField = dialog.getByRole("textbox", { name: preview.previewSheetCommentPlaceholder })

		await giveNameIfAsked(page, commentField)
		await expect(commentField).toBeFocused()
		await page.keyboard.type("Food went up")
		await dialog.getByRole("button", { name: preview.previewSheetCommentPost, exact: true }).click()
		await dialog.getByRole("button", { name: preview.previewSheetCommentReplyPlaceholder, exact: true }).click()
		await expect(dialog.getByRole("textbox", { name: preview.previewSheetCommentReplyPlaceholder })).toBeFocused()
		await page.keyboard.type("Agreed")
		await dialog.getByRole("button", { name: preview.previewSheetCommentReply, exact: true }).click()
		await expect(dialog.getByText("Agreed")).toBeVisible()
		// A press on another cell (clear of the card) closes the card.
		await dialog.getByRole("grid").click({ position: at(0, 8) })
		await expect(dialog.getByRole("dialog", { name: /Food went up|Comment thread/ })).toHaveCount(0)

		// A web link on A4 with Ctrl/Cmd+K, and a link on A5 to the other sheet.
		await goTo(dialog, "A4")
		await page.keyboard.press(`${mod}+K`)

		const linkDialog = page.getByRole("dialog", { name: preview.previewSheetLinkInsertTitle })

		await linkDialog.getByRole("textbox", { name: preview.previewSheetLinkAddress }).fill("example.com/filen-e2e")
		await linkDialog.getByRole("textbox", { name: preview.previewSheetLinkText }).fill("Example")
		await linkDialog.getByRole("button", { name: preview.previewSheetLinkApply }).click()
		await expect(linkDialog).toHaveCount(0)
		await goTo(dialog, "A4")
		await expect(dialog.getByRole("grid").getByRole("gridcell")).toHaveText("Example")

		await goTo(dialog, "A5")
		await page.keyboard.press(`${mod}+K`)
		await linkDialog.getByRole("radio", { name: preview.previewSheetLinkKindPlace }).click()
		await linkDialog.getByRole("textbox", { name: preview.previewSheetLinkReference }).fill("Totals")
		await linkDialog.getByRole("button", { name: preview.previewSheetLinkApply }).click()
		// "Totals" reads as a name, but the workbook has none by it: the session refuses the link.
		await expect(page.getByText(preview.previewSheetLinkTargetInvalid)).toBeVisible()
		await goTo(dialog, "A5")
		await page.keyboard.press(`${mod}+K`)
		await linkDialog.getByRole("radio", { name: preview.previewSheetLinkKindPlace }).click()
		await linkDialog.getByRole("combobox", { name: preview.previewSheetLinkSheet }).click()
		await page.getByRole("option", { name: "Notes" }).click()
		await linkDialog.getByRole("textbox", { name: preview.previewSheetLinkReference }).fill("A1")
		await linkDialog.getByRole("textbox", { name: preview.previewSheetLinkText }).fill("To notes")
		await linkDialog.getByRole("button", { name: preview.previewSheetLinkApply }).click()
		await expect(linkDialog).toHaveCount(0)

		await saveAndClose(page, dialog, mod)

		// What the drive now holds, read fresh.
		await page.reload()
		await open(dialog, row)

		// The note shows on hover.
		await hover(page, dialog, 1, 1)
		await expect(dialog.getByRole("tooltip").getByText("Check the rent")).toBeVisible()
		await hover(page, dialog, 9, 3)
		await expect(dialog.getByRole("tooltip")).toHaveCount(0)

		// The thread, with its reply.
		await hover(page, dialog, 2, 0)
		await expect(dialog.getByRole("tooltip").getByText("Food went up")).toBeVisible()
		await expect(dialog.getByRole("tooltip").getByText("Agreed")).toBeVisible()
		await hover(page, dialog, 9, 3)

		// Ctrl/Cmd+click on the web link asks before an untrusted domain opens (declined: no window opens).
		await hover(page, dialog, 3, 0)
		await expect(dialog.getByRole("tooltip").getByText("https://example.com/filen-e2e")).toBeVisible()
		await dialog.getByRole("grid").click({ position: at(3, 0), modifiers: [mod === "Meta" ? "Meta" : "Control"] })

		const trust = page.getByRole("alertdialog")

		await expect(trust).toContainText("example.com")
		await trust.getByRole("button", { name: "Cancel" }).click()
		await expect(trust).toHaveCount(0)
		await closeStrayMenu(page)

		// The link to the other sheet goes there.
		await hover(page, dialog, 4, 0)
		await expect(dialog.getByRole("tooltip").getByText("Go to Notes!A1")).toBeVisible()
		await dialog.getByRole("grid").click({ position: at(4, 0), modifiers: [mod === "Meta" ? "Meta" : "Control"] })
		await closeStrayMenu(page)
		await expect(dialog.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true")
		await expect(nameBox(dialog)).toHaveValue("A1")

		await close(page, dialog)
	})
})

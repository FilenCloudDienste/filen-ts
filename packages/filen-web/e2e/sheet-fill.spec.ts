import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { withScratchDirectory, LAZY_VIEWER_TIMEOUT_MS, uploadFiles } from "./helpers/listing"
import { framedCenterOf } from "./helpers/geometry"
import { preview } from "@/locales/en/preview"

// The office engine's fill and clipboard end to end: the fill handle dragged with
// the mouse (a series, a copy with Ctrl held, back inside to clear) and with a finger (touch pointer events on the
// handle, which never pans the grid), the Series dialog from the grid's menu, and clipboard HTML pasted from another
// spreadsheet (LibreOffice's, with Google Sheets' attributes): values, an R1C1 formula and number formats.
test.describe.configure({ mode: "default" })

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: "Fill",
					rows: [
						[1, "Mon", 10, 1],
						[2, "x", null, null]
					]
				}
			]
		})
	)
}

// LibreOffice 26.8's clipboard HTML ("HTML (StarCalc)") for a cell, a number with its format and a formula.
const PASTED_HTML =
	'<table cellspacing="0" border="0"><tr>' +
	'<td align="left" data-sheets-value="{ &quot;1&quot;: 2, &quot;2&quot;: &quot;007&quot;}"><b>007</b></td>' +
	'<td align="right" sdval="0.125" sdnum="1033;0;0.0%">12.5%</td>' +
	'<td align="right" sdval="0.25" sdnum="1033;" data-sheets-formula="=RC[-1]*2">0.25</td>' +
	"</tr></table>"

function nameBox(dialog: Locator): Locator {
	return dialog.getByRole("textbox", { name: preview.previewSheetNameBox })
}

function activeCell(dialog: Locator): Locator {
	return dialog.getByRole("grid").getByRole("gridcell")
}

async function goTo(dialog: Locator, ref: string): Promise<void> {
	const box = nameBox(dialog)

	await box.click()
	await box.fill(ref)
	await box.press("Enter")
	await expect(box).toHaveValue(ref)
	await expect(dialog.getByRole("grid")).toBeFocused()
}

// The centre of a cell on screen: the accessible active cell sits over the cell the grid draws.
async function cellCentre(dialog: Locator, ref: string): Promise<{ x: number; y: number }> {
	await goTo(dialog, ref)

	return framedCenterOf(dialog.locator(".fo-sheet-a11y"))
}

async function handleCentre(dialog: Locator): Promise<{ x: number; y: number }> {
	const handle = dialog.locator(".fo-sheet-fill-handle")

	await expect(handle).toBeVisible()

	// Placed on the renderer's frame: visible already from the previous selection, at its old corner.
	return framedCenterOf(handle)
}

async function dragHandle(page: Page, dialog: Locator, to: { x: number; y: number }, ctrl = false): Promise<void> {
	const from = await handleCentre(dialog)

	await page.mouse.move(from.x, from.y)
	await page.mouse.down()
	await page.mouse.move(to.x, to.y, { steps: 8 })

	if (ctrl) await page.keyboard.down("Control")

	await page.mouse.up()

	if (ctrl) await page.keyboard.up("Control")
}

async function expectCell(dialog: Locator, ref: string, text: string): Promise<void> {
	await goTo(dialog, ref)
	await expect(activeCell(dialog)).toHaveText(text)
}

test("the fill handle by mouse and touch, the Series dialog, and HTML pasted from another spreadsheet", async ({ page, browserName }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()

	await withScratchDirectory(page, "sheet-fill", async ({ listbox, runId }) => {
		const name = `e2e-sheet-fill-${runId}.xlsx`

		await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)
		await listbox.getByRole("option", { name }).dblclick()
		await expect(nameBox(dialog)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await goTo(dialog, "A1")
		await expect(activeCell(dialog)).toHaveText("1", { timeout: LAZY_VIEWER_TIMEOUT_MS })

		// Mouse: 1, 2 dragged down to row 5 is a linear series.
		const a5 = await cellCentre(dialog, "A5")

		await goTo(dialog, "A1:A2")
		await dragHandle(page, dialog, a5)
		await expect(nameBox(dialog)).toHaveValue("A1:A5")
		await expectCell(dialog, "A5", "5")

		// Ctrl held at release: "Mon" is copied instead of stepping through the days.
		const b4 = await cellCentre(dialog, "B4")

		await goTo(dialog, "B1")
		await dragHandle(page, dialog, b4, true)
		await expectCell(dialog, "B4", "Mon")
		await goTo(dialog, "B1")
		await dragHandle(page, dialog, b4)
		await expectCell(dialog, "B3", "Wed")

		// Dragged back inside the selection: the cells it leaves are cleared.
		const a3 = await cellCentre(dialog, "A3")

		await goTo(dialog, "A1:A5")
		await dragHandle(page, dialog, a3)
		await expectCell(dialog, "A4", "")
		await expectCell(dialog, "A3", "3")

		// Touch: a finger on the handle drags it (the handle takes no pan); one number is copied. Chromium takes real
		// touches over its protocol; elsewhere the handle gets a touch's pointer events.
		const c4 = await cellCentre(dialog, "C4")

		await goTo(dialog, "C1")

		const from = await handleCentre(dialog)

		if (browserName === "chromium") {
			const cdp = await page.context().newCDPSession(page)

			await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
			await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] })

			for (let step = 1; step <= 6; step++)
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x: from.x + ((c4.x - from.x) * step) / 6, y: from.y + ((c4.y - from.y) * step) / 6 }]
				})

			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
			await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false })
			await cdp.detach()
		} else {
			const handle = dialog.locator(".fo-sheet-fill-handle")
			const touch = { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }

			await handle.dispatchEvent("pointerdown", { ...touch, clientX: from.x, clientY: from.y })
			await handle.dispatchEvent("pointermove", { ...touch, clientX: c4.x, clientY: c4.y })
			await handle.dispatchEvent("pointerup", { ...touch, buttons: 0, clientX: c4.x, clientY: c4.y })
		}

		await expectCell(dialog, "C4", "10")

		// The Series dialog from the grid's menu: steps of 2 down column D.
		const d3 = await cellCentre(dialog, "D3")

		await goTo(dialog, "D1:D5")
		// A right-click inside the selection keeps it.
		await page.mouse.click(d3.x, d3.y, { button: "right" })
		await page.getByRole("menuitem", { name: preview.previewSheetFill }).click()
		await page.getByRole("menuitem", { name: preview.previewSheetFillSeries }).click()

		const series = page.getByRole("dialog", { name: preview.previewSheetSeriesTitle })

		await expect(series).toBeVisible()
		await series.getByRole("textbox", { name: preview.previewSheetSeriesStep }).fill("2")
		await series.getByRole("button", { name: preview.previewSheetSeriesFill }).click()
		await expect(series).toHaveCount(0)
		await expectCell(dialog, "D5", "9")

		// Clipboard HTML from another spreadsheet: text kept text, a number in its format, an R1C1 formula moved here.
		await goTo(dialog, "F2")
		await dialog.getByRole("grid").evaluate((grid, html) => {
			// A paste event carrying the clipboard's data (Firefox leaves a scripted ClipboardEvent's data out).
			const data: Record<string, string> = { "text/html": html, "text/plain": "007\t12.5%\t0.25" }
			const event = new Event("paste", { bubbles: true, cancelable: true })

			Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "" } })
			grid.dispatchEvent(event)
		}, PASTED_HTML)
		await expectCell(dialog, "F2", "007")
		await expectCell(dialog, "G2", "12.5%")
		await expectCell(dialog, "H2", "0.25")
		await expect(dialog.getByRole("textbox", { name: preview.previewSpreadsheetCellContents })).toHaveValue("=G2*2")

		await page.keyboard.press("Escape")
	})
})

import type { Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import { test, expect } from "./fixtures"
import { withScratchDirectory, LAZY_VIEWER_TIMEOUT_MS, uploadFiles } from "./helpers/listing"
import { common } from "@/locales/en/common"
import { ribbonControl } from "./helpers/ribbon"
import { framedCenterOf } from "./helpers/geometry"
import { preview } from "@/locales/en/preview"

// The office engine's grid under a finger, on a sheet's whole range and for a screen reader. A tap selects and a pan
// selects nothing, a double tap opens the entry with focus in it (the soft keyboard's target), a long press shows the
// touch menu above the cell (Cut, Copy, Paste, Select all, Edit, More, with 44 px targets), the start handle drags a touch
// selection wider, and the menu's Edit and Select all work. The name box and Ctrl+arrows reach row 1,048,576 and
// column XFD through a scroll range the browsers hold, the wheel moves the sheet by its own pixels there and the
// scrollbar maps linearly onto it. The grid is a named ARIA grid whose live region says the active cell and the
// selected range.
//
// Chromium's touches go through CDP; Firefox and WebKit have no touch protocol in Playwright beyond a tap, so there
// the same pointer events are dispatched to the element under the finger, captured by what they pressed as a touch's
// are.
test.describe.configure({ mode: "default" })

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
// touch/gestures.ts's LONG_PRESS_MS and DOUBLE_TAP_MS, and some.
const LONG_PRESS_HOLD_MS = 800
const DOUBLE_TAP_WAIT_MS = 450

interface Point {
	x: number
	y: number
}

async function xlsxBytes(): Promise<Buffer> {
	const rows: (string | number)[][] = [["Id", "Name", "Qty"]]

	for (let row = 1; row <= 40; row++) rows.push([row, `item ${String(row)}`, row * 3])

	return Buffer.from(await writeXlsx({ sheets: [{ name: "Touch", rows }] }))
}

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
}

async function cellCentre(dialog: Locator, ref: string): Promise<Point> {
	await goTo(dialog, ref)

	return framedCenterOf(dialog.locator(".fo-sheet-a11y"))
}

// One finger's press, hold, moves and release.
async function touch(page: Page, browserName: string, path: readonly Point[], holdMs = 40): Promise<void> {
	const [first] = path

	if (first === undefined) return

	if (browserName === "chromium") {
		const cdp = await page.context().newCDPSession(page)

		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...first, id: 1 }] })
		await page.waitForTimeout(holdMs)

		for (const point of path.slice(1)) {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1 }] })
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
		}

		if (path.length > 1) await page.waitForTimeout(100)

		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
		await cdp.detach()

		return
	}

	await page.evaluate(
		async ({ path, holdMs }) => {
			const init = (point: { x: number; y: number }): PointerEventInit => ({
				pointerId: 7,
				pointerType: "touch",
				isPrimary: true,
				bubbles: true,
				cancelable: true,
				composed: true,
				clientX: point.x,
				clientY: point.y,
				button: 0,
				buttons: 1
			})
			const names = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const
			const saved = names.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name))
			let captured: Element | null = null
			const define = (name: (typeof names)[number], value: (this: Element) => unknown): void => {
				Object.defineProperty(Element.prototype, name, { configurable: true, writable: true, value })
			}

			const hold = (element: Element | null): void => {
				captured = element
			}

			define("setPointerCapture", function (this: Element) {
				hold(this)
			})
			define("releasePointerCapture", () => {
				hold(null)
			})
			define("hasPointerCapture", function (this: Element) {
				return captured === this
			})

			try {
				const target = (point: { x: number; y: number }): Element =>
					captured ?? document.elementFromPoint(point.x, point.y) ?? document.body
				const start = path[0]

				if (start === undefined) return

				// A touch is captured by what it pressed, as the platforms do.
				const pressed = target(start)

				pressed.dispatchEvent(new PointerEvent("pointerdown", init(start)))
				captured ??= pressed
				await new Promise(resolve => setTimeout(resolve, holdMs))

				for (const point of path.slice(1)) {
					target(point).dispatchEvent(new PointerEvent("pointermove", init(point)))
					await new Promise(resolve => requestAnimationFrame(resolve))
				}

				const end = path[path.length - 1] ?? start

				target(end).dispatchEvent(new PointerEvent("pointerup", { ...init(end), buttons: 0 }))
			} finally {
				names.forEach((name, k) => {
					const descriptor = saved[k]

					if (descriptor !== undefined) Object.defineProperty(Element.prototype, name, descriptor)
				})
			}
		},
		{ path, holdMs }
	)
}

async function openWorkbook(page: Page, listbox: Locator, runId: string, dialog: Locator): Promise<void> {
	const name = `e2e-sheet-touch-${runId}.xlsx`

	await uploadFiles(page, [{ name, mimeType: XLSX_MIME, buffer: await xlsxBytes() }], listbox)
	await listbox.getByRole("option", { name }).dblclick()
	await expect(nameBox(dialog)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await goTo(dialog, "A2")
	await expect(activeCell(dialog)).toHaveText("1", { timeout: LAZY_VIEWER_TIMEOUT_MS })
}

test.describe("touch", () => {
	test.use({ hasTouch: true, viewport: { width: 820, height: 1000 } })

	test("tap, double tap, long press and its menu, the start handle, Edit and Select all", async ({ page, browserName }) => {
		test.slow()

		const dialog = page.getByRole("dialog").first()
		const menu = page.getByRole("toolbar", { name: common.selectionActionsLabel })
		const handle = dialog.locator(".fo-sheet-touch-handle")
		const editor = dialog.locator("textarea.fo-sheet-editor")

		await withScratchDirectory(page, "sheet-touch", async ({ listbox, runId }) => {
			await openWorkbook(page, listbox, runId, dialog)

			// A tap selects, with the start handle.
			const b3 = await cellCentre(dialog, "B3")

			await goTo(dialog, "A1")
			await touch(page, browserName, [b3])
			await expect(nameBox(dialog)).toHaveValue("B3")
			await expect(handle).toBeVisible()
			await expect(menu).toHaveCount(0)

			// A pan selects nothing.
			const a10 = await cellCentre(dialog, "A10")

			await goTo(dialog, "A1")
			await touch(page, browserName, [a10, { x: a10.x, y: a10.y - 60 }, { x: a10.x, y: a10.y - 140 }])
			await page.waitForTimeout(DOUBLE_TAP_WAIT_MS)
			await expect(nameBox(dialog)).toHaveValue("A1")

			// A double tap opens the entry with focus in it.
			const c4 = await cellCentre(dialog, "C4")

			await touch(page, browserName, [c4])
			await page.waitForTimeout(60)
			await touch(page, browserName, [c4])
			await expect(editor).toBeFocused()
			await page.keyboard.press("Escape")
			await expect(editor).toHaveCount(0)

			// A long press shows the menu above the cell, 44 px targets, the grid's own context menu shut. Measured from
			// the top: the pan above scrolled the sheet, and going to A1 for the press scrolls it back.
			await goTo(dialog, "A1")

			const c6 = await cellCentre(dialog, "C6")

			await goTo(dialog, "A1")
			await touch(page, browserName, [c6], LONG_PRESS_HOLD_MS)
			await expect(nameBox(dialog)).toHaveValue("C6")
			await expect(menu).toBeVisible()
			await expect(menu.getByRole("button")).toHaveText([
				preview.previewSheetTouchCut,
				preview.previewSheetTouchCopy,
				preview.previewSheetTouchPaste,
				preview.previewSheetTouchSelectAll,
				preview.previewSheetTouchEdit,
				"⋯"
			])
			await expect(menu.getByRole("button").last()).toHaveAccessibleName(preview.previewSheetTouchMore)
			await expect(page.getByRole("menu", { name: preview.previewSheetGridMenu })).toHaveCount(0)

			const item = await menu.getByRole("button").first().boundingBox()
			const menuBox = await menu.boundingBox()
			const cellBox = await dialog.locator(".fo-sheet-a11y").boundingBox()

			expect(item?.height ?? 0).toBeGreaterThanOrEqual(44)
			expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(cellBox?.y ?? 0)

			// The start handle dragged up and left: the selection runs from C6 to A3.
			const start = await handle.boundingBox()

			if (start === null) throw new Error("no start handle")

			const a3 = { x: b3.x - (c4.x - b3.x), y: b3.y }
			const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 }

			await touch(page, browserName, [from, { x: (from.x + a3.x) / 2, y: (from.y + a3.y) / 2 }, a3])
			await expect(nameBox(dialog)).toHaveValue("A3:C6")
			await expect(menu).toBeVisible()
			await expect(dialog.getByRole("status").filter({ hasText: "A3:C6 selected" })).toHaveCount(1)

			// Select all from the menu.
			await menu.getByRole("button", { name: preview.previewSheetTouchSelectAll }).click()
			await expect(nameBox(dialog)).toHaveValue("A1:XFD1048576")

			// A tap on the cell that is the selection shows the menu; Edit opens its entry.
			const b5 = await cellCentre(dialog, "B5")

			await touch(page, browserName, [b5])
			await page.waitForTimeout(DOUBLE_TAP_WAIT_MS)
			await expect(menu).toBeVisible()
			await menu.getByRole("button", { name: preview.previewSheetTouchEdit }).click()
			await expect(editor).toBeFocused()
			await page.keyboard.press("Escape")
		})
	})
})

test("the whole sheet: the name box, Ctrl+arrows, the wheel and the scrollbar reach row 1,048,576 and column XFD", async ({ page }) => {
	test.slow()

	const dialog = page.getByRole("dialog").first()

	await withScratchDirectory(page, "sheet-large", async ({ listbox, runId }) => {
		await openWorkbook(page, listbox, runId, dialog)

		const grid = dialog.getByRole("grid")
		const scroller = dialog.locator(".fo-sheet-scroller")
		const row = async (y: number): Promise<number> => {
			const box = await scroller.boundingBox()

			if (box === null) throw new Error("no grid")

			await page.mouse.click(box.x + 110, box.y + y)

			return Number((await nameBox(dialog).inputValue()).replace(/^[A-Z]+/, ""))
		}

		await goTo(dialog, "A1048576")
		await expect(grid.locator("[role=row]")).toHaveAttribute("aria-rowindex", "1048576")

		const dom = await scroller.evaluate(element => ({ height: element.scrollHeight, top: element.scrollTop }))

		expect(dom.height).toBeLessThanOrEqual(8_000_200)
		expect(dom.top).toBeGreaterThan(7_000_000)

		await grid.press("Control+ArrowUp")
		await expect(nameBox(dialog)).toHaveValue("A41")
		await grid.press("Control+ArrowDown")
		await expect(nameBox(dialog)).toHaveValue("A1048576")

		// 1,000 px of wheel is 50 rows at the default height, not the scaled distance.
		const before = await row(30)
		const box = await scroller.boundingBox()

		await goTo(dialog, "A1048576")
		await page.mouse.move((box?.x ?? 0) + 300, (box?.y ?? 0) + 300)

		for (let step = 0; step < 10; step++) await page.mouse.wheel(0, -100)

		await page.waitForTimeout(300)
		expect(Math.abs(before - (await row(30)) - 50)).toBeLessThanOrEqual(1)

		// The scrollbar's middle is the sheet's middle: the pane's middle row, not its top one (half a pane above it).
		await scroller.evaluate(element => {
			element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
		})
		await page.waitForTimeout(300)
		expect(Math.abs((await row((box?.height ?? 0) / 2)) - 524_288)).toBeLessThan(50)

		await goTo(dialog, "XFD1")
		await expect(grid.getByRole("gridcell")).toHaveAttribute("aria-colindex", "16384")
		await goTo(dialog, "A60")
		await grid.press("Control+ArrowRight")
		await expect(nameBox(dialog)).toHaveValue("XFD60")
	})
})

test("a screen reader's grid: named, its active cell a gridcell in a row, the live region saying the cell and the range", async ({
	page
}) => {
	const dialog = page.getByRole("dialog").first()

	await withScratchDirectory(page, "sheet-a11y", async ({ listbox, runId }) => {
		await openWorkbook(page, listbox, runId, dialog)

		const grid = dialog.getByRole("grid")

		await expect(grid).toHaveAccessibleName(new RegExp(`^e2e-sheet-touch-${runId}\\.xlsx`))
		await expect(grid).toHaveAttribute("aria-rowcount", "1048576")
		await expect(grid).toHaveAttribute("aria-colcount", "16384")
		await expect(grid).toHaveAttribute("aria-multiselectable", "true")

		await goTo(dialog, "B3")
		await expect(grid.getByRole("row")).toHaveAttribute("aria-rowindex", "3")
		await expect(grid.getByRole("gridcell")).toHaveAttribute("aria-colindex", "2")
		await expect(grid.getByRole("gridcell")).toHaveText("item 2")
		await expect(dialog.locator(".fo-sheet-live")).toHaveText("B3, item 2")

		await goTo(dialog, "B3:C4")
		await expect(dialog.locator(".fo-sheet-live")).toHaveText(/B3:C4 selected$/)

		// The menus a pointer opens are named.
		const centre = await dialog.locator(".fo-sheet-a11y").boundingBox()

		await page.mouse.click((centre?.x ?? 0) + 5, (centre?.y ?? 0) + 5, { button: "right" })
		await expect(page.getByRole("menu", { name: preview.previewSheetGridMenu })).toBeVisible()
		await page.keyboard.press("Escape")
		await (await ribbonControl(page, dialog, preview.previewOfficeRibbonFont, preview.previewSheetFormatFont, "combobox")).click()
		await expect(page.getByRole("listbox", { name: preview.previewSheetFormatFont })).toBeVisible()
		await page.keyboard.press("Escape")
	})
})

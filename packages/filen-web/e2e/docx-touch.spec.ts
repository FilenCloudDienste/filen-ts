import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { DOCX_FIXTURE_TEXT, type DocxFixtureName } from "./helpers/docxFixtures"
import { trackCspViolations } from "./helpers/csp"
import { common } from "@/locales/en/common"
import { preview } from "@/locales/en/preview"

// The DOCX editor under touch: a long press selects the word with a handle at each end and the touch menu
// above it, a handle dragged moves its end, the menu's Select all selects everything, and below 600 px the
// editor shows Mobile view by itself (and pages again once wider); a tap in the body leaves a note. Read-only:
// nothing is typed or saved.
//
// Chromium's touches go through CDP (the browser's own touch pipeline: pointer events of type "touch", pointer
// capture, compatibility mouse events). Firefox and WebKit have no touch protocol in Playwright beyond a tap,
// so there the same pointer events are dispatched to the element under the finger, with pointer capture
// standing in as the platform would give it.

test.describe.configure({ mode: "default" })
test.use({ hasTouch: true })

const TABLET = { width: 820, height: 1180 }
const PHONE = { width: 390, height: 844 }
// DocxEditor.tsx's LONG_PRESS_MS, and some.
const LONG_PRESS_HOLD_MS = 800
const DOCUMENT: DocxFixtureName = "w3-headers.docx"

interface Point {
	x: number
	y: number
}

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text).first()
}

async function centerOf(locator: Locator): Promise<Point> {
	const box = await locator.boundingBox()

	if (box === null) {
		throw new Error("not on screen")
	}

	return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// A point inside a word: the share of `text`'s box at which `word` starts plus half its length (monospace
// enough for a hit inside it).
async function pointInWord(locator: Locator, text: string, word: string): Promise<Point> {
	const box = await locator.boundingBox()
	const at = text.indexOf(word)

	if (box === null || at < 0) {
		throw new Error(`"${word}" is not in "${text}"`)
	}

	return { x: box.x + (box.width * (at + word.length / 2)) / text.length, y: box.y + box.height / 2 }
}

// One finger's press, moves and release.
async function touch(page: Page, browserName: string, path: readonly Point[], holdMs: number): Promise<void> {
	const [first] = path
	const last = path.at(-1)

	if (first === undefined || last === undefined) {
		return
	}

	if (browserName === "chromium") {
		const cdp = await page.context().newCDPSession(page)

		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...first, id: 1 }] })
		await page.waitForTimeout(holdMs)

		// A frame between moves, as a finger gives: Chromium coalesces moves within one, and drops a coalesced
		// last move a release follows at once.
		for (const point of path.slice(1)) {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1 }] })
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
		}

		// A finger rests before it lifts: the last move is delivered with the next frames, not after the release.
		await page.waitForTimeout(100)

		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
		await cdp.detach()

		return
	}

	await page.evaluate(
		async ({ path, holdMs }) => {
			const pointerId = 7
			const init = (point: { x: number; y: number }): PointerEventInit => ({
				pointerId,
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
			const start = path[0]

			if (start === undefined) {
				return
			}

			// Pointer capture of the dispatched pointer, as the platform gives a real one (no other pointer is down
			// meanwhile, so the stand-ins serve every id until they are taken away again).
			const names = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const
			const saved = names.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name))
			let captured: Element | null = null
			const hold = (element: Element | null): void => {
				captured = element
			}
			const define = (name: (typeof names)[number], value: (this: Element) => unknown): void => {
				Object.defineProperty(Element.prototype, name, { configurable: true, writable: true, value })
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

				target(start).dispatchEvent(new PointerEvent("pointerdown", init(start)))
				await new Promise(resolve => setTimeout(resolve, holdMs))

				for (const point of path.slice(1)) {
					target(point).dispatchEvent(new PointerEvent("pointermove", init(point)))
					await new Promise(resolve => requestAnimationFrame(resolve))
				}

				const end = path[path.length - 1] ?? start

				target(end).dispatchEvent(new PointerEvent("pointerup", { ...init(end), buttons: 0 }))

				// A tap ends in a click, as on a touch screen.
				if (path.length === 1 && holdMs < 300) {
					target(end).dispatchEvent(
						new MouseEvent("click", {
							bubbles: true,
							cancelable: true,
							composed: true,
							clientX: end.x,
							clientY: end.y,
							button: 0
						})
					)
				}
			} finally {
				for (const [index, name] of names.entries()) {
					const descriptor = saved[index]

					if (descriptor !== undefined) {
						Object.defineProperty(Element.prototype, name, descriptor)
					}
				}
			}
		},
		{ path, holdMs }
	)
}

async function openDocument(
	page: Page,
	scenario: "docx-edit" | "docx-notes-picture" = "docx-edit",
	name: DocxFixtureName = DOCUMENT
): Promise<void> {
	await bootTo(page)

	const { rows } = await openFixtureRows(page, scenario)
	const files: readonly string[] = FIXTURE_FILES[scenario]
	const row = rows[files.indexOf(name)]

	if (row === undefined) {
		throw new Error(`no row for ${name}`)
	}

	await page.setViewportSize(TABLET)
	await row.dblclick()
	await expect(pageText(page, DOCX_FIXTURE_TEXT[name])).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	// A read lane: the shared tree is never saved into by the editor's idle autosave (e2e/fixtures.ts `page`).
	expect(await page.evaluate(() => sessionStorage.getItem("filen-e2e-docx-autosave"))).toBe("off")
}

test("a long press selects the word: handles at its ends, the touch menu, a handle dragged, Select all", async ({ page, browserName }) => {
	const cspViolations = trackCspViolations(page)

	await openDocument(page)

	const text = DOCX_FIXTURE_TEXT[DOCUMENT]
	const line = pageText(page, text)
	// Named for screen readers.
	const menu = page.getByRole("menu", { name: common.selectionActionsLabel, exact: true })

	await touch(page, browserName, [await pointInWord(line, text, "headers")], LONG_PRESS_HOLD_MS)
	await expect(menu).toBeVisible()
	await expect(menu.getByRole("menuitem", { name: preview.previewDocxCopy, exact: true })).toBeVisible()
	await expect(menu.getByRole("menuitem", { name: preview.previewDocxCut, exact: true })).toBeVisible()

	// The handles are a touch affordance only, kept from the accessibility tree.
	const handles = page.locator("div.touch-none[aria-hidden='true']")

	await expect(handles).toHaveCount(2)

	// The end handle dragged to the end of the line: the selection's end follows it.
	const endHandle = handles.nth(1)
	const before = await centerOf(endHandle)
	const lineBox = await line.boundingBox()
	const target = { x: (lineBox?.x ?? 0) + (lineBox?.width ?? 0) - 2, y: before.y }

	await touch(page, browserName, [before, { x: (before.x + target.x) / 2, y: before.y }, target], 50)
	await expect.poll(async () => (await centerOf(handles.nth(1))).x).toBeGreaterThan(target.x - 8)
	await expect(menu).toBeVisible()

	// Select all from the menu: the start handle goes to the document's start.
	const startBefore = await centerOf(handles.nth(0))

	await touch(page, browserName, [await centerOf(menu.getByRole("menuitem", { name: preview.previewDocxSelectAll, exact: true }))], 0)
	await expect.poll(async () => (await centerOf(handles.nth(0))).x).toBeLessThan(startBefore.x)
	await expect(menu).toBeVisible()

	// A tap elsewhere collapses the selection: no handles, no menu.
	await touch(page, browserName, [await pointInWord(line, text, "fixture")], 0)
	await expect(menu).toHaveCount(0)
	await expect(handles).toHaveCount(0)

	expect(cspViolations).toEqual([])
})

test("a tap in the body leaves a footnote, as a click does", async ({ page, browserName }) => {
	await openDocument(page, "docx-notes-picture", "notes.docx")

	const editor = page.locator(".fo-docx-editor")
	const reference = page
		.locator(".fo-docx-page .fo-docx-line")
		.filter({ hasText: DOCX_FIXTURE_TEXT["notes.docx"] })
		.first()
		.locator(".fo-docx-run")
		.filter({ hasText: /^1$/ })
		.first()

	// Into the note from its reference's chip.
	await touch(page, browserName, [await centerOf(reference)], 0)
	await touch(
		page,
		browserName,
		[
			await centerOf(
				page.getByRole("toolbar", { name: preview.previewDocxFieldChip }).getByRole("button", { name: preview.previewDocxNoteGoTo })
			)
		],
		0
	)
	await expect(editor).toHaveAttribute("data-fo-story", "footnote")

	// One tap in the body: back in it (touch has no Escape key, and no double tap to leave by).
	await touch(page, browserName, [await centerOf(pageText(page, "After the notes."))], 0)
	await expect(editor).toHaveAttribute("data-fo-story", "body")
})

test("below 600 px the editor shows Mobile view by itself, and pages again once wider", async ({ page }) => {
	await openDocument(page)

	const reflow = page.locator(".fo-docx-reflow-doc")

	await expect(reflow).toHaveCount(0)

	await page.setViewportSize(PHONE)
	await expect(reflow.getByText(DOCX_FIXTURE_TEXT[DOCUMENT]).first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.locator(".fo-docx-page")).toHaveCount(0)

	await page.setViewportSize(TABLET)
	await expect(pageText(page, DOCX_FIXTURE_TEXT[DOCUMENT])).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(reflow).toHaveCount(0)
})

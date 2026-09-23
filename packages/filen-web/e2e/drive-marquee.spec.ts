import type { Locator } from "@playwright/test"
import { test, expect } from "./fixtures"
import { enterFixtureDirectory, enterFixtureRoot } from "./helpers/fixtures"
import { bootTo, waitForListingSettled } from "./helpers/listing"
import { MOD_KEY } from "./helpers/modkey"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Strict null handling (no `!`): a locator with no box on screen is a real failure, surfaced here.
async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
	const box = await locator.boundingBox()

	if (!box) {
		throw new Error("expected the element to have an on-screen bounding box")
	}

	return box
}

test.describe("drive rubber-band selection", () => {
	test("marquee selects a row band; ctrl-drag unions; Escape mid-drag restores", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)

		// Six tiny files, provisioned once per run by the fixtures-setup project — the marquee's targets.
		// enterFixtureDirectory forces the same tall viewport enterScratchDirectory did, so all six rows
		// mount and expose real bounding boxes for the pixel-precise drags below.
		const { listbox } = await enterFixtureDirectory(page, "marquee")

		const options = listbox.getByRole("option")
		await expect(options).toHaveCount(6)

		const listboxBox = await boxOf(listbox)
		const centerX = listboxBox.x + listboxBox.width / 2

		// Row boxes are stable for the rest of the test (no scroll happens): capture the ones the drags
		// aim at once.
		const box1 = await boxOf(options.nth(1))
		const box3 = await boxOf(options.nth(3))
		const box5 = await boxOf(options.nth(5))
		// Blank listbox space below the last row — the marquee may only start from here, never a row.
		const blankY = box5.y + box5.height + 20
		expect(blankY).toBeLessThan(listboxBox.y + listboxBox.height)

		async function assertSelected(indices: number[]): Promise<void> {
			for (let i = 0; i < 6; i++) {
				await expect(options.nth(i)).toHaveAttribute("aria-selected", indices.includes(i) ? "true" : "false")
			}
		}

		// 1) Plain marquee from blank space up into row 3 — replace mode selects exactly rows 3, 4, 5.
		await page.mouse.move(centerX, blankY)
		await page.mouse.down()
		await page.mouse.move(centerX, box3.y + box3.height / 2, { steps: 12 })
		await page.mouse.up()

		await expect(page.getByText("3 selected", { exact: true })).toBeVisible()
		await assertSelected([3, 4, 5])

		// 2) Ctrl/Cmd-drag is additive — union the pre-drag {3,4,5} with a band reaching up to row 1,
		// landing at five selected. MOD_KEY is a raw host-level modifier (safe here: this drag never
		// goes through the in-page "mod" hotkey resolution).
		await page.keyboard.down(MOD_KEY)
		await page.mouse.move(centerX, blankY)
		await page.mouse.down()
		await page.mouse.move(centerX, box1.y + box1.height / 2, { steps: 12 })
		await page.mouse.up()
		await page.keyboard.up(MOD_KEY)

		await expect(page.getByText("5 selected", { exact: true })).toBeVisible()
		await assertSelected([1, 2, 3, 4, 5])

		// 3) Escape mid-drag cancels the marquee and restores the arm-time selection ({1..5}). Start a
		// plain (replace) drag that has already narrowed the live selection, then Escape before release.
		await page.mouse.move(centerX, blankY)
		await page.mouse.down()
		await page.mouse.move(centerX, box5.y + box5.height / 2, { steps: 12 })
		// Live selection has now collapsed toward the bottom rows...
		await expect(page.getByText("5 selected", { exact: true })).toHaveCount(0)
		await page.keyboard.press("Escape")
		await page.mouse.up()

		// ...and Escape put the pre-drag five back, never clearing.
		await expect(page.getByText("5 selected", { exact: true })).toBeVisible()
		await assertSelected([1, 2, 3, 4, 5])
	})

	test("a marquee dragged past a short listing's edges never scrolls it or grows its content", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)

		const { listbox } = await enterFixtureDirectory(page, "marquee")
		const options = listbox.getByRole("option")
		await expect(options).toHaveCount(6)

		// Back to a desktop-sized window: six rows still fit, and the pointer can now leave the listbox
		// through its bottom edge while staying inside the page.
		await page.setViewportSize({ width: 1280, height: 720 })

		const metrics = (): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> =>
			listbox.evaluate(el => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
		const before = await metrics()
		expect(before.scrollHeight).toBe(before.clientHeight)

		const listboxBox = await boxOf(listbox)
		const box5 = await boxOf(options.nth(5))
		const centerX = listboxBox.x + listboxBox.width / 2
		const blankY = box5.y + box5.height + 20
		const viewport = page.viewportSize()

		if (!viewport) {
			throw new Error("expected a fixed viewport")
		}

		// Down: past the listbox's bottom edge to the window's last pixel row, then hold there long enough
		// for the edge auto-scroll to run many frames.
		await page.mouse.move(centerX, blankY)
		await page.mouse.down()
		await page.mouse.move(centerX, viewport.height - 1, { steps: 12 })
		await expect(page.getByTestId("marquee-rect")).toBeVisible()
		await page.waitForTimeout(1_000)

		const down = await metrics()
		expect(down.scrollTop).toBe(Math.max(0, before.scrollHeight - before.clientHeight))
		expect(down.scrollHeight).toBe(before.scrollHeight)

		// Up: past the top edge, same hold.
		await page.mouse.move(centerX, 1, { steps: 12 })
		await page.waitForTimeout(1_000)

		const up = await metrics()
		expect(up.scrollTop).toBe(0)
		expect(up.scrollHeight).toBe(before.scrollHeight)

		await page.mouse.up()
		await expect(page.getByTestId("marquee-rect")).toHaveCount(0)
	})

	test("a click away from the items clears the selection, a click on the sole selected row deselects it, and a double-click still opens", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)

		const { listbox: rootListbox } = await enterFixtureRoot(page)
		const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
		// Token-anchored like helpers/listing.ts's own row lookup: the row's accessible name carries its
		// size/date columns after the item name.
		const marqueeDir = rootListbox.getByRole("option", { name: /(^|\s)marquee(\s|$)/ })

		// Double-click on the sole selected directory: its first click deselects, the second (detail 2)
		// must not leave it deselected, and the dblclick still navigates.
		await marqueeDir.click()
		await expect(marqueeDir).toHaveAttribute("aria-selected", "true")
		await marqueeDir.dblclick()
		await expect(breadcrumb.getByText("marquee", { exact: true })).toBeVisible()

		const { listbox } = await waitForListingSettled(page)
		const options = listbox.getByRole("option")
		await expect(options).toHaveCount(6)

		const selectedBar = page.getByText(/^\d+ selected$/)
		const first = options.nth(0)
		const box5 = await boxOf(options.nth(5))
		const listboxBox = await boxOf(listbox)

		// Empty listing space below the last row.
		await first.click()
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		await page.mouse.click(listboxBox.x + listboxBox.width / 2, box5.y + box5.height + 40)
		await expect(listbox.getByRole("option", { selected: true })).toHaveCount(0)
		await expect(selectedBar).toHaveCount(0)

		// The page header's background, in the gap between the breadcrumb and the action buttons.
		const header = page.locator("header", { has: breadcrumb })
		const headerBox = await boxOf(header)
		const breadcrumbBox = await boxOf(breadcrumb)

		await first.click()
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		await page.mouse.click(breadcrumbBox.x + breadcrumbBox.width + 40, headerBox.y + headerBox.height / 2)
		await expect(selectedBar).toHaveCount(0)

		// A control that acts around the selection keeps it — including the press that closes its menu.
		await first.click()
		await page.getByRole("button", { name: "Sort by", exact: true }).click()
		await expect(page.getByRole("menu")).toBeVisible()
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		await page.mouse.click(listboxBox.x + listboxBox.width / 2, box5.y + box5.height + 40)
		await expect(page.getByRole("menu")).toHaveCount(0)
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		await expect(first).toHaveAttribute("aria-selected", "true")

		// Clicking the sole selected row again deselects it.
		await first.click()
		await expect(first).toHaveAttribute("aria-selected", "false")
		await expect(selectedBar).toHaveCount(0)

		// A marquee released over empty space (the column header above the listbox) is a drag, not a
		// click-away: its selection survives the release.
		const centerX = listboxBox.x + listboxBox.width / 2

		await page.mouse.move(centerX, box5.y + box5.height + 40)
		await page.mouse.down()
		await page.mouse.move(centerX, listboxBox.y - 10, { steps: 12 })
		await page.mouse.up()
		await expect(page.getByText("6 selected", { exact: true })).toBeVisible()
	})
})

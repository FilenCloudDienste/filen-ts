import type { CDPSession, Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { enterFixtureRoot } from "./helpers/fixtures"
import { centerOf } from "./helpers/geometry"
import { bootTo, expectBreadcrumbAt } from "./helpers/listing"

// The touch model of the click-to-select lists (useTouchLongPress + touchTapIntent): a tap opens, a
// long-press selects without the context menu, a tap in selection mode toggles, and a pan selects
// nothing. Driven with real touch input — CDP's Input.dispatchTouchEvent runs through Chrome's own
// gesture detection, so its long-press contextmenu is exercised as well as the hook's timer — which is
// why this is chromium-only: Playwright has no touch input beyond a bare tap on the other two.
//
// READ-ONLY BY CONSTRUCTION: it selects and navigates inside the shared fixture tree and writes nothing.
test.describe("touch", () => {
	// Decided from the worker's browser, before a context exists: Firefox rejects isMobile outright.
	test.skip(({ browserName }) => browserName !== "chromium", "touch gestures need CDP's Input.dispatchTouchEvent")
	test.use({ hasTouch: true, isMobile: true })

	// Held well past the 500ms long-press delay, and past Chrome's own long-press timeout.
	const HOLD_MS = 900

	function row(listbox: Locator, name: string): Locator {
		return listbox.getByRole("option", { name: new RegExp(`^${name}\\b`) })
	}

	async function touchStart(cdp: CDPSession, point: { x: number; y: number }): Promise<void> {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
	}

	async function touchEnd(cdp: CDPSession): Promise<void> {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
	}

	async function tap(cdp: CDPSession, target: Locator): Promise<void> {
		await touchStart(cdp, await centerOf(target))
		await touchEnd(cdp)
	}

	function menus(page: Page): Locator {
		return page.getByRole("menu")
	}

	test("a long-press selects without a menu, taps then toggle, a pan selects nothing, and a tap opens", async ({ page }) => {
		await bootTo(page)

		const { listbox } = await enterFixtureRoot(page)
		const cdp = await page.context().newCDPSession(page)
		const marquee = row(listbox, "marquee")
		const thumbnails = row(listbox, "thumbnails")
		const download = row(listbox, "download-fsa")
		const url = page.url()

		// Selected while the finger is still down: the hold is what selects, not the lift.
		await touchStart(cdp, await centerOf(marquee))
		await expect(marquee).toHaveAttribute("aria-selected", "true")
		await page.waitForTimeout(HOLD_MS)
		await touchEnd(cdp)

		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		await expect(menus(page)).toHaveCount(0)
		expect(page.url()).toBe(url)

		// Selection mode: a tap toggles instead of opening.
		await tap(cdp, thumbnails)
		await expect(thumbnails).toHaveAttribute("aria-selected", "true")
		await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

		await tap(cdp, marquee)
		await expect(marquee).toHaveAttribute("aria-selected", "false")
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()
		expect(page.url()).toBe(url)

		// A finger that travels is a pan: held past the delay, it still selects nothing.
		const start = await centerOf(download)

		await touchStart(cdp, start)
		for (let step = 1; step <= 6; step++) {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y + step * 8 }] })
		}
		await page.waitForTimeout(HOLD_MS)
		await touchEnd(cdp)

		await expect(download).toHaveAttribute("aria-selected", "false")
		await expect(menus(page)).toHaveCount(0)

		// The item menu stays a tap away on a coarse pointer, where the ⋯ trigger is always shown.
		const more = download.getByRole("button", { name: "More actions" })

		await expect(more).toHaveCSS("opacity", "1")
		await tap(cdp, more)
		await expect(menus(page)).toHaveCount(1)
		await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible()
		await page.keyboard.press("Escape")
		await expect(menus(page)).toHaveCount(0)

		// The last toggle empties the selection, and taps open again.
		await tap(cdp, thumbnails)
		await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0)

		await tap(cdp, marquee)
		await expectBreadcrumbAt(page, "marquee")
		await expect(listbox.getByRole("option", { selected: true })).toHaveCount(0)
	})
})

import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { revealSlideshowBar, slideshowBar } from "./helpers/slideshow"

// The preview's slideshow over a listing's files (shared read-only tree, scenario "preview-slideshow"): started from
// the header, stepping on its own over the images and the video and never onto the text file, paused and resumed with
// Space, and ended by leaving its full screen.

const [FIRST, SECOND, TEXT, THIRD] = FIXTURE_FILES["preview-slideshow"]

// Four of the scenario's five files are slides.
const SLIDES = 4

// Longer than the default 5 s a slide stays up.
const PAUSE_HOLD_MS = 7_000

// A slide stays the interval (3 or 5 s here) once shown; a step is due well within this.
const STEP_TIMEOUT_MS = 20_000

// The file on screen: the preview dialog's accessible name, its header's title or, while a slideshow runs, the
// hidden one standing in for it.
function previewOf(page: Page, name: string): Locator {
	return page.getByRole("dialog", { name, exact: true })
}

async function shownName(page: Page): Promise<string> {
	return page
		.getByRole("dialog")
		.filter({ has: slideshowBar(page) })
		.evaluate(dialog => document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent ?? "")
}

// Picks a time per image on the bar; the menu closes on the pick.
async function pickInterval(page: Page, label: string): Promise<void> {
	const bar = await revealSlideshowBar(page)

	await bar.getByRole("button", { name: "Time per image", exact: true }).click()
	await page.getByRole("menuitemradio", { name: label, exact: true }).click()
	await expect(page.getByRole("menu")).toHaveCount(0)
	await expect(bar.getByRole("button", { name: "Time per image", exact: true })).toHaveText(label)
}

async function openAndStart(page: Page): Promise<Locator> {
	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-slideshow")

	await listbox.getByRole("option", { name: FIRST }).dblclick()

	const preview = previewOf(page, FIRST)

	await expect(preview).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await preview.getByRole("button", { name: "Slideshow", exact: true }).click()

	const bar = slideshowBar(page)

	await expect(bar).toBeVisible()
	await expect(bar.getByText(`1/${String(SLIDES)}`, { exact: true })).toBeVisible()
	// The header steps aside while the slideshow runs.
	await expect(page.getByRole("button", { name: "Slideshow", exact: true })).toHaveCount(0)

	return bar
}

test.describe("preview slideshow", () => {
	test("starts from the header, advances on its own and skips the text file", async ({ page }) => {
		const bar = await openAndStart(page)
		const interval = bar.getByRole("button", { name: "Time per image", exact: true })

		await pickInterval(page, "3 s")

		// Every file shown, in order, sampled far more often than a slide changes.
		const seen: string[] = []

		await expect
			.poll(
				async () => {
					const name = await shownName(page)

					if (name !== "" && seen.at(-1) !== name) {
						seen.push(name)
					}

					return name
				},
				{ timeout: STEP_TIMEOUT_MS * 2, intervals: [200] }
			)
			.toBe(THIRD)

		expect(seen).toEqual([FIRST, SECOND, THIRD])
		expect(seen).not.toContain(TEXT)
		await expect(bar.getByText(`3/${String(SLIDES)}`, { exact: true })).toBeVisible()

		// An Escape that closes the bar's menu leaves the slideshow running (in full screen too, where the browser may
		// take the same Escape). Opened from the keyboard, so focus is inside the menu in every browser.
		await interval.focus()
		await page.keyboard.press("Enter")
		await expect(page.getByRole("menu")).toBeVisible()
		await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="menu"]')))).toBe(true)
		await page.keyboard.press("Escape")
		await expect(page.getByRole("menu")).toHaveCount(0)
		await expect(bar).toHaveCount(1)
		await expect(bar.getByRole("button", { name: "Pause", exact: true })).toHaveCount(1)

		// The interval is remembered on the device: back to the default.
		await pickInterval(page, "5 s")
	})

	test("pauses with Space and resumes", async ({ page }) => {
		const bar = await openAndStart(page)

		await page.keyboard.press("Space")
		await expect(bar.getByRole("button", { name: "Resume", exact: true })).toBeVisible()

		// Past the interval, still on the first slide.
		await page.waitForTimeout(PAUSE_HOLD_MS)
		await expect(previewOf(page, FIRST)).toBeVisible()
		await expect(bar.getByText(`1/${String(SLIDES)}`, { exact: true })).toBeVisible()

		await page.keyboard.press("Space")
		await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible()
		await expect(previewOf(page, SECOND)).toBeVisible({ timeout: STEP_TIMEOUT_MS })
		await expect(bar.getByText(`2/${String(SLIDES)}`, { exact: true })).toBeVisible()
	})

	test("leaving fullscreen ends it and keeps the preview open", async ({ page, browserName }) => {
		test.skip(browserName !== "chromium", "full screen in headless Firefox and WebKit is unproven")

		const bar = await openAndStart(page)

		await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true)
		await page.evaluate(() => document.exitFullscreen())

		await expect(bar).toHaveCount(0)
		await expect(previewOf(page, FIRST)).toBeVisible()
		await expect(previewOf(page, FIRST).getByRole("button", { name: "Slideshow", exact: true })).toBeVisible()
	})
})

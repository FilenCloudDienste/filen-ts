import type { Locator } from "@playwright/test"
import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
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

		const runId = crypto.randomUUID()
		const scratchName = `e2e-marquee-${runId}`
		// Six tiny files — the marquee's targets. enterScratchDirectory already forces a tall viewport, so
		// all six rows mount and expose real bounding boxes for pixel-precise drags below.
		const files = Array.from({ length: 6 }, (_, i) => ({
			name: `marquee-${runId}-${String(i)}.txt`,
			mimeType: "text/plain",
			buffer: Buffer.from(`marquee probe ${String(i)}`)
		}))

		await page.goto("/drive")

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await page.locator('input[type="file"]').first().setInputFiles(files)

			const options = listbox.getByRole("option")
			await expect(options).toHaveCount(6, { timeout: 60_000 }) // cold boot + six real upload round trips

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
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

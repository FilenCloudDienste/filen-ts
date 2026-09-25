import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	bootTo,
	createDirectoryViaDialog,
	descendInto,
	enterScratchDirectory,
	trashScratchDirectory,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Mirrors src/features/drive/lib/springLoad.ts: how long a drag rests on a directory before it opens.
const SPRING_LOAD_DELAY_MS = 2000

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
	const box = await locator.boundingBox()

	if (box === null) {
		throw new Error("no bounding box — the element is not rendered")
	}

	return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Every value the blink attribute takes, in order, recorded in the page — the blink lasts a few hundred
// milliseconds on an element that is gone right after, too brief and too short-lived to poll for.
async function recordBlinks(page: Page): Promise<void> {
	await page.evaluate(() => {
		const recorded: (string | null)[] = []

		Object.assign(window, { __springBlinks: recorded })
		new MutationObserver(records => {
			for (const record of records) {
				if (record.target instanceof Element) {
					recorded.push(record.target.getAttribute("data-spring-blink"))
				}
			}
		}).observe(document.body, { attributes: true, attributeFilter: ["data-spring-blink"], subtree: true })
	})
}

async function recordedBlinks(page: Page): Promise<(string | null)[]> {
	return page.evaluate(() => (window as unknown as { __springBlinks: (string | null)[] }).__springBlinks)
}

// A real mouse drag, not a dispatched event sequence (drive-dnd-move.spec.ts): the question here is
// whether the browser's drag survives the listing it started in being replaced by another, which only a
// drag the browser itself runs can answer.
test.describe("spring-loaded directories", () => {
	test("a drag resting on a directory blinks it, opens it, and drops inside it", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-spring-${runId}`
		const targetDirName = `spring-target-${runId}`
		const fileName = `sprung-${runId}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, targetDirName, listbox)
			await page
				.getByRole("main")
				.locator('input[type="file"]')
				.first()
				.setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("spring-load probe") })

			await expect(listbox.getByRole("option")).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS })

			const fileRow = listbox.getByRole("option", { name: fileName })
			const targetRow = listbox.getByRole("option", { name: targetDirName })
			const from = await centerOf(fileRow)
			const to = await centerOf(targetRow)
			const scratchUrl = page.url()

			await recordBlinks(page)
			await page.mouse.move(from.x, from.y)
			await page.mouse.down()
			await page.mouse.move(to.x, to.y, { steps: 10 })

			// The highlight shows at once; nothing opens before the delay.
			await expect(targetRow).toHaveClass(/ring-primary/)
			const restedAt = Date.now()

			await page.waitForURL(url => url.toString() !== scratchUrl, { timeout: SPRING_LOAD_DELAY_MS + 5_000 })
			expect(Date.now() - restedAt).toBeGreaterThanOrEqual(SPRING_LOAD_DELAY_MS - 250)
			await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText(targetDirName, { exact: true })).toBeVisible()
			expect(await recordedBlinks(page)).toEqual(["off", "on", "off", "on", null])

			// Still dragging: the new, empty listing takes the drag and the drop once it has loaded, and its
			// highlight covers the listing's visible surface, not just the gap above it.
			await waitForListingSettled(page)
			await page.mouse.move(to.x + 4, to.y + 4, { steps: 2 })

			const highlight = await page.getByTestId("listing-drop-highlight").boundingBox()
			const emptyState = await page.getByTestId("listing-empty").boundingBox()

			expect(highlight).not.toBeNull()
			expect(emptyState).not.toBeNull()

			if (highlight !== null && emptyState !== null) {
				expect(highlight.y).toBeLessThanOrEqual(emptyState.y)
				expect(highlight.y + highlight.height).toBeGreaterThanOrEqual(emptyState.y + emptyState.height)
				expect(highlight.height).toBeGreaterThan(200)
			}

			await page.mouse.up()

			const inside = page.getByRole("listbox", { name: "Directory contents" }).getByRole("option", { name: fileName })
			await expect(inside).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	// Files from the system dropped on a directory row upload into that directory, not beside it. The drop
	// is dispatched with a real DataTransfer carrying a File: an OS drag can't be driven from the test.
	test("files from the system dropped on a directory row upload into it", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-osdrop-${runId}`
		const targetDirName = `osdrop-target-${runId}`
		const fileName = `osdropped-${runId}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, targetDirName, listbox)
			await expect(listbox.getByRole("option")).toHaveCount(1)

			// The drag stays in the page between the two calls, so the highlight is read once React has
			// rendered it (a dragenter's update is not flushed inside the event).
			const dropAllowed = await page.evaluate(
				([dirName, name]) => {
					const row = Array.from(document.querySelectorAll('[role="option"]')).find(element =>
						element.textContent.includes(dirName)
					)

					if (row === undefined) {
						throw new Error(`no row contains "${dirName}"`)
					}

					const dataTransfer = new DataTransfer()

					dataTransfer.items.add(new File(["dropped from the system"], name, { type: "text/plain" }))
					Object.assign(window, { __osDrop: { row, dataTransfer } })
					row.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }))

					return !row.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }))
				},
				[targetDirName, fileName] as const
			)

			expect(dropAllowed).toBe(true)
			await expect(listbox.getByRole("option", { name: targetDirName })).toHaveClass(/outline-dashed/)

			await page.evaluate(() => {
				const { row, dataTransfer } = (window as unknown as { __osDrop: { row: Element; dataTransfer: DataTransfer } }).__osDrop

				row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }))
			})

			// Nothing landed beside the directory; the file is inside it.
			await expect(listbox.getByRole("option")).toHaveCount(1)
			await descendInto(page, listbox, targetDirName)

			const nested = await waitForListingSettled(page, LIVE_WRITE_TIMEOUT_MS)
			await expect(nested.listbox.getByRole("option", { name: fileName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

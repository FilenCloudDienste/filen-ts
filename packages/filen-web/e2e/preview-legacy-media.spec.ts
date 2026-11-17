import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { openFixtureRows } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"

// The containers the app demuxes itself (AVI, ASF, MPEG-PS), a transport stream whose MP2 sound FFmpeg decodes, and
// an MP4's second audio track picked from the controls: WebKit switches it in place on its direct stream (no
// MediaSource), every other browser moves it to the ladder.

async function playing(page: Page): Promise<void> {
	const video = page.getByRole("dialog").locator("video")

	await expect(video).toHaveCount(1, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await video.evaluate(el => {
		const element = el as HTMLVideoElement

		element.muted = true
		void element.play().catch(() => undefined)
	})
	await expect
		.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime).catch(() => 0), { timeout: LAZY_VIEWER_TIMEOUT_MS })
		.toBeGreaterThan(0.3)
}

test("AVI, ASF and MPEG-PS files play, and a transport stream's MP2 plays with sound", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const { rows } = await openFixtureRows(page, "preview-legacy-media")

	for (const row of rows) {
		await row.dblclick()
		await playing(page)
		// No "No sound" notice: the sound plays (decoded by FFmpeg where the browser cannot).
		await expect(page.getByRole("dialog").getByText(/^No sound:/)).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0)
	}

	expect(cspViolations).toEqual([])
})

test("picking an MP4's second audio track plays it, in place on WebKit's direct stream", async ({ page, browserName }) => {
	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-audio-tracks")

	await row.dblclick()
	await playing(page)

	const dialog = page.getByRole("dialog")
	const controls = dialog.getByRole("group", { name: "Playback controls" })

	// The tracks are read on the first reach for the controls.
	await controls.hover()
	await controls.getByRole("button", { name: "Audio" }).click()
	await page.getByRole("menuitemradio", { name: /German/ }).click()
	await expect(page.getByRole("menuitemradio", { name: /German/ })).toHaveCount(0)

	const src = await dialog.locator("video").evaluate(el => (el as HTMLVideoElement).currentSrc)

	if (browserName === "webkit") {
		expect(src.startsWith("blob:")).toBe(false)
		await expect
			.poll(() =>
				dialog.locator("video").evaluate(el => {
					const tracks = (el as HTMLVideoElement & { audioTracks?: { length: number; [index: number]: { enabled: boolean } } })
						.audioTracks

					return tracks?.[1]?.enabled ?? false
				})
			)
			.toBe(true)
	}

	await playing(page)
})

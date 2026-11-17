import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { openFixtureRows } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"

// The containers the app demuxes itself (AVI, ASF, MPEG-PS), a transport stream whose MP2 sound FFmpeg decodes, and
// an MP4's second audio track picked from the controls: WebKit switches it in place on its direct stream (no
// MediaSource), every other browser moves it to the ladder.

// Plays the dialog's video until `seconds` of it have played.
async function playing(page: Page, seconds = 0.3): Promise<void> {
	const video = page.getByRole("dialog").locator("video")

	await expect(video).toHaveCount(1, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await video.evaluate(el => {
		const element = el as HTMLVideoElement

		element.muted = true
		void element.play().catch(() => undefined)
	})
	await expect
		.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime).catch(() => 0), { timeout: LAZY_VIEWER_TIMEOUT_MS })
		.toBeGreaterThan(seconds)
}

test("AVI, ASF and MPEG-PS files play, and a transport stream's MP2 plays with sound", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const { rows } = await openFixtureRows(page, "preview-legacy-media")

	for (const row of rows) {
		await row.dblclick()
		// No "No sound" notice once a second and a half has played, past where a silent track is found out: the sound
		// plays (decoded by FFmpeg where the browser cannot).
		await playing(page, 1.5)
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

	const video = dialog.locator("video")

	if (browserName === "webkit") {
		await expect
			.poll(() =>
				video.evaluate(el => {
					const tracks = (el as HTMLVideoElement & { audioTracks?: { length: number; [index: number]: { enabled: boolean } } })
						.audioTracks

					return tracks?.[1]?.enabled ?? false
				})
			)
			.toBe(true)
	}

	// Played on a while after the pick, which a move to the ladder would have made by then.
	const at = await video.evaluate(el => (el as HTMLVideoElement).currentTime)

	await playing(page, at + 1)

	if (browserName === "webkit") {
		// Still the direct stream: no MediaSource took it over.
		expect(await video.evaluate(el => (el as HTMLVideoElement).currentSrc.startsWith("blob:"))).toBe(false)
	}

	// The pick holds, whichever way the browser plays it.
	await controls.hover()
	await controls.getByRole("button", { name: "Audio" }).click()
	await expect(page.getByRole("menuitemradio", { name: /German/ })).toHaveAttribute("aria-checked", "true")
	await page.keyboard.press("Escape")
})

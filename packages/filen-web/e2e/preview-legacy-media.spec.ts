import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS, setDesktopViewport } from "./helpers/listing"
import { openFixtureRows } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"

// The containers the app demuxes itself (AVI, ASF, MPEG-PS), a transport stream whose MP2 sound FFmpeg decodes, and
// an MP4's second audio track picked from the controls: WebKit switches it in place on its direct stream (no
// MediaSource), every other browser moves it to the ladder. WebKit's Linux build (GStreamer) can stall on the in-place
// switch; the preview then moves it to the ladder too, which is what a user there gets.

// Seconds the element has played since `reset`, summed from its timeupdates: a loop back or a seek adds nothing. The
// clips loop every two or three seconds, so a sampled currentTime can keep landing early in the clip (a poll period
// close to half a loop) however long it plays.
function playedSeconds(video: Locator, reset = false): Promise<number> {
	return video
		.evaluate((el, fresh) => {
			const element = el as HTMLVideoElement & { e2ePlayed?: { total: number; last: number } }

			if (element.e2ePlayed === undefined) {
				element.addEventListener("timeupdate", () => {
					const state = element.e2ePlayed

					if (state !== undefined) {
						const delta = element.currentTime - state.last

						state.last = element.currentTime
						state.total += !element.seeking && delta > 0 && delta < 1 ? delta : 0
					}
				})
			}

			if (fresh || element.e2ePlayed === undefined) {
				element.e2ePlayed = { total: 0, last: element.currentTime }
			}

			return element.e2ePlayed.total
		}, reset)
		.catch(() => 0)
}

// Plays the dialog's video until `seconds` of it have played.
async function playing(page: Page, seconds = 0.3): Promise<void> {
	const video = page.getByRole("dialog").locator("video")

	await expect(video).toHaveCount(1, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await playedSeconds(video, true)
	await video.evaluate(el => {
		const element = el as HTMLVideoElement

		element.muted = true
		void element.play().catch(() => undefined)
	})
	await expect.poll(() => playedSeconds(video), { timeout: LAZY_VIEWER_TIMEOUT_MS }).toBeGreaterThan(seconds)
}

test("AVI, ASF and MPEG-PS files play, and a transport stream's MP2 plays with sound", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const { rows } = await openFixtureRows(page, "preview-legacy-media")

	await setDesktopViewport(page)

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

test("picking an MP4's second audio track plays it, in place on WebKit's direct stream", async ({ page, browserName }, testInfo) => {
	const warnings: string[] = []

	page.on("console", message => {
		if (message.type() === "warning") {
			warnings.push(message.text())
		}
	})
	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-audio-tracks")

	await setDesktopViewport(page)
	await row.dblclick()
	await playing(page)

	const dialog = page.getByRole("dialog")
	const controls = dialog.getByRole("group", { name: "Playback controls" })

	// The tracks are read on the first reach for the controls.
	await controls.hover()
	await controls.getByRole("button", { name: "Audio" }).click()
	await page.getByRole("menuitemradio", { name: /German/ }).click()
	// The menu stays open on a pick, which it marks; Escape closes it.
	await expect(page.getByRole("menuitemradio", { name: /German/ })).toHaveAttribute("aria-checked", "true")
	await page.keyboard.press("Escape")
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

	// Played on a second after the pick, which a move to the ladder would have made by then.
	await playedSeconds(video, true)
	await expect.poll(() => playedSeconds(video), { timeout: LAZY_VIEWER_TIMEOUT_MS }).toBeGreaterThan(1)

	if (browserName === "webkit") {
		// Still the direct stream, unless the switch stalled and the preview moved it to the ladder (MediaSource).
		const laddered = await video.evaluate(el => (el as HTMLVideoElement).currentSrc.startsWith("blob:"))

		testInfo.annotations.push({ type: "audio track switch", description: laddered ? "stalled, moved to the ladder" : "in place" })

		if (laddered) {
			expect(warnings.some(text => text.includes("stalled on an audio track switch"))).toBe(true)
		}
	}

	// The pick holds, whichever way the browser plays it.
	await controls.hover()
	await controls.getByRole("button", { name: "Audio" }).click()
	await expect(page.getByRole("menuitemradio", { name: /German/ })).toHaveAttribute("aria-checked", "true")
	await page.keyboard.press("Escape")
})

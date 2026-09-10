import { test, expect } from "./fixtures"
import { SW_DOWNLOAD_PREFIX } from "@/lib/sw/protocol"
import { enterFixtureDirectory, FIXTURE_FILES } from "./helpers/fixtures"
import { waitForSwReady } from "./helpers/sw"
import { trackCspViolations } from "./helpers/csp"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// The one live proof the streamed-preview architecture actually works: a service worker is PROD-only
// (never registered under `vite dev`), so this only ever runs against
// `npm run build && npm run preview` (playwright.config.ts's webServer). Proves, against the real SW
// route: an <img> is served by it (not the buffered blob: fallback), a <video> plays AND a mid-file
// seek gets answered with a fresh 206/Content-Range (proving Range/seek actually works, not just an
// initial full-file GET), a drive <audio> file hands off to the persistent player and streams over
// that same route, every one of those responses is INLINE (no
// Content-Disposition: attachment — this is a preview, never a download), and the whole run produces
// zero CSP console violations (media-src's own acceptance check). The mp4 fixture is a real,
// faststart-muxed H.264 clip large enough (moov ends ~3 KB in, ~110 KB of mdat follows) that an
// initial `preload="metadata"` fetch cannot plausibly cover the whole file — a mid-file seek is
// guaranteed to need bytes beyond it. Every fixture here is read from the shared read-only tree the
// fixtures-setup project builds (helpers/fixtures.ts), so this spec performs no drive writes at all.

interface SwResponseLog {
	status: number
	contentType: string | null
	contentRange: string | null
	disposition: string | null
}

test("image/video/audio previews stream over the SW's inline route: range-seekable, inline, allowlisted Content-Type, zero CSP violations", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	// Destructured in the scenario's own nameAsc order (mp3 < mp4 < png) — that order is the reason the
	// video sits at the MIDDLE pager index, which the ArrowRight leg below depends on.
	const [nameAudio, nameVideo, nameImage] = FIXTURE_FILES["preview-media"]

	const swResponses: SwResponseLog[] = []

	page.on("response", res => {
		if (res.url().includes(SW_DOWNLOAD_PREFIX)) {
			const headers = res.headers()

			swResponses.push({
				status: res.status(),
				contentType: headers["content-type"] ?? null,
				contentRange: headers["content-range"] ?? null,
				disposition: headers["content-disposition"] ?? null
			})
		}
	})
	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	const { listbox } = await enterFixtureDirectory(page, "preview-media")
	await waitForSwReady(page)

	const rowImage = listbox.getByRole("option", { name: nameImage })
	const rowVideo = listbox.getByRole("option", { name: nameVideo })
	const rowAudio = listbox.getByRole("option", { name: nameAudio })
	await expect(rowImage).toBeVisible({ timeout: 45_000 })
	await expect(rowVideo).toBeVisible({ timeout: 45_000 })
	await expect(rowAudio).toBeVisible({ timeout: 45_000 })

	// ---- image leg: <img> served by the SW's inline route, not the buffered blob: fallback ----
	await rowImage.dblclick()
	const img = page.getByRole("img", { name: nameImage })
	await expect(img).toBeVisible({ timeout: 30_000 })

	const imgSrc = await img.getAttribute("src")
	expect(imgSrc).toMatch(new RegExp(`^${SW_DOWNLOAD_PREFIX}`))

	const imageResponse = swResponses.find(r => r.contentType === "image/png")
	expect(imageResponse?.status).toBe(200)
	expect(imageResponse?.disposition).toBeNull()

	await page.keyboard.press("Escape")
	await expect(img).toHaveCount(0)

	// ---- video leg: <video> plays; the SW route answers an explicit mid-file Range with a matching
	// 206/Content-Range; inline, never attachment. The viewer autoplays on mount, and this fixture is
	// small enough that autoplay's own forward readahead can fully buffer the clip before the test
	// ever gets a turn — at that point ANY currentTime the test picks is already resident in the
	// element's own buffered ranges, so a currentTime-driven seek proves nothing about the network
	// layer (no request happens either way). A direct fetch() against the exact URL the <video> is
	// already using, with an explicit Range header, proves the SW route's Range/206 support
	// deterministically instead — same registration (the SW keeps a download registration alive
	// across multiple GETs, sw.ts's own registerPendingDownload comment: "the id must also survive
	// every GET"), so this is a realistic concurrent read against the same stream the element uses,
	// not a side channel. ----
	await rowVideo.dblclick()
	const video = page.locator("video")
	await expect(video).toBeVisible({ timeout: 30_000 })
	await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).duration || 0), { timeout: 30_000 }).toBeGreaterThan(0)

	// currentSrc resolves to an absolute URL (unlike the image leg's raw src attribute above), so this
	// checks containment rather than an anchored prefix.
	const videoSrc = await video.evaluate(el => (el as HTMLVideoElement).currentSrc)
	expect(videoSrc).toContain(SW_DOWNLOAD_PREFIX)

	const rangeProbe = await page.evaluate(async url => {
		const res = await fetch(url, { headers: { Range: "bytes=65536-" } })

		return {
			status: res.status,
			contentRange: res.headers.get("content-range"),
			contentType: res.headers.get("content-type"),
			disposition: res.headers.get("content-disposition")
		}
	}, videoSrc)

	expect(rangeProbe.status).toBe(206)
	expect(rangeProbe.contentRange).toMatch(/^bytes 65536-/)
	expect(rangeProbe.disposition).toBeNull()
	expect(rangeProbe.contentType).toBe("video/mp4")

	await video.evaluate(el => {
		const videoEl = el as HTMLVideoElement

		videoEl.muted = true
		videoEl.currentTime = Math.max(1, (videoEl.duration || 2) / 2)
	})
	await video.evaluate(el => (el as HTMLVideoElement).play())
	await expect.poll(() => video.evaluate(el => !(el as HTMLVideoElement).paused), { timeout: 15_000 }).toBe(true)

	// ---- a focused native scrubber owns ArrowRight as a seek — the overlay's pager must not steal
	// it. nameAsc sort (mp3 < mp4 < png) puts the video at the MIDDLE pager index, so Next is enabled
	// and a real pager advance (a regression) would be observable as the heading switching to the
	// image. getByText (raw textContent) rather than getByRole("heading", {name}) — PreviewName
	// splits the filename across two sibling <span>s for its own ellipsis styling, and the
	// accessible-NAME computation (unlike textContent) joins separate elements with an inserted
	// space, breaking a name match right at the split point. ----
	await expect(page.getByRole("button", { name: "Next file" })).toBeEnabled()
	const heading = page.getByRole("dialog").getByText(nameVideo)
	await expect(heading).toBeVisible()
	// Paused first, and the seek asserted POSITIVELY: while the clip is playing currentTime climbs on its
	// own, so an advance would prove nothing, and "the heading is still there" is instantly true whether
	// the scrubber consumed the key or nothing did at all. Paused, only a real seek moves the playhead.
	await video.evaluate(el => {
		const videoEl = el as HTMLVideoElement

		videoEl.pause()
		videoEl.focus()
	})
	await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).paused), { timeout: 15_000 }).toBe(true)

	const timeBeforeSeek = await video.evaluate(el => (el as HTMLVideoElement).currentTime)

	await page.keyboard.press("ArrowRight")
	await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime), { timeout: 15_000 }).toBeGreaterThan(timeBeforeSeek)
	await expect(heading).toBeVisible()

	// ---- a resolved stream that fails MID-CONSUMPTION (network drop, an SW-side decrypt abort, a
	// lifecycle hiccup) — never just a registration failure — must still recover, not strand the
	// browser's own broken-media state on screen. Swapping to a same-prefix, never-registered id and
	// forcing a reload reproduces exactly that: handleDownload (sw.ts) 404s any unknown id the same
	// way an aborted/expired one would. Reuses the `video` locator across the ensuing React remount
	// (StreamedMedia -> BufferedMedia) rather than a stale element handle. ----
	await video.evaluate((el, prefix) => {
		const videoEl = el as HTMLVideoElement

		videoEl.src = `${prefix}e2e-stream-failure-probe`
		videoEl.load()
	}, SW_DOWNLOAD_PREFIX)

	// Caught per attempt: expect.poll awaits its callback OUTSIDE the try it retries on, so an element
	// detached mid-poll throws straight out of the poll instead of being retried — and the remount this
	// leg is waiting for is exactly that detachment.
	await expect
		.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentSrc).catch(() => null), { timeout: 30_000 })
		.toMatch(/^blob:/)
	await expect
		.poll(() => video.evaluate(el => (el as HTMLVideoElement).duration || 0).catch(() => 0), { timeout: 30_000 })
		.toBeGreaterThan(0)

	await page.keyboard.press("Escape")
	await expect(video).toHaveCount(0)

	// ---- audio leg: a drive audio double-click no longer opens the overlay — it hands off to the
	// persistent player, whose engine streams the file over the SAME SW inline route the overlay used.
	// That engine's <audio> element lives detached from the document (created in JS, never mounted in
	// JSX), so the proof shifts off the element and onto the docked player bar plus the SW response
	// itself: no dialog opens, the bar reaches a real playing state, and the route still serves
	// audio/mpeg INLINE (no attachment), exactly as the retired overlay arm did. ----
	const bar = page.getByRole("region", { name: "Audio player" })
	await expect(bar).toHaveCount(0)

	await rowAudio.dblclick()
	await expect(bar).toBeVisible({ timeout: 30_000 })
	await expect(page.getByRole("dialog")).toHaveCount(0)
	// [title=…]: the bar renders the track name middle-ellipsized into split spans, so the full
	// name is only reliably present on the title-attribute tooltip, never as one text node.
	await expect(bar.locator(`[title="${nameAudio}"]`)).toBeVisible()

	// A real playing state over the SW stream: the transport shows Pause and the seek slider advances as
	// the decoded file plays (dblclick is a user gesture, so play() is permitted — MP3 has no upfront
	// container metadata the way faststart mp4 does, so a playhead advance, not a Range-on-seek, is the
	// reliable playback signal here).
	await expect(bar.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 })
	const audioSeek = bar.getByRole("slider", { name: "Seek" })
	const audioStart = Number(await audioSeek.inputValue())
	await expect.poll(async () => Number(await audioSeek.inputValue()), { timeout: 15_000 }).toBeGreaterThan(audioStart)

	const audioResponse = swResponses.find(r => r.contentType === "audio/mpeg")
	expect(audioResponse?.disposition).toBeNull()

	// Clearing the queue retires the bar — the shell renders it only for a non-empty queue.
	await bar.getByRole("button", { name: "Show queue" }).click()
	await page.getByRole("button", { name: "Clear queue", exact: true }).click()
	await expect(bar).toHaveCount(0, { timeout: 15_000 })

	expect(cspViolations).toEqual([])
})

import type { Locator, Page } from "@playwright/test"
import { SW_DOWNLOAD_PREFIX } from "@/lib/sw/protocol"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { waitForSwReady } from "./helpers/sw"

// Synthesized audio in the preview, from the shared read-only tree only: tracker modules rendered by the libopenmpt
// build (a 15-sample MOD named by its row alone) and a MIDI song rendered with the bundled SoundFont, each a decoded
// WAV stream the service worker serves; and a `.mod` that is really an MPEG program stream opening as video. Nothing
// is fetched from another host: the SoundFont comes from the app's own /assets/.

const SYNTH = FIXTURE_FILES["preview-synth"]
const [CAMCORDER] = FIXTURE_FILES["preview-mod-video"]

async function playsDecoded(page: Page, row: Locator): Promise<void> {
	await row.dblclick()

	const audio = page.getByRole("dialog").locator("audio")

	await expect(audio).toHaveCount(1, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect
		.poll(() => audio.evaluate(el => (el as HTMLAudioElement).currentSrc), { timeout: LAZY_VIEWER_TIMEOUT_MS })
		.toContain(SW_DOWNLOAD_PREFIX)
	await audio.evaluate(el => {
		const element = el as HTMLAudioElement

		element.muted = true
		void element.play().catch(() => undefined)
	})
	await expect
		.poll(() => audio.evaluate(el => (el as HTMLAudioElement).currentTime), { timeout: LAZY_VIEWER_TIMEOUT_MS })
		.toBeGreaterThan(0.3)

	await page.keyboard.press("Escape")
	await expect(page.getByRole("dialog")).toHaveCount(0)
}

test("tracker modules and a MIDI song play as decoded streams, with nothing fetched from elsewhere", async ({
	page,
	context,
	browserName
}) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: true })
	const soundFonts: string[] = []

	context.on("request", request => {
		if (request.url().endsWith(".sf3")) {
			soundFonts.push(request.url())
		}
	})

	await bootTo(page)

	const { rows } = await openFixtureRows(page, "preview-synth")

	await waitForSwReady(page)

	for (const [index] of SYNTH.entries()) {
		const row = rows[index]

		if (row !== undefined) {
			await playsDecoded(page, row)
		}
	}

	// The bank is the app's own. Chromium reports a nested worker's requests, so there it must have been seen; elsewhere
	// the engine may hide them, and the strict foreign-request check above stands in.
	if (browserName === "chromium") {
		expect(soundFonts.length).toBeGreaterThan(0)
	}

	for (const url of soundFonts) {
		expect(new URL(url).origin).toBe(new URL(page.url()).origin)
		expect(new URL(url).pathname).toMatch(/^\/assets\//)
	}

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("a .mod whose head is an MPEG program stream opens as video", async ({ page }) => {
	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-mod-video")

	await row.dblclick()
	await expect(page.getByRole("dialog").locator("video")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("dialog").getByText(CAMCORDER)).toBeVisible()
})

import type { Locator, Page } from "@playwright/test"
import { SW_DOWNLOAD_PREFIX } from "@/lib/sw/protocol"
import { test, expect, settleLeases } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { closeLinkDialog, createLink, openLinkDialog } from "./helpers/publicLinks"
import { tinyMod } from "@/tests/support/trackerModules"
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

// `audio` plays the decoded WAV stream the service worker serves, a third of a second of it at least.
async function playsStream(audio: Locator): Promise<void> {
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
}

// A MIDI song of `notes` piano notes, an eighth apart at 120 BPM.
function midiSong(notes: number): Buffer {
	const events = [0x00, 0xc0, 0x00]

	for (let i = 0; i < notes; i++) {
		events.push(...(i === 0 ? [0x00] : [0x01]), 0x90, 60 + (i % 12), 100, 0x81, 0x6f, 0x80, 60 + (i % 12), 0)
	}

	events.push(0x00, 0xff, 0x2f, 0x00)

	const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b]
	const length = [events.length >>> 24, (events.length >> 16) & 0xff, (events.length >> 8) & 0xff, events.length & 0xff]

	return Buffer.from([...header, ...length, ...events])
}

async function playsDecoded(page: Page, row: Locator): Promise<void> {
	await row.dblclick()
	await playsStream(page.getByRole("dialog").locator("audio"))

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

test.describe("public links", () => {
	test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account (E2E_PREMIUM)")

	test("a link's MIDI song and tracker module play without a session, with nothing fetched from elsewhere", async ({ page, context }) => {
		test.slow()

		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "synth-links", async ({ listbox, runId }) => {
			const files = [
				{ name: `e2e-link-${runId}.mid`, mimeType: "audio/midi", buffer: midiSong(8) },
				{ name: `e2e-link-${runId}.mod`, mimeType: "audio/x-mod", buffer: Buffer.from(tinyMod(31, true)) }
			]

			await uploadFiles(page, files, listbox)

			const links: string[] = []

			for (const { name } of files) {
				const dialog = await openLinkDialog(page, listbox, name)

				links.push(await createLink(dialog))
				await closeLinkDialog(page, dialog)
			}

			// From here on only the link pages load: anything they fetch off the app's origin is a failure.
			const foreign = trackForeignRequests(context, { strictPreview: true })

			try {
				for (const link of links) {
					await settleLeases(page)
					await page.goto(link)
					await waitForSwReady(page)
					await playsStream(page.locator("audio"))
				}
			} finally {
				// Back on the drive for the scratch directory's teardown (a link page has no sidebar).
				await bootTo(page)
			}

			expect(foreign).toEqual([])
		})

		expect(cspViolations).toEqual([])
	})
})

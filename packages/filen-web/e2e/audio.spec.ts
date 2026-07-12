import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// The drive → persistent-player handoff, end to end: double-clicking a drive audio file enqueues the
// folder's audio siblings and starts the docked player (no preview overlay), and every transport
// control drives real playback of a real decoded file. Runs inside a per-run scratch directory (the
// downloads.spec.ts convention) so parallel specs never race a root-level create/trash.
test.describe.configure({ mode: "default" })

// A valid, tiny PCM WAV of pure silence — 8 kHz, 16-bit, mono. Small (sub-100 KB) but a real container
// Chromium decodes with an honest duration, so the scrubber/timeupdate assertions exercise genuine
// playback rather than a hand-rolled byte string. Duration is caller-chosen so two fixtures differ.
function makeSilentWav(seconds: number): Buffer {
	const sampleRate = 8_000
	const numSamples = sampleRate * seconds
	const dataSize = numSamples * 2
	const buffer = Buffer.alloc(44 + dataSize)

	buffer.write("RIFF", 0, "ascii")
	buffer.writeUInt32LE(36 + dataSize, 4)
	buffer.write("WAVE", 8, "ascii")
	buffer.write("fmt ", 12, "ascii")
	buffer.writeUInt32LE(16, 16) // PCM fmt chunk size
	buffer.writeUInt16LE(1, 20) // audioFormat = PCM
	buffer.writeUInt16LE(1, 22) // mono
	buffer.writeUInt32LE(sampleRate, 24)
	buffer.writeUInt32LE(sampleRate * 2, 28) // byteRate
	buffer.writeUInt16LE(2, 32) // blockAlign
	buffer.writeUInt16LE(16, 34) // bitsPerSample
	buffer.write("data", 36, "ascii")
	buffer.writeUInt32LE(dataSize, 40)
	// Sample bytes are left zero-filled — silence, which decodes and plays exactly like any other PCM.

	return buffer
}

const WAV_A = makeSilentWav(4)
const WAV_B = makeSilentWav(3)

test("drive audio double-click hands off to the persistent player and transport works", async ({ page, injectedSession, browserName }) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const cspViolations = trackCspViolations(page)
	const runId = crypto.randomUUID()
	const scratchName = `e2e-audio-${runId}`
	// Names chosen so the default ascending sort puts A before B — the queue order the handoff derives.
	const nameA = `e2e-audio-a-${runId}.wav`
	const nameB = `e2e-audio-b-${runId}.wav`

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([
			{ name: nameA, mimeType: "audio/wav", buffer: WAV_A },
			{ name: nameB, mimeType: "audio/wav", buffer: WAV_B }
		])

		const rowA = listbox.getByRole("option", { name: nameA })
		const rowB = listbox.getByRole("option", { name: nameB })
		await expect(rowA).toBeVisible({ timeout: 60_000 })
		await expect(rowB).toBeVisible({ timeout: 60_000 })

		// The player bar is absent until a queue exists.
		const bar = page.getByRole("region", { name: "Audio player" })
		await expect(bar).toHaveCount(0)

		// Double-click the first audio file: it hands off to the player (no preview overlay opens).
		await rowA.dblclick()

		await expect(bar).toBeVisible({ timeout: 30_000 })
		await expect(page.getByRole("dialog")).toHaveCount(0) // no preview overlay for audio
		await expect(bar.getByText(nameA)).toBeVisible()

		// Reaches a real playing state: the toggle shows Pause, and the seek position advances as the
		// decoded file plays (proving genuine playback, not just a mounted control).
		const pauseButton = bar.getByRole("button", { name: "Pause" })
		await expect(pauseButton).toBeVisible({ timeout: 30_000 })

		const seek = bar.getByRole("slider", { name: "Seek" })
		await expect(seek).toBeEnabled({ timeout: 30_000 })

		const startValue = Number(await seek.inputValue())
		await expect.poll(async () => Number(await seek.inputValue()), { timeout: 15_000 }).toBeGreaterThan(startValue)

		// Next switches to the second track.
		await bar.getByRole("button", { name: "Next track" }).click()
		await expect(bar.getByText(nameB)).toBeVisible({ timeout: 30_000 })

		// Previous (early in the track, before the smart-previous restart threshold) steps back to the first.
		await bar.getByRole("button", { name: "Previous track" }).click()
		await expect(bar.getByText(nameA)).toBeVisible({ timeout: 30_000 })

		// Scrubber seek: pause for a stable readout, then nudge the slider forward one step and confirm the
		// position jumps to the seeked point.
		await pauseButton.click()
		await expect(bar.getByRole("button", { name: "Play" })).toBeVisible()

		const beforeSeek = Number(await seek.inputValue())
		await seek.focus()
		await seek.press("ArrowRight")
		await expect.poll(async () => Number(await seek.inputValue()), { timeout: 10_000 }).toBeGreaterThan(beforeSeek)

		// Clearing the queue from the now-playing panel hides the bar.
		await bar.getByRole("button", { name: "Show queue" }).click()
		await page.getByRole("button", { name: "Clear queue", exact: true }).click()
		await expect(bar).toHaveCount(0, { timeout: 15_000 })

		expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toHaveLength(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

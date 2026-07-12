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

// Playlist CRUD end to end: create, add the 2 scratch tracks via the drive picker, drag-reorder, play
// (the bar shows the reordered first track), then delete through the UI. Net-zero on the shared
// account: everything created here (the two audio files, the playlist itself) is removed by the end —
// the `.filen/Playlists` directory the app lazily creates is left behind, which is acceptable app
// infrastructure (mirrors mobile leaving it too).
test("playlists: create, add tracks via the picker, reorder, play, and delete", async ({ page, injectedSession, browserName }) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const cspViolations = trackCspViolations(page)
	const runId = crypto.randomUUID()
	const scratchName = `e2e-playlist-${runId}`
	const nameA = `e2e-playlist-a-${runId}.wav`
	const nameB = `e2e-playlist-b-${runId}.wav`
	// Deliberately distinct from scratchName: an identical string for both the scratch directory and
	// the playlist would make every name-scoped locator below ambiguous between a drive row and a
	// playlist row.
	const playlistName = `e2e-playlist-mix-${runId}`

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

		// The now-playing panel (and its Playlists tab) is only reachable through the player bar, which
		// only renders once a queue exists — open a track first, purely to surface it.
		await rowA.dblclick()

		const bar = page.getByRole("region", { name: "Audio player" })
		await expect(bar).toBeVisible({ timeout: 30_000 })

		// The now-playing panel is a Popover, itself `role="dialog"` (Base UI's PopoverPopup) — every
		// dialog locator below is scoped by its own DialogTitle-derived accessible NAME so it can never
		// resolve to the still-open popover instead of the intended nested Dialog.
		await bar.getByRole("button", { name: "Show queue" }).click()
		await page.getByRole("tab", { name: "Playlists" }).click()

		await page.getByRole("button", { name: "New playlist" }).click()
		const createDialog = page.getByRole("dialog", { name: "New playlist" })
		await expect(createDialog).toBeVisible()
		await createDialog.getByLabel("Name", { exact: true }).fill(playlistName)
		await createDialog.getByRole("button", { name: "Create", exact: true }).click()
		await expect(createDialog).toHaveCount(0)

		// Open the new playlist's detail dialog. Scoped to the specific row: the shared account can carry
		// other playlists from unrelated runs, so a page-wide role query risks a strict-mode ambiguity.
		const playlistRow = page.getByRole("listitem").filter({ hasText: playlistName })
		await playlistRow.getByRole("button", { name: playlistName }).click()
		const detailDialog = page.getByRole("dialog", { name: playlistName })
		await expect(detailDialog).toBeVisible()

		// Add both scratch tracks via the picker.
		await detailDialog.getByRole("button", { name: "Add tracks" }).click()
		const pickerDialog = page.getByRole("dialog", { name: "Add tracks" })
		await expect(pickerDialog).toBeVisible()
		await pickerDialog.getByRole("button", { name: scratchName }).click()
		const pickerRowA = pickerDialog.getByRole("button", { name: nameA })
		const pickerRowB = pickerDialog.getByRole("button", { name: nameB })
		await expect(pickerRowA).toBeVisible({ timeout: 30_000 })
		await pickerRowA.click()
		await pickerRowB.click()
		await pickerDialog.getByRole("button", { name: "Add 2 tracks" }).click()
		await expect(pickerDialog).toHaveCount(0)

		const trackRowA = detailDialog.getByText(nameA)
		const trackRowB = detailDialog.getByText(nameB)
		await expect(trackRowA).toBeVisible()
		await expect(trackRowB).toBeVisible()

		// Drag B above A — the reordered list feeds "Play" below, proving the reorder actually persisted
		// (not just a local optimistic reshuffle).
		await trackRowB.dragTo(trackRowA)
		await expect(detailDialog.locator("li").first().getByText(nameB)).toBeVisible({ timeout: 15_000 })

		await detailDialog.getByRole("button", { name: "Play", exact: true }).click()

		// The detail dialog's modal focus trap marks the rest of the page (including the player bar)
		// `aria-hidden` while it's open — playback genuinely starts underneath, but role-based queries
		// can't see it until the dialog closes. Close it first, then assert on the bar.
		await page.keyboard.press("Escape")
		await expect(detailDialog).toHaveCount(0)
		await expect(bar.getByText(nameB)).toBeVisible({ timeout: 30_000 })

		await playlistRow.getByRole("button", { name: "Playlist options" }).click()
		await page.getByRole("menuitem", { name: "Delete" }).click()
		await page.getByRole("alertdialog", { name: "Delete playlist" }).getByRole("button", { name: "Delete", exact: true }).click()
		await expect(playlistRow).toHaveCount(0, { timeout: 15_000 })

		await page.getByRole("tab", { name: "Queue" }).click()
		await page.getByRole("button", { name: "Clear queue", exact: true }).click()
		await expect(bar).toHaveCount(0, { timeout: 15_000 })

		expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toHaveLength(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

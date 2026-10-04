import { test, expect } from "./fixtures"
import {
	withScratchDirectory,
	bootTo,
	enterScratchDirectory,
	trashScratchDirectory,
	dismissOverlays,
	LIVE_WRITE_TIMEOUT_MS,
	uploadFiles
} from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { html5DragMove } from "./helpers/dnd"

// The drive → persistent-player handoff, end to end: double-clicking a drive audio file enqueues the
// folder's audio siblings and starts the docked player (no preview overlay), and every transport
// control drives real playback of a real decoded file. Runs inside a per-run scratch directory (the
// downloads.spec.ts convention) so parallel specs never race a root-level create/trash.
test.describe.configure({ mode: "default" })

// A valid PCM WAV of pure silence — 8 kHz, 16-bit, mono, so a minute of it costs ~940 KB. A real
// container Chromium decodes with an honest duration, so the scrubber/timeupdate assertions exercise
// genuine playback rather than a hand-rolled byte string.
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

// A minute each, not seconds. The transport leg below switches to the second track and then reads,
// pauses and seeks its scrubber — a track that ENDS underneath that leaves the player at end of queue
// with no duration, where the scrubber is disabled (audioPlayerBar.tsx) and every assertion on it burns
// its whole timeout against a player that is behaving correctly.
const WAV_A = makeSilentWav(60)
const WAV_B = makeSilentWav(60)

test("drive audio double-click hands off to the persistent player and transport works", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "audio", async ({ listbox, runId }) => {
		// Names chosen so the default ascending sort puts A before B — the queue order the handoff derives.
		const nameA = `e2e-audio-a-${runId}.wav`
		const nameB = `e2e-audio-b-${runId}.wav`

		await uploadFiles(
			page,
			[
				{ name: nameA, mimeType: "audio/wav", buffer: WAV_A },
				{ name: nameB, mimeType: "audio/wav", buffer: WAV_B }
			],
			listbox
		)

		const rowA = listbox.getByRole("option", { name: nameA })

		// The player bar is absent until a queue exists.
		const bar = page.getByRole("region", { name: "Audio player" })
		await expect(bar).toHaveCount(0)

		// Double-click the first audio file: it hands off to the player (no preview overlay opens).
		await rowA.dblclick()

		await expect(bar).toBeVisible({ timeout: 30_000 })
		await expect(page.getByRole("dialog")).toHaveCount(0) // no preview overlay for audio

		// The bar's title element renders through MiddleEllipsis, which JS-truncates the visible text for
		// long names — so assert on its untouched `title` attribute rather than a substring match against
		// the (possibly truncated) rendered text. These WAV fixtures also carry no ID3/tag metadata, so
		// this doubles as proof the metadata step's extraction degrades silently to filename-only rather
		// than truncating/mangling/blanking the name on a failed tag read.
		await expect(bar.locator(`[title="${nameA}"]`)).toBeVisible()

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
		await expect(bar.locator(`[title="${nameB}"]`)).toBeVisible({ timeout: 30_000 })

		// Previous RESTARTS the current track rather than stepping back once the position is past
		// audioQueue.ts's SMART_PREVIOUS_THRESHOLD_MS (3s), so the press only means "step back" from a position
		// this leg itself puts back under it — it does not lean on the fixture being shorter than the threshold.
		// Pause first, or playback walks the readout past the threshold again between the seek and the press,
		// then seek to the start and read it back: Home on a range input is its min, which the input's own
		// onChange turns into a real seek(0). A track switch also clears the duration until the new track's
		// metadata lands, and the scrubber is inert (disabled, and `press` does not wait on that) until it does.
		await expect(seek).toBeEnabled({ timeout: 30_000 })
		await pauseButton.click()
		await expect(bar.getByRole("button", { name: "Play" })).toBeVisible()
		await expect(async () => {
			await seek.press("Home")
			expect(Number(await seek.inputValue())).toBeLessThan(1_000)
		}).toPass({ timeout: 10_000 })

		await bar.getByRole("button", { name: "Previous track" }).click()
		await expect(bar.locator(`[title="${nameA}"]`)).toBeVisible({ timeout: 30_000 })

		// Scrubber seek: pause for a stable readout, then nudge the slider forward one step and confirm the
		// position jumps to the seeked point. skipPrevious loads AND plays, so the bar is playing again
		// here regardless of the pause above.
		await expect(seek).toBeEnabled({ timeout: 30_000 })
		await pauseButton.click()
		await expect(bar.getByRole("button", { name: "Play" })).toBeVisible()

		const beforeSeek = Number(await seek.inputValue())
		await seek.focus()
		await seek.press("ArrowRight")
		await expect.poll(async () => Number(await seek.inputValue()), { timeout: 10_000 }).toBeGreaterThan(beforeSeek)

		// Clearing the queue from the now-playing panel hides the bar. The panel is queue-only now
		// (playlists moved to their own /playlists screen — see the playlist test below), so opening it
		// here doubles as proof no tab bar survived: no tablist role, no Playlists tab.
		await bar.getByRole("button", { name: "Show queue" }).click()
		// The panel's own content FIRST: both negatives below are vacuously true against a panel that
		// never opened, so nothing after this is worth anything until the popover is proven mounted.
		const clearQueue = page.getByRole("button", { name: "Clear queue", exact: true })
		await expect(clearQueue).toBeVisible()
		await expect(page.getByRole("tablist")).toHaveCount(0)
		await expect(page.getByRole("tab", { name: "Playlists" })).toHaveCount(0)
		await clearQueue.click()
		await expect(bar).toHaveCount(0, { timeout: 15_000 })

		expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toHaveLength(0)
	})
})

// Playlist CRUD end to end: create, add the 2 scratch tracks via the drive picker, drag-reorder, play
// (the bar shows the reordered first track), then delete through the UI. Reaches playlists through the
// rail's dedicated /playlists entry (no queue-seeding preamble needed — the dedicated entry exists exactly
// so playlists are reachable without a playing queue, see iconRail.tsx/nowPlayingPanel.tsx). Net-zero on the shared account:
// everything created here (the two audio files, the playlist itself) is removed by the end — the
// `.filen/Playlists` directory the app lazily creates is left behind, which is acceptable app
// infrastructure (mirrors mobile leaving it too).
test("playlists: create, add tracks via the picker, reorder, play, and delete", async ({ page }) => {
	const cspViolations = trackCspViolations(page)
	const runId = crypto.randomUUID()
	const scratchName = `e2e-playlist-${runId}`
	const nameA = `e2e-playlist-a-${runId}.wav`
	const nameB = `e2e-playlist-b-${runId}.wav`
	// Deliberately distinct from scratchName: an identical string for both the scratch directory and
	// the playlist would make every name-scoped locator below ambiguous between a drive row and a
	// playlist row.
	const playlistName = `e2e-playlist-mix-${runId}`
	// Scoped to the specific row: the shared account can carry other playlists from unrelated runs, so a
	// page-wide role query risks a strict-mode ambiguity.
	const playlistRow = page.getByRole("listitem").filter({ hasText: playlistName })

	// Idempotent by construction, so the same steps serve as this test's delete proof AND as the
	// finally's net — a playlist lives in the app-created `.filen/Playlists` directory, which the drive
	// listing sweeps never descend into, so the only other thing that would ever remove a leaked one is
	// the NEXT run's cleanup setup.
	async function deleteScratchPlaylist(): Promise<void> {
		await page.getByRole("link", { name: "Playlists", exact: true }).click()
		await expect(page.getByRole("heading", { name: "Playlists", exact: true })).toBeVisible()

		const present = await playlistRow
			.first()
			.waitFor({ state: "visible", timeout: 15_000 })
			.then(() => true)
			.catch(() => false)

		if (!present) {
			// Named, not silently skipped: nothing else sweeps `.filen/Playlists`, so a leak that goes
			// unreported here is invisible until someone reads the next run's account by hand.
			console.error(
				`audio: playlist "${playlistName}" is not reachable in the Playlists listing — leaked, left for the next run's sweep`
			)

			return
		}

		await playlistRow.first().getByRole("button", { name: "Playlist options" }).click()
		await page.getByRole("menuitem", { name: "Delete" }).click()
		await page.getByRole("alertdialog", { name: "Delete playlist" }).getByRole("button", { name: "Delete", exact: true }).click()
		await expect(playlistRow).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
	}

	let deleted = false

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await uploadFiles(
			page,
			[
				{ name: nameA, mimeType: "audio/wav", buffer: WAV_A },
				{ name: nameB, mimeType: "audio/wav", buffer: WAV_B }
			],
			listbox
		)

		// The rail's dedicated Playlists entry — no queue needed first, unlike the old popover-tab route.
		await page.getByRole("link", { name: "Playlists", exact: true }).click()
		await expect(page.getByRole("heading", { name: "Playlists", exact: true })).toBeVisible()

		// Not visible until the "Play" click below actually starts a queue.
		const bar = page.getByRole("region", { name: "Audio player" })

		await page.getByRole("button", { name: "New playlist" }).click()
		const createDialog = page.getByRole("dialog", { name: "New playlist" })
		await expect(createDialog).toBeVisible()
		await createDialog.getByLabel("Name", { exact: true }).fill(playlistName)
		await createDialog.getByRole("button", { name: "Create", exact: true }).click()
		// The dialog closes only after the create resolves, and a first playlist in a run is two
		// createDirectory calls plus the JSON upload — a real write chain on the account-wide lease.
		await expect(createDialog).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		// Creating selects the new playlist; its sidebar row is the selected one and the main pane is its
		// page, labelled by the name heading.
		await expect(playlistRow.first().getByRole("link", { name: playlistName })).toHaveAttribute("aria-current", "page")
		const detailPane = page.getByRole("region", { name: playlistName })
		await expect(detailPane.getByRole("heading", { level: 1, name: playlistName })).toBeVisible()

		// Add both scratch tracks via the picker.
		await detailPane.getByRole("button", { name: "Add tracks" }).click()
		const pickerDialog = page.getByRole("dialog", { name: "Add tracks" })
		await expect(pickerDialog).toBeVisible()
		await pickerDialog.getByRole("button", { name: scratchName }).click()
		const pickerRowA = pickerDialog.getByRole("button", { name: nameA })
		const pickerRowB = pickerDialog.getByRole("button", { name: nameB })
		await expect(pickerRowA).toBeVisible({ timeout: 30_000 })
		await pickerRowA.click()
		// The submit's own count is the only signal a pick registered — without it a swallowed first
		// click leaves "Add 2 tracks" unreachable and the failure reads as a missing button.
		await expect(pickerDialog.getByRole("button", { name: "Add 1 track", exact: true })).toBeVisible()
		await pickerRowB.click()
		await pickerDialog.getByRole("button", { name: "Add 2 tracks", exact: true }).click()
		// Same shape as the create above: the add re-uploads the playlist JSON and the dialog closes on it.
		await expect(pickerDialog).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		const trackRowA = detailPane.getByText(nameA)
		const trackRowB = detailPane.getByText(nameB)
		await expect(trackRowA).toBeVisible()
		await expect(trackRowB).toBeVisible()

		// Drag B onto A — the reordered list feeds "Play" below, proving the reorder actually persisted
		// (not just a local optimistic reshuffle). Dispatched (helpers/dnd.ts): both rows are resolved in
		// the turn that drops, so a pane re-rendering underneath cannot swallow it the way a mouse dragTo
		// could. The row only moves once the save lands, which on a contended account outlasts an orphaned
		// lease, hence the live-write budget. A retry (the rows refused the drag mid-save) reads the order
		// first: dropping B on A again once B already leads would move it back down. The first track row
		// is aria-rowindex 2 (the header is 1); the tbody's first <tr> can be the virtualizer's padding.
		const firstTrackRow = detailPane.locator('tbody tr[aria-rowindex="2"]')
		const trackRow = (name: string) => ({ selector: 'tbody tr[draggable="true"]', text: name })

		await expect(async () => {
			if (!((await firstTrackRow.textContent()) ?? "").includes(nameB)) {
				await html5DragMove(page, trackRow(nameB), trackRow(nameA))
			}

			await expect(firstTrackRow.getByText(nameB)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		}).toPass({ timeout: 2 * LIVE_WRITE_TIMEOUT_MS })

		await detailPane.getByRole("button", { name: "Play", exact: true }).click()
		await expect(bar.locator(`[title="${nameB}"]`)).toBeVisible({ timeout: 30_000 })

		// The row must still be there, so the idempotent delete below cannot no-op into a false pass.
		await expect(playlistRow).toHaveCount(1)
		await deleteScratchPlaylist()
		deleted = true

		// Queue playback is client-only (never persisted server-side, useAudioStore.ts), so leaving it
		// playing here carries no net-zero cost — nothing left behind to clean up.
		expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toHaveLength(0)
	} finally {
		// Only when the in-body delete did not run: repeating it walks a listing that correctly no longer
		// has the row and would report a leak that never happened. Every failure path still gets the net,
		// and it starts by clearing whatever the failure left standing — the rail link it clicks first
		// does not exist for the role engine while a modal is open. trashScratchDirectory does its own.
		if (!deleted) {
			await dismissOverlays(page)
			await deleteScratchPlaylist().catch(() => undefined)
		}

		await trashScratchDirectory(page, scratchName)
	}
})

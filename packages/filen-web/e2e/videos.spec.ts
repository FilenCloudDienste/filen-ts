import type { Locator, Page } from "@playwright/test"
import { SW_DOWNLOAD_PREFIX } from "@/lib/sw/protocol"
import type { VideosSyncSnapshot } from "./global"
import { test, expect } from "./fixtures"
import {
	bootTo,
	clickLinkUntilUrl,
	enterScratchDirectory,
	openRailGroupChild,
	reloadToShell,
	trashScratchDirectory,
	uploadFiles,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { waitForSwReady } from "./helpers/sw"
import { VIDEOS_MKV_BYTES, VIDEOS_MP4_BYTES } from "./helpers/videoFixtures"

// The live proof of the Videos arc on a real account: a directory picked on the first run, its scan, a movie the
// browser plays as it is (over the service worker's stream route), a Matroska movie it cannot (remuxed into
// MediaSource by the remux worker), the watch position reaching `.filen/videos/watch-state.v1.json` on the
// server, and Resume after a reload.
//
// Videos keeps its library and watch state in `.filen/videos` on the account, which every run and browser shares,
// so the test snapshots that directory first and puts it back at the end (src/e2e-hooks/videosSync.ts). That runs
// from a freshly loaded page that never opened Videos: a page that did would save its own copy straight back.
// The library directory is a scratch directory like every write-lane spec's, trashed at the end.

const WATCH_STATE_FILE = "watch-state.v1.json"
// Movie names with a year, so both classify as movies by name alone.
const DIRECT_TITLE = "Direct Feature"
const REMUX_TITLE = "Remux Feature"
const DIRECT_FILE = `${DIRECT_TITLE} (2001).mp4`
const REMUX_FILE = `${REMUX_TITLE} (2002).mkv`
const DIRECT_DURATION_SEC = 320
const REMUX_DURATION_SEC = 12
// Past 5 % of the 320 s fixture and short of 90 %, so the position is kept to resume from.
const RESUME_FROM_SEC = 100
// A scan is one listing, then a classification in the worker; the first probe of each title reads a few KB.
const SCAN_TIMEOUT_MS = 30_000
// Playback start: the stream route or the remux worker's first fragment, over the live account.
const PLAYBACK_TIMEOUT_MS = 45_000
// The restore's deletes and version restores are drive writes, each queued on the account-wide lease.
const RESTORE_TIMEOUT_MS = 2 * LIVE_WRITE_TIMEOUT_MS

// The test's ceiling, from the waits pinned below, so a slow but healthy run unwinds through its own restore
// instead of being killed (a kill orphans the drive-write lease and leaves `.filen/videos` changed):
//   scratch bracket   728 s  enterScratchDirectory 468 + trashScratchDirectory 260 (playwright.config.ts write lane)
//   boot + upload     450 s  bootTo 90, uploadFiles 360 (two rows at 120, pending list 120)
//   first run         325 s  SW 30, Videos link 30, first-run text 30, chooser actions 75, library save 120, cards 40
//   direct + sync     295 s  title 40, Play 15, two playback waits 90, Back 30, watch-state upload 120
//   resume            240 s  reloadToShell 90, heading 30, Resume 30 + 15, playback 45, Back 30
//   remux + sync      265 s  Home 15, title 40, Play 15, playback 45, Back 30, watch-state upload 120
//   restore           330 s  bootTo 90, restore 240
const TEST_TIMEOUT_MS = (728 + 450 + 325 + 295 + 240 + 265 + 330) * 1_000

function card(page: Page, title: string): Locator {
	return page
		.getByRole("main")
		.getByRole("link", { name: new RegExp(`^${title}\\b`) })
		.first()
}

function player(page: Page, title: string): Locator {
	return page.locator("video").and(page.getByLabel(`Player: ${title}`))
}

interface VideoState {
	src: string
	time: number
	paused: boolean
	readyState: number
	error: number | null
}

async function videoState(video: Locator): Promise<VideoState | null> {
	return video
		.evaluate(element => {
			const media = element as HTMLVideoElement

			return {
				src: media.currentSrc,
				time: media.currentTime,
				paused: media.paused,
				readyState: media.readyState,
				error: media.error?.code ?? null
			}
		})
		.catch(() => null)
}

// Playing past `sinceSec`: the element is attached to its source, decoding, and its clock moves.
async function expectPlayingPast(video: Locator, sinceSec: number): Promise<VideoState> {
	await expect
		.poll(
			async () => {
				const state = await videoState(video)

				return state !== null && state.error === null && !state.paused && state.readyState >= 2 && state.time > sinceSec
			},
			{ timeout: PLAYBACK_TIMEOUT_MS }
		)
		.toBe(true)

	const state = await videoState(video)

	if (state === null) {
		throw new Error("the player's video element went away")
	}

	return state
}

// The title page from its card. Its primary button reads "Play", or "Resume <time>" for a started title.
async function openTitle(page: Page, title: string): Promise<void> {
	await clickLinkUntilUrl(page, card(page, title), /\/videos\/title\//)
	// The library is already held: a local render.
	await expect(page.getByRole("heading", { name: title })).toBeVisible()
}

// The controls hide after a few seconds untouched, under a layer that takes the pointer: a pointer move over the
// stage brings them back first, as it does for a user. Retried until the player is gone, never clicking twice once
// it is.
async function leavePlayer(page: Page): Promise<void> {
	const video = page.locator("video")
	const back = page.getByRole("button", { name: "Back", exact: true }).first()

	await expect(async () => {
		if ((await video.count()) > 0) {
			await page.mouse.move(600, 400)
			await page.mouse.move(640, 420)
			await back.click({ timeout: 2_000 })
		}

		await expect(video).toHaveCount(0, { timeout: 5_000 })
	}).toPass({ timeout: 30_000 })
}

interface SyncedItem {
	p?: { pos: number; dur: number }
	w?: { pl: boolean }
}

// The watch state as the server holds it now: each item's progress (p) and played (w) registers, keyed by an id
// derived from the file. The two fixtures tell apart by duration.
async function syncedItems(page: Page): Promise<SyncedItem[]> {
	const text = await page.evaluate(name => window.__filenE2E.videosSyncFileText(name), WATCH_STATE_FILE)

	if (text === null) {
		return []
	}

	return Object.values((JSON.parse(text) as { items?: Record<string, SyncedItem> }).items ?? {})
}

async function syncedPositionSec(page: Page, minDurationSec: number): Promise<number | null> {
	return (await syncedItems(page)).find(item => (item.p?.dur ?? 0) >= minDurationSec)?.p?.pos ?? null
}

async function syncedPlayed(page: Page, maxDurationSec: number): Promise<boolean> {
	return (await syncedItems(page)).some(item => (item.p?.dur ?? Infinity) <= maxDurationSec && item.w?.pl === true)
}

async function restoreVideosSync(page: Page, snapshot: VideosSyncSnapshot): Promise<void> {
	// A fresh document: nothing in it has opened Videos, so nothing saves the library or watch state back.
	await bootTo(page)

	let timer: ReturnType<typeof setTimeout> | undefined

	try {
		await Promise.race([
			page.evaluate(before => window.__filenE2E.videosSyncRestore(before), snapshot),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`restoring .filen/videos did not finish in ${String(RESTORE_TIMEOUT_MS / 1000)} s`))
				}, RESTORE_TIMEOUT_MS)
			})
		])
	} finally {
		clearTimeout(timer)
	}

	// The hook lists by name, so this compares the same state whatever order the server listed it in.
	expect(await page.evaluate(() => window.__filenE2E.videosSyncSnapshot())).toEqual(snapshot)
}

test("videos: first-run directory, scan, direct and remuxed playback, watch state synced to .filen, resume after a reload", async ({
	page
}) => {
	test.setTimeout(TEST_TIMEOUT_MS)

	const scratchName = `e2e-videos-${crypto.randomUUID()}`
	let snapshot: VideosSyncSnapshot | null = null

	await bootTo(page)

	try {
		snapshot = await page.evaluate(() => window.__filenE2E.videosSyncSnapshot())

		const { listbox } = await enterScratchDirectory(page, scratchName)

		await uploadFiles(
			page,
			[
				{ name: DIRECT_FILE, mimeType: "video/mp4", buffer: VIDEOS_MP4_BYTES },
				{ name: REMUX_FILE, mimeType: "video/x-matroska", buffer: VIDEOS_MKV_BYTES }
			],
			listbox
		)
		await page.setViewportSize({ width: 1280, height: 800 })
		await waitForSwReady(page)

		// ---- first run: pick the scratch directory ----
		await openRailGroupChild(page, "Media", "Videos", /\/videos\/?$/)

		const libraryOnAccount = snapshot.files.length > 0

		if (!libraryOnAccount) {
			await expect(page.getByText("Add a directory to build your library")).toBeVisible({ timeout: 30_000 })
		}

		await page
			.locator("#videos-first-run-action")
			.or(page.getByRole("button", { name: "Add a directory", exact: true }))
			.first()
			.click()

		const chooser = page.getByRole("dialog", { name: "Add a directory to Videos" })

		await expect(chooser).toBeVisible()
		await chooser.getByRole("button", { name: scratchName, exact: true }).dblclick()

		const add = chooser.getByRole("button", { name: `Add “${scratchName}”`, exact: true })

		await expect(add).toBeEnabled()
		await add.click()
		await expect(chooser).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		// ---- scan: both movies show up ----
		await expect(card(page, DIRECT_TITLE)).toBeVisible({ timeout: SCAN_TIMEOUT_MS })
		await expect(card(page, REMUX_TITLE)).toBeVisible()

		// ---- direct: the MP4 streams over the service worker's route ----
		await openTitle(page, DIRECT_TITLE)
		await page.getByRole("button", { name: "Play", exact: true }).click()

		const direct = player(page, DIRECT_TITLE)
		const directStart = await expectPlayingPast(direct, 0.5)

		expect(directStart.src).toContain(SW_DOWNLOAD_PREFIX)

		await direct.evaluate((element, at) => {
			;(element as HTMLVideoElement).currentTime = at
		}, RESUME_FROM_SEC)
		await expectPlayingPast(direct, RESUME_FROM_SEC + 1)
		await leavePlayer(page)

		// ---- the position reaches .filen/videos on the server ----
		await expect
			.poll(() => syncedPositionSec(page, DIRECT_DURATION_SEC - 1), { timeout: LIVE_WRITE_TIMEOUT_MS, intervals: [2_000, 5_000] })
			.toBeGreaterThanOrEqual(RESUME_FROM_SEC)

		// ---- resume after a reload ----
		await reloadToShell(page)
		await expect(page.getByRole("heading", { name: DIRECT_TITLE })).toBeVisible({ timeout: 30_000 })

		const resume = page.getByRole("button", { name: /^Resume \d/ })

		await expect(resume).toBeVisible({ timeout: 30_000 })
		await resume.click()

		const resumed = await expectPlayingPast(player(page, DIRECT_TITLE), RESUME_FROM_SEC - 5)

		expect(resumed.time).toBeLessThan(RESUME_FROM_SEC + 30)
		await leavePlayer(page)

		// ---- remux: the MKV plays from MediaSource ----
		await page.getByRole("link", { name: "Home", exact: true }).first().click()
		await openTitle(page, REMUX_TITLE)
		await page.getByRole("button", { name: "Play", exact: true }).click()

		const remuxed = await expectPlayingPast(player(page, REMUX_TITLE), 1)

		expect(remuxed.src).toMatch(/^blob:/)
		await leavePlayer(page)

		// A short movie counts as played once started: that change is synced too. Waited for here so the page
		// has nothing left to save when the restore below navigates away from it.
		await expect
			.poll(() => syncedPlayed(page, REMUX_DURATION_SEC + 1), { timeout: LIVE_WRITE_TIMEOUT_MS, intervals: [2_000, 5_000] })
			.toBe(true)
	} finally {
		if (snapshot !== null) {
			await restoreVideosSync(page, snapshot)
		}

		await trashScratchDirectory(page, scratchName)
	}
})

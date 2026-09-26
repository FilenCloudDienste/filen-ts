import { statSync } from "node:fs"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { enterFixtureDirectory, FIXTURE_FILES } from "./helpers/fixtures"
import { bootTo, clickSidebarLink, openTransfers, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { DOWNLOAD_FSA_TEXT, DOWNLOAD_SW_TEXT } from "./helpers/fixtureBytes"
import { MOD_KEY } from "./helpers/modkey"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Neither native picker is drivable by Playwright, so every FSA-path test below stubs
// window.showSaveFilePicker (installed via addInitScript, before the app's own first script runs, so
// isFsaAvailable() -- saveDownload.ts -- sees it from first paint) with a function that returns a fake
// FileSystemFileHandle-alike whose createWritable() resolves to a REAL WritableStream (required:
// ReadableStream.pipeTo's own brand check rejects a duck-typed non-WritableStream object) backed by a
// custom sink. The app still runs its real FSA code path end to end (capability check -> picker ->
// TransformStream bridge -> coordinated teardown -- saveDownload.ts/download.ts) against that
// controllable sink, which accumulates into window.__smokeSink for the test to read back. The SW-path
// test instead DELETES the picker so isFsaAvailable() is false and the app takes the service-worker
// route, whose plain navigation becomes a real browser download caught via page.waitForEvent("download").
//
// Every test drives the SAME UI trigger: select the row(s), then the bulk-action bar's "Download"
// button (bulkActionBar.tsx) -- chosen over the per-item ⋯ menu (its trigger is opacity-0 until
// row-hover, an extra, unnecessary step to drive from Playwright) and over the mod+s keymap (an
// invisible interaction with no visible affordance to assert against first). Selecting a row always
// swaps the toolbar for the bulk bar, even for a single-item selection (directoryListing.tsx), so one
// trigger covers both the single-file and the zip path below.

// Ambient shim for window.showSaveFilePicker, merged with e2e/global.d.ts's own Window augmentation
// (same program, same declaration-merging rules) rather than touching that file -- this isn't a real
// e2e hook the app ships, just this spec's own test double.
declare global {
	interface Window {
		// File System Access API -- absent from this project's e2e tsconfig program (src/types/file-system-access.d.ts
		// isn't part of it; see tsconfig.node.json's own "include" list), so it needs its own minimal
		// ambient shim here, mirroring that file's rationale. Optional so stubFsaPicker/deleteFsaPicker
		// below can assign/delete it.
		showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
			createWritable: () => Promise<WritableStream<Uint8Array>>
		}>
		// Set by stubFsaPicker's addInitScript before the app's own first script runs -- accumulates every
		// byte the app's real FSA code path (saveDownload.ts/download.ts) writes into the fake sink below,
		// plus the first 4 bytes written (the zip test's magic-number check). Declared non-optional: every
		// test that reads it called stubFsaPicker first (mirrors e2e/global.d.ts's own __filenE2E rationale).
		__smokeSink: { bytes: number; first4: number[] }
		// Set by stubFsaPicker alongside __smokeSink: opens a gated sink (see there). A no-op on an ungated one.
		__releaseSmokeSink: () => void
	}
}

// After the release, a gated sink still paces each chunk, so the rest of the file outlasts the worker
// picking up a cancel that was dispatched just before it.
const GATED_SINK_CHUNK_DELAY_MS = 75

// Trick 1 (FSA path, Chromium's default) -- see the file-level comment above for the full rationale.
// `gated` holds every write() until the test calls releaseSmokeSink, so a transfer cannot finish before
// the test lets it, however slow the runner (the cancel test needs it still in flight at the confirm).
async function stubFsaPicker(page: Page, gated = false): Promise<void> {
	await page.addInitScript(
		([isGated, delayMs]) => {
			window.__smokeSink = { bytes: 0, first4: [] }

			let release: () => void = () => undefined
			const released = isGated
				? new Promise<void>(resolve => {
						release = resolve
					})
				: Promise.resolve()

			window.__releaseSmokeSink = () => {
				release()
			}

			window.showSaveFilePicker = () =>
				Promise.resolve({
					createWritable: () =>
						Promise.resolve(
							new WritableStream<Uint8Array>({
								async write(chunk) {
									await released

									if (isGated) {
										await new Promise<void>(resolve => {
											setTimeout(resolve, delayMs)
										})
									}

									if (window.__smokeSink.first4.length === 0 && chunk.byteLength > 0) {
										window.__smokeSink.first4 = Array.from(chunk.subarray(0, 4))
									}

									window.__smokeSink.bytes += chunk.byteLength
								}
							})
						)
				})
		},
		[gated, GATED_SINK_CHUNK_DELAY_MS] as const
	)
}

function releaseSmokeSink(page: Page): Promise<void> {
	return page.evaluate(() => {
		window.__releaseSmokeSink()
	})
}

// Trick 2 (SW path, Firefox/Safari's default -- forced here on Chromium) -- see the file-level comment
// above for the full rationale.
async function deleteFsaPicker(page: Page): Promise<void> {
	await page.addInitScript(() => {
		delete window.showSaveFilePicker
	})
}

function readSmokeSink(page: Page): Promise<{ bytes: number; first4: number[] }> {
	return page.evaluate(() => window.__smokeSink)
}

// The files these tests download live in the shared read-only fixture tree the fixtures-setup project
// builds once per run (helpers/fixtures.ts), so nothing here uploads. That also retires the
// "Clear finished" round trip every test used to make first: a transfer row's accessible name is just
// its bare file name regardless of direction (transferRow.tsx), so an upload done IN THIS CONTEXT left
// a finished row that collided with the download's own row on every progressbar/"Done" locator below.
// With the upload gone from the context, the transfers list starts empty and the only row that ever
// appears is the download under test.

test.describe("downloads", () => {
	test("a single file downloads through the File System Access path and the transfer reaches Done", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await stubFsaPicker(page)

		await bootTo(page)

		const [fileName] = FIXTURE_FILES["download-fsa"]

		const { listbox } = await enterFixtureDirectory(page, "download-fsa")

		const row = listbox.getByRole("option", { name: fileName })
		await expect(row).toBeVisible({ timeout: 20_000 })

		await row.click()
		await page.getByRole("button", { name: "Download", exact: true }).click()

		await openTransfers(page)

		// The transfer row's accessible name lives on its progressbar, not the row's outer container --
		// the Pause/Cancel buttons are exact-named siblings (vs. the screen's own header
		// "Pause all"/"Cancel all"), located independently below since only one row is ever active here.
		// The status label is a sibling of that progressbar inside the same row div, so stepping up to the
		// row pins "Done" to THIS transfer rather than to the first one anywhere on the screen.
		const progressbar = page.getByRole("progressbar", { name: fileName })
		await expect(progressbar).toBeVisible()
		await expect(progressbar.locator("xpath=..").getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 })

		const sink = await readSmokeSink(page)
		expect(sink.bytes).toBe(Buffer.byteLength(DOWNLOAD_FSA_TEXT, "utf8"))
	})

	test("a multi-select download zips into ONE archive over the File System Access path", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await stubFsaPicker(page)

		await bootTo(page)

		const [nameA, nameB] = FIXTURE_FILES["download-zip"]

		const { listbox } = await enterFixtureDirectory(page, "download-zip")

		const rowA = listbox.getByRole("option", { name: nameA })
		const rowB = listbox.getByRole("option", { name: nameB })
		await expect(rowA).toBeVisible({ timeout: 20_000 })
		await expect(rowB).toBeVisible({ timeout: 20_000 })

		// Click, then modifier-click to add to the selection -- the same mechanism drive-actions.spec.ts's
		// own bulk tests use.
		await rowA.click()
		await rowB.click({ modifiers: [MOD_KEY] })
		await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

		await page.getByRole("button", { name: "Download", exact: true }).click()

		await openTransfers(page)

		// A mixed multi-item selection has no single source name to derive from, so the zip falls back to
		// the shared generic archive name (downloadZip.ts's resolveSuggestedZipName). exact: true guards
		// against Playwright's default substring/case-insensitive accessible-name matching picking up an
		// unrelated row that merely CONTAINS this literal name.
		const zipProgressbar = page.getByRole("progressbar", { name: "Filen.zip", exact: true })
		await expect(zipProgressbar).toBeVisible({ timeout: 10_000 })
		await expect(zipProgressbar).toHaveCount(1)

		// Scoped to the archive's own row (the status label is that progressbar's sibling), not the first
		// "Done" anywhere on the screen.
		await expect(zipProgressbar.locator("xpath=..").getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 })

		const sink = await readSmokeSink(page)
		// ZIP local-file-header magic (PK\x03\x04) -- proves a real, complete archive streamed through,
		// not just a registration ack.
		expect(sink.first4).toEqual([0x50, 0x4b, 0x03, 0x04])
		expect(sink.bytes).toBeGreaterThan(100)
	})

	test("a single file downloads through the service-worker path as a real browser download", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await deleteFsaPicker(page)

		await bootTo(page)

		const [fileName] = FIXTURE_FILES["download-sw"]

		const { listbox } = await enterFixtureDirectory(page, "download-sw")

		const row = listbox.getByRole("option", { name: fileName })
		await expect(row).toBeVisible({ timeout: 20_000 })

		await row.click()

		const [download] = await Promise.all([
			page.waitForEvent("download", { timeout: 30_000 }),
			page.getByRole("button", { name: "Download", exact: true }).click()
		])

		expect(download.suggestedFilename()).toBe(fileName)
		expect(statSync(await download.path()).size).toBe(Buffer.byteLength(DOWNLOAD_SW_TEXT, "utf8"))

		// The sw path is fire-and-forget once the navigation triggers (saveDownload.ts's
		// triggerSwDownload; download.ts's runDownload sw branch has no per-byte progress to report,
		// unlike the fsa branch) -- live-verified against runDownload's own settle call that the row
		// still reaches Done for a file this size, so that is what this asserts, not an invented
		// intermediate state.
		await openTransfers(page)
		// Scoped to this transfer's own row (the status label is the progressbar's sibling), not the first
		// "Done" anywhere on the screen.
		const swProgressbar = page.getByRole("progressbar", { name: fileName })
		await expect(swProgressbar).toBeVisible()
		await expect(swProgressbar.locator("xpath=..").getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 })
	})

	test("cancelling a File System Access download mid-flight removes the row and leaves the source untouched", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		// The only read-lane test that enters the fixture tree TWICE — once here and again after the
		// cancel, to prove the listing survived the round trip. Two descents plus this test's own pins
		// sit above the lane ceiling, so it opts in where that cost is visible rather than widening the
		// budget for the fourteen read specs that never touch the tree at all.
		test.setTimeout(600_000)

		// A gated sink holds the transfer in flight until the cancel is confirmed, however slow the runner
		// is to reach that confirm; a throttle alone only bought a few seconds, which a slow runner's UI
		// steps could outlast and let the download finish first.
		await stubFsaPicker(page, true)

		await bootTo(page)

		const [fileName] = FIXTURE_FILES["download-cancel"]

		const { listbox } = await enterFixtureDirectory(page, "download-cancel")

		const row = listbox.getByRole("option", { name: fileName })
		await expect(row).toBeVisible({ timeout: 20_000 })

		await row.click()
		await page.getByRole("button", { name: "Download", exact: true }).click()

		// Snapshot the fixture directory's own option count before leaving for the /transfers screen
		// (the rail entry navigates there now, rather than overlaying a popover on this same
		// page) -- race-free here, unlike the identical snapshot-then-assert shape in drive.spec.ts's
		// own "selection" test: the shared fixture tree is READ-ONLY for the whole run, so nothing
		// else ever creates/trashes inside it the way concurrent specs do at /drive's shared root.
		const optionCountBeforeCancel = await listbox.getByRole("option").count()

		await openTransfers(page)

		const progressbar = page.getByRole("progressbar", { name: fileName })
		await expect(progressbar).toBeVisible()

		await page.getByRole("button", { name: "Cancel", exact: true }).click()

		// Cancel now gates behind a destructive confirm (it used to fire immediately): the
		// dialog appears rather than the transfer cancelling on this click alone. Scoped by title, not
		// just role, since the shared account's own async master-keys reminder can independently pop
		// up mid-test and also renders as an alertdialog. Not re-asserting the background progressbar
		// here -- Base UI's modal AlertDialog hides the rest of the page from the accessibility tree
		// while open (aria-hide-others), so it's intentionally unqueryable, not a sign anything
		// cancelled yet.
		const confirmDialog = page.getByRole("alertdialog", { name: "Cancel transfer?" })
		await expect(confirmDialog).toBeVisible()
		await confirmDialog.getByRole("button", { name: "Cancel", exact: true }).click()

		// Only now: the cancel has been dispatched, and the app's pipe cannot unwind until the write it is
		// holding settles (a pipeTo abort waits out an in-flight write), so the row would never leave.
		await releaseSmokeSink(page)

		// Cancelled transfers keep no history (download.ts's runDownload Cancelled branch settles then
		// immediately removes the row) -- unlike a finished row, there is no separate Dismiss step. The
		// row leaves on the SDK's own abort path unwinding, not on a React commit, so it gets the live
		// budget rather than the UI-responsiveness default.
		await expect(progressbar).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(page.getByText(/failed/i)).toHaveCount(0)

		// An in-app sidebar Link click plus a re-descent, never page.goto() -- goto is a hard reload
		// that re-runs the whole boot/re-auth sequence, tearing down and rebooting the wasm SDK/OPFS
		// session this test relies on staying alive across the round trip.
		await clickSidebarLink(page, "Cloud Drive", /\/drive$/)
		await enterFixtureDirectory(page, "download-cancel")

		// The source item itself is untouched -- cancelling aborts the in-flight transfer, never the
		// underlying file, and the listing was never patched by a download in the first place. The
		// unchanged option count alongside it proves nothing else in the fixture listing shifted either,
		// not just that this one specific row happens to still be there.
		await expect(row).toBeVisible()
		await expect(listbox.getByRole("option")).toHaveCount(optionCountBeforeCancel)
	})
})

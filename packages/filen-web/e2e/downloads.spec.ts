import { statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"

// Neither native picker is drivable by Playwright, so every FSA-path test below stubs
// window.showSaveFilePicker (installed via addInitScript, before the app's own first script runs, so
// isFsaAvailable() -- save-download.ts -- sees it from first paint) with a function that returns a fake
// FileSystemFileHandle-alike whose createWritable() resolves to a REAL WritableStream (required:
// ReadableStream.pipeTo's own brand check rejects a duck-typed non-WritableStream object) backed by a
// custom sink. The app still runs its real FSA code path end to end (capability check -> picker ->
// TransformStream bridge -> coordinated teardown -- save-download.ts/download.ts) against that
// controllable sink, which accumulates into window.__smokeSink for the test to read back. The SW-path
// test instead DELETES the picker so isFsaAvailable() is false and the app takes the service-worker
// route, whose plain navigation becomes a real browser download caught via page.waitForEvent("download").
//
// Every test drives the SAME UI trigger: select the row(s), then the bulk-action bar's "Download"
// button (bulk-action-bar.tsx) -- chosen over the per-item ⋯ menu (its trigger is opacity-0 until
// row-hover, an extra, unnecessary step to drive from Playwright) and over the mod+s keymap (an
// invisible interaction with no visible affordance to assert against first). Selecting a row always
// swaps the toolbar for the bulk bar, even for a single-item selection (directory-listing.tsx), so one
// trigger covers both the single-file and the zip path below.
const FIREFOX_HANG_REASON = "drive listing needs an authenticated listDir call, which hangs indefinitely on Playwright-firefox under COI"

// Meta on macOS (where this suite runs today), Control elsewhere -- mirrors drive-actions.spec.ts's own
// multi-select modifier.
const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control"

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
		// byte the app's real FSA code path (save-download.ts/download.ts) writes into the fake sink below,
		// plus the first 4 bytes written (the zip test's magic-number check). Declared non-optional: every
		// test that reads it called stubFsaPicker first (mirrors e2e/global.d.ts's own __filenE2E rationale).
		__smokeSink: { bytes: number; first4: number[] }
	}
}

// Duplicated from drive.spec.ts/uploads.spec.ts rather than shared -- this package has no cross-spec e2e
// helpers module yet, and every other spec file here owns its helpers locally too.
async function waitForListingSettled(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	const listbox = page.getByRole("listbox", { name: "Directory contents" })
	const empty = page.getByText("Nothing here yet")

	await expect(listbox.or(empty)).toBeVisible()

	return { listbox, hasItems: await listbox.isVisible() }
}

// Every test below nests its fixture file(s) inside a per-test scratch directory rather than creating
// them at /drive's root -- mirrors drive-actions.spec.ts's own hardened convention (see the comment on
// that file's one mutating test). Under this suite's fullyParallel config (playwright.config.ts),
// root-level create/trash from one spec races root-level reads from another: drive.spec.ts's own
// "selection" test snapshots the root listbox's option COUNT, then asserts a select-all against it --
// a TOCTOU a concurrent create/trash at root can break, and this exact interference already reproduced
// live once as a flaky drive.spec.ts failure (drive-actions.spec.ts's own comment documents it).
// Nesting confines every count-shifting moment to the two around the scratch directory itself (create,
// final trash) instead of one pair per fixture file.
async function enterScratchDirectory(page: Page, name: string): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	// The listing virtualizes its rows (directory-listing.tsx's useVirtualizer, keyed by item uuid) --
	// on a long/shared listing a row sorted well below the fold may not be mounted in the DOM at all, so
	// a locator that depends on finding a SPECIFIC named row (this function's own scratchRow below,
	// trashScratchDirectory's row) can silently miss it. A generously tall viewport makes the scroll
	// container's height exceed any realistic item count's total row height, so the virtualizer renders
	// every row in one pass for the rest of this test -- simpler and more robust here than driving
	// synthetic scroll/wheel events against an unknown scroll container to hunt for one row.
	await page.setViewportSize({ width: 1280, height: 8000 })

	const { listbox } = await waitForListingSettled(page)

	await page.getByRole("button", { name: "New directory", exact: true }).click()
	const dialog = page.getByRole("dialog")
	await expect(dialog).toBeVisible()
	await page.getByLabel("Name", { exact: true }).fill(name)
	await page.getByRole("button", { name: "Create", exact: true }).click()
	await expect(dialog).toHaveCount(0)

	const scratchRow = listbox.getByRole("option", { name })
	await expect(scratchRow).toBeVisible()

	// A real double-click (an in-app client-side route change, same as drive-actions.spec.ts's own
	// descent) -- everything the calling test does until trashScratchDirectory below stays inside this
	// directory and never touches the root listing again.
	await scratchRow.dblclick()

	return waitForListingSettled(page)
}

// Failure-proof companion to enterScratchDirectory above -- called from every test's own finally, so the
// scratch directory (and everything uploaded into it) is trashed even when an assertion above throws.
// Escape first: every test below opens the rail's Transfers popover, which renders close enough to the
// sidebar to risk covering its own "My Drive" link, and dismissing an already-closed popover is a
// harmless no-op.
async function trashScratchDirectory(page: Page, name: string): Promise<void> {
	await page.keyboard.press("Escape")
	await page.getByRole("complementary").getByRole("link", { name: "My Drive", exact: true }).click()

	const { listbox } = await waitForListingSettled(page)
	const row = listbox.getByRole("option", { name })

	// waitForListingSettled only proves SOME listbox is showing, not that it reflects the scratch
	// directory just created: React Query serves this root query key's LAST-cached result instantly
	// (queries/client.ts's staleTime 0 still triggers a background refetch, but never blocks the
	// already-cached render) -- root was cached once already, at this test's own initial goto, before
	// the scratch directory existed. A one-shot visibility check races that background refetch and
	// reliably loses under load; polling rides it out. A genuine timeout (the scratch directory never
	// made it into the listing at all, e.g. enterScratchDirectory itself failed before creating it) is
	// the one case there is nothing to trash.
	try {
		await expect(row).toBeVisible({ timeout: 15_000 })
	} catch {
		return
	}

	await row.click()
	await page.getByRole("button", { name: "Trash", exact: true }).click()

	const confirm = page.getByRole("alertdialog")
	await expect(confirm).toBeVisible()
	await confirm.getByRole("button", { name: "Trash", exact: true }).click()
	await expect(confirm).toHaveCount(0)
}

// Trick 1 (FSA path, Chromium's default) -- see the file-level comment above for the full rationale.
// `throttleMs`, when positive, awaits inside write() so a caller (the cancel test) can keep a transfer
// reliably in-flight long enough for a real Cancel click to land.
async function stubFsaPicker(page: Page, throttleMs = 0): Promise<void> {
	await page.addInitScript(delayMs => {
		window.__smokeSink = { bytes: 0, first4: [] }

		window.showSaveFilePicker = () =>
			Promise.resolve({
				createWritable: () =>
					Promise.resolve(
						new WritableStream<Uint8Array>({
							async write(chunk) {
								if (delayMs > 0) {
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
	}, throttleMs)
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

// Fixture files are uploaded through the SAME real UI path a user would use -- the hidden file input
// upload-menu.tsx wires up, targeting whatever directory the app is currently navigated into
// (directory-listing.tsx passes it the current listing's own uuid) -- rather than through the
// createTestFile e2e hook: that hook's own doc comment says it uploads at the account ROOT with no
// parentUuid option, which would defeat the whole point of nesting above. Driving the UI instead also
// means the upload lands through runUpload's own optimistic cache patch (lib/drive/upload.ts), so the
// new row appears in the already-open scratch listing on its own -- no forced refetch needed. Mirrors
// uploads.spec.ts's own picker-driven test.
async function uploadTestFiles(page: Page, files: { name: string; content: string }[]): Promise<void> {
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles(files.map(({ name, content }) => ({ name, mimeType: "text/plain", buffer: Buffer.from(content, "utf8") })))
}

// Same UI path as uploadTestFiles above, but for the cancel test's larger file: the content is written
// to a REAL temp file on disk first (mirrors uploads.spec.ts's own directory-upload test), then handed
// to setInputFiles as a path rather than a buffer -- Playwright/CDP reads a path-based file input
// straight off local disk into the browser, so a several-MiB payload never has to serialize through the
// Playwright<->driver bridge as a call argument.
async function uploadLargeTestFile(page: Page, name: string, sizeBytes: number): Promise<void> {
	const path = join(tmpdir(), name)
	writeFileSync(path, "x".repeat(sizeBytes))

	await page.locator('input[type="file"]').first().setInputFiles(path)
}

// A real, UI-driven fixture upload (uploadTestFiles/uploadLargeTestFile above) leaves a FINISHED
// "upload" transfer row behind in the same store the download flow below reads -- and a transfer row's
// accessible name is just its bare file name regardless of direction (transfer-row.tsx's own
// `<Progress aria-label={transfer.name} />`), so an upload and a later download of the SAME file
// collide on every getByRole("progressbar", { name: fileName })/getByText("Done") locator below unless
// the upload's own row is cleared first. The panel's "Clear finished" button (transfers-panel.tsx)
// clears every finished row in one click, so this works the same whether one file or several were just
// uploaded.
async function clearFinishedTransfers(page: Page): Promise<void> {
	await page
		.getByRole("button", { name: /Transfers/i })
		.first()
		.click()

	await page.getByRole("button", { name: "Clear finished", exact: true }).click()
	await page.keyboard.press("Escape")
}

test.describe("downloads", () => {
	test("a single file downloads through the File System Access path and the transfer reaches Done", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await stubFsaPicker(page)

		await page.goto("/drive")

		const scratchName = `e2e-download-fsa-${crypto.randomUUID()}`
		const fileName = `e2e-download-fsa-${crypto.randomUUID()}.txt`
		const content = "filen web e2e download probe"

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await uploadTestFiles(page, [{ name: fileName, content }])

			const row = listbox.getByRole("option", { name: fileName })
			await expect(row).toBeVisible({ timeout: 20_000 })

			await clearFinishedTransfers(page)

			await row.click()
			await page.getByRole("button", { name: "Download", exact: true }).click()

			await page
				.getByRole("button", { name: /Transfers/i })
				.first()
				.click()

			// The transfer row's accessible name lives on its progressbar, not the row's outer container --
			// the Pause/Cancel buttons are exact-named siblings (vs. the separate /transfers screen's own
			// "Pause all"/"Cancel all"), located independently below since only one row is ever active here.
			await expect(page.getByRole("progressbar", { name: fileName })).toBeVisible()
			await expect(page.getByText("Done")).toBeVisible({ timeout: 20_000 })

			const sink = await readSmokeSink(page)
			expect(sink.bytes).toBe(Buffer.byteLength(content, "utf8"))
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("a multi-select download zips into ONE archive over the File System Access path", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await stubFsaPicker(page)

		await page.goto("/drive")

		const scratchName = `e2e-download-zip-${crypto.randomUUID()}`
		const nameA = `e2e-download-zip-a-${crypto.randomUUID()}.txt`
		const nameB = `e2e-download-zip-b-${crypto.randomUUID()}.txt`

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await uploadTestFiles(page, [
				{ name: nameA, content: "filen web e2e zip download file a" },
				{ name: nameB, content: "filen web e2e zip download file b" }
			])

			const rowA = listbox.getByRole("option", { name: nameA })
			const rowB = listbox.getByRole("option", { name: nameB })
			await expect(rowA).toBeVisible({ timeout: 20_000 })
			await expect(rowB).toBeVisible({ timeout: 20_000 })

			await clearFinishedTransfers(page)

			// Click, then modifier-click to add to the selection -- the same mechanism drive-actions.spec.ts's
			// own bulk tests use.
			await rowA.click()
			await rowB.click({ modifiers: [MOD_KEY] })
			await expect(page.getByText("2 selected", { exact: true })).toBeVisible()

			await page.getByRole("button", { name: "Download", exact: true }).click()

			await page
				.getByRole("button", { name: /Transfers/i })
				.first()
				.click()

			// A mixed multi-item selection has no single source name to derive from, so the zip falls back to
			// the shared generic archive name (download-zip.ts's resolveSuggestedZipName). exact: true guards
			// against Playwright's default substring/case-insensitive accessible-name matching picking up an
			// unrelated row that merely CONTAINS this literal name.
			await expect(page.getByRole("progressbar", { name: "Filen.zip", exact: true })).toBeVisible({ timeout: 10_000 })
			await expect(page.getByRole("progressbar", { name: "Filen.zip", exact: true })).toHaveCount(1)

			await expect(page.getByText("Done")).toBeVisible({ timeout: 20_000 })

			const sink = await readSmokeSink(page)
			// ZIP local-file-header magic (PK\x03\x04) -- proves a real, complete archive streamed through,
			// not just a registration ack.
			expect(sink.first4).toEqual([0x50, 0x4b, 0x03, 0x04])
			expect(sink.bytes).toBeGreaterThan(100)
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("a single file downloads through the service-worker path as a real browser download", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await deleteFsaPicker(page)

		await page.goto("/drive")

		const scratchName = `e2e-download-sw-${crypto.randomUUID()}`
		const fileName = `e2e-download-sw-${crypto.randomUUID()}.txt`
		const content = "filen web e2e sw download probe"

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await uploadTestFiles(page, [{ name: fileName, content }])

			const row = listbox.getByRole("option", { name: fileName })
			await expect(row).toBeVisible({ timeout: 20_000 })

			await clearFinishedTransfers(page)

			await row.click()

			const [download] = await Promise.all([
				page.waitForEvent("download", { timeout: 15_000 }),
				page.getByRole("button", { name: "Download", exact: true }).click()
			])

			expect(download.suggestedFilename()).toBe(fileName)
			expect(statSync(await download.path()).size).toBe(Buffer.byteLength(content, "utf8"))

			// The sw path is fire-and-forget once the navigation triggers (save-download.ts's
			// triggerSwDownload; download.ts's runDownload sw branch has no per-byte progress to report,
			// unlike the fsa branch) -- live-verified against runDownload's own settle call that the row
			// still reaches Done for a file this size, so that is what this asserts, not an invented
			// intermediate state.
			await page
				.getByRole("button", { name: /Transfers/i })
				.first()
				.click()
			await expect(page.getByRole("progressbar", { name: fileName })).toBeVisible()
			await expect(page.getByText("Done")).toBeVisible({ timeout: 20_000 })
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("cancelling a File System Access download mid-flight removes the row and leaves the source untouched", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		// A throttled sink (~75ms per chunk) keeps a large-enough download reliably in-flight long enough
		// for a real Cancel click to land deterministically, rather than racing a real transfer's own,
		// unpredictable network speed. Live-verified against this exact SDK/account: a 24 MiB file streams
		// in ~1 MiB chunks, so the throttle alone buys several seconds of in-flight window -- comfortably
		// under the "few MiB, well under 50MB" ceiling a real UI upload input would otherwise need.
		await stubFsaPicker(page, 75)

		await page.goto("/drive")

		const scratchName = `e2e-download-cancel-${crypto.randomUUID()}`
		const fileName = `e2e-download-cancel-${crypto.randomUUID()}.bin`
		const sizeBytes = 24 * 1024 * 1024

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await uploadLargeTestFile(page, fileName, sizeBytes)

			const row = listbox.getByRole("option", { name: fileName })
			await expect(row).toBeVisible({ timeout: 20_000 })

			await clearFinishedTransfers(page)

			await row.click()
			await page.getByRole("button", { name: "Download", exact: true }).click()

			await page
				.getByRole("button", { name: /Transfers/i })
				.first()
				.click()

			const progressbar = page.getByRole("progressbar", { name: fileName })
			await expect(progressbar).toBeVisible()

			// Snapshot the scratch directory's own option count just before cancelling -- race-free here,
			// unlike the identical snapshot-then-assert shape in drive.spec.ts's own "selection" test: the
			// scratch directory is this test's private space, so nothing else ever concurrently
			// creates/trashes inside it the way concurrent specs do at /drive's shared root.
			const optionCountBeforeCancel = await listbox.getByRole("option").count()

			await page.getByRole("button", { name: "Cancel", exact: true }).click()

			// Cancelled transfers keep no history (download.ts's runDownload Cancelled branch settles then
			// immediately removes the row) -- unlike a finished row, there is no separate Dismiss step.
			await expect(progressbar).toHaveCount(0)
			await expect(page.getByText(/failed/i)).toHaveCount(0)

			// The source item itself is untouched -- cancelling aborts the in-flight transfer, never the
			// underlying file, and the listing was never patched by a download in the first place. The
			// unchanged option count alongside it proves nothing else in the scratch listing shifted either,
			// not just that this one specific row happens to still be there.
			await expect(row).toBeVisible()
			await expect(listbox.getByRole("option")).toHaveCount(optionCountBeforeCancel)
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

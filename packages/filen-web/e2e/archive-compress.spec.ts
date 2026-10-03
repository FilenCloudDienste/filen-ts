import type { Locator, Page } from "@playwright/test"
import { formatBytes } from "@filen/shared"
import { test, expect, readFixtureManifest } from "./fixtures"
import {
	archivePasswordPrompt,
	compressPreset,
	deleteConfirm,
	expectInTrash,
	expectRows,
	expectRowSize,
	expectTextPreview,
	itemRow,
	openArchive,
	openCompressDialog,
	openExtractDialog,
	setArchiveMemory,
	type ArchiveBrowserPO,
	type CompressDialogPO
} from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import {
	ARCHIVE_JOB_TIMEOUT_MS,
	clearJobCards,
	expectExactJobCard,
	expectStackedAtPhoneWidth,
	holdChunks,
	jobCard,
	openReport,
	openStopPrompt,
	pauseFirst,
	reportRow,
	reportRows,
	reportSection,
	stopPrompt,
	withArchiveScratch
} from "./helpers/jobs"
import {
	backTo,
	bootTo,
	clearSelection,
	clickSidebarLink,
	createDirectoryViaDialog,
	descendInto,
	LIVE_WRITE_TIMEOUT_MS,
	textFile,
	uploadFiles,
	waitForListingSettled
} from "./helpers/listing"

// Compress end to end, in the write lane: presets and the names they pick, the options dialog round
// trip (passwords, AES strength, encrypted names, levels), what happens to the originals afterwards,
// stopping a compress, every format against the real wasm codecs, and the biggest archive memory.
// Every test works in its own scratch directory and stops whatever job is left before trashing it. A
// compress is never submitted at the drive root, and a fixture-tree file is only ever a source with
// its originals kept, the archive saved into the scratch directory.

const [DOWNLOAD_CANCEL] = FIXTURE_FILES["download-cancel"]

// A tarball or single compressed file is downloaded whole to be listed; a zip's or 7z's index is one read.
const LISTING_TIMEOUT_MS = 60_000

const EXTRACT_PASSWORD_DIALOG = /^(Password required|Wrong password)$/

function compressedTitle(count: number, name: string): string {
	return `Compressed ${String(count)} ${count === 1 ? "item" : "items"} into ${name}`
}

// Opens an archive of the scratch directory, checks its root rows, and closes it again.
async function expectArchiveRoot(page: Page, listbox: Locator, archive: string, rows: readonly string[]): Promise<ArchiveBrowserPO> {
	const browser = await openArchive(page, listbox, archive)
	const [first] = rows

	await expect(browser.list).toHaveAccessibleName(`Contents of ${archive}`, { timeout: LISTING_TIMEOUT_MS })

	if (first !== undefined) {
		await expect(browser.row(first)).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
	}

	await expectRows(browser.list, rows)

	return browser
}

// ── The format matrix ───────────────────────────────────────────────────────────────────────────────

interface MatrixJob {
	key: string
	// "tree": the source directory; "single": the source text file.
	source: "tree" | "single"
	format: RegExp
	extension: string
	// zip and 7z: the method, named in the archive's name, run at level 1 (none for the stored ones).
	method?: { label: string; leveled: boolean; solid?: false }
}

const TAR_JOBS: MatrixJob[] = [
	{ key: "tar.gz", source: "tree", format: /^Tarball, gzip /, extension: ".tar.gz" },
	{ key: "tar.xz", source: "tree", format: /^Tarball, xz /, extension: ".tar.xz" },
	{ key: "tar.zst", source: "tree", format: /^Tarball, Zstandard /, extension: ".tar.zst" },
	{ key: "tar", source: "tree", format: /^Tarball, uncompressed /, extension: ".tar" },
	{ key: "tar.bz2", source: "tree", format: /^Tarball, bzip2 /, extension: ".tar.bz2" },
	{ key: "tar.lz4", source: "tree", format: /^Tarball, LZ4 /, extension: ".tar.lz4" },
	{ key: "tar.br", source: "tree", format: /^Tarball, Brotli /, extension: ".tar.br" },
	{ key: "tar.lz", source: "tree", format: /^Tarball, lzip /, extension: ".tar.lz" },
	{ key: "tar.lzma", source: "tree", format: /^Tarball, LZMA /, extension: ".tar.lzma" }
]

const SINGLE_JOBS: MatrixJob[] = [
	{ key: "gz", source: "single", format: /^gzip /, extension: ".gz" },
	{ key: "bz2", source: "single", format: /^bzip2 /, extension: ".bz2" },
	{ key: "xz", source: "single", format: /^xz /, extension: ".xz" },
	{ key: "lzma", source: "single", format: /^LZMA /, extension: ".lzma" },
	{ key: "lz", source: "single", format: /^lzip /, extension: ".lz" },
	{ key: "lz4", source: "single", format: /^LZ4 /, extension: ".lz4" },
	{ key: "br", source: "single", format: /^Brotli /, extension: ".br" },
	{ key: "zst", source: "single", format: /^Zstandard /, extension: ".zst" }
]

const ZIP = /^ZIP \.zip/
const SEVEN_ZIP = /^7-Zip \.7z/

const METHOD_JOBS: MatrixJob[] = [
	{ key: "zip-deflate", source: "tree", format: ZIP, extension: ".zip", method: { label: "Deflate", leveled: true } },
	{ key: "zip-bzip2", source: "tree", format: ZIP, extension: ".zip", method: { label: "BZip2", leveled: true } },
	{ key: "zip-stored", source: "tree", format: ZIP, extension: ".zip", method: { label: "Stored (no compression)", leveled: false } },
	{ key: "7z-lzma2", source: "tree", format: SEVEN_ZIP, extension: ".7z", method: { label: "LZMA2", leveled: true } },
	{ key: "7z-lzma", source: "tree", format: SEVEN_ZIP, extension: ".7z", method: { label: "LZMA", leveled: true } },
	{ key: "7z-ppmd", source: "tree", format: SEVEN_ZIP, extension: ".7z", method: { label: "PPMd", leveled: true } },
	{ key: "7z-bzip2", source: "tree", format: SEVEN_ZIP, extension: ".7z", method: { label: "BZip2", leveled: true } },
	{ key: "7z-deflate", source: "tree", format: SEVEN_ZIP, extension: ".7z", method: { label: "Deflate", leveled: true } },
	{ key: "7z-copy", source: "tree", format: SEVEN_ZIP, extension: ".7z", method: { label: "Copy (no compression)", leveled: false } },
	{
		key: "7z-nonsolid",
		source: "tree",
		format: SEVEN_ZIP,
		extension: ".7z",
		method: { label: "LZMA2", leveled: true, solid: false }
	}
]

const ALL_JOBS = [...TAR_JOBS, ...SINGLE_JOBS, ...METHOD_JOBS]

// Off Chromium: one of each family. The codecs are the same wasm in every engine, so the sub-sample
// proves the engine runs them; Chromium proves every one.
const SUBSAMPLE_KEYS = ["zip-deflate", "7z-lzma2", "tar.gz", "tar.xz", "gz"]
const FULL_EXTRACT_KEYS = ["tar.lz4", "zst", "7z-ppmd"]
const SUBSAMPLE_EXTRACT_KEYS = ["tar.xz", "gz", "7z-lzma2"]

test.describe.configure({ mode: "default" })

test.describe("archive compress", () => {
	test("the presets name the archive after what is compressed, and a second run keeps both", async ({ page }) => {
		await withArchiveScratch(page, "compress-presets", async ({ listbox, scratchName, runId }) => {
			const file = `e2e-c-one-${runId}.txt`
			const directory = `e2e-c-dir-${runId}`
			const inner = `e2e-c-inner-${runId}.txt`

			await uploadFiles(page, [textFile(file, `one ${runId}\n`)], listbox)
			await createDirectoryViaDialog(page, directory, listbox)
			await descendInto(page, listbox, directory)
			await uploadFiles(page, [textFile(inner, `inner ${runId}\n`)], listbox)
			await backTo(page, scratchName)

			// One file: its name without the extension.
			await compressPreset(page, listbox, [file], "ZIP (.zip)")
			await expectExactJobCard(page, compressedTitle(1, `e2e-c-one-${runId}.zip`))
			await expect(itemRow(listbox, `e2e-c-one-${runId}.zip`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await clearJobCards(page, ["compress", "extract"])

			// One directory: its name.
			await compressPreset(page, listbox, [directory], "7-Zip (.7z)")
			await expectExactJobCard(page, compressedTitle(1, `${directory}.7z`))
			await expect(itemRow(listbox, `${directory}.7z`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await clearJobCards(page, ["compress", "extract"])

			// Several: the directory they sit in.
			await compressPreset(page, listbox, [file, directory], "Tarball (.tar.gz)")
			await expectExactJobCard(page, compressedTitle(2, `${scratchName}.tar.gz`))
			await expect(itemRow(listbox, `${scratchName}.tar.gz`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await clearJobCards(page, ["compress", "extract"])
			await clearSelection(page)

			// The same name again: the SDK keeps both, and the card names the archive as it was saved.
			await compressPreset(page, listbox, [file], "ZIP (.zip)")
			await expectExactJobCard(page, compressedTitle(1, `e2e-c-one-${runId} (1).zip`))
			await expect(itemRow(listbox, `e2e-c-one-${runId} (1).zip`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(itemRow(listbox, `e2e-c-one-${runId}.zip`)).toBeVisible()
			await clearJobCards(page, ["compress", "extract"])

			// Each archive holds what was compressed, a directory as itself.
			for (const archive of [`e2e-c-one-${runId}.zip`, `e2e-c-one-${runId} (1).zip`]) {
				const browser = await expectArchiveRoot(page, listbox, archive, [file])

				await browser.close()
			}

			let browser = await expectArchiveRoot(page, listbox, `${directory}.7z`, [directory])

			await browser.into(directory)
			await expectRows(browser.list, [inner])
			await browser.close()

			browser = await expectArchiveRoot(page, listbox, `${scratchName}.tar.gz`, [file, directory])
			await browser.into(directory)
			await expectRows(browser.list, [inner])
			await browser.close()

			// At the drive root the default name is "Archive". Only looked at: nothing is ever written there.
			await clickSidebarLink(page, "Cloud Drive", /\/drive$/)

			const root = await waitForListingSettled(page)
			const dialog = await openCompressDialog(page, root.listbox, [scratchName, readFixtureManifest().fixtureRoot])

			await expect(dialog.nameInput).toHaveValue("Archive")
			await dialog.cancel()
			await clearSelection(page)
		})
	})

	test("the options dialog's password, AES strength, encrypted names and level reach the archive", async ({ page }) => {
		await withArchiveScratch(page, "compress-options", async ({ listbox, scratchName, runId }) => {
			const first = `e2e-c2-a-${runId}.txt`
			const second = `e2e-c2-b-${runId}.txt`
			const dest = `dest-${runId}`
			const password = `e2e-pw-${runId}`
			const aes256 = `e2e-c-aes256-${runId}`
			const aes128 = `e2e-c-aes128-${runId}`
			const hidden = `e2e-c-hidden-${runId}`
			const xz = `e2e-c-xz-${runId}`
			const sources = [first, second]

			await uploadFiles(page, [textFile(first, `first ${runId}\n`), textFile(second, `second ${runId}\n`)], listbox)
			await createDirectoryViaDialog(page, dest, listbox)

			const submitted = async (dialog: CompressDialogPO, archive: string): Promise<void> => {
				await dialog.submit()
				await expect(dialog.dialog).toHaveCount(0)
				await expectExactJobCard(page, compressedTitle(2, archive))
				await expect(itemRow(listbox, archive)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
				await clearJobCards(page, ["compress", "extract"])
			}

			// ZIP, AES-256: a mismatched confirmation is refused first.
			let dialog = await openCompressDialog(page, listbox, sources)

			await dialog.format(ZIP)
			await dialog.name(aes256)
			await dialog.protect(password, `${password}-typo`)
			await dialog.submit()
			await expect(dialog.dialog.getByText("The passwords don't match")).toBeVisible()
			await dialog.dialog.getByLabel("Confirm password", { exact: true }).fill(password)
			await expect(dialog.dialog.getByText("The passwords don't match")).toHaveCount(0)
			await dialog.advanced()
			await dialog.aes("AES-256")
			await submitted(dialog, `${aes256}.zip`)

			// ZIP, AES-128.
			dialog = await openCompressDialog(page, listbox, sources)
			await dialog.format(ZIP)
			await dialog.name(aes128)
			await dialog.protect(password)
			await dialog.advanced()
			await dialog.aes("AES-128")
			await submitted(dialog, `${aes128}.zip`)

			// 7-Zip with its names encrypted too.
			dialog = await openCompressDialog(page, listbox, sources)
			await dialog.format(SEVEN_ZIP)
			await dialog.name(hidden)
			await dialog.protect(password)
			await dialog.encryptNames(true)
			await submitted(dialog, `${hidden}.7z`)

			// Tarball, xz at its highest level for the default 128 MiB of archive memory.
			dialog = await openCompressDialog(page, listbox, sources)
			await dialog.format(/^Tarball, xz /)
			await dialog.name(xz)
			await dialog.slider().focus()
			await page.keyboard.press("End")
			expect(await dialog.range()).toEqual({ min: 0, max: 6 })
			await expect(dialog.slider()).toHaveAttribute("aria-valuenow", "6")
			await expect(dialog.levelLine()).toHaveText(/^Level 6 · /)
			await submitted(dialog, `${xz}.tar.xz`)

			// Both zips list their entries as encrypted until the password is given.
			for (const archive of [`${aes256}.zip`, `${aes128}.zip`]) {
				const browser = await expectArchiveRoot(page, listbox, archive, sources)
				const banner = browser.status("Some entries are encrypted. Extracting them needs the password.")

				await expect(browser.row(first)).toHaveAccessibleName(/(^|\s)Encrypted(\s|$)/)
				await expect(banner).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
				await browser.overlay.getByRole("button", { name: "Enter password", exact: true }).click()
				await browser.unlock(password)
				await expect(browser.status("Checking the password…")).toHaveCount(0, { timeout: LISTING_TIMEOUT_MS })
				await expect(banner).toHaveCount(0)
				await browser.close()
			}

			// The 7z hides even its names: the prompt comes before any row. While it is up, its markOthers
			// hides the overlay from role queries, so the banner behind it is found by its text alone.
			const browser = await openArchive(page, listbox, `${hidden}.7z`)

			await expect(archivePasswordPrompt(page)).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
			await expect(page.getByText("This archive's contents are encrypted.", { exact: true })).toBeVisible()
			await expect(browser.list.getByRole("option")).toHaveCount(0)
			await browser.unlock(password)
			await expect(browser.row(first)).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
			await expectRows(browser.list, sources)

			// The password the listing took goes with the extract: no prompt, the files land.
			await browser.check(browser.row(first))
			await browser.check(browser.row(second))
			await browser.extractSelected({ tree: [scratchName, dest] })
			await expectExactJobCard(page, `Extracted ${hidden}.7z → ${dest}`, { hover: false })
			await expect(page.getByRole("dialog", { name: EXTRACT_PASSWORD_DIALOG })).toHaveCount(0)
			await browser.close()
			await clearJobCards(page, ["compress", "extract"])

			const tarball = await expectArchiveRoot(page, listbox, `${xz}.tar.xz`, sources)

			await tarball.close()

			await descendInto(page, listbox, dest)
			await descendInto(page, listbox, hidden)
			await expect(itemRow(listbox, first)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(itemRow(listbox, second)).toBeVisible()
			await backTo(page, scratchName)

			// The dialog reopens on the last format and its options, never with a password or a disposal.
			dialog = await openCompressDialog(page, listbox, sources)
			await expect(dialog.formatTrigger).toHaveText(/^Tarball, xz/)
			await expect(dialog.slider()).toHaveAttribute("aria-valuenow", "6")
			await expect(dialog.protectSwitch).toBeDisabled()
			await expect(dialog.dialog.getByRole("radio", { name: "Keep the originals", exact: true })).toBeChecked()
			await dialog.format(SEVEN_ZIP)
			await expect(dialog.protectSwitch).toHaveAttribute("aria-checked", "false")
			await dialog.advanced()
			await expect(dialog.dialog.getByRole("combobox", { name: "Method", exact: true })).toHaveText(/^LZMA2/)
			await dialog.format(ZIP)
			await dialog.protectSwitch.click()
			await expect(dialog.protectSwitch).toHaveAttribute("aria-checked", "true")
			await expect(dialog.dialog.getByLabel("Password", { exact: true })).toHaveValue("")
			await expect(dialog.dialog.getByRole("combobox", { name: "Encryption strength", exact: true })).toHaveText(/^AES-128/)
			await dialog.cancel()
			await clearSelection(page)
		})
	})

	test("moving the originals to the trash afterwards leaves only the archive and says so in the report", async ({ page }) => {
		await withArchiveScratch(page, "compress-trash", async ({ listbox, scratchName, runId }) => {
			const sources = [`e2e-c-trash-a-${runId}.txt`, `e2e-c-trash-b-${runId}.txt`]
			const archive = `${scratchName}.zip`

			await uploadFiles(
				page,
				sources.map(name => textFile(name, `trash ${name}\n`)),
				listbox
			)

			const dialog = await openCompressDialog(page, listbox, sources)

			await expect(dialog.nameInput).toHaveValue(scratchName)
			await dialog.format(ZIP)
			await dialog.afterwards("Move the originals to the trash")
			await dialog.submit()
			await expect(dialog.dialog).toHaveCount(0)

			const card = await expectExactJobCard(page, compressedTitle(2, archive))
			const report = await openReport(page, card)

			const removed = reportSection(report, "Originals removed")

			// Collapsed by default: the heading, "Originals removed 2", opens it.
			await expect(removed).toHaveAccessibleName("Originals removed 2")
			await expect(removed).toHaveAttribute("aria-expanded", "false")
			await removed.click()
			await expect(reportRows(report)).toHaveCount(2)

			for (const name of sources) {
				await expect(reportRow(report, name)).toContainText("Moved to the trash")
			}

			await page.keyboard.press("Escape")
			await expect(report).toHaveCount(0)
			await clearJobCards(page, ["compress", "extract"])
			await clearSelection(page)

			await expect(itemRow(listbox, archive)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			for (const name of sources) {
				await expect(itemRow(listbox, name)).toHaveCount(0)
			}

			// "e2e-" names: the run's debris sweep takes them out of the trash later.
			await expectInTrash(page, sources)
		})
	})

	test("deleting the originals permanently asks first, and the archive still opens with its password", async ({ page }) => {
		await withArchiveScratch(page, "compress-delete", async ({ listbox, scratchName, runId }) => {
			const base = `e2e-c-del-${runId}`
			const source = `${base}.txt`
			const archive = `${base}.zip`
			const password = `e2e-pw-${runId}`
			const text = `delete me ${runId}`

			await uploadFiles(page, [textFile(source, `${text}\n`)], listbox)

			const dialog = await openCompressDialog(page, listbox, [source])

			await dialog.format(ZIP)
			await dialog.protect(password)
			await dialog.afterwards("Delete the originals permanently")
			await dialog.submit()

			const confirm = deleteConfirm(page)

			await expect(confirm).toContainText("downloaded again and checked")
			await expect(confirm).toContainText("The check uses the password you typed, which is why it was entered twice.")
			await dialog.confirmDelete()
			await expect(dialog.dialog).toHaveCount(0)

			// Checked by downloading it again before the original goes.
			const card = await expectExactJobCard(page, compressedTitle(1, archive), { timeout: ARCHIVE_JOB_TIMEOUT_MS })
			const report = await openReport(page, card)

			await reportSection(report, "Originals removed").click()
			await expect(reportRow(report, source)).toContainText("Deleted permanently")
			await page.keyboard.press("Escape")
			await expect(report).toHaveCount(0)
			await clearJobCards(page, ["compress", "extract"])

			await expect(itemRow(listbox, archive)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(itemRow(listbox, source)).toHaveCount(0)

			// The archive is good: it extracts with the password into a new directory beside it.
			const extract = await openExtractDialog(page, listbox, archive)

			await expect(extract.folderNameInput).toHaveValue(base)
			await extract.password(password)
			await extract.submit()
			await expect(extract.dialog).toHaveCount(0)
			await expectExactJobCard(page, `Extracted ${archive} → ${scratchName}`)
			await clearJobCards(page, ["compress", "extract"])

			await descendInto(page, listbox, base)
			await expectTextPreview(page, listbox, source, text)
		})
	})

	test("a compress stops on request, paused or running, and leaves nothing behind", async ({ page, browserName }) => {
		await withArchiveScratch(page, "compress-cancel", async ({ listbox, scratchName, runId, holds }) => {
			const waiting = `e2e-c-wait-${runId}.txt`
			const paused = `e2e-c-cancel-${runId}.zip`
			const waitingArchive = `e2e-c-wait-${runId}.zip`

			await uploadFiles(page, [textFile(waiting, `wait ${runId}\n`)], listbox)

			// The 24 MiB fixture file, saved into the scratch directory: the fixture tree only gives.
			const startFromFixture = async (base: string): Promise<void> => {
				await clickSidebarLink(page, "Cloud Drive", /\/drive$/)

				const fixture = await openFixtureRows(page, "download-cancel")
				const dialog = await openCompressDialog(page, fixture.listbox, [DOWNLOAD_CANCEL])

				await dialog.format(ZIP)
				await dialog.name(base)
				await expect(dialog.dialog.getByRole("radio", { name: "Keep the originals", exact: true })).toBeChecked()
				await dialog.changeDestination([scratchName])
				await dialog.submit()
				await expect(dialog.dialog).toHaveCount(0)
			}

			const toScratch = async (): Promise<void> => {
				await clickSidebarLink(page, "Cloud Drive", /\/drive$/)

				const root = await waitForListingSettled(page)

				await descendInto(page, root.listbox, scratchName)
			}

			const prompt = stopPrompt(page, "compress")
			const keepGoing = prompt.getByRole("button", { name: "Continue compressing", exact: true })
			const stop = prompt.getByRole("button", { name: "Stop compressing", exact: true })

			// Paused at once: deterministic, and it keeps the page's one archive slot.
			await startFromFixture(`e2e-c-cancel-${runId}`)

			const pausedCard = jobCard(page, paused)

			await expect(pausedCard).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await pausedCard.hover()
			await pauseFirst(pausedCard)

			// A second compress waits for the slot, and the paused one says it holds it.
			await toScratch()
			await compressPreset(page, listbox, [waiting], "ZIP (.zip)")

			const waitingCard = jobCard(page, waitingArchive)

			await expect(waitingCard).toContainText("Waiting for another archive job", { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(pausedCard).toContainText(
				"This paused job holds the only archive slot. Other archive jobs wait until it resumes or stops."
			)
			// The newest card is the front one; hiding it brings the paused one forward (its job runs on).
			await waitingCard.getByRole("button", { name: "Hide compress progress", exact: true }).click()
			await expect(waitingCard).toHaveCount(0)

			await openStopPrompt(page, pausedCard, "compress")
			await expect(prompt).toContainText("Stopping leaves nothing behind.")
			// At phone width the prompt's buttons stack, each whole on screen.
			await expectStackedAtPhoneWidth(page, prompt, ["Continue compressing", "Stop compressing"])
			await keepGoing.click()
			await expect(prompt).toHaveCount(0)
			await expect(pausedCard).toContainText("Paused")

			await openStopPrompt(page, pausedCard, "compress")
			await stop.click()
			await expect(prompt).toHaveCount(0)
			await expect(pausedCard).toContainText("Stopped. Nothing was left behind.", { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(pausedCard.getByText(`Compress into ${paused}`, { exact: true })).toBeVisible()

			// The slot is free: the waiting compress runs, the stopped one left no archive.
			await expect(itemRow(listbox, waitingArchive)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(itemRow(listbox, paused)).toHaveCount(0)
			await clearJobCards(page, ["compress", "extract"])

			// Running, its downloads held: WebKit does not route the SDK worker's requests (the paused leg
			// above is its stop coverage).
			const hold = await holdChunks(page, browserName, { hosts: "egest" })

			holds.push(hold)

			if (hold === null) {
				return
			}

			const held = `e2e-c-held-${runId}.zip`

			await startFromFixture(`e2e-c-held-${runId}`)

			const heldCard = jobCard(page, held)

			await expect(heldCard).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect.poll(() => hold.held(), { timeout: LIVE_WRITE_TIMEOUT_MS }).toBeGreaterThan(0)
			await expect(heldCard).not.toContainText("Paused")
			await openStopPrompt(page, heldCard, "compress")
			await expect(prompt).toContainText("Stopping leaves nothing behind.")
			await stop.click()
			await expect(prompt).toHaveCount(0)
			// The stop is asked for first; the held chunks then go and the job ends on it.
			hold.release()
			await expect(heldCard).toContainText("Stopped. Nothing was left behind.", { timeout: LIVE_WRITE_TIMEOUT_MS })
			await hold.dispose()
			await clearJobCards(page, ["compress", "extract"])

			await toScratch()
			await expect(itemRow(listbox, waitingArchive)).toBeVisible()
			await expect(itemRow(listbox, held)).toHaveCount(0)
		})
	})

	test("every format and method round-trips through the real codecs", async ({ page, browserName }) => {
		const full = browserName === "chromium" || process.env["E2E_ARCHIVE_FULL_MATRIX"] === "1"

		if (full) {
			// 27 compresses, a listing of each and three extracts, on top of the scratch brackets.
			test.setTimeout(1_200_000)
		}

		const jobs = full ? ALL_JOBS : ALL_JOBS.filter(job => SUBSAMPLE_KEYS.includes(job.key))
		const extractKeys = full ? FULL_EXTRACT_KEYS : SUBSAMPLE_EXTRACT_KEYS

		await withArchiveScratch(page, "compress-matrix", async ({ listbox, scratchName, runId }) => {
			const sourceDir = `e2e-m-src-${runId}`
			const note = `e2e-m-note-${runId}.txt`
			const alpha = `alpha ${runId}`
			const bravo = `bravo ${runId}`
			const noteText = `note ${runId}`
			const alphaBytes = Buffer.byteLength(`${alpha}\n`)
			const bravoBytes = Buffer.byteLength(`${bravo}\n`)
			const noteBytes = Buffer.byteLength(`${noteText}\n`)
			const archiveName = (job: MatrixJob): string =>
				job.method === undefined
					? `${job.source === "tree" ? sourceDir : note}${job.extension}`
					: `e2e-m-${job.key}-${runId}${job.extension}`
			const destOf = (key: string): string => `e2e-m-dest-${key}-${runId}`

			// The sources, and an empty destination per extract.
			await createDirectoryViaDialog(page, sourceDir, listbox)
			await descendInto(page, listbox, sourceDir)
			await uploadFiles(page, [textFile("a.txt", `${alpha}\n`)], listbox)
			await createDirectoryViaDialog(page, "nested", listbox)
			await descendInto(page, listbox, "nested")
			await uploadFiles(page, [textFile("b.txt", `${bravo}\n`)], listbox)
			await backTo(page, scratchName)
			await uploadFiles(page, [textFile(note, `${noteText}\n`)], listbox)

			for (const key of extractKeys) {
				await createDirectoryViaDialog(page, destOf(key), listbox)
			}

			for (const job of jobs) {
				const name = archiveName(job)
				const dialog = await openCompressDialog(page, listbox, [job.source === "tree" ? sourceDir : note])

				await dialog.format(job.format)

				if (job.method === undefined) {
					// The default name and level.
					await expect(dialog.suffix()).toHaveText(job.extension)
				} else {
					await dialog.name(name.slice(0, -job.extension.length))
					await dialog.advanced()
					await dialog.method(job.method.label)

					if (job.method.leveled) {
						await dialog.level(1)
					} else {
						await expect(dialog.dialog.getByText("No compression", { exact: true })).toBeVisible()
					}

					if (job.method.solid === false) {
						await dialog.solid(false)
					}
				}

				await dialog.submit()
				await expect(dialog.dialog).toHaveCount(0)
				await expectExactJobCard(page, compressedTitle(1, name))
				await expect(itemRow(listbox, name)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
				await clearJobCards(page, ["compress", "extract"])
			}

			// Every archive lists what went in, stepping through them in the preview's pager: walked to the
			// first slot, then forward over every one, whatever order the drive sorts them in.
			const expected = new Map(jobs.map(job => [archiveName(job), job]))
			const [firstJob] = jobs

			if (firstJob === undefined) {
				throw new Error("the matrix is empty")
			}

			const browser = await openArchive(page, listbox, archiveName(firstJob))
			const title = browser.overlay.locator("h2").first()
			const slotName = async (): Promise<string> => ((await title.textContent()) ?? "").trim()
			const previous = browser.overlay.getByRole("button", { name: "Previous file", exact: true })
			const next = browser.overlay.getByRole("button", { name: "Next file", exact: true })
			const step = async (button: Locator): Promise<void> => {
				const before = await slotName()

				await button.click()
				await expect.poll(slotName).not.toBe(before)
			}

			await expect.poll(slotName).toBe(archiveName(firstJob))

			for (let guard = 0; guard < 64 && (await previous.isEnabled()); guard++) {
				await step(previous)
			}

			const seen: string[] = []

			for (let guard = 0; guard < 64; guard++) {
				const name = await slotName()
				const job = expected.get(name)

				if (job !== undefined) {
					await expect(browser.list).toHaveAccessibleName(`Contents of ${name}`, { timeout: LISTING_TIMEOUT_MS })

					if (job.source === "single") {
						await expect(browser.row(note)).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
						await expectRows(browser.list, [note])
						await expectRowSize(browser.list, note, formatBytes(noteBytes))
					} else {
						await expect(browser.row(sourceDir)).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
						await expectRows(browser.list, [sourceDir])
						await browser.into(sourceDir)
						await expectRows(browser.list, ["a.txt", "nested"])
						await expectRowSize(browser.list, "a.txt", formatBytes(alphaBytes))
						await browser.into("nested")
						await expectRows(browser.list, ["b.txt"])
						await expectRowSize(browser.list, "b.txt", formatBytes(bravoBytes))
					}

					seen.push(name)
				}

				if (!(await next.isEnabled())) {
					break
				}

				await step(next)
			}

			await browser.close()
			expect(seen.sort()).toEqual([...expected.keys()].sort())

			// Three back out, each straight into its own destination, and read.
			for (const key of extractKeys) {
				const job = jobs.find(candidate => candidate.key === key)

				if (job === undefined) {
					throw new Error(`no matrix job ${key}`)
				}

				const name = archiveName(job)
				const dest = destOf(key)
				const extract = await openExtractDialog(page, listbox, name)

				await extract.changeDestination([scratchName, dest])

				if (job.source === "tree") {
					await extract.root(new RegExp(`^Directly into ${dest}$`))
				}

				await extract.submit()
				await expect(extract.dialog).toHaveCount(0)
				await expectExactJobCard(page, `Extracted ${name} → ${dest}`)
				await clearJobCards(page, ["compress", "extract"])

				await descendInto(page, listbox, dest)

				if (job.source === "tree") {
					await descendInto(page, listbox, sourceDir)
					await expectTextPreview(page, listbox, "a.txt", alpha)
				} else {
					await expectTextPreview(page, listbox, note, noteText)
				}

				await backTo(page, scratchName)
			}
		})
	})

	test("at 512 MiB of archive memory a 7z runs at LZMA2 level 8 and lists", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)
		await setArchiveMemory(page, 512)

		await withArchiveScratch(
			page,
			"compress-memory",
			async ({ listbox, scratchName, runId }) => {
				const directory = `e2e-c-big-${runId}`
				const inner = `e2e-c-big-inner-${runId}.txt`

				await createDirectoryViaDialog(page, directory, listbox)
				await descendInto(page, listbox, directory)
				await uploadFiles(page, [textFile(inner, `big ${runId}\n`)], listbox)
				await backTo(page, scratchName)

				const dialog = await openCompressDialog(page, listbox, [directory])

				await dialog.format(SEVEN_ZIP)
				await dialog.advanced()
				await dialog.method("LZMA2")
				await dialog.slider().focus()
				await page.keyboard.press("End")
				expect((await dialog.range()).max).toBe(8)
				await expect(dialog.slider()).toHaveAttribute("aria-valuenow", "8")
				await expect(dialog.levelLine()).toHaveText(/^Level 8 · uses about .+ while compressing$/)
				await dialog.submit()
				await expect(dialog.dialog).toHaveCount(0)
				await expectExactJobCard(page, compressedTitle(1, `${directory}.7z`), { timeout: ARCHIVE_JOB_TIMEOUT_MS })
				await clearJobCards(page, ["compress", "extract"])

				const browser = await expectArchiveRoot(page, listbox, `${directory}.7z`, [directory])

				await browser.into(directory)
				await expectRows(browser.list, [inner])
				await browser.close()
			},
			cspViolations
		)
	})
})

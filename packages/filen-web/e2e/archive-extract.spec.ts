import type { Locator, Page } from "@playwright/test"
import { formatBytes } from "@filen/shared"
import { test, expect } from "./fixtures"
import {
	archiveStem,
	deleteConfirm,
	escapeRegExp,
	expectEntries,
	expectRows,
	expectRowSize,
	expectTextPreview,
	extractQuick,
	extractToPicker,
	extractToTree,
	itemRow,
	openArchive,
	openCompressDialog,
	openExtractDialog,
	openExtractSubmenu,
	pickTreeTarget,
	selectionBar,
	selectRows,
	uploadArchives
} from "./helpers/archive"
import {
	GATE_BIG_BLOB_BYTES,
	HOSTILE_MISLEADING_NAME,
	LOCKED_FILES,
	MANY_LINKS_COUNT,
	TREE_FILES,
	TREE_ROOT,
	ZIPCRYPTO_PASSWORD,
	noteGz,
	noteText,
	plainTreeZip,
	treeReadmeText
} from "./helpers/archiveFixtures"
import { DOWNLOAD_CANCEL_BYTES } from "./helpers/fixtureBytes"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import {
	ARCHIVE_JOB_TIMEOUT_MS,
	answerExtractPassword,
	cardButton,
	dismissExtractPassword,
	expectJobCard,
	expectStackedAtPhoneWidth,
	extractDone,
	hideJobCards,
	holdChunks,
	jobCard,
	openReport,
	openStopPrompt,
	readCardSummary,
	reportRow,
	reportRows,
	reportSection,
	settledExtractCard,
	withArchiveScratch,
	type ChunkHold
} from "./helpers/jobs"
import {
	backTo,
	breadcrumb,
	createDirectoryViaDialog,
	descendInto,
	gotoDirectory,
	openTransfers,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"

// Extracting from the drive's menus and dialogs, end to end through the SDK: every leg lands in the
// test's own scratch directory and is checked by what arrived there (rows, sizes, the text a preview
// shows). The fixture tree's archives are only ever extracted INTO an empty directory of the scratch
// one — never here, beside or with Afterwards, which would write into or remove from the shared tree.
// Anything a leg can leave in the trash on its own (Afterwards, a stop that trashes, a late wrong
// password) is named "e2e-…", so the debris sweep takes it.

const [, , , HOSTILE, , LOCKED] = FIXTURE_FILES["archive-browse"]
const [GATE_BIG] = FIXTURE_FILES["archive-gate"]
const [MANY_LINKS] = FIXTURE_FILES["archive-report"]
const [BULK_A, BULK_B, BULK_C] = FIXTURE_FILES["archive-bulk"]
const [DOWNLOAD_CANCEL] = FIXTURE_FILES["download-cancel"]

// The SDK's MAX_REPORT_RECORDS: a report lists this many entries per kind, then only counts the rest.
const REPORT_CAP = 1000

// The password the late-password leg compresses with.
const LATE_PASSWORD = "e2e-late-password"

const CANCEL_BUTTONS = ["Continue extracting", "Stop and move extracted items to trash", "Stop and keep extracted items"] as const

// A tree zip's directory: its root rows, the readme's size and text, and one level below.
async function expectTreeDirectory(page: Page, listbox: Locator, directory: string, readme: string): Promise<void> {
	await descendInto(page, listbox, directory)
	await expectEntries(listbox, TREE_ROOT)
	await expectRowSize(listbox, "readme.txt", formatBytes(Buffer.byteLength(readme)))
	await expectTextPreview(page, listbox, "readme.txt", readme)
	await descendInto(page, listbox, "photos")
	await expectEntries(listbox, ["2024", "cover.txt"])
	await expectRowSize(listbox, "cover.txt", formatBytes(Buffer.byteLength(TREE_FILES["photos/cover.txt"])))
}

// Into a directory whose name its parent shares, where descendInto's breadcrumb check would see two.
async function openNestedDirectory(page: Page, listbox: Locator, name: string): Promise<void> {
	const before = page.url()

	await itemRow(listbox, name).dblclick()
	await page.waitForURL(url => url.toString() !== before)
	await waitForListingSettled(page)
}

// Starts "Extract all" of the fixture gate tarball (8.5 MiB) from its gate into `path`, and pauses it
// at once. Off WebKit the upload chunks are held until Pause is pressed, so the job cannot finish first;
// on WebKit (no routing of worker requests) the tarball's size alone keeps it running that long.
async function pausedGateExtract(page: Page, browserName: string, path: readonly string[], holds: (ChunkHold | null)[]): Promise<Locator> {
	const hold = await holdChunks(page, browserName, { hosts: "ingest" })

	holds.push(hold)

	const card = await startGateExtract(page, path)

	await cardButton(card, "Pause").click()
	await hold?.dispose()
	await expect(card.getByText("Paused", { exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

	return card
}

async function startGateExtract(page: Page, path: readonly string[]): Promise<Locator> {
	const listbox = await gotoFixture(page, "archive-gate")
	const browser = await openArchive(page, listbox, GATE_BIG)

	await expect(browser.gate.body).toBeVisible()
	await browser.extractAll({ tree: path })
	// The overlay hides the toaster from clicks; the card is driven once it is closed.
	await browser.close()

	return expectJobCard(page, `Extracting ${GATE_BIG}`, LIVE_WRITE_TIMEOUT_MS)
}

test.describe.configure({ mode: "default" })

test.describe("archive extract", () => {
	test("the quick destinations put the archive's tree where each entry says", async ({ page }) => {
		await withArchiveScratch(page, "x-quick", async ({ listbox, scratchName, runId }) => {
			const archive = `e2e-x-plain-${runId}.zip`
			const stem = archiveStem(archive)
			const destName = `dest-${runId}`
			const readme = treeReadmeText(runId)

			await createDirectoryViaDialog(page, destName)
			await uploadArchives(page, listbox, [{ name: archive, buffer: plainTreeZip(runId) }])

			// Here, into a new directory named after the archive.
			await extractQuick(page, listbox, archive, new RegExp(`^Extract here to “${escapeRegExp(stem)}/”$`))
			await extractDone(page, archive)
			await expectTreeDirectory(page, listbox, stem, readme)
			await backTo(page, scratchName)

			// Here, straight in beside the archive.
			await extractQuick(page, listbox, archive, /^Extract here$/)
			await extractDone(page, archive)
			await expectEntries(listbox, [archive, destName, stem, ...TREE_ROOT])
			await expectTextPreview(page, listbox, "readme.txt", readme)

			// The tree submenu, into the empty destination.
			await extractToTree(page, listbox, archive, [scratchName, destName])
			await extractDone(page, archive)
			await descendInto(page, listbox, destName)
			await expectEntries(listbox, [stem])
			await expectTreeDirectory(page, listbox, stem, readme)
			await backTo(page, scratchName)

			// The picker, into the same place again: the SDK keeps both names.
			await extractToPicker(page, listbox, archive, [scratchName, destName])
			await extractDone(page, archive)
			await descendInto(page, listbox, destName)
			await expectEntries(listbox, [stem, `${stem} (1)`])
			await expectTreeDirectory(page, listbox, `${stem} (1)`, readme)
		})
	})

	test("a single compressed file extracts as the one file it holds", async ({ page }) => {
		await withArchiveScratch(page, "x-single", async ({ listbox, runId }) => {
			const archive = `e2e-x-note-${runId}.txt.gz`
			const file = `e2e-x-note-${runId}.txt`

			await uploadArchives(page, listbox, [{ name: archive, buffer: noteGz(runId) }])
			await openExtractSubmenu(page, listbox, archive)

			const here = page.getByRole("menuitem", { name: `Extract here as “${file}”`, exact: true })

			await expect(here).toBeEnabled()
			await expect(page.getByRole("menuitem", { name: /^Extract here to “/ })).toHaveCount(0)
			await here.click()
			await extractDone(page, archive)

			await expectEntries(listbox, [archive, file])
			await expectRowSize(listbox, file, formatBytes(Buffer.byteLength(noteText(runId))))
			await expectTextPreview(page, listbox, file, noteText(runId))
		})
	})

	test("the options dialog names the directory, extracts straight in, and leaves macOS metadata out or in", async ({ page }) => {
		await withArchiveScratch(page, "x-options", async ({ listbox, scratchName, runId }) => {
			const archive = `e2e-x-opts-${runId}.zip`
			const custom = `custom-${runId}`
			const direct = `direct-${runId}`
			const macKept = `mac-kept-${runId}`
			const macSkipped = `mac-skipped-${runId}`
			const readme = treeReadmeText(runId)
			const hostileDir = archiveStem(HOSTILE)

			for (const name of [direct, macKept, macSkipped]) {
				await createDirectoryViaDialog(page, name)
			}

			await uploadArchives(page, listbox, [{ name: archive, buffer: plainTreeZip(runId) }])

			// A new directory of the user's naming, beside the archive.
			let dialog = await openExtractDialog(page, listbox, archive)

			await expect(dialog.folderNameInput).toHaveValue(archiveStem(archive))
			await dialog.folderName(custom)
			await dialog.submit()
			await expect(dialog.dialog).toHaveCount(0)
			await extractDone(page, archive)
			await expectTreeDirectory(page, listbox, custom, readme)
			await backTo(page, scratchName)

			// Straight into another directory.
			dialog = await openExtractDialog(page, listbox, archive)
			await dialog.changeDestination([scratchName, direct])
			await dialog.root(/^Directly into /)
			await dialog.submit()
			await expect(dialog.dialog).toHaveCount(0)
			await extractDone(page, archive)
			await descendInto(page, listbox, direct)
			await expectEntries(listbox, TREE_ROOT)
			await expectTextPreview(page, listbox, "readme.txt", readme)

			// The hostile zip with its macOS metadata kept, then left out (the default).
			const fixture = await gotoFixture(page, "archive-browse")

			dialog = await openExtractDialog(page, fixture, HOSTILE)
			await dialog.changeDestination([scratchName, macKept])
			await dialog.skipMac(false)
			await dialog.submit()
			await expect(dialog.dialog).toHaveCount(0)
			await extractDone(page, HOSTILE)

			dialog = await openExtractDialog(page, fixture, HOSTILE)
			await dialog.changeDestination([scratchName, macSkipped])
			await dialog.submit()
			await expect(dialog.dialog).toHaveCount(0)

			// The hostile zip: __MACOSX/._ok.txt and ._readme.txt are its two AppleDouble files.
			const card = await settledExtractCard(page, HOSTILE)

			await card.getByRole("button", { name: "Details", exact: true }).click()
			await expect(card.getByText("2 of them were macOS metadata.", { exact: true })).toBeVisible()
			await hideJobCards(page, ["extract"])

			// __MACOSX is no dot-file, so the Show hidden items filter never hides it.
			const kept = await gotoDirectory(page, [scratchName, macKept, hostileDir])

			await expect(itemRow(kept, "ok.txt")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(itemRow(kept, "__MACOSX")).toBeVisible()

			const skipped = await gotoDirectory(page, [scratchName, macSkipped, hostileDir])

			await expect(itemRow(skipped, "ok.txt")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(itemRow(skipped, "__MACOSX")).toHaveCount(0)
		})
	})

	test("Afterwards moves an own archive to the trash, or deletes it, once its contents are out", async ({ page }) => {
		await withArchiveScratch(page, "x-dispose", async ({ listbox, runId }) => {
			const trashed = `e2e-x-dispose-a-${runId}.zip`
			const deleted = `e2e-x-dispose-b-${runId}.zip`

			await uploadArchives(page, listbox, [
				{ name: trashed, buffer: plainTreeZip(runId) },
				{ name: deleted, buffer: plainTreeZip(runId) }
			])

			const expectRemoved = async (archive: string, note: "Moved to the trash" | "Deleted permanently"): Promise<void> => {
				const report = await openReport(page, await settledExtractCard(page, archive))
				const removed = reportSection(report, "Originals removed")

				// A list nobody needs to read: it starts collapsed.
				await expect(removed).toHaveAttribute("aria-expanded", "false")
				await removed.click()
				await expect(reportRow(report, archive)).toContainText(note)
				await page.keyboard.press("Escape")
				await expect(report).toHaveCount(0)
				await hideJobCards(page, ["extract"])
				await expect(itemRow(listbox, archive)).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
				await expect(itemRow(listbox, archiveStem(archive))).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			}

			let dialog = await openExtractDialog(page, listbox, trashed)

			await dialog.afterwards("Move the archive to the trash")
			await dialog.submit()
			await expect(dialog.dialog).toHaveCount(0)
			await expectRemoved(trashed, "Moved to the trash")

			dialog = await openExtractDialog(page, listbox, deleted)
			await dialog.afterwards("Delete the archive permanently")
			await dialog.submit()
			await expect(deleteConfirm(page)).toContainText(
				"Once everything is extracted and checked, the archive is deleted permanently. It will not be in the trash."
			)
			await dialog.confirmDelete()
			await expect(dialog.dialog).toHaveCount(0)
			await expectRemoved(deleted, "Deleted permanently")

			await expectTreeDirectory(page, listbox, archiveStem(deleted), treeReadmeText(runId))
		})
	})

	test("a hostile zip extracts what is safe, and its report says what was left out and why", async ({ page }) => {
		await withArchiveScratch(page, "x-hostile", async ({ scratchName, runId }) => {
			const destName = `dest-${runId}`
			const hostileDir = archiveStem(HOSTILE)

			await createDirectoryViaDialog(page, destName)
			await extractToTree(page, await gotoFixture(page, "archive-browse"), HOSTILE, [scratchName, destName])

			const card = await settledExtractCard(page, HOSTILE)

			// Extracted: ok.txt, docs/readme.txt, abs/rooted.txt, the misleading name, the second dup.txt.
			// Skipped: the symlink, ../escape.txt, the 257-segment path and the two AppleDouble files. The
			// first dup.txt is a duplicate, which the report lists apart.
			expect(await readCardSummary(card)).toEqual({ extracted: 5, skipped: 5, failed: 0 })
			await expect(
				card.getByText(
					"1 extracted name holds hidden characters that can make it look like something else. Check it before opening.",
					{ exact: true }
				)
			).toBeVisible()

			const report = await openReport(page, card)

			await expect(reportSection(report, "Symbolic links")).toBeVisible()
			await expect(reportRow(report, "link-to-ok")).toContainText("Points to ok.txt")
			await expect(reportSection(report, "Unsafe paths")).toBeVisible()
			await expect(report.getByTitle("../escape.txt", { exact: true })).toBeVisible()
			await expect(reportSection(report, "Paths nested too deeply")).toBeVisible()

			// macOS metadata starts collapsed; the misleading names open, with what they are.
			const macMetadata = reportSection(report, "macOS metadata")

			await expect(macMetadata).toHaveAttribute("aria-expanded", "false")
			await expect(report.getByTitle("._readme.txt", { exact: true })).toHaveCount(0)
			await macMetadata.click()
			await expect(report.getByTitle("._readme.txt", { exact: true })).toBeVisible()
			await expect(reportSection(report, "Misleading names")).toHaveAttribute("aria-expanded", "true")
			await expect(report.getByTitle(HOSTILE_MISLEADING_NAME.replace("‮", "⟨U+202E⟩"), { exact: true })).toBeVisible()
			await expect(
				report.getByText("Names with invisible or direction-changing characters; they may not be what they look like.", {
					exact: true
				})
			).toBeVisible()
			await expect(reportSection(report, "Duplicate names")).toBeVisible()
			await expect(report.getByTitle("dup.txt", { exact: true })).toBeVisible()

			// Show in directory opens where the extract landed, its directory selected.
			await report.getByRole("button", { name: "Show in directory", exact: true }).click()
			await expect(report).toHaveCount(0)
			await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(destName, { timeout: LIVE_WRITE_TIMEOUT_MS })

			const { listbox } = await waitForListingSettled(page)

			await expect(itemRow(listbox, hostileDir)).toHaveAttribute("aria-selected", "true")
			await hideJobCards(page, ["extract"])
			await descendInto(page, listbox, hostileDir)
			await expectEntries(listbox, ["abs", "docs", "dup.txt", HOSTILE_MISLEADING_NAME, "ok.txt"])
			// The later of the two dup.txt entries wins.
			await expectTextPreview(page, listbox, "dup.txt", "second\n")
		})
	})

	test("a report past its row cap stays virtualized and comes back through the transfers row", async ({ page }) => {
		await withArchiveScratch(page, "x-report", async ({ scratchName, runId }) => {
			const destName = `dest-${runId}`
			const omittedCount = MANY_LINKS_COUNT - REPORT_CAP

			await createDirectoryViaDialog(page, destName)
			await extractToTree(page, await gotoFixture(page, "archive-report"), MANY_LINKS, [scratchName, destName])

			let card = await settledExtractCard(page, MANY_LINKS)

			expect(await readCardSummary(card)).toEqual({ extracted: 1, skipped: MANY_LINKS_COUNT, failed: 0 })
			await hideJobCards(page, ["extract"])
			await expect(jobCard(page, MANY_LINKS)).toHaveCount(0)

			// The job's transfers row reopens its card.
			await openTransfers(page)

			const show = page.getByRole("button", { name: "Show extract progress", exact: true })

			await expect(show).toHaveCount(1)
			await show.click()
			card = await settledExtractCard(page, MANY_LINKS)

			// The report keeps REPORT_CAP links and counts the rest apart.
			const report = await openReport(page, card)
			const omitted = report.getByText(`${String(omittedCount)} more not listed`, { exact: true })

			await expect(reportSection(report, "Symbolic links")).toHaveAccessibleName(`Symbolic links ${String(REPORT_CAP)}`)
			await expect(reportRow(report, "l/00001")).toContainText("Points to ../ok.txt")
			await expect(omitted).toHaveCount(0)
			expect(await reportRows(report).count()).toBeLessThan(100)

			// The list's own scroller: the rows' nearest scrolling ancestor.
			const scroller = reportRows(report)
				.first()
				.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' overflow-y-auto ')][1]")

			await expect(async () => {
				await scroller.evaluate(element => {
					element.scrollTop = element.scrollHeight
				})
				await expect(omitted).toBeVisible({ timeout: 2_000 })
			}).toPass({ timeout: 15_000 })
			// What the SDK did not keep a record of is counted under its own heading, after the kept links.
			await expect(reportSection(report, "Other skipped items")).toHaveAccessibleName(`Other skipped items ${String(omittedCount)}`)
			expect(await reportRows(report).count()).toBeLessThan(100)

			await page.keyboard.press("Escape")
			await expect(report).toHaveCount(0)
			await hideJobCards(page, ["extract"])
			await page.getByRole("button", { name: "Clear finished", exact: true }).click()
			await expect(show).toHaveCount(0)
		})
	})

	test("an encrypted zip asks for its password, says when it is wrong, and extracts with the right one", async ({ page }) => {
		await withArchiveScratch(page, "x-password", async ({ scratchName, runId }) => {
			const destName = `dest-${runId}`

			await createDirectoryViaDialog(page, destName)
			await extractToTree(page, await gotoFixture(page, "archive-browse"), LOCKED, [scratchName, destName])

			const required = page.getByRole("dialog", { name: "Password required", exact: true })

			await expect(required).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(required).toContainText(`“${LOCKED}” is encrypted. Enter its password to extract it.`)
			await dismissExtractPassword(page)

			// Dismissed, the card keeps the way back to it.
			const card = await expectJobCard(page, "This archive is protected by a password.", LIVE_WRITE_TIMEOUT_MS)

			await cardButton(card, "Enter password").click()
			await answerExtractPassword(page, "not-the-zipcrypto-password", { expectTitle: "Password required" })
			await expect(page.getByRole("dialog", { name: "Wrong password", exact: true })).toContainText(
				`That password didn't open “${LOCKED}”. Try again.`,
				{ timeout: LIVE_WRITE_TIMEOUT_MS }
			)
			await answerExtractPassword(page, ZIPCRYPTO_PASSWORD, { expectTitle: "Wrong password" })
			await extractDone(page, LOCKED)

			const listbox = await gotoDirectory(page, [scratchName, destName, archiveStem(LOCKED)])

			await expectEntries(listbox, ["inner", "secret.txt"])
			await expectTextPreview(page, listbox, "secret.txt", LOCKED_FILES["secret.txt"])
			await descendInto(page, listbox, "inner")
			await expectEntries(listbox, ["more.txt"])
		})
	})

	test("a wrong password found only once extracting began trashes the directory it made", async ({ page, browserName }) => {
		test.skip(
			browserName !== "chromium" && process.env["E2E_ARCHIVE_FULL_MATRIX"] !== "1",
			"the SDK's late-password path is browser-independent and moves about 48 MiB; E2E_ARCHIVE_FULL_MATRIX=1 runs it everywhere"
		)
		test.setTimeout(1_200_000)

		await withArchiveScratch(page, "x-latepw", async ({ scratchName, runId }) => {
			// A 7z whose data is encrypted and whose names are not: its one file (24 MiB) is past the SDK's
			// 16 MiB password probe, so a wrong password shows only once that file is opened.
			const stem = `e2e-x-late-${runId}`
			const archive = `${stem}.7z`
			const compress = await openCompressDialog(page, await gotoFixture(page, "download-cancel"), [DOWNLOAD_CANCEL])

			await compress.name(stem)
			await compress.format(/^7-Zip \.7z/)
			await compress.protect(LATE_PASSWORD)
			await compress.encryptNames(false)
			await compress.changeDestination([scratchName])
			await compress.submit()
			await expect(compress.dialog).toHaveCount(0)
			await expectJobCard(page, `Compressed 1 item into ${archive}`, ARCHIVE_JOB_TIMEOUT_MS)
			await hideJobCards(page, ["compress"])

			const listbox = await gotoDirectory(page, [scratchName])

			await expect(itemRow(listbox, archive)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await extractQuick(page, listbox, archive, new RegExp(`^Extract here to “${escapeRegExp(stem)}/”$`))
			// The header says the data is encrypted: asked before anything is made.
			await answerExtractPassword(page, "not-the-password", { expectTitle: "Password required" })
			await expect(page.getByRole("dialog", { name: "Wrong password", exact: true })).toBeVisible({ timeout: ARCHIVE_JOB_TIMEOUT_MS })
			await dismissExtractPassword(page)

			// The new directory was made before the file showed the password wrong, and went to the trash.
			const card = await expectJobCard(page, "The password is wrong.", LIVE_WRITE_TIMEOUT_MS)

			await card.getByRole("button", { name: "Details", exact: true }).click()
			await expect(
				card.getByText("1 directory created before the password turned out wrong was moved to the trash.", { exact: true })
			).toBeVisible()
			await expect(itemRow(listbox, stem)).toHaveCount(0)

			await cardButton(card, "Enter password").click()
			await answerExtractPassword(page, LATE_PASSWORD, { expectTitle: "Wrong password" })
			await extractDone(page, archive, ARCHIVE_JOB_TIMEOUT_MS)

			await descendInto(page, listbox, stem)
			await expectEntries(listbox, [DOWNLOAD_CANCEL])
			await expectRowSize(listbox, DOWNLOAD_CANCEL, formatBytes(DOWNLOAD_CANCEL_BYTES))
		})
	})

	test("a bulk extract runs one job per archive, and one password serves those waiting for it", async ({ page }) => {
		await withArchiveScratch(page, "x-bulk", async ({ listbox, scratchName, runId }) => {
			const destName = `dest-${runId}`
			const ownA = `e2e-x-each-a-${runId}.zip`
			const ownB = `e2e-x-each-b-${runId}.zip`

			await createDirectoryViaDialog(page, destName)
			await uploadArchives(page, listbox, [
				{ name: ownA, buffer: plainTreeZip(runId) },
				{ name: ownB, buffer: plainTreeZip(runId) }
			])

			// Three fixture archives, two of them ZipCrypto under one password, into the tree's destination.
			const fixture = await gotoFixture(page, "archive-bulk")

			await selectRows(fixture, [BULK_A, BULK_B, BULK_C])
			await selectionBar(page).getByRole("button", { name: "Extract", exact: true }).click()
			await pickTreeTarget(page, "Extract to", [scratchName, destName], "Extract here")

			// The first encrypted one asks; once the second waits too, the prompt offers it the same password.
			const prompt = page.getByRole("dialog", { name: "Password required", exact: true })

			await expect(prompt).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(prompt).toContainText(/“e2e-bulk-[ab]\.zip” is encrypted\./)
			await expect(
				prompt.getByRole("switch", { name: "Also try it for the other archive waiting for a password", exact: true })
			).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			// Only the first job of a batch shows its card; the rest are transfers rows until something needs a look.
			await expect(jobCard(page, /e2e-bulk-/)).toHaveCount(1)
			await answerExtractPassword(page, ZIPCRYPTO_PASSWORD, { expectTitle: "Password required", applyToAll: true })
			await expect(page.getByRole("dialog", { name: /^(Password required|Wrong password)$/ })).toHaveCount(0)

			const dest = await gotoDirectory(page, [scratchName, destName])
			const letters = ["a", "b", "c"] as const

			await expectEntries(
				dest,
				letters.map(letter => `e2e-bulk-${letter}`)
			)

			for (const letter of letters) {
				await descendInto(page, dest, `e2e-bulk-${letter}`)
				await expectEntries(dest, [`${letter}.txt`])
				await expectTextPreview(page, dest, `${letter}.txt`, `bulk ${letter}\n`)
				await backTo(page, destName)
			}

			// Two own archives, each into its own new directory beside it.
			await hideJobCards(page, ["extract"])

			const scratch = await gotoDirectory(page, [scratchName])

			await selectRows(scratch, [ownA, ownB])
			await selectionBar(page).getByRole("button", { name: "Extract", exact: true }).click()
			await page.getByRole("menuitem", { name: "Extract here (each into its own directory)", exact: true }).click()
			await expectEntries(scratch, [destName, ownA, ownB, archiveStem(ownA), archiveStem(ownB)])
			await expectTreeDirectory(page, scratch, archiveStem(ownA), treeReadmeText(runId))
			await backTo(page, scratchName)
			await expectTreeDirectory(page, scratch, archiveStem(ownB), treeReadmeText(runId))
		})
	})

	test("an extract stopped from its card continues, keeps what it extracted, or trashes it", async ({ page, browserName }) => {
		await withArchiveScratch(page, "x-cancel", async ({ scratchName, runId, holds }) => {
			const keepName = `keep-${runId}`
			const trashName = `trash-${runId}`
			const runningName = `running-${runId}`
			const gateDir = archiveStem(GATE_BIG)

			for (const name of [keepName, trashName, runningName]) {
				await createDirectoryViaDialog(page, name)
			}

			// Paused: Continue leaves it paused, then a stop that keeps what was made.
			let card = await pausedGateExtract(page, browserName, [scratchName, keepName], holds)
			let prompt = await openStopPrompt(page, card, "extract")

			await expect(prompt).toContainText(/Items already extracted to .*can stay there or move to the trash\./)
			await expect(prompt.getByRole("button", { name: "Stop and keep extracted items", exact: true })).toBeFocused()
			await expectStackedAtPhoneWidth(page, prompt, CANCEL_BUTTONS)
			await prompt.getByRole("button", { name: "Continue extracting", exact: true }).click()
			await expect(prompt).toHaveCount(0)
			await expect(card.getByText("Paused", { exact: true })).toBeVisible()

			prompt = await openStopPrompt(page, card, "extract")
			await prompt.getByRole("button", { name: "Stop and keep extracted items", exact: true }).click()
			await expect(prompt).toHaveCount(0)
			await expectJobCard(page, "Stopped. What was extracted so far was kept.", LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page, ["extract"])

			// With its uploads held, the job made its new directory before the pause, and the stop keeps it.
			// WebKit cannot hold them, so its pause can land before even that directory is made.
			if (browserName !== "webkit") {
				const kept = await gotoDirectory(page, [scratchName, keepName])

				await expect(itemRow(kept, gateDir)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			}

			// Paused again, then a stop that moves what was made to the trash.
			card = await pausedGateExtract(page, browserName, [scratchName, trashName], holds)
			prompt = await openStopPrompt(page, card, "extract")
			await prompt.getByRole("button", { name: "Stop and move extracted items to trash", exact: true }).click()
			await expect(prompt).toHaveCount(0)
			await expectJobCard(page, /Stopped\./, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page, ["extract"])
			await gotoDirectory(page, [scratchName, trashName])
			await expect(page.getByTestId("listing-empty")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// Running, not paused: held mid-upload, stopped into the trash. WebKit cannot hold a worker's
			// requests, and a job it cannot hold may end before the stop lands.
			const hold = await holdChunks(page, browserName, { hosts: "ingest", passFirst: 2 })

			holds.push(hold)

			if (hold !== null) {
				card = await startGateExtract(page, [scratchName, runningName])
				await expect.poll(() => hold.held(), { timeout: ARCHIVE_JOB_TIMEOUT_MS }).toBeGreaterThan(0)
				await expect(card.getByText("Paused", { exact: true })).toHaveCount(0)
				prompt = await openStopPrompt(page, card, "extract")
				await prompt.getByRole("button", { name: "Stop and move extracted items to trash", exact: true }).click()
				await expect(prompt).toHaveCount(0)
				hold.release()
				await expectJobCard(page, "Stopped. 1 extracted item was moved to the trash.", LIVE_WRITE_TIMEOUT_MS)
				await hideJobCards(page, ["extract"])
				await gotoDirectory(page, [scratchName, runningName])
				await expect(page.getByTestId("listing-empty")).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			}
		})
	})

	test("a paused extract holds the page's archive slot until it resumes", async ({ page, browserName }) => {
		await withArchiveScratch(page, "x-slot", async ({ listbox, scratchName, runId, holds }) => {
			const destName = `dest-${runId}`
			const slotZip = `e2e-x-slot-${runId}.zip`
			const gateDir = archiveStem(GATE_BIG)

			await createDirectoryViaDialog(page, destName)
			await uploadArchives(page, listbox, [{ name: slotZip, buffer: plainTreeZip(runId) }])

			const card = await pausedGateExtract(page, browserName, [scratchName, destName], holds)

			// A zip lists at once, unless a paused job holds the slot.
			const scratch = await gotoDirectory(page, [scratchName])
			let browser = await openArchive(page, scratch, slotZip)

			await expect(browser.status("Waiting for another archive job").first()).toBeVisible()
			await expect(browser.status("A paused job is holding it — resume or cancel it in Transfers.")).toBeVisible()
			await expect(browser.row("readme.txt")).toHaveCount(0)
			await browser.close()

			await card.hover()
			await cardButton(card, "Resume").click()
			await extractDone(page, GATE_BIG, ARCHIVE_JOB_TIMEOUT_MS)

			browser = await openArchive(page, scratch, slotZip)
			await expectRows(browser.list, TREE_ROOT)
			await expect(browser.status("Waiting for another archive job")).toHaveCount(0)
			await browser.close()

			// The tarball's own top directory, inside the new one named after it.
			const dest = await gotoDirectory(page, [scratchName, destName])

			await expectEntries(dest, [gateDir])
			await openNestedDirectory(page, dest, gateDir)
			await expectEntries(dest, [gateDir])
			await openNestedDirectory(page, dest, gateDir)
			await expectEntries(dest, ["blob.bin"])
			await expectRowSize(dest, "blob.bin", formatBytes(GATE_BIG_BLOB_BYTES))
		})
	})
})

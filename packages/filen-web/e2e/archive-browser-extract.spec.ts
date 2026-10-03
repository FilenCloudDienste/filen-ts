import { test, expect, settleLeases } from "./fixtures"
import {
	archiveStem,
	expectEntries,
	expectRows,
	expectTextPreview,
	itemRow,
	openArchive,
	openTrash,
	pickTreeTarget,
	revealRow,
	uploadArchives,
	type ArchiveBrowserPO
} from "./helpers/archive"
import {
	LINKS_TARGET_TEXT,
	LOCKED_FILES,
	TREE_FILES,
	TREE_ROOT,
	ZIPCRYPTO_PASSWORD,
	plainTreeZip,
	treeReadmeText
} from "./helpers/archiveFixtures"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { extractDone, jobCard, withArchiveScratch } from "./helpers/jobs"
import { backTo, createDirectoryViaDialog, descendInto, gotoDirectory, selectAndTrashRow, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"

// Extracting from inside the archive browser: a selection, with its paths taken relative to the
// directory shown, or the whole archive, each to wherever its menu says. Every leg lands in the test's
// own scratch directory; the fixture tree's archives are only extracted into an empty directory there,
// never next to themselves.

const [, , , , LINKS, LOCKED, , , TREE] = FIXTURE_FILES["archive-browse"]

test.describe.configure({ mode: "default" })

test.describe("archive browser extract", () => {
	test("Extract selected keeps paths relative to the directory shown; Extract all goes where its menu says", async ({ page }) => {
		await withArchiveScratch(page, "bx-paths", async ({ listbox, scratchName, runId }) => {
			const destName = `dest-${runId}`
			const own = `e2e-bx-tree-${runId}.zip`
			const readme = treeReadmeText(runId)

			await createDirectoryViaDialog(page, destName)
			await uploadArchives(page, listbox, [{ name: own, buffer: plainTreeZip(runId) }])

			// From inside photos/: a directory and a file. The new directory is named after photos, and
			// nothing is nested twice.
			let browser = await openArchive(page, await gotoFixture(page, "archive-browse"), TREE)

			await browser.into("photos")
			await browser.ensureChecked("2024")
			await browser.ensureChecked("cover.txt")
			await browser.extractSelected({ tree: [scratchName, destName] })
			await browser.close()
			await extractDone(page, TREE)

			const dest = await gotoDirectory(page, [scratchName, destName])

			await expectEntries(dest, ["photos"])
			await descendInto(page, dest, "photos")
			await expectEntries(dest, ["2024", "cover.txt"])
			await expectTextPreview(page, dest, "cover.txt", TREE_FILES["photos/cover.txt"])
			await descendInto(page, dest, "2024")
			await expectEntries(dest, ["x.txt", "y.txt"])
			await expectTextPreview(page, dest, "y.txt", TREE_FILES["photos/2024/y.txt"])

			// From the root, the whole archive through the picker: a new directory named after it.
			browser = await openArchive(page, await gotoFixture(page, "archive-browse"), TREE)
			await expectRows(browser.list, TREE_ROOT)
			await browser.extractAll({ picker: [scratchName, destName] })
			await browser.close()
			await extractDone(page, TREE)
			await gotoDirectory(page, [scratchName, destName])
			await expectEntries(dest, [archiveStem(TREE), "photos"])
			await descendInto(page, dest, archiveStem(TREE))
			await expectEntries(dest, TREE_ROOT)
			await expectTextPreview(page, dest, "readme.txt", TREE_FILES["readme.txt"])

			// An own archive: Extract all's button goes next to it into a new directory at once.
			const scratch = await gotoDirectory(page, [scratchName])

			browser = await openArchive(page, scratch, own)
			await expectRows(browser.list, TREE_ROOT)
			await expect(browser.overlay.getByRole("button", { name: "More places to extract to", exact: true })).toBeVisible()
			await browser.extractAll({ besideNewFolder: true })
			await browser.close()
			await extractDone(page, own)
			await expectEntries(scratch, [destName, own, archiveStem(own)])
			await descendInto(page, scratch, archiveStem(own))
			await expectEntries(scratch, TREE_ROOT)
			await expectTextPreview(page, scratch, "readme.txt", readme)
			await backTo(page, scratchName)

			// Extract selected ▸ next to the archive: the file itself, straight beside it.
			browser = await openArchive(page, scratch, own)
			await browser.ensureChecked("readme.txt")
			await browser.extractSelected({ beside: true })
			await browser.close()
			await extractDone(page, own)
			await expectEntries(scratch, [destName, own, archiveStem(own), "readme.txt"])
			await expectTextPreview(page, scratch, "readme.txt", readme)
		})
	})

	test("an archive unlocked in the browser extracts without asking for its password again", async ({ page }) => {
		await withArchiveScratch(page, "bx-locked", async ({ scratchName, runId }) => {
			const destName = `dest-${runId}`
			const encryptedBanner = "Some entries are encrypted. Extracting them needs the password."

			await createDirectoryViaDialog(page, destName)

			const browser = await openArchive(page, await gotoFixture(page, "archive-browse"), LOCKED)

			await expect(browser.status(encryptedBanner)).toBeVisible()
			await browser.overlay.getByRole("button", { name: "Enter password", exact: true }).click()
			await browser.unlock(ZIPCRYPTO_PASSWORD)
			await expect(browser.status("Checking the password…")).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(browser.status(encryptedBanner)).toHaveCount(0)

			// At the root, a selection goes into a new directory named after the archive.
			await browser.ensureChecked("secret.txt")
			await browser.extractSelected({ tree: [scratchName, destName] })
			await browser.close()
			await extractDone(page, LOCKED)
			await expect(page.getByRole("dialog", { name: /^(Password required|Wrong password)$/ })).toHaveCount(0)

			const dest = await gotoDirectory(page, [scratchName, destName, archiveStem(LOCKED)])

			await expectEntries(dest, ["secret.txt"])
			await expectTextPreview(page, dest, "secret.txt", LOCKED_FILES["secret.txt"])
		})
	})

	test("hard links pointing outside the directory shown are left out, or taken from a directory above", async ({ page }) => {
		await withArchiveScratch(page, "bx-links", async ({ scratchName, runId }) => {
			const leaveOutName = `leave-out-${runId}`
			const fromParentName = `from-parent-${runId}`
			const linksDialog = page.getByRole("dialog", { name: "Linked files outside this directory", exact: true })

			for (const name of [leaveOutName, fromParentName]) {
				await createDirectoryViaDialog(page, name)
			}

			// other/hl-out.txt is a hard link to dir/target.txt, which an extract from other/ cannot reach.
			const openOther = async (): Promise<ArchiveBrowserPO> => {
				const browser = await openArchive(page, await gotoFixture(page, "archive-browse"), LINKS)

				await browser.into("other")
				await browser.ensureChecked("hl-out.txt")
				await browser.ensureChecked("plain.txt")

				return browser
			}

			let browser = await openOther()

			// Cancel: nothing starts. Leaving the links out is the default, holding the focus.
			await browser.extractSelected({ tree: [scratchName, leaveOutName] })
			await expect(linksDialog).toContainText(
				"1 selected hard link points to a file outside “other”, which an extract from here can't include."
			)
			await expect(linksDialog.getByRole("button", { name: "Leave those links out", exact: true })).toBeFocused()
			await linksDialog.getByRole("button", { name: "Cancel", exact: true }).click()
			await expect(linksDialog).toHaveCount(0)
			await expect(jobCard(page, LINKS)).toHaveCount(0)

			// Leave the link out: only the plain file, under a new directory named after other/.
			await browser.ensureChecked("hl-out.txt")
			await browser.ensureChecked("plain.txt")
			await browser.extractSelected({ tree: [scratchName, leaveOutName] })
			await linksDialog.getByRole("button", { name: "Leave those links out", exact: true }).click()
			await expect(linksDialog).toHaveCount(0)
			await browser.close()
			await extractDone(page, LINKS)

			const leftOut = await gotoDirectory(page, [scratchName, leaveOutName])

			await expectEntries(leftOut, ["other"])
			await descendInto(page, leftOut, "other")
			await expectEntries(leftOut, ["plain.txt"])
			await expectTextPreview(page, leftOut, "plain.txt", "plain\n")

			// From the archive's root instead: the link becomes its target's content, which comes along.
			browser = await openOther()
			await browser.extractSelected({ tree: [scratchName, fromParentName] })
			await linksDialog.getByRole("button", { name: /^Extract from “.+” instead$/ }).click()
			await expect(linksDialog).toHaveCount(0)
			await browser.close()
			await extractDone(page, LINKS)

			const fromParent = await gotoDirectory(page, [scratchName, fromParentName])

			await expectEntries(fromParent, [archiveStem(LINKS)])
			await descendInto(page, fromParent, archiveStem(LINKS))
			await expectEntries(fromParent, ["dir", "other"])
			await descendInto(page, fromParent, "other")
			await expectEntries(fromParent, ["hl-out.txt", "plain.txt"])
			await expectTextPreview(page, fromParent, "hl-out.txt", LINKS_TARGET_TEXT)
			await backTo(page, archiveStem(LINKS))
			await descendInto(page, fromParent, "dir")
			await expectEntries(fromParent, ["target.txt"])
		})
	})

	test("an archive in the trash lists, and extracts only to a directory picked for it", async ({ page }) => {
		await withArchiveScratch(page, "bx-trashed", async ({ listbox, scratchName, runId }) => {
			// e2e-named: it stays in the trash after the test, for the debris sweep.
			const archive = `e2e-bx-trash-${runId}.zip`
			const destName = `dest-${runId}`

			await createDirectoryViaDialog(page, destName)
			await uploadArchives(page, listbox, [{ name: archive, buffer: plainTreeZip(runId) }])
			await selectAndTrashRow(page, listbox, archive)
			await settleLeases(page)

			const trash = await openTrash(page)

			await revealRow(trash, itemRow(trash, archive))

			const browser = await openArchive(page, trash, archive)

			await expectRows(browser.list, TREE_ROOT)

			// No directory of its own to go next to: Extract all is the menu, without those entries.
			await expect(browser.overlay.getByRole("button", { name: "More places to extract to", exact: true })).toHaveCount(0)
			await browser.overlay.getByRole("button", { name: "Extract all", exact: true }).click()

			const menu = page.getByRole("menu").last()

			await expect(menu.getByRole("menuitem", { name: "Choose destination…", exact: true })).toBeVisible()
			await expect(menu.getByRole("menuitem", { name: /next to the archive$/ })).toHaveCount(0)
			await pickTreeTarget(page, "Extract to", [scratchName, destName], "Extract here")
			await browser.close()
			await extractDone(page, archive)

			const dest = await gotoDirectory(page, [scratchName, destName])

			await expectEntries(dest, [archiveStem(archive)])
			await descendInto(page, dest, archiveStem(archive))
			await expectEntries(dest, TREE_ROOT)
			await expectTextPreview(page, dest, "readme.txt", treeReadmeText(runId))
		})
	})
})

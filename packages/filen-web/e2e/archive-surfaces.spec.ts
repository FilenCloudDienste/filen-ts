import type { Browser, Locator, Page } from "@playwright/test"
import { test, expect, settleLeases } from "./fixtures"
import { escapeRegExp, leadingNamePattern, namePattern, openRowMenu, pickDestination, waitForCompressDialog } from "./helpers/archive"
import { plainTreeZip } from "./helpers/archiveFixtures"
import { trackCspViolations } from "./helpers/csp"
import { expectJobCard, hideJobCards, observeEgest, stopAllJobs } from "./helpers/jobs"
import {
	bootTo,
	createDirectoryViaDialog,
	descendInto,
	enterScratchDirectory,
	trashScratchDirectory,
	uploadFiles,
	waitForListingSettled,
	BOOT_SETTLE_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS,
	type ListingHandle
} from "./helpers/listing"

// Archives on the surfaces beside the drive (b6-design.md): a public file link, a public directory link
// (with and without a password), a chat's link card, Shared with me. Every success path needs a public
// link the account owns, and creating one is premium, so the whole file runs only against a premium
// account (E2E_PREMIUM). Signed in, a visitor browses an archive only on a click, extracts it into their
// own drive while the link allows downloads, and saves a linked directory as an archive; signed out, they
// get Download and nothing else (the SDK's unauthenticated client cannot list an archive).

const NOT_ALLOWED_NOTE = "The link's owner doesn't allow downloads, so nothing can be extracted from it."
const LINK_PASSWORD = "e2e-link-password"

// The item's "Public link" dialog, opened from its row menu.
async function openLinkDialog(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await openRowMenu(page, listbox, name)
	await page.getByRole("menuitem", { name: "Public link", exact: true }).click()

	const dialog = page.getByRole("dialog", { name: "Public link", exact: true })

	await expect(dialog).toBeVisible()

	return dialog
}

// Creates the item's link and returns its URL (built on the app's own origin).
async function createLink(dialog: Locator): Promise<string> {
	await dialog.getByRole("button", { name: "Create public link", exact: true }).click()

	const url = dialog.getByLabel("Link", { exact: true })

	await expect(url).toHaveValue(/\/[fd]\/[0-9a-f-]+#/, { timeout: LIVE_WRITE_TIMEOUT_MS })

	return url.inputValue()
}

// Each change is a write the switch waits out (disabled while pending).
async function setLinkDownloads(dialog: Locator, on: boolean): Promise<void> {
	const allow = dialog.getByRole("switch", { name: "Allow downloads", exact: true })

	if ((await allow.getAttribute("aria-checked")) !== String(on)) {
		await allow.click()
	}

	await expect(allow).toHaveAttribute("aria-checked", String(on), { timeout: LIVE_WRITE_TIMEOUT_MS })
	await expect(allow).toBeEnabled({ timeout: LIVE_WRITE_TIMEOUT_MS })
}

async function setLinkPassword(dialog: Locator, password: string): Promise<void> {
	await dialog.getByRole("button", { name: "Set password", exact: true }).click()
	await dialog.getByPlaceholder("No password", { exact: true }).fill(password)
	await dialog.getByRole("button", { name: "Save", exact: true }).click()
	await expect(dialog.getByText("Password set", { exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
}

async function closeLinkDialog(page: Page, dialog: Locator): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(dialog).toHaveCount(0)
}

// A link page from the signed-in tab. The link was just written, so the lease is let go first.
async function visitLink(page: Page, url: string): Promise<void> {
	await settleLeases(page)
	await page.goto(url)
}

// Back on the drive at the scratch directory (the link pages have no sidebar to walk back by).
async function backToScratch(page: Page, scratchName: string): Promise<ListingHandle> {
	await bootTo(page)

	const { listbox } = await waitForListingSettled(page)

	await descendInto(page, listbox, scratchName)

	return waitForListingSettled(page)
}

// The archive browser a link page renders in place (not in the preview overlay).
function linkArchiveBrowser(page: Page): { list: Locator; extractAll: Locator; note: Locator } {
	return {
		list: page.getByRole("listbox", { name: /^Contents of / }),
		extractAll: page.getByRole("button", { name: "Extract all", exact: true }),
		note: page.getByText(NOT_ALLOWED_NOTE, { exact: true })
	}
}

// The tree zip's root, as plainTreeZip writes it.
async function expectTreeRoot(list: Locator): Promise<void> {
	for (const name of ["docs", "empty-dir", "photos", "readme.txt"]) {
		await expect(list.getByRole("option", { name: leadingNamePattern(name) })).toBeVisible({ timeout: 60_000 })
	}
}

// The "Save as archive" dialog of a linked directory, redirected from Cloud Drive (its default) into
// `path`, then submitted.
async function saveAsArchiveInto(page: Page, path: readonly string[]): Promise<void> {
	await page.getByRole("button", { name: "Save as archive", exact: true }).click()

	const dialog = await waitForCompressDialog(page, "Save as archive")

	await expect(dialog.saveIn).toHaveText("Cloud Drive")
	// A link's items are never anything the visitor may remove.
	await expect(dialog.dialog.getByRole("radio", { name: "Move the originals to the trash", exact: true })).toHaveCount(0)
	await dialog.changeDestination(path)
	await expect(dialog.saveIn).toHaveText(path.at(-1) ?? "")
	await dialog.submit()
	await expect(dialog.dialog).toHaveCount(0)
}

// A visitor with no session. WebKit keeps one OPFS per origin for the whole machine (e2e/fixtures.ts), so
// a second context there would share the signed-in tab's session: no signed-out visitor exists on WebKit.
async function signedOutVisit(
	browser: Browser,
	baseURL: string | undefined,
	url: string
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext(baseURL === undefined ? {} : { baseURL })
	const page = await context.newPage()

	await page.goto(url)

	return { page, close: () => context.close() }
}

test.describe.configure({ mode: "default" })

test.describe("archives on links, chats and shares", () => {
	test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account")

	test("a public file link: browse on a click only, extract into the drive, nothing to extract without downloads, Download only signed out", async ({
		page,
		browser,
		browserName,
		baseURL
	}) => {
		const cspViolations = trackCspViolations(page)
		const egest = observeEgest(page)
		const runId = crypto.randomUUID()
		const scratchName = `e2e-arc-link-${runId}`
		const destName = `dest-${runId}`
		const archiveName = `e2e-sf-${runId}.zip`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, destName, listbox)
			await uploadFiles(page, [{ name: archiveName, mimeType: "application/zip", buffer: plainTreeZip(runId) }], listbox)

			const dialog = await openLinkDialog(page, listbox, archiveName)
			const url = await createLink(dialog)

			await closeLinkDialog(page, dialog)

			// ---- signed in: Browse contents reads nothing until clicked ----
			await visitLink(page, url)

			const browse = page.getByRole("button", { name: "Browse contents", exact: true })
			const extractToDrive = page.getByRole("button", { name: "Extract to my Cloud Drive", exact: true })
			const linkBrowser = linkArchiveBrowser(page)

			await expect(browse).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
			await expect(extractToDrive).toBeVisible()

			const beforeBrowse = egest.count()

			// The hero card shows the archive's name and actions; none of it read the archive.
			await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible()
			expect(egest.count()).toBe(beforeBrowse)

			await browse.click()
			await expectTreeRoot(linkBrowser.list)
			// Positive control: the listing did read the archive's index.
			expect(egest.count()).toBeGreaterThan(beforeBrowse)
			await page.getByRole("button", { name: "Hide contents", exact: true }).click()
			await expect(linkBrowser.list).toHaveCount(0)

			// ---- Extract to my Cloud Drive: a pick, then the extract's own card ----
			await extractToDrive.click()
			await pickDestination(page, "Extract to", [scratchName, destName], "Extract here")
			await expectJobCard(page, new RegExp(`Extracted ${escapeRegExp(archiveName)} → `), LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)

			// ---- signed out: Download, and no archive UI at all ----
			if (browserName === "webkit") {
				test.info().annotations.push({ type: "skip-leg", description: "signed-out visitor: WebKit shares one OPFS per origin" })
			} else {
				const visitor = await signedOutVisit(browser, baseURL, url)

				try {
					await expect(visitor.page.getByRole("button", { name: "Download", exact: true })).toBeVisible({
						timeout: BOOT_SETTLE_TIMEOUT_MS
					})
					await expect(visitor.page.getByRole("button", { name: "Browse contents", exact: true })).toHaveCount(0)
					await expect(visitor.page.getByRole("button", { name: "Extract to my Cloud Drive", exact: true })).toHaveCount(0)
				} finally {
					await visitor.close()
				}
			}

			// ---- the extracted directory sits in dest; then downloads off for the link ----
			const scratch = await backToScratch(page, scratchName)

			await descendInto(page, scratch.listbox, destName)
			await expect(scratch.listbox.getByRole("option", { name: namePattern(`e2e-sf-${runId}`) })).toBeVisible({
				timeout: LIVE_WRITE_TIMEOUT_MS
			})
			await page.goBack()
			await waitForListingSettled(page)

			const downloadsDialog = await openLinkDialog(page, scratch.listbox, archiveName)

			await setLinkDownloads(downloadsDialog, false)
			await closeLinkDialog(page, downloadsDialog)

			// ---- signed in, downloads off: browsing stays, extracting goes, with the reason ----
			await visitLink(page, url)
			await expect(browse).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
			await expect(page.getByText("The owner has disabled downloads for this link.", { exact: true })).toBeVisible()
			await expect(extractToDrive).toHaveCount(0)
			await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(0)
			await browse.click()
			await expectTreeRoot(linkBrowser.list)
			await expect(linkBrowser.extractAll).toBeDisabled()
			await expect(linkBrowser.note).toBeVisible()

			expect(cspViolations).toEqual([])
		} finally {
			await bootTo(page).catch(() => undefined)
			await stopAllJobs(page)
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("a public directory link: an archive child browses, and the directory saves as an archive into the drive, with a password too", async ({
		page
	}) => {
		const cspViolations = trackCspViolations(page)
		const runId = crypto.randomUUID()
		const scratchName = `e2e-arc-dirlink-${runId}`
		const sharedName = `shared-${runId}`
		const destName = `dest-${runId}`
		const archiveName = `e2e-sd-${runId}.zip`
		const savedCard = new RegExp(`Compressed 1 item into ${escapeRegExp(sharedName)}`)

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, destName, listbox)
			await createDirectoryViaDialog(page, sharedName, listbox)
			await descendInto(page, listbox, sharedName)
			await uploadFiles(page, [{ name: archiveName, mimeType: "application/zip", buffer: plainTreeZip(runId) }], listbox)
			await page.goBack()
			await waitForListingSettled(page)

			const dialog = await openLinkDialog(page, listbox, sharedName)
			const url = await createLink(dialog)

			await closeLinkDialog(page, dialog)

			// ---- the archive child: its hero offers Browse contents, which lists it ----
			await visitLink(page, url)

			const child = page.getByRole("listitem", { name: namePattern(archiveName) })

			await expect(child).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
			await child.click()
			await page.getByRole("button", { name: "Browse contents", exact: true }).click()
			await expectTreeRoot(linkArchiveBrowser(page).list)
			await page.getByRole("button", { name: "Back to directory", exact: true }).click()
			await expect(child).toBeVisible()

			// ---- Save as archive: Cloud Drive by default, redirected into dest ----
			await saveAsArchiveInto(page, [scratchName, destName])
			await expectJobCard(page, savedCard, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)

			// ---- the same through a password link ----
			await backToScratch(page, scratchName)

			const passwordDialog = await openLinkDialog(page, listbox, sharedName)

			await setLinkPassword(passwordDialog, LINK_PASSWORD)
			await closeLinkDialog(page, passwordDialog)
			await visitLink(page, url)
			await expect(page.getByText("This link is protected with a password.", { exact: true })).toBeVisible({
				timeout: BOOT_SETTLE_TIMEOUT_MS
			})
			await page.getByLabel("Password", { exact: true }).fill(LINK_PASSWORD)
			await page.getByRole("button", { name: "Unlock", exact: true }).click()
			await expect(child).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
			await saveAsArchiveInto(page, [scratchName, destName])
			await expectJobCard(page, savedCard, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)

			// ---- both archives in dest (the second under a kept-both name) ----
			const scratch = await backToScratch(page, scratchName)

			await descendInto(page, scratch.listbox, destName)
			await expect(scratch.listbox.getByRole("option", { name: new RegExp(`^${escapeRegExp(sharedName)}`) })).toHaveCount(2, {
				timeout: LIVE_WRITE_TIMEOUT_MS
			})

			expect(cspViolations).toEqual([])
		} finally {
			await bootTo(page).catch(() => undefined)
			await stopAllJobs(page)
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("a chat's link card opens the archive browser, extracting only while the link allows downloads", () => {
		// A chat message is a chats-lane write (`chats-write` lease, `conversations/create` rate limit), which
		// this drive-lane file must not take; filenLinkCard's archive gating is covered by its component tests.
		test.skip(true, "a chat message is a chats-lane write; covered by component tests")
	})

	test("Shared with me: browse and extract a shared archive", () => {
		test.skip(true, "needs a second account sharing into this one")
	})
})

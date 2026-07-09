import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"

// Mirrors drive.spec.ts's own FIREFOX_HANG_REASON — every test below needs the listing's own
// authenticated listDir call to settle before the picker inputs are even enabled (directory-listing.tsx's
// writeDisabled gates on listingQuery.status), and that hangs indefinitely on Playwright-firefox under
// COI (see drive.spec.ts's own comment for the live-verified root cause).
const FIREFOX_HANG_REASON = "drive listing needs an authenticated listDir call, which hangs indefinitely on Playwright-firefox under COI"

// Drag-and-drop upload — both the files dropzone and a dropped directory's FileSystemEntry walk — is
// NOT covered anywhere in this suite: Playwright has no API to synthesize a real OS file drop (there is
// no way to populate a DataTransfer's `files` list or back `webkitGetAsEntry` the way an actual
// OS-level drag does), so upload-dropzone.tsx's own drop handler never fires from automation. It's
// manual-QA-only. Both tests below drive the picker inputs instead (setInputFiles), a real,
// automatable path through the exact same upload orchestration.
//
// Duplicated from drive.spec.ts/drive-actions.spec.ts/share.spec.ts rather than shared — this package
// has no cross-spec e2e helpers module yet, and every other spec file here owns its helpers locally too.
async function waitForListingSettled(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	const listbox = page.getByRole("listbox", { name: "Directory contents" })
	const empty = page.getByText("Nothing here yet")

	await expect(listbox.or(empty)).toBeVisible()

	return { listbox, hasItems: await listbox.isVisible() }
}

// Duplicated from downloads.spec.ts/drive-actions.spec.ts's own enterScratchDirectory — both uploads
// below land inside a scratch directory rather than at /drive's root: this suite runs fullyParallel
// (playwright.config.ts), and a root-level create/trash races other specs' own root-listing
// assertions (drive-actions.spec.ts's own comment documents the exact interference this once produced
// live). A generous viewport defeats virtualization so a later named-row locator can't miss a
// mounted-but-scrolled row; dblclick descends via a real client-side route change.
async function enterScratchDirectory(page: Page, name: string): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
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

	await scratchRow.dblclick()

	return waitForListingSettled(page)
}

// Duplicated from downloads.spec.ts's own trashScratchDirectory — failure-proof companion to
// enterScratchDirectory above, called from every test's own finally so the scratch directory (and
// everything uploaded into it) is trashed even when an assertion above throws. Trashing the whole
// directory covers both tests below in one step — no separate per-file trash is needed.
async function trashScratchDirectory(page: Page, name: string): Promise<void> {
	await page.keyboard.press("Escape")
	await page.getByRole("complementary").getByRole("link", { name: "My Drive", exact: true }).click()

	const { listbox } = await waitForListingSettled(page)
	const row = listbox.getByRole("option", { name })

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

test.describe("uploads", () => {
	test("picking a file uploads it through the worker and lands a row in the listing", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-upload-${runId}`
		const fileName = `e2e-upload-${runId}.txt`

		await page.goto("/drive")

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			// The unlabeled multiple picker is the first `type=file` input in DOM order (upload-menu.tsx) —
			// present regardless of visibility, and nothing is selected yet at this point in the test, so it
			// hasn't been swapped out for the bulk-action bar.
			await page
				.locator('input[type="file"]')
				.first()
				.setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("e2e upload probe") })

			const row = listbox.getByRole("option", { name: fileName })
			await expect(row).toBeVisible({ timeout: 45_000 }) // cold boot + a real upload round trip

			// The rail Transfers popover reflects this same just-finished transfer — runUpload settles the
			// store to "done" before it patches the listing (lib/drive/upload.ts), so the row above already
			// being visible guarantees the store side already settled too.
			await page
				.getByRole("button", { name: /Transfers/i })
				.first()
				.click()
			await expect(page.getByText("Done")).toBeVisible()
			await page.keyboard.press("Escape")
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("picking a directory recreates its tree and lands the top-level directory in the listing", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-dir-upload-${runId}`
		const rootName = `e2e-dir-upload-tree-${runId}`
		const base = mkdtempSync(join(tmpdir(), "filen-web-e2e-"))
		const rootPath = join(base, rootName)
		mkdirSync(join(rootPath, "sub"), { recursive: true })
		writeFileSync(join(rootPath, "a.txt"), "a")
		writeFileSync(join(rootPath, "sub", "b.txt"), "b")

		await page.goto("/drive")

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			// `#drive-upload-directory-input` carries `webkitdirectory` (set imperatively — upload-menu.tsx).
			// Playwright walks the given directory itself and stamps each File's own webkitRelativePath
			// rooted at the directory's own basename (rootName), exactly like a real OS directory pick —
			// and targets whatever directory the app is currently navigated into (directory-listing.tsx
			// passes it the current listing's own uuid), which is this scratch directory since the picker
			// mounts fresh on every navigation.
			await page.locator("#drive-upload-directory-input").setInputFiles(rootPath)

			const row = listbox.getByRole("option", { name: rootName })
			await expect(row).toBeVisible({ timeout: 60_000 }) // cold boot + a tree walk + two file uploads
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})

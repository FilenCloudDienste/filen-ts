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

// The one sanctioned mutation both tests below make: select the row this test itself uploaded, bulk
// Trash it, confirm, and verify it's gone — recoverable (trash, not permanent delete), net-zero on the
// live account, mirroring drive-actions.spec.ts's own create -> act -> trash convention.
async function trashRow(page: Page, row: ReturnType<Page["getByRole"]>): Promise<void> {
	await row.click()
	await page.getByRole("button", { name: "Trash", exact: true }).click()

	const confirm = page.getByRole("alertdialog")
	await expect(confirm).toBeVisible()
	await confirm.getByRole("button", { name: "Trash", exact: true }).click()
	await expect(confirm).toHaveCount(0)
	await expect(row).toHaveCount(0)
}

test.describe("uploads", () => {
	test("picking a file uploads it through the worker and lands a row in the listing", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const fileName = `e2e-upload-${crypto.randomUUID()}.txt`

		await page.goto("/drive")
		const { listbox } = await waitForListingSettled(page)

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

		await trashRow(page, row)
	})

	test("picking a directory recreates its tree and lands the top-level directory in the listing", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const rootName = `e2e-dir-upload-${crypto.randomUUID()}`
		const base = mkdtempSync(join(tmpdir(), "filen-web-e2e-"))
		const rootPath = join(base, rootName)
		mkdirSync(join(rootPath, "sub"), { recursive: true })
		writeFileSync(join(rootPath, "a.txt"), "a")
		writeFileSync(join(rootPath, "sub", "b.txt"), "b")

		await page.goto("/drive")
		const { listbox } = await waitForListingSettled(page)

		// `#drive-upload-directory-input` carries `webkitdirectory` (set imperatively — upload-menu.tsx).
		// Playwright walks the given directory itself and stamps each File's own webkitRelativePath
		// rooted at the directory's own basename (rootName), exactly like a real OS directory pick.
		await page.locator("#drive-upload-directory-input").setInputFiles(rootPath)

		const row = listbox.getByRole("option", { name: rootName })
		await expect(row).toBeVisible({ timeout: 60_000 }) // cold boot + a tree walk + two file uploads

		await trashRow(page, row)
	})
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, expect } from "./fixtures"
import type { Route } from "@playwright/test"
import {
	withScratchDirectory,
	bootTo,
	descendInto,
	enterScratchDirectory,
	fileInput,
	openTransfers,
	trashScratchDirectory,
	uploadFiles,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"

// Drag-and-drop upload — both the files dropzone and a dropped directory's FileSystemEntry walk — is
// NOT covered anywhere in this suite: Playwright has no API to synthesize a real OS file drop (there is
// no way to populate a DataTransfer's `files` list or back `webkitGetAsEntry` the way an actual
// OS-level drag does), so uploadDropzone.tsx's own drop handler never fires from automation. It's
// manual-QA-only. Both tests below drive the picker inputs instead (setInputFiles), a real,
// automatable path through the exact same upload orchestration.

// Held back long enough that a running upload is still on screen when the test looks for it.
const SLOW_CHUNK_DELAY_MS = 2_000

test.describe("uploads", () => {
	test("picking a file uploads it through the worker and lands a row in the listing", async ({ page }) => {
		await withScratchDirectory(page, "upload", async ({ listbox, runId }) => {
			const fileName = `e2e-upload-${runId}.txt`

			// The picker is present regardless of visibility, and nothing is selected yet at this point in the
			// test, so it hasn't been swapped out for the bulk-action bar.
			await uploadFiles(page, [{ name: fileName, mimeType: "text/plain", buffer: Buffer.from("e2e upload probe") }], listbox)

			// The rail Transfers entry navigates straight to the /transfers screen (no more popover)
			// and reflects this same just-finished transfer — runUpload settles the store to "done" before
			// it patches the listing (features/drive/lib/upload.ts), so the row above already being visible
			// guarantees the store side already settled too.
			await openTransfers(page)
			// Scoped to THIS transfer's own row (a list item named after the file, transferRow.tsx) rather
			// than the first status line anywhere on the screen.
			const transferRow = page.getByRole("listitem", { name: fileName })
			await expect(transferRow.getByText(/^Uploaded · /)).toBeVisible()
		})
	})

	test("picking a directory recreates its tree and lands the top-level directory in the listing", async ({ page }) => {
		const runId = crypto.randomUUID()
		const scratchName = `e2e-dir-upload-${runId}`
		const rootName = `e2e-dir-upload-tree-${runId}`
		const base = mkdtempSync(join(tmpdir(), "filen-web-e2e-"))
		const rootPath = join(base, rootName)
		mkdirSync(join(rootPath, "sub"), { recursive: true })
		writeFileSync(join(rootPath, "a.txt"), "a")
		writeFileSync(join(rootPath, "sub", "b.txt"), "b")

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			// The directory input carries `webkitdirectory` (set imperatively — uploadMenu.tsx). Playwright
			// walks the given directory itself and stamps each File's own webkitRelativePath rooted at the
			// directory's own basename (rootName), exactly like a real OS directory pick — and targets
			// whatever directory the app is currently navigated into (directoryListing.tsx passes it the
			// current listing's own uuid), which is this scratch directory since the picker mounts fresh on
			// every navigation. .first(): the empty scratch listing mounts the upload menu (and its hidden
			// inputs) twice — toolbar + the empty state's add affordance; the toolbar's is first in DOM.
			await page.getByRole("main").getByTestId("drive-upload-directory-input").first().setInputFiles(rootPath)

			const row = listbox.getByRole("option", { name: rootName })
			// A tree walk plus two file uploads, all on the account-wide write lease.
			await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// The top-level row alone proves nothing about the TREE: a walk that created the root and
			// dropped every child passes that assertion identically. Descend both levels and assert each
			// one's own contents.
			await descendInto(page, listbox, rootName)
			const uploadedRoot = await waitForListingSettled(page)
			await expect(uploadedRoot.listbox.getByRole("option", { name: "a.txt" })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(uploadedRoot.listbox.getByRole("option", { name: "sub" })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			await descendInto(page, uploadedRoot.listbox, "sub")
			const uploadedSub = await waitForListingSettled(page)
			await expect(uploadedSub.listbox.getByRole("option", { name: "b.txt" })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		} finally {
			await trashScratchDirectory(page, scratchName)
			// The temp tree is this test's own, and nothing else ever removes it.
			rmSync(base, { recursive: true, force: true })
		}
	})

	// The SDK's upload chunks leave from its own worker; Playwright routes a worker's requests only in Chromium.
	test("a running upload shows as the listing's first row, then gives way to the real row", async ({ page, browserName }) => {
		test.skip(browserName !== "chromium", "routing the SDK worker's own requests needs Chromium")

		await withScratchDirectory(page, "upload-pending", async ({ listbox, runId }) => {
			const fileName = `e2e-upload-pending-${runId}.bin`
			let heldChunks = 0
			const isChunk = (url: URL) => url.hostname.startsWith("ingest.filen")
			const holdChunk = async (route: Route) => {
				heldChunks++
				await new Promise<void>(resolve => {
					setTimeout(resolve, SLOW_CHUNK_DELAY_MS)
				})
				await route.continue().catch(() => undefined)
			}

			await page.context().route(isChunk, holdChunk)

			try {
				// Two chunks' worth, so the upload is still running through at least one held chunk.
				await fileInput(page).setInputFiles([
					{ name: fileName, mimeType: "application/octet-stream", buffer: Buffer.alloc(2 * 1024 * 1024, 7) }
				])

				const pending = listbox.getByRole("list", { name: "Transfers into this directory" })
				const pendingRow = pending.getByRole("listitem", { name: fileName })

				await expect(pendingRow).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
				await expect(pendingRow.getByRole("progressbar", { name: fileName })).toBeVisible()
				// A pending row is no item: never an option of the listbox, and the listing's first row.
				await expect(listbox.getByRole("option", { name: fileName })).toHaveCount(0)

				const pendingBox = await pendingRow.boundingBox()
				const listboxBox = await listbox.boundingBox()

				expect(pendingBox).not.toBeNull()
				expect(listboxBox).not.toBeNull()
				expect(Math.abs((pendingBox?.y ?? 0) - (listboxBox?.y ?? 0))).toBeLessThan(2)

				// Finished, the real row takes its place and the pending row goes.
				await expect(listbox.getByRole("option", { name: fileName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
				await expect(pendingRow).toHaveCount(0)
				expect(heldChunks).toBeGreaterThan(0)
			} finally {
				await page.context().unroute(isChunk, holdChunk)
			}
		})
	})
})

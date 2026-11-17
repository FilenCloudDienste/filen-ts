import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, expect, settleLeases } from "./fixtures"
import { LARGE_UPLOAD_TIMEOUT_MS, LAZY_VIEWER_TIMEOUT_MS, uploadDiskFiles, withScratchDirectory } from "./helpers/listing"
import { previewOverlay } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest } from "./helpers/requests"
import { RICH_SQLITE_BIG_BYTES, writeBigDatabase } from "./fixtures/richSqlite"

// A database past 256 MiB opens read in ranges at once, unchecked: its first table's rows download a few of its 1 MiB
// chunks, not the file. "Check integrity" then reads the whole file through the check's own small bridge, while the
// grid stays usable, and ends "Checked". A write-lane spec: it uploads the file into a scratch directory of its own.

// Opening and drawing the first rows: the header, the schema and the first table's pages.
const OPEN_CHUNKS = 16
const CHECK_TIMEOUT_MS = 600_000

test("a 300 MiB database opens unchecked in ranges and checks its integrity when asked", async ({ page, context }) => {
	test.setTimeout(900_000 + LARGE_UPLOAD_TIMEOUT_MS + CHECK_TIMEOUT_MS)

	const cspViolations = trackCspViolations(page)
	const dir = mkdtempSync(join(tmpdir(), "filen-e2e-sqlite-big-"))

	try {
		await withScratchDirectory(page, "sqlite-large", async ({ listbox, runId }) => {
			const name = `e2e-sqlite-large-${runId}.sqlite`
			const path = join(dir, name)

			expect(writeBigDatabase(path)).toBeGreaterThan(RICH_SQLITE_BIG_BYTES)
			await uploadDiskFiles(page, [path], listbox)
			await settleLeases(page)

			const egest = observeEgest(context)
			const dialog = previewOverlay(page)

			await listbox.getByRole("option", { name }).dblclick()
			await expect(dialog.getByText("Not checked", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await expect(dialog.getByText("2 rows", { exact: false })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			expect(egest.requests()).toBeLessThanOrEqual(OPEN_CHUNKS)

			await dialog.getByRole("button", { name: "Check integrity", exact: true }).click()
			await expect(dialog.getByText(/^Checking/)).toBeVisible()
			await expect(dialog.getByText("Checked", { exact: true })).toBeVisible({ timeout: CHECK_TIMEOUT_MS })
			expect(egest.requests()).toBeGreaterThan(OPEN_CHUNKS)

			await page.keyboard.press("Escape")
			await expect(dialog).toHaveCount(0)
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}

	expect(cspViolations).toEqual([])
})

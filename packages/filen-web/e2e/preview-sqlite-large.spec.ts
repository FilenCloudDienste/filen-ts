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
// chunks, not the file, and its rows are counted only as far as the grid read ("≥ 63 rows"), however long it sits
// idle. "Count" takes the exact count; "Check integrity" reads the whole file through the check's own small bridge,
// while the grid stays usable, and ends "Checked". A write-lane spec: it uploads the file into a scratch directory of
// its own.

// Opening and drawing the first rows: the block holding the header, the schema and `users`, and the leaf pages of
// `blobs`' first tile. Three 1 MiB rows fit a leaf and each leaf follows its rows' overflow pages, so the tile's 63 rows
// span 20 blocks (counted through the range VFS: 21 blocks in all). One block of slack: the open's own requests, which
// the run that read all of `blobs` counted one above the VFS (101 against 100).
const OPEN_CHUNKS = 22
// Longer than the viewer's idle wait before a counting step (SQLITE_COUNT_IDLE_MS), several times over.
const IDLE_MS = 3_000
const CHECK_TIMEOUT_MS = 600_000

test("a 300 MiB database opens unchecked in ranges and checks its integrity when asked", async ({ page, context, browserName }) => {
	// One engine is enough for the 300 MiB upload and its download; the VFS is the same code on all three.
	test.skip(browserName !== "chromium", "the large-database leg runs on Chromium only")
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
			// The list is by name: `blobs` is selected first, counted only as far as its first tile.
			await expect(dialog.getByText("≥ 63 rows", { exact: false })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

			// The first tile's own reads settle (they may still be landing as the count shows): no request for a second.
			let opened = egest.requests()

			await expect
				.poll(
					async () => {
						const before = egest.requests()

						await page.waitForTimeout(1_000)
						opened = egest.requests()

						return opened === before
					},
					{ timeout: LAZY_VIEWER_TIMEOUT_MS }
				)
				.toBe(true)
			expect(opened).toBeLessThanOrEqual(OPEN_CHUNKS)
			// Left idle, it counts no further: no read of the rest of the table.
			await page.waitForTimeout(IDLE_MS)
			expect(egest.requests()).toBe(opened)
			await expect(dialog.getByText("≥ 63 rows", { exact: false })).toBeVisible()

			// Count reads the table to its end.
			await dialog.getByRole("button", { name: "Count", exact: true }).click()
			await expect(dialog.getByText("300 rows", { exact: false })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await expect(dialog.getByRole("button", { name: "Count", exact: true })).toHaveCount(0)
			expect(egest.requests()).toBeGreaterThan(opened)

			// A table its first step counts whole is exact at once, with no Count.
			await dialog.getByRole("button", { name: "users", exact: true }).click()
			await expect(dialog.getByText("2 rows", { exact: false })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await expect(dialog.getByRole("button", { name: "Count", exact: true })).toHaveCount(0)

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

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, expect, seedSession, settleLeases } from "./fixtures"
import {
	LARGE_UPLOAD_TIMEOUT_MS,
	LAZY_VIEWER_TIMEOUT_MS,
	bootTo,
	directoryListbox,
	uploadDiskFiles,
	withScratchDirectory
} from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest } from "./helpers/requests"
import { PDF_THUMB_LARGE_BYTES, writeLargeThumbPdf } from "./fixtures/largeFiles"

// A PDF's thumbnail reads page 1 by range, whatever the file's size: the 100 MiB file keeps page 1 in its first block
// and its cross-reference table in its last (fixtures/largeFiles.ts), so drawing it costs two of its 100 chunk
// requests, and at most four (pdf.js may probe a block beside each). A write-lane spec: it uploads the file into a
// scratch directory of its own. The upload warm draws the uploading tab's thumbnail from the local file, so the drive
// side is proven in a second signed-in context, whose thumbnail cache is empty: it always reads the file.
//
// WebKit cannot boot a second context (its OPFS lives only in the persistent context the fixture opens,
// e2e/fixtures.ts): there the leg is skipped.

test("a 100 MiB PDF gets a thumbnail after at most four chunk requests", async ({
	page,
	browser,
	browserName,
	baseURL,
	injectedSession
}) => {
	test.skip(browserName === "webkit", "a second signed-in context: WebKit shares one OPFS per origin")
	// The write lane's 900s holds the scratch directory's brackets; a 100 MiB upload has its own budget on top.
	test.setTimeout(900_000 + LARGE_UPLOAD_TIMEOUT_MS)

	const cspViolations = trackCspViolations(page)
	const dir = mkdtempSync(join(tmpdir(), "filen-e2e-pdf-thumb-"))

	try {
		await withScratchDirectory(page, "pdf-thumb-large", async ({ listbox, runId }) => {
			const name = `e2e-pdf-thumb-large-${runId}.pdf`
			const path = join(dir, name)

			expect(writeLargeThumbPdf(path)).toBe(PDF_THUMB_LARGE_BYTES)
			await uploadDiskFiles(page, [path], listbox)
			await settleLeases(page)

			const context = await browser.newContext(baseURL === undefined ? {} : { baseURL })

			try {
				const viewer = await context.newPage()
				const egest = observeEgest(context)
				const viewerCsp = trackCspViolations(viewer)

				await seedSession(viewer, injectedSession)
				await bootTo(viewer, new URL(page.url()).pathname)

				const thumb = directoryListbox(viewer).getByRole("option", { name }).locator("img")

				await expect(thumb).toHaveAttribute("src", /^blob:/, { timeout: LAZY_VIEWER_TIMEOUT_MS })

				const requests = egest.requests()

				expect(requests).toBeGreaterThan(0)
				expect(requests).toBeLessThanOrEqual(4)
				expect(await egest.bytes()).toBeLessThan(PDF_THUMB_LARGE_BYTES / 16)
				expect(viewerCsp).toEqual([])
				await settleLeases(viewer)
			} finally {
				await context.close()
			}
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}

	expect(cspViolations).toEqual([])
})

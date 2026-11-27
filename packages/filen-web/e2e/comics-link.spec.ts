import { test, expect, settleLeases } from "./fixtures"
import { buildZip } from "./helpers/archiveFixtures"
import { trackCspViolations } from "./helpers/csp"
import { bootTo, enterScratchDirectory, trashScratchDirectory, uploadFiles, BOOT_SETTLE_TIMEOUT_MS } from "./helpers/listing"
import { closeLinkDialog, createLink, openAsVisitor, openLinkDialog } from "./helpers/publicLinks"
import { comicPagePng, COMIC_PAGES } from "./fixtures/comics"

// A comic book on a public file link, read page by page through the public-link client's archive reader (W6 §3.8): by a
// signed-out visitor, then by the signed-in owner through the session's unauthenticated view. Creating a link is premium, so this runs only against a premium account (E2E_PREMIUM).

test.describe("comic books on public links", () => {
	test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account")

	test("a signed-out visitor reads a linked .cbz page by page", async ({ page, browser, browserName, baseURL }) => {
		test.skip(browserName === "webkit", "a signed-out visitor: WebKit shares one OPFS per origin")

		const cspViolations = trackCspViolations(page)
		const runId = crypto.randomUUID()
		const scratchName = `e2e-comic-link-${runId}`
		const comicName = `e2e-comic-${runId}.cbz`
		const pages = Array.from({ length: COMIC_PAGES }, (_, i) => ({ name: `p0${String(i + 1)}.png`, data: comicPagePng(i + 1) }))

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await uploadFiles(page, [{ name: comicName, mimeType: "application/vnd.comicbook+zip", buffer: buildZip(pages) }], listbox)

			const dialog = await openLinkDialog(page, listbox, comicName)
			const url = await createLink(dialog)

			await closeLinkDialog(page, dialog)
			await settleLeases(page)

			const visitor = await openAsVisitor(browser, baseURL, url)

			try {
				const pageImage = (number: number) =>
					visitor.page.getByRole("img", { name: `Page ${String(number)} of ${String(COMIC_PAGES)}`, exact: true })

				await expect(pageImage(1)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
				await visitor.page.keyboard.press("PageDown")
				await expect(pageImage(2)).toBeVisible()
				// Extracting and browsing are a signed-in visitor's.
				await expect(visitor.page.getByRole("button", { name: "Extract to read", exact: true })).toHaveCount(0)
			} finally {
				await visitor.close()
			}

			// A signed-in visitor reads it too, through the session's own view of the public-link client.
			await page.goto(url)

			const ownPage = (number: number) =>
				page.getByRole("img", { name: `Page ${String(number)} of ${String(COMIC_PAGES)}`, exact: true })

			await expect(ownPage(1)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
			await page.keyboard.press("PageDown")
			await expect(ownPage(2)).toBeVisible()

			expect(cspViolations).toEqual([])
		} finally {
			await bootTo(page).catch(() => undefined)
			await trashScratchDirectory(page, scratchName)
		}
	})
})

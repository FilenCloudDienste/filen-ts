import type { Browser } from "@playwright/test"
import { test, expect, settleLeases } from "./fixtures"
import { buildZip } from "./helpers/archiveFixtures"
import { trackCspViolations } from "./helpers/csp"
import { bootTo, enterScratchDirectory, trashScratchDirectory, uploadFiles, BOOT_SETTLE_TIMEOUT_MS } from "./helpers/listing"
import { closeLinkDialog, createLink, openLinkDialog } from "./helpers/publicLinks"
import { comicPagePng, COMIC_PAGES } from "./fixtures/comics"

// A comic book on a public file link, read page by page by a signed-out visitor through the public-link client's
// archive reader (W6 §3.8). Creating a link is premium, so this runs only against a premium account (E2E_PREMIUM).

async function signedOutPage(browser: Browser, baseURL: string | undefined, url: string) {
	const context = await browser.newContext(baseURL === undefined ? {} : { baseURL })
	const page = await context.newPage()

	await page.goto(url)

	return { page, close: () => context.close() }
}

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

			const visitor = await signedOutPage(browser, baseURL, url)

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

			expect(cspViolations).toEqual([])
		} finally {
			await bootTo(page).catch(() => undefined)
			await trashScratchDirectory(page, scratchName)
		}
	})
})

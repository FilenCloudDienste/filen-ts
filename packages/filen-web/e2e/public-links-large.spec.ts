import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Browser, Locator, Page } from "@playwright/test"
import { test, expect, settleLeases } from "./fixtures"
import { BOOT_SETTLE_TIMEOUT_MS, LARGE_UPLOAD_TIMEOUT_MS, bootTo, uploadDiskFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest } from "./helpers/requests"
import { closeLinkDialog, createLink, openLinkDialog } from "./helpers/publicLinks"
import { waitForSwReady } from "./helpers/sw"
import { LINK_IMAGE_BYTES, MIB, writeLargeLinkImage } from "./fixtures/w4"
import { SW_DOWNLOAD_PREFIX } from "@/lib/sw/protocol"
import { preview } from "@/locales/en/preview"

// A public link's image above the image buffer cap (300 MiB, fixtures/w4.ts) is never loaded whole: with a service
// worker controlling the page it streams through the worker's inline route; on a first visit with none it waits for
// one, and where none ever controls the page it shows the unsupported card with Download. A write-lane spec of its own,
// apart from public-links.spec.ts: it uploads the file and creates the link (premium), where that one only reads.
//
// The visitor legs need a signed-out context of their own, which WebKit cannot boot (its OPFS lives only in the
// persistent context the fixture opens, e2e/fixtures.ts): there only the signed-in tab's leg runs.

// What a visitor may read of the file while it is not shown: at most the probe of its first blocks, never the file.
const NOT_LOADED_BYTES = 16 * MIB
// A streamed image's first pixels need its first bytes through the service worker; the rest may still be arriving.
const STREAM_PAINT_TIMEOUT_MS = 300_000

function linkImage(page: Page, name: string): Locator {
	return page.getByRole("img", { name, exact: true })
}

function tooLargeCard(page: Page): Locator {
	return page.getByText(preview.previewTooLargeToShowHere, { exact: true })
}

// The image is drawn from the service worker's inline route, never a blob: of bytes held whole.
async function expectStreamed(page: Page, name: string): Promise<void> {
	const image = linkImage(page, name)

	await expect(image).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
	await expect(tooLargeCard(page)).toHaveCount(0)

	const src = (await image.getAttribute("src")) ?? ""

	expect(src.startsWith("blob:"), `src ${src}`).toBe(false)
	expect(new URL(src, page.url()).pathname.startsWith(SW_DOWNLOAD_PREFIX), `src ${src}`).toBe(true)
	await expect
		.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), { timeout: STREAM_PAINT_TIMEOUT_MS })
		.toBeGreaterThan(0)
}

// A signed-out visitor in a context of its own; `block` keeps any service worker from ever controlling it.
async function visit(
	browser: Browser,
	baseURL: string | undefined,
	serviceWorkers: "allow" | "block"
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), serviceWorkers })
	const page = await context.newPage()

	return { page, close: () => context.close() }
}

test.describe("a public link's image above its buffer cap", () => {
	test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account (E2E_PREMIUM)")

	test("streams through the service worker, and without one shows the too-large card instead of loading it whole", async ({
		page,
		browser,
		browserName,
		baseURL
	}) => {
		// The write lane's 900s holds the scratch directory's brackets; a 300 MiB upload has its own budget on top, and the
		// streamed legs theirs.
		test.setTimeout(900_000 + LARGE_UPLOAD_TIMEOUT_MS + 2 * STREAM_PAINT_TIMEOUT_MS)

		const cspViolations = trackCspViolations(page)
		const dir = mkdtempSync(join(tmpdir(), "filen-e2e-link-image-"))

		try {
			await withScratchDirectory(page, "link-image", async ({ listbox, runId }) => {
				const name = `e2e-link-image-${runId}.jpg`
				const path = join(dir, name)

				expect(writeLargeLinkImage(path)).toBe(LINK_IMAGE_BYTES)
				await uploadDiskFiles(page, [path], listbox)

				const dialog = await openLinkDialog(page, listbox, name)
				const url = await createLink(dialog)

				await closeLinkDialog(page, dialog)

				try {
					// ---- first visit, no service worker ever: the card, and nothing of the file read ----
					if (browserName === "webkit") {
						test.info().annotations.push({
							type: "skip-leg",
							description: "signed-out visitors: WebKit shares one OPFS per origin"
						})
					} else {
						const blocked = await visit(browser, baseURL, "block")
						const egest = observeEgest(blocked.page.context())

						try {
							await blocked.page.goto(url)
							await expect(tooLargeCard(blocked.page)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
							await expect(blocked.page.getByRole("button", { name: "Download", exact: true }).first()).toBeVisible()
							await expect(linkImage(blocked.page, name)).toHaveCount(0)
							expect(await egest.bytes()).toBeLessThan(NOT_LOADED_BYTES)
						} finally {
							await blocked.close()
						}

						// ---- first visit with a service worker: nothing controls the page until it installs, so the preview
						// waits for it (a few seconds at most), then streams, or else shows the card: never the file whole ----
						const first = await visit(browser, baseURL, "allow")
						const firstEgest = observeEgest(first.page.context())

						try {
							await first.page.goto(url)
							await expect(linkImage(first.page, name).or(tooLargeCard(first.page))).toBeVisible({
								timeout: BOOT_SETTLE_TIMEOUT_MS
							})

							if (await tooLargeCard(first.page).isVisible()) {
								test.info().annotations.push({ type: "first-visit", description: "no controller in time: the card" })
								expect(await firstEgest.bytes()).toBeLessThan(NOT_LOADED_BYTES)
							} else {
								await expectStreamed(first.page, name)
							}
						} finally {
							await first.close()
						}
					}

					// ---- the signed-in tab, its worker in control: streams ----
					await settleLeases(page)
					await page.goto(url)
					await waitForSwReady(page)
					await expectStreamed(page, name)
				} finally {
					// Back on the drive for the scratch directory's teardown (a link page has no sidebar).
					await bootTo(page)
				}
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}

		expect(cspViolations).toEqual([])
	})
})

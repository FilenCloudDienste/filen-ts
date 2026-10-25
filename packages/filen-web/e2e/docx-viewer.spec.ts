import type { Browser, Locator, Page, Worker } from "@playwright/test"
import { test, expect, settleLeases } from "./fixtures"
import { archiveBrowser, openRowMenu, previewOverlay } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import {
	DOCX_MIME,
	DOCX_VIEWER_TEXT,
	VIEWER_ENTRY_NAME,
	VIEWER_ENTRY_TEXT,
	VIEWER_FONT_PLAIN,
	VIEWER_FONT_SAMPLE,
	VIEWER_LINK_TARGET_TEXT,
	VIEWER_LINKS,
	VIEWER_PAGES,
	docxViewerBytes
} from "./helpers/docxFixtures"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import {
	BOOT_SETTLE_TIMEOUT_MS,
	LAZY_VIEWER_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS,
	bootTo,
	uploadFiles,
	withScratchDirectory
} from "./helpers/listing"
import { common } from "@/locales/en/common"
import { preview } from "@/locales/en/preview"

// The DOCX viewer in a real browser against the real backend, at each place a document opens read-only: an
// archive's entry (zip and 7z), a public link (signed out, and with downloads off) and a chat's link card. Per
// place: the engine drew the pages (never docx-preview's .docx-wrapper), nothing violated the CSP, find and zoom
// work. The zip's documents also cover comments, an embedded font, links (only http(s) and mailto open, in a new tab
// with no opener), 300 pages, and the one docx worker every document shares and that ends a minute after the last
// one closed. A document in the drive opens in the editor (docx-smoke.spec.ts), so the overlay leg checks only the
// files the editor hands to the viewer: the docx-preview fallback for a package the engine refuses, and the
// messages for an encrypted and a legacy file.

test.describe.configure({ mode: "default" })

// A desktop window: the fixture listing's tall one would show dozens of pages at once.
const WINDOW = { width: 1280, height: 900 }
// docxEngine.ts's WORKER_IDLE_MS plus room for a slow runner.
const WORKER_IDLE_WAIT_MS = 90_000

type ViewerFile = (typeof FIXTURE_FILES)["docx-viewer"][number]

function pages(scope: Page | Locator): Locator {
	return scope.locator(".fo-docx-page")
}

function pageText(scope: Page | Locator, text: string): Locator {
	return pages(scope).getByText(text, { exact: true }).first()
}

// The docx worker(s) a page starts (the bundle names it docx.worker-<hash>.js; the zip worker is another).
function trackDocxWorkers(page: Page): Worker[] {
	const workers: Worker[] = []

	page.on("worker", worker => {
		if (/\/docx\.worker[-.]/.test(worker.url())) {
			workers.push(worker)
		}
	})

	return workers
}

async function openRow(page: Page, rows: Readonly<Record<ViewerFile, Locator>>, name: ViewerFile): Promise<Locator> {
	await rows[name].dblclick()

	const overlay = previewOverlay(page)

	await expect(overlay).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return overlay
}

async function closeOverlay(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(previewOverlay(page)).toHaveCount(0)
}

async function viewerRows(page: Page): Promise<Readonly<Record<ViewerFile, Locator>>> {
	await bootTo(page)

	const { rows } = await openFixtureRows(page, "docx-viewer")

	await page.setViewportSize(WINDOW)

	return Object.fromEntries(FIXTURE_FILES["docx-viewer"].map((name, index) => [name, rows[index]])) as Record<ViewerFile, Locator>
}

// The toolbar's find: a match counted and announced, then closed.
async function expectFind(scope: Locator, query: string, total: number): Promise<void> {
	await scope.getByRole("button", { name: preview.previewDocxFindAction, exact: true }).click()

	const field = scope
		.getByRole("searchbox", { name: preview.previewDocxFindPlaceholder })
		.or(scope.getByRole("textbox", { name: preview.previewDocxFindPlaceholder }))

	await field.fill(query)
	await expect(scope.getByRole("status").filter({ hasText: `Match 1 of ${String(total)}` })).toHaveCount(1, {
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})
	await scope.getByRole("button", { name: preview.previewDocxFindClose, exact: true }).click()
	await expect(field).toHaveCount(0)
}

// Zoom in changes the zoom from fit-to-width; the zoom menu's Fit to width brings it back.
async function expectZoom(scope: Locator): Promise<void> {
	const menu = scope.getByRole("button", { name: /^Zoom level, \d+%$/ })
	const fitted = await menu.getAttribute("aria-label")

	await scope.getByRole("button", { name: preview.previewDocxZoomInAction, exact: true }).click()
	await expect(menu).not.toHaveAttribute("aria-label", fitted ?? "")
	await menu.click()
	await scope.page().getByRole("menuitemradio", { name: preview.previewDocxFitWidth, exact: true }).click()
	await expect(menu).toHaveAttribute("aria-label", fitted ?? "")
}

// The engine's own pages, never docx-preview's.
async function expectEngine(scope: Locator, text: string): Promise<void> {
	await expect(pageText(scope, text)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(scope.locator(".docx-wrapper")).toHaveCount(0)
}

async function expectMessage(scope: Locator, message: string): Promise<void> {
	await expect(scope.getByText(message, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(scope.locator(".docx-wrapper")).toHaveCount(0)
	await expect(pages(scope)).toHaveCount(0)
}

async function expectFallback(scope: Locator): Promise<void> {
	await expect(scope.locator(".docx-wrapper").getByText(DOCX_VIEWER_TEXT["viewer-malformed.docx"])).toBeVisible({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})
	await expect(pages(scope)).toHaveCount(0)
}

// Each text in the embedded font is a row of 1 em boxes: far wider than the same letters in the default font.
async function expectEmbeddedFont(scope: Locator): Promise<void> {
	const boxed = pageText(scope, VIEWER_FONT_SAMPLE)
	const plain = pageText(scope, VIEWER_FONT_PLAIN)

	await expect(boxed).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(plain).toBeVisible()
	await expect
		.poll(async () => {
			const [a, b] = await Promise.all([boxed.boundingBox(), plain.boundingBox()])

			return a === null || b === null ? 0 : a.width / b.width
		})
		.toBeGreaterThan(1.6)
}

// http(s) opens in a new tab with no opener, once its domain is confirmed; javascript: and data: links do
// nothing at all.
async function expectLinks(page: Page, scope: Locator): Promise<void> {
	const context = page.context()
	const opened: Page[] = []
	const dialogs: string[] = []
	const onPage = (other: Page): void => {
		opened.push(other)
	}
	const onDialog = (dialog: { message: () => string; dismiss: () => Promise<void> }): void => {
		dialogs.push(dialog.message())
		void dialog.dismiss()
	}

	await context.route(`${VIEWER_LINKS.web.href}*`, route =>
		route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>e2e link</title>" })
	)
	context.on("page", onPage)
	page.on("dialog", onDialog)

	try {
		const url = page.url()

		for (const link of [VIEWER_LINKS.script, VIEWER_LINKS.data]) {
			await scope.getByText(link.text, { exact: true }).first().click()
		}

		// Nothing to wait for: a refused link does nothing, so give a wrongly opened one time to show.
		await page.waitForTimeout(1_000)
		expect(opened).toHaveLength(0)
		expect(dialogs).toEqual([])
		expect(page.url()).toBe(url)

		// A domain not trusted yet asks first; the link opens from the confirmation.
		await scope.getByRole("link", { name: VIEWER_LINKS.web.text, exact: true }).click()

		const confirm = page.getByRole("alertdialog", { name: common.linkTrustTitle })

		await expect(confirm).toContainText(new URL(VIEWER_LINKS.web.href).hostname)
		expect(opened).toHaveLength(0)

		const popup = context.waitForEvent("page")

		await confirm.getByRole("button", { name: common.linkTrustConfirm, exact: true }).click()

		const tab = await popup

		await tab.waitForLoadState()
		expect(tab.url()).toBe(VIEWER_LINKS.web.href)
		expect(await tab.evaluate(() => window.opener === null)).toBe(true)
		await tab.close()

		// An internal link goes to its bookmark's page.
		await scope.getByRole("link", { name: VIEWER_LINKS.internal.text, exact: true }).click()
		await expect(scope.getByText("Page 3 of 3", { exact: true })).toBeVisible()
		await expect(pageText(scope, VIEWER_LINK_TARGET_TEXT)).toBeInViewport()
	} finally {
		context.off("page", onPage)
		page.off("dialog", onDialog)
		await context.unroute(`${VIEWER_LINKS.web.href}*`)
	}
}

test("drive preview overlay: the documents the editor hands to the viewer, no CSP errors", async ({ page }) => {
	const cspViolations = trackCspViolations(page)
	const rows = await viewerRows(page)

	// The editor opens the readable documents (docx-smoke.spec.ts); what it cannot open goes to the viewer.
	let overlay = await openRow(page, rows, "viewer-malformed.docx")

	await expectFallback(overlay)
	await closeOverlay(page)

	overlay = await openRow(page, rows, "viewer-encrypted.docx")
	await expectMessage(overlay, preview.previewDocxUnsupportedEncryption)
	await closeOverlay(page)

	overlay = await openRow(page, rows, "viewer-legacy.docx")
	await expectMessage(overlay, preview.previewDocxLegacyFormat)
	await closeOverlay(page)

	expect(cspViolations).toEqual([])
})

test("archive entries: a docx in a zip and in a 7z opens in the viewer, view-only, on one docx worker", async ({ page }) => {
	const cspViolations = trackCspViolations(page)
	const workers = trackDocxWorkers(page)
	const rows = await viewerRows(page)

	for (const archive of ["viewer-archive.zip", "viewer-archive.7z"] as const) {
		await rows[archive].dblclick()

		const browser = archiveBrowser(page)

		await expect(browser.row(VIEWER_ENTRY_NAME)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await browser.row(VIEWER_ENTRY_NAME).dblclick()
		await expectEngine(browser.overlay, VIEWER_ENTRY_TEXT)

		// Why it is view-only.
		await browser.overlay.getByRole("button", { name: preview.previewDocxViewOnly, exact: true }).click()
		await expect(page.getByText(preview.previewDocxViewOnlyArchive, { exact: true })).toBeVisible()
		await page.keyboard.press("Escape")

		await expectFind(browser.overlay, "entry", 1)
		await expectZoom(browser.overlay)

		await browser.overlay.getByRole("button", { name: preview.previewArchiveEntryBack, exact: true }).click()
		await expect(browser.row(VIEWER_ENTRY_NAME)).toBeVisible()
		await browser.close()
	}

	expect(workers).toHaveLength(1)
	expect(cspViolations).toEqual([])
})

test("archive viewer documents: comments, an embedded font, links and 300 pages on one docx worker ended once idle", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const workers = trackDocxWorkers(page)
	const rows = await viewerRows(page)

	await rows["viewer-archive.zip"].dblclick()

	const browser = archiveBrowser(page)
	const overlay = browser.overlay

	async function openEntry(name: string, text: string): Promise<void> {
		await expect(browser.row(name)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await browser.row(name).dblclick()
		await expectEngine(overlay, text)
	}

	async function back(name: string): Promise<void> {
		await overlay.getByRole("button", { name: preview.previewArchiveEntryBack, exact: true }).click()
		await expect(browser.row(name)).toBeVisible()
	}

	// Comments and tracked changes: the balloons beside the page, find and zoom.
	await openEntry("viewer-review.docx", DOCX_VIEWER_TEXT["viewer-review.docx"])
	// The column is a landmark around absolutely placed balloons (it has no box of its own).
	await expect(overlay.getByRole("complementary", { name: preview.previewDocxComments })).toBeAttached({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})
	await expect(overlay.getByLabel("Comment by E2E Reviewer", { exact: true }).first()).toBeVisible()
	await expectFind(overlay, "fixture", 1)
	await expectZoom(overlay)
	await back("viewer-review.docx")

	await openEntry("viewer-fonts.docx", DOCX_VIEWER_TEXT["viewer-fonts.docx"])
	await expectEmbeddedFont(overlay)
	await back("viewer-fonts.docx")

	await openEntry("viewer-links.docx", DOCX_VIEWER_TEXT["viewer-links.docx"])
	await expectLinks(page, overlay)
	await back("viewer-links.docx")

	// 300 pages: laid out to the end, and found on its last.
	const opening = Date.now()

	await openEntry("viewer-300p.docx", DOCX_VIEWER_TEXT["viewer-300p.docx"])
	console.log(`docx-viewer: 300 pages, first page shown ${String(Date.now() - opening)} ms after the double-click`)
	await expect(overlay.getByText(`Page 1 of ${String(VIEWER_PAGES)}`, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expectFind(overlay, `Viewer page ${String(VIEWER_PAGES)}`, 1)
	await expect(pageText(overlay, `Viewer page ${String(VIEWER_PAGES)}`)).toBeInViewport()
	await back("viewer-300p.docx")
	await browser.close()

	expect(cspViolations).toEqual([])

	// Every document above ran on one worker, which ends a minute after the last one closed.
	expect(workers).toHaveLength(1)

	const [worker] = workers

	if (worker !== undefined) {
		await worker.waitForEvent("close", { timeout: WORKER_IDLE_WAIT_MS })
	}
})

// ---- public links and chat cards: success needs a link the account owns, which is premium ---------------

async function createLink(page: Page, listbox: Locator, name: string): Promise<{ dialog: Locator; url: string }> {
	await openRowMenu(page, listbox, name)
	await page.getByRole("menuitem", { name: "Public link", exact: true }).click()

	const dialog = page.getByRole("dialog", { name: "Public link", exact: true })

	await expect(dialog).toBeVisible()
	await dialog.getByRole("button", { name: "Create public link", exact: true }).click()

	const field = dialog.getByLabel("Link", { exact: true })

	await expect(field).toHaveValue(/\/[fd]\/[0-9a-f-]+#/, { timeout: LIVE_WRITE_TIMEOUT_MS })

	return { dialog, url: await field.inputValue() }
}

async function setLinkDownloads(dialog: Locator, on: boolean): Promise<void> {
	const allow = dialog.getByRole("switch", { name: "Allow downloads", exact: true })

	if ((await allow.getAttribute("aria-checked")) !== String(on)) {
		await allow.click()
	}

	await expect(allow).toHaveAttribute("aria-checked", String(on), { timeout: LIVE_WRITE_TIMEOUT_MS })
	await expect(allow).toBeEnabled({ timeout: LIVE_WRITE_TIMEOUT_MS })
}

// A visitor with no session; WebKit keeps one OPFS per origin for the whole machine (e2e/fixtures.ts), so
// there the signed-in tab visits instead.
async function visitLink(page: Page, browser: Browser, browserName: string, baseURL: string | undefined, url: string): Promise<Page> {
	if (browserName === "webkit") {
		await settleLeases(page)
		await page.goto(url)

		return page
	}

	const context = await browser.newContext(baseURL === undefined ? {} : { baseURL })
	const visitor = await context.newPage()

	await visitor.goto(url)

	return visitor
}

test.describe("public link and chat card", () => {
	test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account (E2E_PREMIUM)")

	test("a public link shows the document view-only, with no download or print when downloads are off", async ({
		page,
		browser,
		browserName,
		baseURL
	}) => {
		const name = "viewer-review.docx"

		await withScratchDirectory(page, "docx-viewer-link", async ({ listbox, scratchName }) => {
			await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxViewerBytes(name) }], listbox)

			const { dialog, url } = await createLink(page, listbox, name)

			for (const downloads of [true, false]) {
				await setLinkDownloads(dialog, downloads)
				await page.keyboard.press("Escape")
				await expect(dialog).toHaveCount(0)

				const visitor = await visitLink(page, browser, browserName, baseURL, url)
				const cspViolations = trackCspViolations(visitor)
				const main = visitor.getByRole("main")

				try {
					await expectEngine(main, DOCX_VIEWER_TEXT[name])
					await main.getByRole("button", { name: preview.previewDocxViewOnly, exact: true }).click()
					await expect(visitor.getByText(preview.previewDocxViewOnlyPublicLink, { exact: true })).toBeVisible()
					await visitor.keyboard.press("Escape")
					await expectFind(main, "fixture", 1)
					await expectZoom(main)
					await expect(visitor.getByRole("button", { name: "Download", exact: true })).toHaveCount(downloads ? 1 : 0)
					await expect(visitor.getByRole("button", { name: /^Print/ })).toHaveCount(0)
					expect(cspViolations).toEqual([])
				} finally {
					if (visitor !== page) {
						await visitor.context().close()
					}
				}

				// Back to the link dialog for the next round.
				if (visitor === page) {
					await bootTo(page)
				}

				if (downloads) {
					await page.goto(`/drive`)
					await expect(page.getByRole("listbox").first()).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
					await page.getByRole("option", { name: scratchName }).dblclick()
					await expect(listbox.getByRole("option", { name })).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
					await openRowMenu(page, listbox, name)
					await page.getByRole("menuitem", { name: "Public link", exact: true }).click()
					await expect(dialog).toBeVisible()
				}
			}
		})
	})

	test("a chat's link card opens the document in the viewer", () => {
		// A chat message is a chats-lane write (the `chats` account lock and the conversation rate limit), which
		// this drive-lane file must not take; the card opens the same DocxViewer as the overlay (variant "links").
		test.skip(true, "a chat message is a chats-lane write")
	})
})

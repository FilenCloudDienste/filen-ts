import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, setDesktopViewport, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { resolveModKey } from "./helpers/modkey"
import { buildZip } from "./helpers/archiveFixtures"
import { preview } from "@/locales/en/preview"

// The e-book reader: an EPUB, an FB2 and a MOBI open laid out to the view; find and the outline work over the laid-out
// pages; a larger text size lays the book out again and keeps the chapter on screen; the Japanese chapter fetches its
// fallback face from the app; the Hebrew chapter's lines are right-to-left; closing ends the engine's worker. Under the
// CSP, with no request leaving the app.
test.describe.configure({ mode: "default" })

const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. "
const XHTML = (body: string, lang?: string): string =>
	`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"${lang === undefined ? "" : ` xml:lang="${lang}" lang="${lang}"`}><head><title>c</title></head><body>${body}</body></html>`

const CHAPTERS = ["Opening", "Japanese", "Hebrew"] as const
const OPENING_WORDS = "It was a bright cold day in April"

function epub(): Buffer {
	return buildZip([
		{ name: "mimetype", data: "application/epub+zip", method: "stored" },
		{
			name: "META-INF/container.xml",
			data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
		},
		{
			name: "OEBPS/content.opf",
			data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">e2e-book</dc:identifier><dc:title>E2E Book</dc:title><dc:creator>An Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`
		},
		{
			name: "OEBPS/nav.xhtml",
			data: XHTML(
				`<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol>${CHAPTERS.map((title, index) => `<li><a href="c${String(index + 1)}.xhtml">${title}</a></li>`).join("")}</ol></nav>`
			)
		},
		{ name: "OEBPS/c1.xhtml", data: XHTML(`<h1>Opening</h1><p>${OPENING_WORDS}. ${LOREM.repeat(300)}</p><p>unique anchor phrase</p>`) },
		{ name: "OEBPS/c2.xhtml", data: XHTML(`<h1>日本語の章</h1><p>${"吾輩は猫である。名前はまだ無い。".repeat(20)}</p>`, "ja") },
		{ name: "OEBPS/c3.xhtml", data: XHTML(`<h1>Hebrew</h1><p dir="rtl">${"שלום עולם, זהו פרק בעברית. ".repeat(10)}</p>`, "he") }
	])
}

function fb2(): Buffer {
	return Buffer.from(
		`<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>FB Title</book-title><author><first-name>Ann</first-name><last-name>Writer</last-name></author><lang>en</lang></title-info></description><body><section><title><p>Chapter A</p></title><p>The first FB2 chapter. ${LOREM.repeat(10)}</p></section><section><title><p>Chapter B</p></title><p>The second chapter.</p></section></body></FictionBook>`,
		"utf8"
	)
}

// A PalmDB of uncompressed PalmDOC text records.
function mobi(): Buffer {
	const text = Buffer.from(`<html><body><h1>Mobi</h1><p>A MOBI paragraph. ${LOREM.repeat(20)}</p></body></html>`, "utf8")
	const recordSize = 4096
	const header = Buffer.alloc(16 + 232)
	const textRecords = Math.ceil(text.length / recordSize)

	header.writeUInt16BE(1, 0)
	header.writeUInt32BE(text.length, 4)
	header.writeUInt16BE(textRecords, 8)
	header.writeUInt16BE(recordSize, 10)
	header.write("MOBI", 16, "latin1")
	header.writeUInt32BE(232, 20)
	header.writeUInt32BE(2, 24)
	header.writeUInt32BE(65001, 28)
	header.writeUInt32BE(0xffffffff, 16 + 0x50)

	const records = [header]

	for (let at = 0; at < text.length; at += recordSize) records.push(text.subarray(at, at + recordSize))

	const list = 78 + records.length * 8 + 2
	const head = Buffer.alloc(list)
	let offset = list

	head.write("E2E Mobi", 0, "latin1")
	head.write("BOOKMOBI", 60, "latin1")
	head.writeUInt16BE(records.length, 76)
	records.forEach((record, index) => {
		head.writeUInt32BE(offset, 78 + index * 8)
		head.writeUInt32BE(index, 78 + index * 8 + 4)
		offset += record.length
	})

	return Buffer.concat([head, ...records])
}

async function open(page: Page, listbox: Locator, name: string): Promise<Locator> {
	// A normal window for the book: the listing's tall one (setTallListingViewport) lays every chapter out on one page.
	await setDesktopViewport(page)
	await listbox.getByRole("option", { name }).dblclick()

	const first = page.getByRole("region", { name: /Page 1 of \d+/u })

	await expect(first).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(first.locator(".fo-pdf-text-layer span").first()).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return first
}

// The book's page count, from page 1's region name ("… Page 1 of 42").
async function pageCount(page: Page): Promise<number> {
	const name = (await page.getByRole("region", { name: /Page 1 of \d+/u }).getAttribute("aria-label")) ?? ""

	return Number(/of (\d+)/u.exec(name)?.[1] ?? "0")
}

async function close(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("region", { name: /Page 1 of \d+/u })).toHaveCount(0)
}

function engineWorkers(page: Page): number {
	return page.workers().filter(worker => worker.url().includes("pdfEngine")).length
}

test("EPUB, FB2 and MOBI books open laid out, find, follow the outline, relayout and close their engine", async ({ page, context }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	// The fallback faces the engine fetched (synchronously, from its worker): MuPDF needs them to lay the book out, so
	// they are fetched while it opens, not when a page is drawn. Watched from before the open.
	const faces: string[] = []

	context.on("request", request => {
		if (request.url().includes("/office-fonts/")) faces.push(request.url())
	})

	await page.setViewportSize({ width: 1280, height: 900 })

	await withScratchDirectory(page, "ebook-view", async ({ listbox, runId }) => {
		const names = { epub: `e2e-book-${runId}.epub`, fb2: `e2e-book-${runId}.fb2`, mobi: `e2e-book-${runId}.mobi` }

		await uploadFiles(
			page,
			[
				{ name: names.epub, mimeType: "application/epub+zip", buffer: epub() },
				{ name: names.fb2, mimeType: "application/x-fictionbook+xml", buffer: fb2() },
				{ name: names.mobi, mimeType: "application/x-mobipocket-ebook", buffer: mobi() }
			],
			listbox
		)

		// EPUB: the opening words, find, the outline, a larger text size and the fallback faces.
		const first = await open(page, listbox, names.epub)

		await expect(first.getByText(OPENING_WORDS, { exact: false })).toBeAttached()

		// Find's key straight after the open, with no click: Mod as the page reads it (Playwright's WebKit reports a Mac
		// user agent on every host, so the app binds Cmd there while ControlOrMeta would send Ctrl on Linux).
		await page.keyboard.press(`${await resolveModKey(page)}+f`)
		await page.keyboard.type("unique anchor phrase")
		await page.keyboard.press("Enter")
		await expect(page.locator(".fo-pdf-text-layer .highlight").first()).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.keyboard.press("Escape")

		await page.getByRole("button", { name: preview.previewPdfOutlinePane, exact: true }).click()

		const tree = page.getByRole("tree", { name: preview.previewPdfOutlinePane })

		await expect(tree.getByRole("treeitem")).toHaveCount(CHAPTERS.length)

		await expect.poll(() => faces.some(url => url.includes("noto-sans-jp"))).toBe(true)
		await tree.getByRole("treeitem", { name: "Japanese" }).click()

		await tree.getByRole("treeitem", { name: "Hebrew" }).click()
		await expect(page.locator('.fo-pdf-text-layer span[dir="rtl"]').first()).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		// Back to the opening chapter, then a larger text size: the book is laid out again and the chapter stays.
		await tree.getByRole("treeitem", { name: "Opening" }).click()
		// The relayout itself is observed, not its veil (which a short book shows for less than a poll): a larger text
		// size lays the book out over more pages.
		const pagesBefore = await pageCount(page)

		// Three steps (11 → 16 pt): the opening chapter, several pages long, takes clearly more.
		for (let step = 0; step < 3; step++) await page.getByRole("button", { name: preview.previewEbookTextLarger }).click()
		await expect.poll(() => pageCount(page), { timeout: LAZY_VIEWER_TIMEOUT_MS }).toBeGreaterThan(pagesBefore)
		await expect(page.getByRole("status").filter({ hasText: preview.previewEbookRelayout })).toHaveCount(0)
		await expect(page.locator(".fo-pdf-text-layer").getByText("It was a bright", { exact: false }).first()).toBeInViewport({
			timeout: LAZY_VIEWER_TIMEOUT_MS
		})
		for (let step = 0; step < 3; step++) await page.getByRole("button", { name: preview.previewEbookTextSmaller }).click()
		await page.getByRole("button", { name: preview.previewPdfOutlinePane, exact: true }).click()

		await close(page)
		await expect.poll(() => engineWorkers(page)).toBe(0)

		// FB2 and MOBI.
		const fb2Page = await open(page, listbox, names.fb2)

		await expect(fb2Page.getByText("The first FB2 chapter", { exact: false })).toBeAttached()
		await close(page)

		const mobiPage = await open(page, listbox, names.mobi)

		await expect(mobiPage.getByText("A MOBI paragraph", { exact: false })).toBeAttached()
		await close(page)
		await expect.poll(() => engineWorkers(page)).toBe(0)
	})

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

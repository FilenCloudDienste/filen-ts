import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Locator, Page, Worker } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LARGE_UPLOAD_TIMEOUT_MS, uploadDiskFiles, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest, type EgestObserver } from "./helpers/requests"
import { latinDocument } from "../scripts/pdf-fixtures/view/documents"
import { RESIDENT_PDF_PAGES, writeResidentPdf } from "./fixtures/largeFiles"

// The PDF viewer reads a drive file on demand: a large file shows page 1 after downloading only part of it (counted
// in the SDK's chunk requests, one per MiB), a document that has read past the device's resident limit is reopened
// where it was shown, and the self-hosted pdf.js data files draw non-embedded CJK text, JPEG 2000, JBIG2 and CMYK
// pages, all under the CSP.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
const FIXTURES = new URL("./fixtures/pdf/view/", import.meta.url)
const CHUNK = 1024 * 1024

function fixture(name: string): Buffer {
	return readFileSync(new URL(name, FIXTURES))
}

async function openPdf(page: Page, listbox: Locator, name: string): Promise<Locator> {
	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await row.dblclick()

	const dialog = page.getByRole("dialog").first()

	await expect(dialog.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// The SDK chunks pdf.js needs before page 1 paints, for the non-linearized latin document: the cross-reference table
// and trailer at the end, page 1's objects from the start of the file, and every page's own dictionary (pdf.js walks the
// page tree to the last page at open). The pages beside page 1 are read only after it painted.
function firstPaintChunks(bytes: Buffer, pages: number): number {
	const text = bytes.toString("latin1")
	const chunks = new Set<number>()
	const add = (from: number, to: number): void => {
		for (let chunk = Math.floor(from / CHUNK); chunk <= Math.floor((to - 1) / CHUNK); chunk++) chunks.add(chunk)
	}
	const object = (number: number): readonly [number, number] => {
		const start = text.indexOf(`\n${String(number)} 0 obj`)
		const end = text.indexOf("endobj", start)

		if (start < 0 || end < 0) throw new Error(`no object ${String(number)}`)

		return [start + 1, end + "endobj".length]
	}

	// Catalog, page tree, font, then page 1, its content and its image (objects 4 to 6).
	add(0, object(6)[1])

	// Each page is three objects from 4: the page, its content, its image.
	for (let page = 2; page <= pages; page++) add(...object(4 + (page - 1) * 3))

	add(text.lastIndexOf("xref"), bytes.length)

	return chunks.size
}

// Dark and coloured pixels of the first painted page canvas.
async function inkOf(dialog: Locator): Promise<{ dark: number; colour: number }> {
	return dialog
		.locator("canvas.block")
		.first()
		.evaluate((canvas: HTMLCanvasElement) => {
			const context = canvas.getContext("2d")

			if (context === null) return { dark: 0, colour: 0 }

			const data = context.getImageData(0, 0, canvas.width, canvas.height).data
			let dark = 0
			let colour = 0

			for (let at = 0; at < data.length; at += 4) {
				const r = data[at] ?? 255
				const g = data[at + 1] ?? 255
				const b = data[at + 2] ?? 255

				if (Math.max(r, g, b) < 128) dark++
				if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colour++
			}

			return { dark, colour }
		})
}

test("a large PDF shows its first page after reading part of the file", async ({ page }, testInfo) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	// 12 pages of 2048 x 2048 grey noise: about 48 MiB, an image's worth of chunks per page.
	const bytes = Buffer.from(latinDocument({ pages: 12, imageSide: 2048, linearized: false }))
	const chunks = Math.ceil(bytes.length / CHUNK)

	await withScratchDirectory(page, "pdf-ranged", async ({ listbox, runId }) => {
		const name = `e2e-pdf-ranged-${runId}.pdf`

		// Counted from before the upload: the new row's thumbnail is drawn from the uploaded file, so a listing that
		// downloaded the file for it instead would count every chunk.
		const egest = observeEgest(page.context())
		let atPaint = -1
		// Diagnostic: each chunk request's path in order, with the milliseconds since the row was opened (negative:
		// before), to tell a second reader from a read-ahead.
		const requested: string[] = []
		let openedAt = Date.now()

		page.context().on("request", request => {
			const url = new URL(request.url())

			if (url.hostname.startsWith("egest.filen")) requested.push(`${String(Date.now() - openedAt)}ms ${url.pathname}`)
		})

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: bytes }], listbox)

		// Counted the moment page 1's canvas has its bitmap (the pages beside it start reading only then).
		await page.exposeFunction("pdfPagePainted", () => {
			if (atPaint < 0) atPaint = egest.requests()
		})
		await page.evaluate(() => {
			const report = Reflect.get(window, "pdfPagePainted") as () => void
			const observer = new MutationObserver(() => {
				if (document.querySelector('[data-page="1"][data-rendered="true"]') !== null) {
					observer.disconnect()
					report()
				}
			})

			observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-rendered"] })
		})

		// A desktop window: page 1 alone in view. The listing's 8000px viewport (setTallListingViewport) shows seven
		// pages at once, and the viewer rightly reads every page in view before the first one paints.
		await page.setViewportSize({ width: 1280, height: 720 })
		openedAt = Date.now()

		const dialog = await openPdf(page, listbox, name)

		await expect.poll(() => atPaint, { timeout: LAZY_VIEWER_TIMEOUT_MS }).toBeGreaterThanOrEqual(0)

		if (atPaint !== firstPaintChunks(bytes, 12)) {
			await testInfo.attach("egest-requests", {
				body: [`at first paint: ${String(atPaint)} of ${String(chunks)} chunks`, ...requested].join("\n"),
				contentType: "text/plain"
			})
		}

		expect(atPaint).toBe(firstPaintChunks(bytes, 12))
		expect(atPaint).toBeLessThan(chunks / 2)
		await expect(dialog.getByText("Page 1 of 12", { exact: false }).first()).toBeAttached()
	})

	expect(cspViolations).toEqual([])
})

test("the viewer's own data files draw CJK text, JPEG 2000, JBIG2 and CMYK pages", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const assets: string[] = []

	page.context().on("requestfinished", request => {
		const url = new URL(request.url())

		if (url.pathname.startsWith("/assets/pdfjs-")) assets.push(url.pathname)
	})

	await withScratchDirectory(page, "pdf-assets", async ({ listbox, runId }) => {
		const files = ["cjk-non-embedded.pdf", "jpx.pdf", "jbig2.pdf", "cmyk.pdf"].map(file => ({
			file,
			name: `e2e-pdf-${runId}-${file}`
		}))

		await uploadFiles(
			page,
			files.map(({ file, name }) => ({ name, mimeType: PDF_MIME, buffer: fixture(file) })),
			listbox
		)

		for (const { file, name } of files) {
			const dialog = await openPdf(page, listbox, name)
			const ink = await inkOf(dialog)

			if (file === "jpx.pdf" || file === "cmyk.pdf") expect(ink.colour, file).toBeGreaterThan(10_000)
			else expect(ink.dark, file).toBeGreaterThan(3_000)

			await page.keyboard.press("Escape")
			await expect(dialog).toHaveCount(0)
		}
	})

	expect(assets.some(path => path.endsWith(".bcmap"))).toBe(true)
	expect(assets.some(path => path.endsWith("/openjpeg.wasm"))).toBe(true)
	expect(assets.some(path => path.endsWith("/jbig2.wasm"))).toBe(true)
	expect(assets.some(path => path.includes("quickjs"))).toBe(false)
	expect(cspViolations).toEqual([])
})

// Resolves once no chunk request has started for `quietMs`: the reads of a scroll or a render have settled, and with
// them the viewer's own wait (1 s idle) before it reopens a document over its resident limit.
async function egestSettled(egest: EgestObserver, quietMs: number): Promise<void> {
	let seen = -1
	let since = Date.now()

	await expect
		.poll(
			() => {
				const now = egest.requests()

				if (now !== seen) {
					seen = now
					since = Date.now()
				}

				return Date.now() - since >= quietMs
			},
			{ timeout: LAZY_VIEWER_TIMEOUT_MS, intervals: [100] }
		)
		.toBe(true)
}

// The chunks a document opened again reads to show page `shown`: the header and catalog, every page's own dictionary
// (pdf.js walks the page tree at open), the pages within two of the one in view with their images (the view's
// read-ahead margin), and the cross-reference table at the end.
function reopenChunks(layout: ReturnType<typeof writeResidentPdf>, shown: number): number {
	const chunks = new Set<number>()
	const add = (from: number, to: number): void => {
		for (let chunk = Math.floor(from / CHUNK); chunk <= Math.floor((to - 1) / CHUNK); chunk++) chunks.add(chunk)
	}
	const first = layout.pages[0]
	const last = layout.pages.at(-1)

	if (first === undefined || last === undefined) throw new Error("no pages")

	add(0, first[0])

	layout.pages.forEach(([start, end], index) => {
		const page = index + 1

		if (Math.abs(page - shown) <= 2) add(start, end)
		else add(start, start + 1)
	})

	add(last[1], layout.length)

	return chunks.size
}

// 20 pages of one 16 MiB image each (fixtures/largeFiles.ts): viewed in turn, pdf.js reads past the desktop's 256 MiB resident
// limit. Once those reads settle the viewer opens the document again (a new pdf.js worker, the old one going once the
// new one shows), on the page and at the zoom it was showing, and the new document reads only what is near the view.
test("a ranged PDF that read past the resident limit reopens where it was shown", async ({ page }, testInfo) => {
	// Linux WebKit runs pdf.js without OffscreenCanvas (@filen/office's pdfDocumentParams): with it, plain pdf.js on these
	// pages kept 1.4 GB by page 1, 2.6 GB by page 12 and 3.2 GB by page 20 in its web process, and 1.9 GB after the
	// document was destroyed; without it 0.3, 0.6 and 0.7 GB. Chromium: 0.2, 0.5 and 0.7 GB.
	// The write lane's 900s holds the scratch directory's brackets; on top of them a 320 MiB upload (its own budget)
	// and twenty 16-megapixel page renders.
	test.setTimeout(900_000 + LARGE_UPLOAD_TIMEOUT_MS + 300_000)

	const cspViolations = trackCspViolations(page)
	const dir = mkdtempSync(join(tmpdir(), "filen-e2e-resident-"))

	try {
		await withScratchDirectory(page, "pdf-resident", async ({ listbox, runId }) => {
			const name = `e2e-pdf-resident-${runId}.pdf`
			const layout = writeResidentPdf(join(dir, name))

			await uploadDiskFiles(page, [join(dir, name)], listbox)

			// The upload warm draws the row's thumbnail from the local file on a pdf.js worker of its own: done before
			// the viewer's workers are counted.
			await expect(listbox.getByRole("option", { name }).locator("img")).toHaveAttribute("src", /^blob:/, {
				timeout: LAZY_VIEWER_TIMEOUT_MS
			})

			const egest = observeEgest(page.context())
			const workers: Worker[] = []
			const closed = new Set<Worker>()
			let atReopen = -1

			page.on("worker", worker => {
				if (!/\/pdf\.worker[-.]/u.test(worker.url())) return

				workers.push(worker)
				worker.on("close", () => closed.add(worker))

				if (workers.length === 2) atReopen = egest.requests()
			})

			// A desktop window: about one page in view at 200%.
			await page.setViewportSize({ width: 1280, height: 720 })

			const dialog = await openPdf(page, listbox, name)
			const field = dialog.getByRole("textbox", { name: "Page number" })
			const rendered = (n: number): Locator => dialog.locator(`[data-page="${String(n)}"][data-rendered="true"]`)

			await expect(rendered(1)).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await dialog.getByRole("button", { name: /^Zoom level/u }).click()
			await page.getByRole("menuitemradio", { name: "200%" }).click()
			await expect(dialog.getByRole("button", { name: "Zoom level, 200%" })).toBeVisible()

			let shown = 1

			for (let next = 2; next <= RESIDENT_PDF_PAGES && workers.length < 2; next++) {
				await field.fill(String(next))
				await field.press("Enter")
				await expect(rendered(next)).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })
				shown = next
				await egestSettled(egest, 1_500)
			}

			const [opened] = workers

			if (workers.length < 2 || opened === undefined) {
				await testInfo.attach("chunk-requests", {
					body: `${String(egest.requests())} after page ${String(shown)}`,
					contentType: "text/plain"
				})
			}

			expect(workers.length, "the document was opened again").toBeGreaterThanOrEqual(2)
			// The first document goes once the second shows.
			await expect.poll(() => opened !== undefined && closed.has(opened), { timeout: LAZY_VIEWER_TIMEOUT_MS }).toBe(true)

			// Same page, same zoom, drawn by the new document.
			await expect(field).toHaveValue(String(shown))
			await expect(dialog.getByRole("button", { name: "Zoom level, 200%" })).toBeVisible()
			await expect(rendered(shown)).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await egestSettled(egest, 1_500)

			const afterReopen = egest.requests() - atReopen

			expect(afterReopen).toBeLessThanOrEqual(reopenChunks(layout, shown))
			// Opened once more for it, not again and again.
			expect(workers.length).toBe(2)
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}

	expect(cspViolations).toEqual([])
})

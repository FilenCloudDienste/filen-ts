import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { buildZip, prng } from "../helpers/archiveFixtures"
import { PDF_DESKTOP_MEMORY, PDF_MOBILE_MEMORY } from "@filen/office/core/pdfedit"

// What laying an e-book out costs in MuPDF, against the e-book reader's budgets (on request: FILEN_WEB_E2E_EBOOK_BENCH=1;
// Chromium only, it throttles through CDP). The book is a generated novel of about 2 MB of XHTML in 40 chapters, the
// engine the app's own MuPDF build run in a blank page (the same wasm the read role's worker runs; a worker's CPU is
// the page's). Per profile, desktop at full speed and a mid phone at 4x CPU throttling, and per sample in a fresh
// context: the whole-book layout at open (open, layout, page count), a relayout at a larger text size, and the wasm
// heap's size (its high-water mark: wasm memory never shrinks) before the book, after the open and after the relayout.
// Medians are attached; FILEN_WEB_E2E_EBOOK_BENCH_RECORD=<path> writes them. The run fails when a layout misses its
// budget (1.5 s desktop, 4 s mid phone) or the heap passes the profile's heap budget.
// ebookLayout.baseline.json is the record of the run the reader shipped with (Apple Silicon desktop, Chromium).

test.skip(process.env["FILEN_WEB_E2E_EBOOK_BENCH"] !== "1", "The e-book layout bench runs on request (FILEN_WEB_E2E_EBOOK_BENCH=1)")
test.use({ injectSession: false })

const SAMPLES = Number(process.env["FILEN_WEB_E2E_EBOOK_BENCH_SAMPLES"] ?? "3")
const MIB = 1024 * 1024
const BENCH_ORIGIN = "http://ebook-bench.invalid"
const MUPDF_DIST = dirname(createRequire(fileURLToPath(import.meta.url)).resolve("mupdf"))

interface Profile {
	readonly name: "desktop" | "midPhone"
	readonly cpuThrottle: number
	readonly layoutBudgetMs: number
	readonly heapBudgetMb: number
}

const PROFILES: readonly Profile[] = [
	{ name: "desktop", cpuThrottle: 1, layoutBudgetMs: 1500, heapBudgetMb: PDF_DESKTOP_MEMORY.heapBudget / MIB },
	{ name: "midPhone", cpuThrottle: 4, layoutBudgetMs: 4000, heapBudgetMb: PDF_MOBILE_MEMORY.heapBudget / MIB }
]

interface Sample {
	readonly openMs: number
	readonly relayoutMs: number
	readonly pages: number
	readonly relaidPages: number
	readonly baseHeapMb: number
	readonly openHeapMb: number
	readonly relayoutHeapMb: number
}

const WORDS = [
	"the",
	"and",
	"was",
	"morning",
	"river",
	"house",
	"light",
	"against",
	"window",
	"quietly",
	"remembered",
	"letter",
	"between",
	"stairs",
	"evening",
	"garden",
	"whispered",
	"through",
	"door",
	"long",
	"before",
	"winter",
	"station",
	"journey",
	"never",
	"anyone",
	"believed",
	"strange",
	"careful",
	"hands"
]

// A novel: 40 chapters of about 50 KB of XHTML each (paragraphs of pseudo-random prose, a heading per chapter).
function novel(): { readonly epub: Buffer; readonly xhtmlBytes: number } {
	const random = prng(0xb00c)
	const chapters: string[] = []

	for (let chapter = 0; chapter < 40; chapter++) {
		const paragraphs: string[] = []
		let size = 0

		while (size < 50_000) {
			const bytes = random(120)
			const words = Array.from(bytes, byte => WORDS[byte % WORDS.length] ?? "the")
			const paragraph = `<p>${words.join(" ")}.</p>`

			paragraphs.push(paragraph)
			size += paragraph.length
		}

		chapters.push(
			`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><h1>Chapter ${String(chapter + 1)}</h1>${paragraphs.join("")}</body></html>`
		)
	}

	const manifest = chapters.map(
		(_, index) => `<item id="c${String(index)}" href="c${String(index)}.xhtml" media-type="application/xhtml+xml"/>`
	)
	const spine = chapters.map((_, index) => `<itemref idref="c${String(index)}"/>`)
	const epub = buildZip([
		{ name: "mimetype", data: "application/epub+zip", method: "stored" },
		{
			name: "META-INF/container.xml",
			data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
		},
		{
			name: "OEBPS/content.opf",
			data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">bench</dc:identifier><dc:title>Bench Novel</dc:title><dc:language>en</dc:language></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`
		},
		...chapters.map((data, index) => ({ name: `OEBPS/c${String(index)}.xhtml`, data }))
	])

	return { epub, xhtmlBytes: chapters.reduce((sum, chapter) => sum + chapter.length, 0) }
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)

	return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

// The app's MuPDF build, served from the package under a bench origin that touches no network.
async function serveMupdf(page: Page): Promise<void> {
	await page.route(`${BENCH_ORIGIN}/**`, async route => {
		const path = new URL(route.request().url()).pathname

		if (path === "/") {
			await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>bench</title>" })

			return
		}

		const file = path.slice(1)

		if (!/^mupdf(?:-wasm)?\.(?:js|wasm)$/u.test(file)) {
			await route.fulfill({ status: 404 })

			return
		}

		await route.fulfill({
			contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
			body: readFileSync(join(MUPDF_DIST, file))
		})
	})
}

async function sample(page: Page, epub: Buffer): Promise<Sample> {
	return await page.evaluate(
		async ({ base64, origin }) => {
			const mupdf = (await import(`${origin}/mupdf.js`)) as typeof import("mupdf")
			const heapMb = (): number => {
				const probe = new mupdf.Buffer()
				const bytes = probe.asUint8Array().buffer.byteLength

				probe.destroy()

				return bytes / 1048576
			}
			const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
			const baseHeapMb = heapMb()
			const opened = performance.now()
			const document = mupdf.Document.openDocument(bytes, "application/epub+zip")

			document.layout(432, 648, 11)

			const pages = document.countPages()
			const openMs = performance.now() - opened
			const openHeapMb = heapMb()
			const relaid = performance.now()

			mupdf.shrinkStore(50)
			document.layout(432, 648, 14)

			const relaidPages = document.countPages()
			const relayoutMs = performance.now() - relaid
			const relayoutHeapMb = heapMb()

			document.destroy()

			return { openMs, relayoutMs, pages, relaidPages, baseHeapMb, openHeapMb, relayoutHeapMb }
		},
		{ base64: epub.toString("base64"), origin: BENCH_ORIGIN }
	)
}

test("e-book layout cost", async ({ browser, browserName }, testInfo) => {
	test.skip(browserName !== "chromium", "The CPU throttle is set through CDP, Chromium's alone")
	test.setTimeout(PROFILES.length * SAMPLES * 120_000)

	const { epub, xhtmlBytes } = novel()
	const results: Record<string, unknown> = { xhtmlMb: xhtmlBytes / 1e6, epubMb: epub.length / 1e6, samples: SAMPLES }
	const misses: string[] = []

	for (const profile of PROFILES) {
		const samples: Sample[] = []

		for (let run = 0; run < SAMPLES; run++) {
			const context = await browser.newContext()

			try {
				const page = await context.newPage()

				await serveMupdf(page)
				await page.goto(`${BENCH_ORIGIN}/`)

				if (profile.cpuThrottle > 1) {
					const cdp = await context.newCDPSession(page)

					await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottle })
				}

				samples.push(await sample(page, epub))
			} finally {
				await context.close()
			}
		}

		const result = {
			cpuThrottle: profile.cpuThrottle,
			pages: samples[0]?.pages ?? 0,
			relaidPages: samples[0]?.relaidPages ?? 0,
			openMs: Math.round(median(samples.map(entry => entry.openMs))),
			relayoutMs: Math.round(median(samples.map(entry => entry.relayoutMs))),
			baseHeapMb: median(samples.map(entry => entry.baseHeapMb)),
			openHeapMb: median(samples.map(entry => entry.openHeapMb)),
			relayoutHeapMb: median(samples.map(entry => entry.relayoutHeapMb)),
			layoutBudgetMs: profile.layoutBudgetMs,
			heapBudgetMb: profile.heapBudgetMb
		}

		results[profile.name] = result

		if (result.openMs > profile.layoutBudgetMs) misses.push(`${profile.name} layout at open ${String(result.openMs)} ms`)
		if (result.relayoutMs > profile.layoutBudgetMs) misses.push(`${profile.name} relayout ${String(result.relayoutMs)} ms`)
		if (result.relayoutHeapMb > profile.heapBudgetMb) misses.push(`${profile.name} heap ${String(result.relayoutHeapMb)} MB`)
	}

	const report = JSON.stringify(results, null, "\t")

	await testInfo.attach("ebook-layout-cost", { body: report, contentType: "application/json" })

	const recordPath = process.env["FILEN_WEB_E2E_EBOOK_BENCH_RECORD"]

	if (recordPath !== undefined && recordPath !== "") writeFileSync(recordPath, report)

	expect(misses, report).toEqual([])
})

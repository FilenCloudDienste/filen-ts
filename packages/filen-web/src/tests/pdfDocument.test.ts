import { describe, expect, it } from "vitest"
import * as legacy from "pdfjs-dist/legacy/build/pdf.mjs"
import "pdfjs-dist/legacy/build/pdf.worker.mjs"
import { openPdf, pdfLinks, PdfFinder, PDF_FIND_INTS, resolveDestination, type PdfJs, type PdfSource } from "@filen/office/dom/pdf"

// @filen/office's PDF loader, links and find against the real pdf.js, in its legacy build with the in-thread
// worker (as a page that cannot start a worker runs it; the import above installs that worker).

const PDFJS: PdfJs = {
	getDocument: legacy.getDocument,
	GlobalWorkerOptions: legacy.GlobalWorkerOptions,
	PDFDataRangeTransport: legacy.PDFDataRangeTransport
}

interface PageSpec {
	readonly lines: readonly string[]
	// Annotation dictionaries; "PAGE<n>" is replaced by page n's reference.
	readonly annots?: readonly string[]
}

// A minimal PDF 1.4: Helvetica text, one line per Tj, links as annotations, named destinations in /Dests.
function buildPdf(pages: readonly PageSpec[], dests: Record<string, number> = {}): Uint8Array {
	const objects: string[] = []
	const add = (body: string): number => objects.push(body)
	const catalog = add("")
	const tree = add("")
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	const pageIds = pages.map(() => 0)

	pages.forEach((page, index) => {
		const stream = page.lines.map((line, row) => `BT /F1 12 Tf 20 ${String(360 - row * 20)} Td (${line}) Tj ET`).join("\n")
		const content = add(`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`)

		pageIds[index] = add("")

		const annots = (page.annots ?? []).map(annot => `${String(add(annot))} 0 R`)

		objects[(pageIds[index] ?? 0) - 1] =
			`<< /Type /Page /Parent ${String(tree)} 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(content)} 0 R${annots.length > 0 ? ` /Annots [${annots.join(" ")}]` : ""} >>`
	})

	const ref = (page: number): string => `${String(pageIds[page - 1])} 0 R`
	const destEntries = Object.entries(dests)
		.map(([name, page]) => `/${name} [${ref(page)} /Fit]`)
		.join(" ")

	objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(tree)} 0 R${destEntries.length > 0 ? ` /Dests << ${destEntries} >>` : ""} >>`
	objects[tree - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`

	for (let index = 0; index < objects.length; index++) {
		objects[index] = (objects[index] ?? "").replace(/PAGE(\d+)/g, (_, page: string) => ref(Number(page)))
	}

	let out = "%PDF-1.4\n"
	const offsets: number[] = []

	objects.forEach((body, index) => {
		offsets.push(out.length)
		out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`
	})

	const xref = out.length

	out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
	out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`

	return new TextEncoder().encode(out)
}

const PAGES: PageSpec[] = [
	{
		lines: ["The quick brown fox", "jumps over the lazy dog"],
		annots: [
			"<< /Type /Annot /Subtype /Link /Rect [20 340 120 360] /Border [0 0 0] /A << /S /URI /URI (https://example.com/pdf) >> >>",
			"<< /Type /Annot /Subtype /Link /Rect [20 300 120 320] /Border [0 0 0] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>",
			"<< /Type /Annot /Subtype /Link /Rect [20 260 120 280] /Border [0 0 0] /Dest /chapter >>",
			"<< /Type /Annot /Subtype /Link /Rect [20 220 120 240] /Border [0 0 0] /Dest [PAGE2 /Fit] >>"
		]
	},
	{ lines: ["Second page", "the fox again"] },
	{ lines: ["Chapter", "no animals here"] }
]

const BYTES = buildPdf(PAGES, { chapter: 3 })
const NO_PASSWORD = (): void => {
	throw new Error("no password expected")
}

async function open(source: PdfSource) {
	const opening = openPdf(PDFJS, source, { worker: { kind: "inThread" }, onPassword: NO_PASSWORD })
	const document = await opening.promise

	return { document, opening }
}

describe("the PDF loader on pdf.js", () => {
	it("opens the whole file without detaching the caller's bytes", async () => {
		const bytes = BYTES.slice()
		const { document, opening } = await open({ kind: "bytes", bytes })

		expect(document.numPages).toBe(3)
		expect(bytes.byteLength).toBe(BYTES.byteLength)
		await opening.destroy()
	})

	it("opens a file read in ranges no larger than the reader's limit", async () => {
		const reads: number[] = []
		const { document, opening } = await open({
			kind: "ranges",
			length: BYTES.length,
			chunkSize: 1024,
			maxRead: 700,
			read: (offset, length) => {
				reads.push(length)

				return Promise.resolve(BYTES.slice(offset, offset + length))
			}
		})
		const page = await document.getPage(3)
		const text = await page.getTextContent()

		expect(text.items.map(item => String(Reflect.get(item as object, "str")))).toContain("no animals here")
		expect(Math.max(...reads)).toBeLessThanOrEqual(700)
		await opening.destroy()
	})

	it("reports a file that is not a PDF as an invalid document", async () => {
		const opening = openPdf(
			PDFJS,
			{ kind: "bytes", bytes: new TextEncoder().encode("not a pdf") },
			{ worker: { kind: "inThread" }, onPassword: NO_PASSWORD }
		)

		await expect(opening.promise).rejects.toMatchObject({ name: "InvalidPDFException" })
		await opening.destroy()
	})
})

describe("PDF links on pdf.js", () => {
	it("keeps the https link and the destinations, drops the script, and resolves where each destination leads", async () => {
		const { document, opening } = await open({ kind: "bytes", bytes: BYTES })
		const page = await document.getPage(1)
		const links = pdfLinks(await page.getAnnotations({ intent: "display" }))

		expect(links.map(link => (link.kind === "external" ? link.url : "internal"))).toEqual([
			"https://example.com/pdf",
			"internal",
			"internal"
		])

		const targets = await Promise.all(
			links.flatMap(link => (link.kind === "internal" ? [resolveDestination(document, link.dest)] : []))
		)

		expect(targets.map(target => target?.page)).toEqual([3, 2])
		await opening.destroy()
	})
})

describe("PDF find on pdf.js", () => {
	it("finds every match across pages, mapped onto the text items the text layer draws", async () => {
		const { document, opening } = await open({ kind: "bytes", bytes: BYTES })
		const result = await new PdfFinder(document).search("FOX", false, { aborted: false })
		const matches = Array.from(result?.matches ?? [])
		const found: string[] = []

		for (let at = 0; at < matches.length; at += PDF_FIND_INTS) {
			const [pageNumber = 0, first = 0, offset = 0, last = 0, end = 0] = matches.slice(at, at + PDF_FIND_INTS)
			const items = (await (await document.getPage(pageNumber)).getTextContent()).items.map(item =>
				String(Reflect.get(item as object, "str"))
			)

			expect(first).toBe(last)
			found.push(`${String(pageNumber)}:${(items[first] ?? "").slice(offset, end)}`)
		}

		expect(found).toEqual(["1:fox", "2:fox"])
		await opening.destroy()
	})

	it("finds a phrase broken over two lines", async () => {
		const { document, opening } = await open({ kind: "bytes", bytes: BYTES })
		const result = await new PdfFinder(document).search("brown fox jumps", false, { aborted: false })

		expect(result?.matches.length).toBe(PDF_FIND_INTS)
		expect(result?.matches[0]).toBe(1)
		await opening.destroy()
	})
})

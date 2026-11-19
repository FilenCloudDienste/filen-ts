import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { PdfEngineError, type PdfEngineClient } from "../../dom/pdfedit/client"
import { MUPDF_FORMATS, type MupdfFormat } from "../../dom/pdfedit/formats"
import type { PdfEngineArgs, PdfEngineOp, PdfOpenResult, PdfRenderArgs } from "../../dom/pdfedit/protocol"
import { PDF_ENGINE_REQUESTS } from "../../dom/pdfedit/requests"
import { ENCRYPTION_XML_MAX_BYTES, encryptionAlgorithms, READ_REQUESTS } from "../../dom/pdfedit/readRequests"
import { localEngine, stopLocalEngines } from "./localEngine"
import { startEngine, stopEngines } from "./harness"
import { EPUB_CHAPTERS, makeEpub, makeFb2, makeMobi } from "./readFixtures"
import { makePdf } from "./fixtures"
import { budget } from "../timing"
import { strToU8, unzipSync, zipSync } from "fflate"

afterEach(() => {
	stopLocalEngines()
	stopEngines()
})

const TIMEOUT = budget(30_000)
const LAYOUT = { width: 400, height: 600, em: 11 }
const UNBOUNDED = 1e12

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise

		return "ok"
	} catch (error) {
		return error instanceof PdfEngineError ? error.failure : String(error)
	}
}

async function openBytes(
	client: PdfEngineClient,
	format: MupdfFormat,
	bytes: Uint8Array,
	extra: Partial<PdfEngineArgs<"open">> = {}
): Promise<PdfOpenResult> {
	return client.call("open", { bytes, role: "read", format, layout: LAYOUT, maxImagePixels: UNBOUNDED, ...extra })
}

function tile(page: number, generation: number, scale = 1): PdfRenderArgs {
	return { page, scale, rotation: 0, tile: [0, 0, 256, 256], priority: "visible", generation }
}

describe("the read role", () => {
	it("opens EPUB, FB2 and MOBI books from their bytes", async () => {
		const books: readonly (readonly [MupdfFormat, Uint8Array, string])[] = [
			["epub", makeEpub(), "EPUB"],
			["fb2", makeFb2(), "FictionBook2"],
			["mobi", makeMobi(), "MOBI"]
		]

		for (const [format, bytes, name] of books) {
			const client = localEngine()
			const opened = await openBytes(client, format, bytes)

			expect(opened.status).toBe("open")
			expect(opened.status === "open" ? opened.document.format : "").toBe(name)
			expect(opened.status === "open" ? opened.document.pageCount : 0).toBeGreaterThan(1)

			const text = await client.call("text", { page: 0, generation: 0 })

			expect(text.lines.length).toBeGreaterThan(0)
			client.terminate()
		}
	})

	it(
		"opens an EPUB through the sync range channel",
		async () => {
			const bytes = makeEpub({ imageSide: 800 })
			const engine = startEngine(bytes)
			const opened = await engine.openRead({ format: "epub", layout: LAYOUT, maxImagePixels: UNBOUNDED })

			expect(opened.status).toBe("open")

			const tileValue = await engine.client.call("render", tile(0, 0))

			expect(tileValue.tile).toEqual([0, 0, 256, 256])
			expect(engine.reads.length).toBeGreaterThan(0)
		},
		TIMEOUT
	)

	it("lays out again as a new generation, and cancels requests of the old one", async () => {
		const client = localEngine()

		await openBytes(client, "epub", makeEpub())

		const before = await client.call("pages", { from: 0, count: 1000, generation: 0 })
		const laidOut = await client.call("layout", { width: 800, height: 600, em: 11, generation: 1 })

		expect(laidOut.generation).toBe(1)
		expect(laidOut.pageCount).toBeLessThan(before.length)
		expect(await failure(client.call("render", tile(0, 0)))).toBe("cancelled")
		expect(await failure(client.call("text", { page: 0, generation: 0 }))).toBe("cancelled")
		expect(await failure(client.call("layout", { ...LAYOUT, generation: 1 }))).toBe("cancelled")
		expect(await failure(client.call("render", tile(0, 1)))).toBe("ok")
		expect(await failure(client.call("render", { page: 0, scale: 1, rotation: 0, tile: [0, 0, 256, 256], priority: "visible" }))).toBe(
			"badRequest"
		)
	})

	it("runs only the newest of the layouts waiting", async () => {
		const client = localEngine()

		await openBytes(client, "epub", makeEpub())

		// Sent in one go: the first runs, the second waits and is replaced by the third.
		const first = client.call("layout", { width: 300, height: 500, em: 11, generation: 1 })
		const second = client.call("layout", { width: 500, height: 500, em: 11, generation: 2 })
		const third = client.call("layout", { width: 700, height: 500, em: 11, generation: 3 })

		expect((await first).generation).toBe(1)
		expect(await failure(second)).toBe("cancelled")
		expect((await third).generation).toBe(3)
	})

	it("gives the outline with numeric destinations, metadata and outward search", async () => {
		const client = localEngine()

		await openBytes(client, "epub", makeEpub())

		const outline = await client.call("outline", { generation: 0 })
		const pages = await client.call("pages", { from: 0, count: 1000, generation: 0 })

		expect(outline.map(node => node.title)).toEqual([...EPUB_CHAPTERS])

		const starts = outline.map(node => node.dest?.[0] ?? -1)

		expect(starts[0]).toBe(0)
		expect(starts[1]).toBeGreaterThan(0)
		expect(starts[2]).toBeGreaterThan(starts[1] ?? 0)
		expect(starts[2]).toBeLessThan(pages.length)
		expect(outline[0]?.dest?.[1]).toEqual({ name: "XYZ" })

		expect(await client.call("metadata", {})).toEqual({ format: "EPUB", title: "Test Book", author: "An Author", subject: null })

		const anchor = (starts[1] ?? 1) - 1

		expect(await client.call("locate", { text: "unique anchor phrase", around: 0, radius: 0, generation: 0 })).toBe(
			anchor === 0 ? 0 : null
		)
		expect(await client.call("locate", { text: "unique anchor phrase", around: anchor + 2, radius: 3, generation: 0 })).toBe(anchor)
		expect(await client.call("locate", { text: "no such words", around: 0, radius: 2, generation: 0 })).toBeNull()
	})

	it("gives right-to-left lines their direction and resolves chapter links", async () => {
		const client = localEngine()

		await openBytes(client, "epub", makeEpub())

		const outline = await client.call("outline", { generation: 0 })
		const hebrew = outline[2]?.dest?.[0] ?? -1
		const text = await client.call("text", { page: hebrew, generation: 0 })

		expect(text.lines.find(line => /[\u05d0-\u05ea]/.test(line.str))?.dir).toBe("rtl")
		expect(text.lines.find(line => line.str.includes("Hebrew"))?.dir).toBe("ltr")
		expect(text.links).toContainEqual(expect.objectContaining({ page: 0 }))
	})

	it("places a right-to-left line at its visual extent, not from its logical first character", async () => {
		const client = localEngine()
		const book = makeEpub()

		await openBytes(client, "epub", book)

		const outline = await client.call("outline", { generation: 0 })
		const hebrew = outline[2]?.dest?.[0] ?? -1
		const text = await client.call("text", { page: hebrew, generation: 0 })
		const line = text.lines.find(found => /^[\u05d0-\u05ea\s]+$/.test(found.str.trim()))

		// The same line's box as MuPDF lays it out.
		const document = mupdf.Document.openDocument(book, MUPDF_FORMATS.epub.magic)

		document.layout(LAYOUT.width, LAYOUT.height, LAYOUT.em)

		const page = document.loadPage(hebrew)
		const bounds = page.getBounds()
		const stext = page.toStructuredText("preserve-whitespace")
		let box: readonly number[] | null = null
		let current: readonly number[] = []
		let chars = ""

		stext.walk({
			beginLine: bbox => {
				current = bbox
				chars = ""
			},
			onChar: c => {
				chars += c
			},
			endLine: () => {
				if (box === null && line !== undefined && chars === line.str) box = current
			}
		})
		stext.destroy()
		page.destroy()
		document.destroy()

		expect(line?.dir).toBe("rtl")
		expect(box).not.toBeNull()

		const [x0 = 0, , x1 = 0] = box ?? []

		expect(line?.width ?? 0).toBeGreaterThan(0)
		expect(Math.abs((line?.x ?? 0) - (x0 - bounds[0]))).toBeLessThan(1)
		expect(Math.abs((line?.width ?? 0) - (x1 - x0))).toBeLessThan(1)
	})

	it("refuses a book locked by DRM, and opens one whose fonts are only obfuscated", async () => {
		const locked = makeEpub({ encryption: ["http://www.w3.org/2001/04/xmlenc#aes128-cbc"] })
		const obfuscated = makeEpub({ encryption: ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"] })

		expect(await failure(openBytes(localEngine(), "epub", locked))).toBe("notSupported")
		expect(await failure(openBytes(localEngine(), "epub", obfuscated))).toBe("ok")
		expect(await failure(openBytes(localEngine(), "mobi", makeMobi(2)))).toBe("notSupported")
		expect(await failure(openBytes(localEngine(), "epub", new Uint8Array(100)))).toBe("notSupported")
		expect(await failure(openBytes(localEngine(), "mobi", new Uint8Array(100)))).toBe("notSupported")
	})

	it("reads encryption.xml's algorithms in one linear pass", () => {
		expect(
			encryptionAlgorithms(
				[
					'<enc:EncryptionMethod Algorithm="a"/>',
					"<EncryptionMethod Algorithm = 'b' />",
					'<x-y:EncryptionMethod xmlns:x-y="u" Algorithm="c">',
					'<EncryptionMethodX Algorithm="no"/>',
					"<EncryptionMethod/>",
					'<<<EncryptionMethod Algorithm="d">',
					'<EncryptionMethod Algorithm="unclosed'
				].join("")
			)
		).toEqual(["a", "b", "c", "d"])

		// A quadratic scan takes minutes over these.
		for (const hostile of ["<EncryptionMethod ", '<EncryptionMethod Algorithm="', "<"]) {
			const xml = hostile.repeat(Math.ceil((4 * 1024 * 1024) / hostile.length))
			const started = performance.now()

			encryptionAlgorithms(xml)
			encryptionAlgorithms(`${xml}>`)
			expect(performance.now() - started).toBeLessThan(budget(500))
		}
	})

	it("answers a cap-sized hostile encryption.xml quickly and counts an oversized one as locked", async () => {
		const withEncryptionXml = (xml: string): Uint8Array => {
			const files = unzipSync(makeEpub())

			files["META-INF/encryption.xml"] = strToU8(xml)

			return zipSync(files)
		}
		const hostile = "<EncryptionMethod ".repeat(Math.floor(ENCRYPTION_XML_MAX_BYTES / 18))
		const started = performance.now()

		// No algorithm is named, so the DRM check passes it on; MuPDF's own open then refuses the file.
		expect(await failure(openBytes(localEngine(), "epub", withEncryptionXml(hostile)))).toBe("notSupported")
		expect(performance.now() - started).toBeLessThan(budget(2000))
		expect(await failure(openBytes(localEngine(), "epub", withEncryptionXml(" ".repeat(ENCRYPTION_XML_MAX_BYTES + 1))))).toBe(
			"notSupported"
		)
	})

	it("refuses a page whose image is over the pixel budget without decoding it", async () => {
		const client = localEngine()
		const side = 600

		await openBytes(client, "epub", makeEpub({ imageSide: side }), { maxImagePixels: side * side - 1 })

		const outline = await client.call("outline", { generation: 0 })
		const pages = await client.call("pages", { from: 0, count: 1000, generation: 0 })
		const imagePage = pages.length - 1

		expect(outline).toHaveLength(EPUB_CHAPTERS.length)

		// The page's list and text are built (the image's header is read), then a render must not grow anything.
		await client.call("text", { page: imagePage, generation: 0 })

		const before = await client.call("heap", {})

		expect(await failure(client.call("render", tile(imagePage, 0)))).toBe("overBudget")
		expect(await client.call("heap", {})).toEqual(before)
		expect(await failure(client.call("render", tile(0, 0)))).toBe("ok")
	})

	it(
		"refuses every PDF request while a read document is open, and the read requests while a PDF is",
		async () => {
			const client = localEngine()

			await openBytes(client, "fb2", makeFb2())

			const served = new Set<string>([...Object.keys(READ_REQUESTS), "heap"])

			for (const op of Object.keys(PDF_ENGINE_REQUESTS) as PdfEngineOp[]) {
				if (served.has(op)) continue

				expect([op, await failure(client.call(op, {} as never))]).toEqual([op, "badRequest"])
			}

			expect(await failure(client.call("destination", { pageObject: 3, generation: 0 }))).toBe("badRequest")
			await client.call("close", {})
			expect(await failure(client.call("outline", { generation: 0 }))).toBe("closed")

			const pdf = localEngine()
			const document = makePdf({ pages: 1 })

			// A PDF opened in the read role is refused as not one of its formats.
			expect(
				await failure(pdf.call("open", { bytes: document, role: "read", format: "pdf" as MupdfFormat, maxImagePixels: 1 }))
			).toBe("badRequest")
			expect(await failure(pdf.call("open", { bytes: document, role: "edit" }))).toBe("badRequest")

			const engine = startEngine(document)

			await engine.open()

			for (const call of [
				engine.client.call("layout", { ...LAYOUT, generation: 1 }),
				engine.client.call("outline", { generation: 0 }),
				engine.client.call("metadata", {}),
				engine.client.call("locate", { text: "Page", around: 0, radius: 0, generation: 0 })
			])
				expect(await failure(call)).toBe("badRequest")
		},
		TIMEOUT
	)

	it("sets a book's text at the layout's size even where the publisher fixed it in px", async () => {
		const chapter = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title><style>p{font-size:12px;color:#fff;background:#000}</style></head><body>${`<p>${"Lorem ipsum dolor sit amet. ".repeat(20)}</p>`.repeat(40)}</body></html>`
		const book = zipSync({
			mimetype: [strToU8("application/epub+zip"), { level: 0 }],
			"META-INF/container.xml": strToU8(
				'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
			),
			"c.opf": strToU8(
				'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">px</dc:identifier><dc:title>Px</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'
			),
			"c.xhtml": strToU8(chapter)
		})
		const client = localEngine()

		await client.call("open", { bytes: book, role: "read", format: "epub", layout: { ...LAYOUT, em: 9 }, maxImagePixels: UNBOUNDED })

		const small = (await client.call("pages", { from: 0, count: 10_000, generation: 0 })).length
		const large = await client.call("layout", { ...LAYOUT, em: 18, generation: 1 })

		expect(large.pageCount).toBeGreaterThan(small * 1.5)
	})

	it("keeps the format table's answers and MuPDF's void isReflowable", () => {
		expect(MUPDF_FORMATS.epub.readsWhole).toBe(false)
		expect(MUPDF_FORMATS.mobi.readsWhole).toBe(true)
		expect(MUPDF_FORMATS.fb2.readsWhole).toBe(true)

		const document = mupdf.Document.openDocument(makeFb2(), MUPDF_FORMATS.fb2.magic)

		// Upstream canary: if this ever answers, the table's `reflowable` can be checked against it.
		expect(document.isReflowable()).toBeUndefined()
		document.destroy()
	})
})

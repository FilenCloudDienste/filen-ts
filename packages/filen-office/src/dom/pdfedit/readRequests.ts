import type * as Mupdf from "mupdf"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit/budget"
import type { ByteSource } from "../../core/opc/io"
import { ZipArchive } from "../../core/opc/zipReader"
import { PDF_OUTLINE_LIMIT, PDF_OUTLINE_MAX_DEPTH } from "../pdf/outline"
import { isFatalEngineError, PdfEngineRefusal, type PdfEngineContext, type ReadDocument } from "./context"
import { isMupdfFormat, MUPDF_FORMATS, type MupdfFormat } from "./formats"
import { drawTile, pageInfos } from "./pageOps"
import { installReadFontHook } from "./readFonts"
import type { MupdfLayout, PdfDocumentSummary, PdfEngineArgs, PdfOpenResult, PdfReadMetadata, PdfReadOutlineNode } from "./protocol"
import { TileRenderer } from "./render"
import type { PdfHandled, PdfRequestHandler } from "./requests"
import { SyncRangeReader, syncRangeStreamHandle } from "./stream"
import { pageBoundsOf, pageTextLinks, pointOf, structuredTextLines } from "./text"

// The read role: a document other than PDF (formats.ts) opened to read, from its whole bytes or through a sync range
// channel. Its requests name the layout generation they were asked under; a layout starts a new one, and a request of
// an older one is answered "cancelled" before any work (its pages are gone). Pages are drawn by a guarded TileRenderer:
// a page whose largest image is over the open's pixel budget is refused, from the image headers alone. After the open
// and every layout the heap is checked against the memory profile's budget ("overBudget": the page closes the engine).

// An e-book whose encryption.xml names any other algorithm than these (font obfuscation) is locked by DRM.
const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"])
const ENCRYPTION_XML_MAX_BYTES = 4 * 1024 * 1024
const ENCRYPTION_METHOD = /<(?:[\w-]+:)?EncryptionMethod\b[^>]*?\bAlgorithm\s*=\s*["']([^"']*)["']/g

// Layout bounds: points, and the font size.
const LAYOUT_MIN = 72
const LAYOUT_MAX = 14_400
const EM_MIN = 4
const EM_MAX = 144

type OutlineItem = NonNullable<ReturnType<Mupdf.Document["loadOutline"]>>[number]

// The longest text locate searches for.
const LOCATE_MAX_CHARS = 512

function validLayout(layout: MupdfLayout): boolean {
	const within = (value: number, min: number, max: number): boolean => Number.isFinite(value) && value >= min && value <= max

	return (
		within(layout.width, LAYOUT_MIN, LAYOUT_MAX) && within(layout.height, LAYOUT_MIN, LAYOUT_MAX) && within(layout.em, EM_MIN, EM_MAX)
	)
}

// The open read document at `generation`: "cancelled" when the layout moved on.
function readAt(context: PdfEngineContext, generation: number | undefined): ReadDocument {
	const read = context.openRead()

	if (generation === undefined || !Number.isInteger(generation))
		throw new PdfEngineRefusal("badRequest", "a read request names its layout generation")
	if (generation !== read.generation) throw new PdfEngineRefusal("cancelled", "the document was laid out again")

	return read
}

function checkPage(document: Mupdf.Document, page: number): void {
	if (!Number.isInteger(page) || page < 0 || page >= document.countPages()) throw new PdfEngineRefusal("badRequest")
}

function checkHeap(context: PdfEngineContext, read: { readonly memory: { readonly heapBudget: number } }): void {
	const heapBytes = context.heapBytes()

	if (heapBytes > read.memory.heapBudget) throw new PdfEngineRefusal("overBudget", `the engine's heap reached ${heapBytes} bytes`)
}

// Bytes [offset, offset + length) of the file, read synchronously from whichever source it is.
function exactReader(source: SyncRangeReader | Uint8Array): (offset: number, length: number) => Uint8Array {
	if (source instanceof Uint8Array) {
		return (offset, length) => {
			if (offset + length > source.length) throw new PdfEngineRefusal("notSupported", "the file is truncated")

			return source.subarray(offset, offset + length)
		}
	}

	return (offset, length) => {
		const bytes = new Uint8Array(length)

		for (let at = 0; at < length;) {
			const read = source.read(bytes, at, length - at, offset + at)

			if (read <= 0) throw new PdfEngineRefusal(read === 0 ? "notSupported" : "readFailed", source.failure ?? "end of file")

			at += read
		}

		return bytes
	}
}

// Whether the book's content is encrypted (DRM): an EPUB's encryption.xml naming a cipher other than font obfuscation, a
// MOBI whose PalmDOC header names an encryption. Read from the zip's directory and that one entry, or the header.
async function lockedByDrm(format: MupdfFormat, size: number, read: (offset: number, length: number) => Uint8Array): Promise<boolean> {
	if (format === "epub") {
		const source: ByteSource = {
			size,
			read: (offset, length) => {
				try {
					return Promise.resolve(read(offset, length))
				} catch (error) {
					return Promise.reject(error instanceof Error ? error : new Error(String(error)))
				}
			}
		}
		let archive: ZipArchive

		try {
			archive = await ZipArchive.open(source)
		} catch (error) {
			if (error instanceof PdfEngineRefusal) throw error

			// Not a zip MuPDF reads either: its open refuses it.
			return false
		}

		const entry = archive.get("META-INF/encryption.xml")

		if (entry === undefined) return false
		if (entry.uncompressedSize > ENCRYPTION_XML_MAX_BYTES) return true

		const xml = new TextDecoder().decode(await archive.read(entry))

		for (const match of xml.matchAll(ENCRYPTION_METHOD)) {
			if (!FONT_OBFUSCATION.has((match[1] ?? "").trim())) return true
		}

		return false
	}

	if (format === "mobi") {
		// PalmDB: the record count at 76, the first record's offset at 78; the PalmDOC header's encryption at 12 in it.
		if (size < 86) return false

		const view = new DataView(read(76, 6).slice().buffer)

		if (view.getUint16(0) === 0) return false

		const record = view.getUint32(2)

		if (record + 14 > size) return false

		return new DataView(read(record + 12, 2).slice().buffer).getUint16(0) !== 0
	}

	return false
}

function summary(document: Mupdf.Document, pageCount: number): PdfDocumentSummary {
	return {
		pageCount,
		versions: 1,
		repaired: false,
		format: document.getMetaData("format") ?? "",
		encryption: "None",
		permissions: {
			print: true,
			printHq: true,
			copy: true,
			edit: false,
			annotate: false,
			form: false,
			assemble: false,
			accessibility: true
		}
	}
}

export async function openReadDocument(context: PdfEngineContext, args: PdfEngineArgs<"open">): Promise<PdfHandled<PdfOpenResult>> {
	if (context.current !== null || context.reading !== null) throw new PdfEngineRefusal("badRequest", "a document is already open")

	const { format, layout, maxImagePixels, memory = PDF_DESKTOP_MEMORY } = args

	if (!isMupdfFormat(format)) throw new PdfEngineRefusal("badRequest", "not a format the read role opens")
	if (maxImagePixels === undefined || !Number.isFinite(maxImagePixels) || maxImagePixels < 0)
		throw new PdfEngineRefusal("badRequest", "the read role needs its pixel budget")
	if (layout !== undefined && !validLayout(layout)) throw new PdfEngineRefusal("badRequest", "not a layout")

	const { mupdf, host } = context
	const row = MUPDF_FORMATS[format]
	const reader =
		"channel" in args
			? new SyncRangeReader(args.channel.buffer, args.channel.port, args.channel.length, {
					deadlineMs: host.readDeadlineMs,
					now: host.now
				})
			: null
	const bytes = "bytes" in args ? args.bytes : null
	let document: Mupdf.Document | null = null
	let release = (): void => undefined

	try {
		const size = reader?.length ?? bytes?.length ?? 0

		if (await lockedByDrm(format, size, exactReader(reader ?? bytes ?? new Uint8Array(0))))
			throw new PdfEngineRefusal("notSupported", "the book is locked by DRM")

		// Before the open: laying the book out may already need a face.
		if (host.readFonts !== undefined) release = installReadFontHook(mupdf, { ...host.readFonts, language: args.language })

		if (reader === null) document = mupdf.Document.openDocument(bytes ?? new Uint8Array(0), row.magic)
		else {
			const stream = new mupdf.Stream(syncRangeStreamHandle(reader))

			try {
				document = mupdf.Document.openDocument(stream, row.magic)
			} finally {
				stream.destroy()
			}
		}

		if (row.reflowable && layout !== undefined) document.layout(layout.width, layout.height, layout.em)

		const pageCount = document.countPages()

		if (pageCount === 0) throw new PdfEngineRefusal("notSupported", "the document has no pages")

		checkHeap(context, { memory })
		context.setReading({
			document,
			format,
			reader,
			renderer: new TileRenderer(mupdf, document, host.maxDisplayLists, host.now, { maxImagePixels }),
			generation: 0,
			memory,
			maxImagePixels,
			release
		})

		return { value: { status: "open", document: summary(document, pageCount), access: "none" } }
	} catch (error) {
		document?.destroy()
		reader?.close()
		release()

		if (error instanceof PdfEngineRefusal || isFatalEngineError(error)) throw error
		if (reader?.failure !== null && reader?.failure !== undefined) throw new PdfEngineRefusal("readFailed", reader.failure)

		throw new PdfEngineRefusal("notSupported", error instanceof Error ? error.message : String(error))
	}
}

function closeRead(context: PdfEngineContext): PdfHandled<{ readonly heapBytes: number }> {
	const read = context.reading

	if (read !== null) {
		context.setReading(null)
		read.renderer.destroy()
		read.document.destroy()
		read.reader?.close()
		read.release()
		context.mupdf.emptyStore()
	}

	return { value: { heapBytes: context.heapBytes() } }
}

// A link URI's page in the document and its point. MuPDF's destination names the page within its chapter; resolveLink
// gives the document's index.
function resolveIndex(
	document: Mupdf.Document,
	uri: string
): { readonly page: number; readonly point: ReturnType<Mupdf.Document["resolveLinkDestination"]> } | null {
	let page: number
	let point: ReturnType<Mupdf.Document["resolveLinkDestination"]>

	try {
		page = document.resolveLink(uri)
		point = document.resolveLinkDestination(uri)
	} catch {
		return null
	}

	return Number.isInteger(page) && page >= 0 && page < document.countPages() ? { page, point } : null
}

function outlineOf(document: Mupdf.Document): PdfReadOutlineNode[] {
	const raw = document.loadOutline()
	let count = 0
	let boundsOf: ((index: number) => Mupdf.Rect | null) | null = null

	const destOf = (uri: string | undefined): PdfReadOutlineNode["dest"] => {
		if (uri === undefined || uri.length === 0) return null

		const resolved = resolveIndex(document, uri)

		if (resolved === null) return null

		if (boundsOf === null) {
			const first = document.loadPage(resolved.page)

			boundsOf = pageBoundsOf(document, resolved.page, first.getBounds())
			first.destroy()
		}

		const bounds = boundsOf(resolved.page)

		if (bounds === null) return null

		const { left, top } = pointOf(resolved.point, bounds)

		return [resolved.page, { name: "XYZ" }, left, top]
	}

	const walk = (items: readonly OutlineItem[] | undefined, depth: number): PdfReadOutlineNode[] => {
		const nodes: PdfReadOutlineNode[] = []

		for (const item of items ?? []) {
			if (count >= PDF_OUTLINE_LIMIT) break

			count++
			nodes.push({
				title: item.title ?? "",
				dest: destOf(item.uri),
				items: depth + 1 < PDF_OUTLINE_MAX_DEPTH ? walk(item.down, depth + 1) : []
			})
		}

		return nodes
	}

	return walk(raw ?? [], 0)
}

function metadataOf(document: Mupdf.Document): PdfReadMetadata {
	const value = (key: string): string | null => {
		const text = document.getMetaData(key)?.trim()

		return text === undefined || text.length === 0 ? null : text
	}

	return {
		format: value("format") ?? "",
		title: value("info:Title"),
		author: value("info:Author"),
		subject: value("info:Subject")
	}
}

// The pages from `around` outward: around, around + 1, around - 1, ... within `radius`.
function outward(around: number, radius: number, count: number): number[] {
	const order: number[] = []

	for (let step = 0; step <= radius; step++) {
		for (const page of step === 0 ? [around] : [around + step, around - step]) {
			if (page >= 0 && page < count) order.push(page)
		}
	}

	return order
}

type ReadOp = "pages" | "render" | "text" | "destination" | "evict" | "close" | "layout" | "outline" | "metadata" | "locate"

// The requests a read document serves (with heap); the server refuses every other while one is open.
export const READ_REQUESTS: { readonly [K in ReadOp]: PdfRequestHandler<K> } = {
	pages: (context, { from, count, generation }) => ({ value: pageInfos(readAt(context, generation).document, from, count) }),
	render: (context, args) => {
		const { document, renderer } = readAt(context, args.generation)

		return drawTile(context, document, renderer, args)
	},
	text: (context, { page, generation }) => {
		const { document, renderer } = readAt(context, generation)

		checkPage(document, page)

		const { text, bounds } = renderer.pageText(page)
		const lines = structuredTextLines(text, bounds)
		const loaded = document.loadPage(page)

		try {
			return { value: { lines, links: pageTextLinks(document, loaded, pageBoundsOf(document, page, bounds)) } }
		} finally {
			loaded.destroy()
		}
	},
	// A link's URI (`name`) to its page and point; a PDF page object means nothing here.
	destination: (context, args) => {
		const { document } = readAt(context, args.generation)

		if (!("name" in args)) throw new PdfEngineRefusal("badRequest", "a read document has no page objects")

		const resolved = resolveIndex(document, args.name)

		if (resolved === null) return { value: null }

		const loaded = document.loadPage(resolved.page)
		const bounds = loaded.getBounds()

		loaded.destroy()

		return { value: { page: resolved.page, ...pointOf(resolved.point, bounds) } }
	},
	evict: (context, { pages, generation }) => {
		readAt(context, generation).renderer.evict(pages)

		return { value: null }
	},
	close: closeRead,
	layout: (context, { width, height, em, generation }) => {
		const read = context.openRead()

		if (!MUPDF_FORMATS[read.format].reflowable) throw new PdfEngineRefusal("badRequest", "the document has a fixed layout")
		if (!Number.isInteger(generation) || !validLayout({ width, height, em })) throw new PdfEngineRefusal("badRequest", "not a layout")
		if (generation <= read.generation) throw new PdfEngineRefusal("cancelled", "a newer layout was asked for")

		const { mupdf, host } = context

		// The old layout's display lists (and what the store kept for them) go first.
		read.renderer.destroy()
		mupdf.shrinkStore(50)
		read.document.layout(width, height, em)

		const next: ReadDocument = {
			...read,
			renderer: new TileRenderer(mupdf, read.document, host.maxDisplayLists, host.now, { maxImagePixels: read.maxImagePixels }),
			generation
		}

		context.setReading(next)

		const pageCount = read.document.countPages()

		if (pageCount === 0) throw new PdfEngineRefusal("notSupported", "the document has no pages")

		checkHeap(context, next)

		return { value: { pageCount, generation } }
	},
	outline: (context, { generation }) => ({ value: outlineOf(readAt(context, generation).document) }),
	metadata: context => ({ value: metadataOf(context.openRead().document) }),
	locate: (context, { text, around, radius, generation }) => {
		const { document } = readAt(context, generation)
		const count = document.countPages()

		if (typeof text !== "string" || text.length === 0 || text.length > LOCATE_MAX_CHARS) throw new PdfEngineRefusal("badRequest")
		if (!Number.isInteger(around) || !Number.isInteger(radius) || radius < 0) throw new PdfEngineRefusal("badRequest")

		for (const page of outward(Math.min(Math.max(0, around), count - 1), radius, count)) {
			const loaded = document.loadPage(page)

			try {
				if (loaded.search(text, "").length > 0) return { value: page }
			} finally {
				loaded.destroy()
			}
		}

		return { value: null }
	}
}

// The read requests the PDF table answers too: each refuses ("badRequest") while a PDF is open, "closed" when nothing is.
export const READ_ONLY_REQUESTS: Pick<typeof READ_REQUESTS, "layout" | "outline" | "metadata" | "locate"> = {
	layout: READ_REQUESTS.layout,
	outline: READ_REQUESTS.outline,
	metadata: READ_REQUESTS.metadata,
	locate: READ_REQUESTS.locate
}

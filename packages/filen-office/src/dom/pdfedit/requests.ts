import type * as Mupdf from "mupdf"
import { PdfEngineRefusal, type PdfEngineContext } from "./context"
import type {
	PdfAccess,
	PdfDocumentSummary,
	PdfEngineArgs,
	PdfEngineOp,
	PdfEngineValue,
	PdfOpenResult,
	PdfPageInfo,
	PdfPermission
} from "./protocol"
import { TileRenderer } from "./render"
import { SyncRangeReader, syncRangeStreamHandle } from "./stream"

// The engine's request table: one entry per request. A handler gets the engine context and the request's arguments
// and returns its value (and what of it to transfer); it may throw a PdfEngineRefusal. Renders are queued by priority
// (server.ts); everything else runs in arrival order.

export interface PdfHandled<V> {
	readonly value: V
	readonly transfer?: readonly unknown[]
}

export type PdfRequestHandler<K extends PdfEngineOp> = (
	context: PdfEngineContext,
	args: PdfEngineArgs<K>
) => PdfHandled<PdfEngineValue<K>> | Promise<PdfHandled<PdfEngineValue<K>>>

export type PdfRequestTable = { readonly [K in PdfEngineOp]: PdfRequestHandler<K> }

const PERMISSIONS: readonly (readonly [PdfPermission, Mupdf.DocumentPermission])[] = [
	["print", "print"],
	["printHq", "print-hq"],
	["copy", "copy"],
	["edit", "edit"],
	["annotate", "annotate"],
	["form", "form"],
	["assemble", "assemble"],
	["accessibility", "accessibility"]
]

function summary(document: Mupdf.PDFDocument): PdfDocumentSummary {
	const permissions: Record<PdfPermission, boolean> = {
		print: false,
		printHq: false,
		copy: false,
		edit: false,
		annotate: false,
		form: false,
		assemble: false,
		accessibility: false
	}

	for (const [ours, theirs] of PERMISSIONS) permissions[ours] = document.hasPermission(theirs)

	return {
		pageCount: document.countPages(),
		versions: document.countVersions(),
		repaired: document.wasRepaired(),
		format: document.getMetaData("format") ?? "",
		encryption: document.getMetaData("encryption") ?? "None",
		permissions
	}
}

// fz_authenticate_password's bits: 1 none needed, 2 user, 4 owner.
function access(result: number): PdfAccess {
	return (result & 4) !== 0 ? "owner" : (result & 2) !== 0 ? "user" : "none"
}

function opened(document: Mupdf.PDFDocument, password: string | undefined): PdfOpenResult {
	if (!document.needsPassword()) return { status: "open", document: summary(document), access: "none" }
	if (password === undefined) return { status: "password" }

	const result = document.authenticatePassword(password)

	return result === 0 ? { status: "password" } : { status: "open", document: summary(document), access: access(result) }
}

function heap(context: PdfEngineContext): PdfHandled<{ readonly heapBytes: number }> {
	return { value: { heapBytes: context.heapBytes() } }
}

export const PDF_ENGINE_REQUESTS: PdfRequestTable = {
	open: (context, { channel, role, password }) => {
		if (context.current !== null) throw new PdfEngineRefusal("badRequest", "a document is already open")

		const { mupdf, host } = context
		const reader = new SyncRangeReader(channel.buffer, channel.port, channel.length, { deadlineMs: host.readDeadlineMs, now: host.now })
		const stream = new mupdf.Stream(syncRangeStreamHandle(reader))
		let document: Mupdf.PDFDocument | null = null

		try {
			document = mupdf.Document.openDocument(stream, "application/pdf").asPDF()
		} catch (error) {
			reader.close()

			if (reader.failure !== null) throw new PdfEngineRefusal("readFailed", reader.failure)

			throw error
		} finally {
			stream.destroy()
		}

		if (document === null) {
			reader.close()

			throw new PdfEngineRefusal("notPdf")
		}

		// Scripts never run (MuPDF builds without a JavaScript engine report it unsupported).
		if (document.isJSSupported()) document.disableJS()
		// Pages are found by walking the page tree to each one. The cache would load every page's object on the first
		// page loaded, which reads blocks all over a file whose pages lie between their images (a scan).
		document.setPageTreeCache(false)

		context.setCurrent({ document, reader, role, renderer: new TileRenderer(mupdf, document, host.maxDisplayLists) })

		return { value: opened(document, password) }
	},
	authenticate: (context, { password }) => {
		const { document } = context.open()

		return { value: opened(document, password) }
	},
	pages: (context, { from, count }) => {
		const { document } = context.open()
		const total = document.countPages()
		const pages: PdfPageInfo[] = []

		for (let index = Math.max(0, from); index < Math.min(total, from + count); index++) {
			const page = document.loadPage(index)
			const bounds = page.getBounds()

			pages.push({ width: bounds[2] - bounds[0], height: bounds[3] - bounds[1], label: page.getLabel() })
			page.destroy()
		}

		return { value: pages }
	},
	render: async (context, { page, scale, rotation, tile }) => {
		const { document, renderer } = context.open()

		if (!Number.isInteger(page) || page < 0 || page >= document.countPages() || !(scale > 0)) throw new PdfEngineRefusal("badRequest")

		const drawn = renderer.render(page, scale, rotation, tile)
		const bitmap = await context.host.toBitmap(drawn.rgba, drawn.width, drawn.height)

		return { value: { bitmap, tile: drawn.tile }, transfer: [bitmap] }
	},
	evict: (context, { pages }) => {
		context.open().renderer.evict(pages)

		return { value: null }
	},
	heap,
	close: context => {
		const current = context.current

		if (current !== null) {
			context.setCurrent(null)
			current.renderer.destroy()
			current.document.destroy()
			current.reader.close()
			context.mupdf.emptyStore()
		}

		return heap(context)
	}
}

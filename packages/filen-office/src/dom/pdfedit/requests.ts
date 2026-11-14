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
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit/budget"
import { saslPrepPassword } from "../../core/pdfwrite/crypto"
import { ANNOTATION_REQUESTS } from "./annotationRequests"
import { EDIT_REQUESTS, startEdit } from "./editRequests"
import { FORM_REQUESTS } from "./formRequests"
import { EXTRACT_REQUESTS } from "./pages/extractRequest"
import { PAGE_SOURCE_REQUESTS } from "./pages/sources"
import { PROTECT_REQUESTS } from "./protectRequests"
import { SIGN_REQUESTS } from "./signRequests"
import { TOOL_REQUESTS } from "./toolRequests"
import { TileRenderer } from "./render"
import { SyncRangeReader, syncRangeStreamHandle } from "./stream"
import { fileRevisions } from "./verifyRequest"

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
	if (!document.needsPassword()) {
		if (password === undefined) return { status: "open", document: summary(document), access: "none" }

		// A file that opens without a password may still be given its owner password (one the session unlocked, or the
		// owner password a save just set): it lifts the restrictions. A failed attempt drops all access, which the empty
		// password gives back.
		for (const candidate of passwordCandidates(password)) {
			if ((document.authenticatePassword(candidate) & 4) !== 0)
				return { status: "open", document: summary(document), access: "owner" }
		}

		document.authenticatePassword("")

		return { status: "open", document: summary(document), access: "none" }
	}

	if (password === undefined) return { status: "password" }

	// As typed, then SASLprep'd (an AES-256 password, PDF 32000-2 §7.6.4.3.3): each attempt authenticates anew, so the
	// last one decides the document's access.
	let result = 0

	for (const candidate of passwordCandidates(password)) {
		result = document.authenticatePassword(candidate)

		if (result !== 0) break
	}

	return result === 0 ? { status: "password" } : { status: "open", document: summary(document), access: access(result) }
}

function passwordCandidates(password: string): string[] {
	let prepared: string | null = null

	try {
		prepared = saslPrepPassword(password)
	} catch {
		// Prohibited characters: only the password as typed can match.
	}

	return prepared === null || prepared === password ? [password] : [password, prepared]
}

function heap(context: PdfEngineContext): PdfHandled<{ readonly heapBytes: number }> {
	return { value: { heapBytes: context.heapBytes() } }
}

export const PDF_ENGINE_REQUESTS: PdfRequestTable = {
	open: (context, { channel, role, password, memory = PDF_DESKTOP_MEMORY }) => {
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

		const result = opened(document, password)

		context.setCurrent({
			document,
			reader,
			role,
			renderer: new TileRenderer(mupdf, document, host.maxDisplayLists),
			// The editor's journal starts once the document is unlocked (its objects are read to know the form).
			edit:
				role === "edit" && result.status === "open"
					? startEdit(document, result, password, fileRevisions(mupdf, reader, password), memory, channel.length)
					: null,
			heap: null,
			base: null,
			memory
		})

		return { value: result }
	},
	authenticate: (context, { password }) => {
		const current = context.open()
		const result = opened(current.document, password)

		if (current.role === "edit" && current.edit === null && result.status === "open")
			context.setCurrent({
				...current,
				edit: startEdit(
					current.document,
					result,
					password,
					fileRevisions(context.mupdf, current.reader, password),
					current.memory ?? PDF_DESKTOP_MEMORY,
					current.reader.length
				)
			})

		return { value: result }
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
	render: async (context, { page, scale, rotation, tile, print, priority }) => {
		const { document, renderer } = context.open()

		if (!Number.isInteger(page) || page < 0 || page >= document.countPages() || !(scale > 0)) throw new PdfEngineRefusal("badRequest")

		const drawn = renderer.render(
			page,
			scale,
			rotation,
			tile,
			print === undefined ? undefined : { annotations: print.annotations === true },
			priority === "thumbnail"
		)
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
			current.edit?.close()
			current.renderer.destroy()
			current.document.destroy()
			current.reader.close()
			if (current.base !== null && current.base !== current.heap) current.base.destroy()

			current.heap?.destroy()
			context.mupdf.emptyStore()
		}

		return heap(context)
	},
	// The verifier (pkijs, WebCrypto) is a worker's own entry, so a host without it never bundles it.
	verifySignatures: () => {
		throw new PdfEngineRefusal("badRequest", "signature verification is not served")
	},
	signatureHints: () => {
		throw new PdfEngineRefusal("badRequest", "signature hints are not served")
	},
	// The redaction verifier runs in a verifying engine's worker, which registers it.
	verifyRedaction: () => {
		throw new PdfEngineRefusal("badRequest", "redaction verification is not served")
	},
	...EDIT_REQUESTS,
	...FORM_REQUESTS,
	...ANNOTATION_REQUESTS,
	...PAGE_SOURCE_REQUESTS,
	...EXTRACT_REQUESTS,
	...PROTECT_REQUESTS,
	...TOOL_REQUESTS,
	...SIGN_REQUESTS
}

import type * as Mupdf from "mupdf"
import { passwordCandidates } from "../../../core/pdfedit/security"
import { PdfEngineRefusal, type PdfEngineContext } from "../context"
import type { MupdfModule, PdfByteChannel } from "../protocol"
import type { PdfRequestHandler } from "../requests"
import { SyncRangeReader, syncRangeStreamHandle } from "../stream"

// Second documents held open beside the edited one, for "insert pages from another PDF": each reads its file through
// its own sync range channel (a drive file from the SDK worker, a device file from the page), so only what the
// inserted pages use is read. A source stays open while the engine lives: an undo past a save rebuilds the document by
// running its commands again, insertions included. Scripts never run in it. The engine worker is terminated with its
// document, which closes them all.

interface HeldSource {
	readonly document: Mupdf.PDFDocument
	readonly reader: SyncRangeReader
}

// Per engine (one MuPDF module per engine worker).
const held = new WeakMap<MupdfModule, { next: number; readonly sources: Map<number, HeldSource> }>()

function registry(mupdf: MupdfModule): { next: number; readonly sources: Map<number, HeldSource> } {
	let entry = held.get(mupdf)

	if (entry === undefined) {
		entry = { next: 1, sources: new Map() }
		held.set(mupdf, entry)
	}

	return entry
}

// The open source document `id`, or null.
export function pageSource(mupdf: MupdfModule, id: number): Mupdf.PDFDocument | null {
	return held.get(mupdf)?.sources.get(id)?.document ?? null
}

export type PdfSourceAttach =
	| { readonly status: "open"; readonly source: number; readonly pageCount: number }
	// Encrypted, and the password (if any) did not unlock it: attach again with one.
	| { readonly status: "password" }

function unlock(document: Mupdf.PDFDocument, password: string | undefined): boolean {
	if (!document.needsPassword()) return true
	if (password === undefined) return false

	for (const candidate of passwordCandidates(password)) {
		if (document.authenticatePassword(candidate) !== 0) return true
	}

	return false
}

function attach(context: PdfEngineContext, channel: PdfByteChannel, password: string | undefined): PdfSourceAttach {
	const { mupdf, host } = context
	const reader = new SyncRangeReader(channel.buffer, channel.port, channel.length, { deadlineMs: host.readDeadlineMs, now: host.now })
	const stream = new mupdf.Stream(syncRangeStreamHandle(reader))
	let document: Mupdf.PDFDocument | null = null

	try {
		document = mupdf.Document.openDocument(stream, "application/pdf").asPDF()
	} catch (error) {
		reader.close()

		if (reader.failure !== null) throw new PdfEngineRefusal("readFailed", reader.failure)

		throw new PdfEngineRefusal("notPdf", error instanceof Error ? error.message : "notPdf")
	} finally {
		stream.destroy()
	}

	if (document === null) {
		reader.close()

		throw new PdfEngineRefusal("notPdf")
	}

	if (document.isJSSupported()) document.disableJS()

	document.setPageTreeCache(false)

	if (!unlock(document, password)) {
		document.destroy()
		reader.close()

		return { status: "password" }
	}

	const pageCount = document.countPages()

	if (pageCount === 0) {
		document.destroy()
		reader.close()

		throw new PdfEngineRefusal("notPdf", "the document has no pages")
	}

	const entry = registry(mupdf)
	const source = entry.next++

	entry.sources.set(source, { document, reader })

	return { status: "open", source, pageCount }
}

// Closes a source (its pages were never inserted, or the session ended).
function detach(mupdf: MupdfModule, id: number): void {
	const entry = held.get(mupdf)
	const source = entry?.sources.get(id)

	if (entry === undefined || source === undefined) return

	entry.sources.delete(id)
	source.document.destroy()
	source.reader.close()
}

export const PAGE_SOURCE_REQUESTS: {
	readonly attachSource: PdfRequestHandler<"attachSource">
	readonly detachSource: PdfRequestHandler<"detachSource">
} = {
	attachSource: (context, { channel, password }) => {
		const { role } = context.open()

		if (role !== "edit") throw new PdfEngineRefusal("badRequest", "only the editor inserts pages")

		return { value: attach(context, channel, password) }
	},
	detachSource: (context, { source }) => {
		detach(context.mupdf, source)

		return { value: null }
	}
}

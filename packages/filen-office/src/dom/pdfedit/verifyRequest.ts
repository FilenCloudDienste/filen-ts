import type * as Mupdf from "mupdf"
import type { PdfSubtle } from "../../core/pdfsign/cms"
import { PdfEngineRefusal, type OpenDocument } from "./context"
import { createPdfDigest } from "./digest"
import type { MupdfModule } from "./protocol"
import type { PdfRequestHandler } from "./requests"
import { SyncRangeReader, syncRangeStreamHandle, type MupdfStreamHandle } from "./stream"
import type { PdfRevisions } from "./formState"
import { collectFields, signatureFieldHints, signatureFieldsOf } from "./fields"
import { verifyPdfSignatures } from "./verify"

// The engine's verifySignatures request: the signatures of a file checked on its raw bytes. A verifying engine checks
// its own document, read through the reader MuPDF uses. The editing engine checks the file as it now is on the drive
// (the last save it wrote, else the file it opened), as a second read-only document over those bytes: the document
// being edited holds unsaved changes the signatures never covered, and is never touched. An earlier revision a
// signature signed is opened as one more read-only document over the same bytes, cut at the revision's end.

interface FileBytes {
	readonly length: number
	readonly handle: (length: number) => MupdfStreamHandle
	readonly read: (offset: number, length: number) => Uint8Array
}

function heapBytes(buffer: Mupdf.Buffer): FileBytes {
	const length = buffer.getLength()

	return {
		length,
		// A fresh view per read: the heap may grow (and move) between reads.
		handle: limit => ({
			fileSize: () => limit,
			read: (memory, offset, count, position) => {
				if (position >= limit) return 0

				const end = Math.min(limit, position + count)

				memory.set(buffer.asUint8Array().subarray(position, end), offset)

				return end - position
			},
			close: () => undefined
		}),
		read: (offset, count) => buffer.asUint8Array().slice(offset, Math.min(length, offset + count))
	}
}

function readerBytes(reader: SyncRangeReader): FileBytes {
	const whole = syncRangeStreamHandle(reader)

	return {
		length: reader.length,
		handle: limit =>
			limit === reader.length
				? whole
				: {
						fileSize: () => limit,
						read: (memory, offset, count, position) =>
							position >= limit ? 0 : reader.read(memory, offset, Math.min(count, limit - position), position),
						close: () => undefined
					},
		read: (offset, count) => {
			const bytes = new Uint8Array(count)
			let at = 0

			while (at < count) {
				const got = reader.read(bytes, at, count - at, offset + at)

				if (got <= 0) throw new PdfEngineRefusal("readFailed", reader.failure ?? "end of file")

				at += got
			}

			return bytes
		}
	}
}

function openOn(mupdf: MupdfModule, handle: MupdfStreamHandle): Mupdf.PDFDocument {
	const stream = new mupdf.Stream(handle)

	try {
		const opened = mupdf.Document.openDocument(stream, "application/pdf").asPDF()

		if (opened === null) throw new PdfEngineRefusal("notPdf")

		return opened
	} finally {
		stream.destroy()
	}
}

// A read-only document over `handle`, unlocked with `password` when it needs one (else a "needsPassword" refusal).
function openUnlocked(mupdf: MupdfModule, handle: MupdfStreamHandle, password: string | undefined): Mupdf.PDFDocument {
	const document = openOn(mupdf, handle)

	if (document.needsPassword() && (password === undefined || document.authenticatePassword(password) === 0)) {
		document.destroy()

		throw new PdfEngineRefusal("needsPassword")
	}

	return document
}

// The earlier revisions of a file (byte prefixes of it), each opened as its own document unlocked with the document's
// password: the file behind the reader, or a written file in the heap.
export function fileRevisions(mupdf: MupdfModule, file: SyncRangeReader | Mupdf.Buffer, password: string | undefined): PdfRevisions {
	const bytes = file instanceof SyncRangeReader ? readerBytes(file) : heapBytes(file)

	return { length: bytes.length, open: length => openUnlocked(mupdf, bytes.handle(length), password) }
}

// The file as it now is on the drive, as a document over its bytes: a verifying engine's own document, or the editing
// engine's read-only copy of its file (the caller destroys it when it is not `open.document`).
function savedFile(context: Parameters<PdfRequestHandler<"verifySignatures">>[0]): {
	readonly open: OpenDocument
	readonly bytes: FileBytes
	readonly document: Mupdf.PDFDocument
} {
	const open = context.open()
	const editing = open.role === "edit"
	const bytes = editing && open.heap !== null ? heapBytes(open.heap) : readerBytes(open.reader)

	// Never needsPassword() on the document being edited or verified: on an authenticated document MuPDF drops the
	// access it granted. The editor's own read-only copy is unlocked with the document's password.
	if (!editing) return { open, bytes, document: open.document }

	return { open, bytes, document: openUnlocked(context.mupdf, bytes.handle(bytes.length), open.edit?.password) }
}

// The signatures of the file as it now is, as this engine reads them (pdf.js's shape): what a verifier cross-checks
// against for a file the editor wrote, which pdf.js never read.
export const signatureHintsRequest: PdfRequestHandler<"signatureHints"> = context => {
	const { open, bytes, document } = savedFile(context)

	try {
		return { value: signatureFieldHints(signatureFieldsOf(document, collectFields(document).fields), bytes.length) }
	} finally {
		if (document !== open.document) document.destroy()
	}
}

export function verifySignaturesRequest(subtle: PdfSubtle): PdfRequestHandler<"verifySignatures"> {
	return async (context, { fields }) => {
		const { mupdf } = context
		const { open, bytes, document } = savedFile(context)

		try {
			const report = await verifyPdfSignatures(
				document,
				{ length: bytes.length, read: (offset, length) => Promise.resolve(bytes.read(offset, length)) },
				{
					subtle,
					createDigest: createPdfDigest,
					openRevision: length => openOn(mupdf, bytes.handle(length)),
					expectedFields: fields
				}
			)

			return { value: report }
		} finally {
			if (document !== open.document) document.destroy()
		}
	}
}

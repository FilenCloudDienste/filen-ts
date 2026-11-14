import type * as Mupdf from "mupdf"
import type { PdfSubtle } from "../../core/pdfsign/cms"
import { PdfEngineRefusal, type OpenDocument } from "./context"
import { createPdfDigest } from "./digest"
import type { MupdfModule } from "./protocol"
import type { PdfRequestHandler } from "./requests"
import { syncRangeStreamHandle, type MupdfStreamHandle } from "./stream"
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

function readerBytes(open: OpenDocument): FileBytes {
	const { reader } = open
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

export function verifySignaturesRequest(subtle: PdfSubtle): PdfRequestHandler<"verifySignatures"> {
	return async (context, { fields }) => {
		const open = context.open()
		const { mupdf } = context
		const editing = open.role === "edit"
		const bytes = editing && open.heap !== null ? heapBytes(open.heap) : readerBytes(open)
		// Never needsPassword() on the document being edited or verified: on an authenticated document MuPDF drops the
		// access it granted. The editor's own read-only copy is unlocked with the document's password.
		let document = open.document

		if (editing) {
			document = openOn(mupdf, bytes.handle(bytes.length))

			const password = open.edit?.password

			if (document.needsPassword() && (password === undefined || document.authenticatePassword(password) === 0)) {
				document.destroy()

				throw new PdfEngineRefusal("needsPassword")
			}
		}

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

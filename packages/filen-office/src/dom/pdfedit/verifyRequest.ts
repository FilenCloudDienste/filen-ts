import type * as Mupdf from "mupdf"
import type { PdfSubtle } from "../../core/pdfsign/cms"
import { PdfEngineRefusal } from "./context"
import { createPdfDigest } from "./digest"
import type { PdfRequestHandler } from "./requests"
import type { MupdfStreamHandle } from "./stream"
import { verifyPdfSignatures } from "./verify"

// The engine's verifySignatures request: the signatures of the open document checked on its raw bytes, read through
// the reader MuPDF uses. An earlier revision a signature signed is opened as a second read-only document over the
// same reader, cut at the revision's end.
export function verifySignaturesRequest(subtle: PdfSubtle): PdfRequestHandler<"verifySignatures"> {
	return async (context, { fields }) => {
		const { document, reader } = context.open()
		const { mupdf } = context

		// Never document.needsPassword() here: on an authenticated document MuPDF drops the access it granted.
		const openRevision = (length: number): Mupdf.PDFDocument => {
			const prefix: MupdfStreamHandle = {
				fileSize: () => length,
				read: (memory, offset, count, position) =>
					position >= length ? 0 : reader.read(memory, offset, Math.min(count, length - position), position),
				close: () => undefined
			}
			const stream = new mupdf.Stream(prefix)
			const opened = mupdf.Document.openDocument(stream, "application/pdf").asPDF()

			stream.destroy()

			if (opened === null) throw new PdfEngineRefusal("notPdf")

			return opened
		}

		const report = await verifyPdfSignatures(
			document,
			{ length: reader.length, read: (offset, length) => Promise.resolve(context.readBytes(offset, length)) },
			{ subtle, createDigest: createPdfDigest, openRevision, expectedFields: fields }
		)

		return { value: report }
	}
}

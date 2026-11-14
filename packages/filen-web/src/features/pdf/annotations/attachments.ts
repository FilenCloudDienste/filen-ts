import type { PdfAttachmentInfo } from "@filen/office/core/pdfedit/annotations"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { attachmentFileName } from "@/features/pdf/annotations/annotationTools.logic"
import { downloadBlob } from "@/lib/downloadBlob"

// A PDF's attachments leave it only as downloads: their bytes typed application/octet-stream whatever they claim to
// be, so the browser saves them and never opens them inline.

function sameSource(a: PdfAttachmentInfo["source"], b: PdfAttachmentInfo["source"]): boolean {
	if (a.kind === "document") return b.kind === "document" && a.key === b.key

	return b.kind === "annotation" && a.ref.page === b.ref.page && a.ref.id === b.ref.id
}

// Downloads the attachment `source` under the name the document gives it; false when it is gone or empty.
export async function downloadAttachment(session: PdfEditSessionModel, source: PdfAttachmentInfo["source"]): Promise<boolean> {
	const [bytes, list] = await Promise.all([session.engine.call("attachment", { source }), session.engine.call("attachments", {})])

	if (bytes === null) return false

	const name = list.find(entry => sameSource(entry.source, source))?.name ?? "attachment"

	// The engine transferred its own copy: viewed as it is, not copied again.
	const owned = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice()

	downloadBlob(attachmentFileName(name), new Blob([owned], { type: "application/octet-stream" }))

	return true
}

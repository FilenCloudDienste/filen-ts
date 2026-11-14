import type { PDFDocument, PDFObject } from "mupdf"
import { classifyLink } from "@filen/shared/linkPolicy"
import { attachmentDisplayName, type PdfAnnotationRef, type PdfAttachmentInfo, type PdfLinkInfo } from "../../../core/pdfedit/annotations"
import { annotationId, loadPage, rectOf, requireAnnotation } from "./shared"

// Links and attachments, read only; nothing navigates here. Attachments are only ever handed out as bytes for a
// download.

// The link annotations of page `index`: their rects and targets. An external URI is judged by the shared link policy
// (classifyLink, as dom/pdf/links.ts judges pdf.js's links) and only a URL it allows is returned, as it normalised
// it; javascript:, data:, file: (MuPDF's form of GoToR and Launch actions) and every other refused or unparsable
// target is "none". An internal link names its page when the destination resolves.
export function listLinks(document: PDFDocument, index: number): PdfLinkInfo[] {
	const out: PdfLinkInfo[] = []

	for (const link of loadPage(document, index).getLinks()) {
		const uri = link.getURI()
		const rect = rectOf(link.getBounds())

		if (link.isExternal()) {
			const verdict = classifyLink(uri)

			out.push({ page: index, rect, target: verdict.kind === "external" ? { kind: "uri", uri: verdict.url } : { kind: "none" } })

			continue
		}

		const page = uri === "" ? -1 : document.resolveLink(link)

		out.push({ page: index, rect, target: page >= 0 && page < document.countPages() ? { kind: "page", page } : { kind: "none" } })
	}

	return out
}

// An embedded file's size from its stream's /Params /Size, when the writer recorded it.
function sizeOf(spec: PDFObject): number | null {
	const stream = spec.get("EF").get("F")
	const size = stream.isNull() ? stream : stream.get("Params").get("Size")

	return size.isInteger() && size.asNumber() >= 0 ? size.asNumber() : null
}

// The file's name (without hidden or reordering characters), or `fallback` when none is left.
function nameOf(spec: PDFObject, fallback: string): string {
	for (const key of ["UF", "F"]) {
		const value = spec.get(key)
		const name = value.isString() ? attachmentDisplayName(value.asString()) : ""

		if (name !== "") return name
	}

	return fallback
}

// The document's embedded files (the EmbeddedFiles name tree).
export function listDocumentAttachments(document: PDFDocument): PdfAttachmentInfo[] {
	const out: PdfAttachmentInfo[] = []

	for (const [key, spec] of Object.entries(document.getEmbeddedFiles())) {
		const resolved = spec.resolve()

		if (document.isEmbeddedFile(resolved))
			out.push({ name: nameOf(resolved, key), size: sizeOf(resolved), source: { kind: "document", key } })
	}

	return out
}

// The file attachment annotations of page `index`.
export function listAnnotationAttachments(document: PDFDocument, index: number): PdfAttachmentInfo[] {
	const out: PdfAttachmentInfo[] = []

	for (const annotation of loadPage(document, index).getAnnotations()) {
		if (annotation.getType() !== "FileAttachment" || !annotation.hasFilespec()) continue

		const spec = annotation.getFileSpec().resolve()

		if (document.isEmbeddedFile(spec)) {
			out.push({
				name: nameOf(spec, "attachment"),
				size: sizeOf(spec),
				source: { kind: "annotation", ref: { page: index, id: annotationId(annotation) } }
			})
		}
	}

	return out
}

// An attachment's bytes, copied out of the engine heap (to transfer), or null when it is gone or empty.
export function readAttachment(document: PDFDocument, source: PdfAttachmentInfo["source"]): Uint8Array | null {
	let spec: PDFObject | undefined

	if (source.kind === "document") {
		spec = document.getEmbeddedFiles()[source.key]?.resolve()
	} else {
		const ref: PdfAnnotationRef = source.ref
		const { annotation } = requireAnnotation(document, ref)

		spec = annotation.getType() === "FileAttachment" && annotation.hasFilespec() ? annotation.getFileSpec().resolve() : undefined
	}

	if (spec === undefined || !document.isEmbeddedFile(spec)) return null

	const contents = document.getEmbeddedFileContents(spec)

	if (contents === null) return null

	const bytes = contents.asUint8Array().slice()

	contents.destroy()

	return bytes
}

import type * as Mupdf from "mupdf"
import {
	quadBounds,
	rectUnion,
	type RedactionMark,
	type RedactionMarkKind,
	type RedactQuad,
	type RedactRect
} from "../../../core/pdfedit/redactVerify"

export type { RedactionMark }

// Redaction marks are standard Redact annotations: marked text carries QuadPoints, an area or a whole page only a
// Rect. Nothing is removed until the marks are applied (apply.ts). Each function here is one edit of one page.

// Page marks cover the MediaBox, which holds everything the page can draw (the CropBox may hide part of it).
function pageBox(page: Mupdf.PDFPage): RedactRect {
	return page.getBounds("MediaBox")
}

// Applied marks leave black boxes (MuPDF's default fill for Redact annotations).
function create(page: Mupdf.PDFPage): Mupdf.PDFAnnotation {
	return page.createAnnotation("Redact")
}

// Marks characters: `quads` from the page's structured text (one per line or character), in page space. Returns
// the new mark's id. Touches `page` only.
export function markText(page: Mupdf.PDFPage, quads: readonly RedactQuad[]): number {
	const bounds = rectUnion(quads.map(quadBounds))

	if (bounds === null) throw new RangeError("no quads to mark")

	const annotation = create(page)

	annotation.setQuadPoints(quads.map(quad => [...quad]))
	annotation.setRect([...bounds])
	annotation.update()

	return annotation.getObject().asIndirect()
}

// Marks a rectangle in page space. Returns the new mark's id.
export function markArea(page: Mupdf.PDFPage, rect: RedactRect): number {
	const annotation = create(page)

	annotation.setRect([Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])])
	annotation.update()

	return annotation.getObject().asIndirect()
}

// Marks the whole page. Returns the new mark's id.
export function markPage(page: Mupdf.PDFPage): number {
	return markArea(page, pageBox(page))
}

export function isRedaction(annotation: Mupdf.PDFAnnotation): boolean {
	return annotation.getType() === "Redact"
}

function covers(outer: RedactRect, inner: RedactRect): boolean {
	const slack = 0.5

	return outer[0] <= inner[0] + slack && outer[1] <= inner[1] + slack && outer[2] >= inner[2] - slack && outer[3] >= inner[3] - slack
}

export function markOf(page: Mupdf.PDFPage, index: number, annotation: Mupdf.PDFAnnotation): RedactionMark {
	const rect = annotation.getRect()
	const quads = annotation.hasQuadPoints() ? annotation.getQuadPoints() : []
	const kind: RedactionMarkKind = quads.length > 0 ? "text" : covers(rect, pageBox(page)) ? "page" : "area"

	return { id: annotation.getObject().asIndirect(), page: index, kind, rect, quads }
}

// The marks on one page, in annotation order.
export function pageRedactionMarks(page: Mupdf.PDFPage, index: number): RedactionMark[] {
	return page
		.getAnnotations()
		.filter(isRedaction)
		.map(annotation => markOf(page, index, annotation))
}

// Every pending mark in the document, page by page (the review list).
export function listRedactionMarks(document: Mupdf.PDFDocument): RedactionMark[] {
	const marks: RedactionMark[] = []

	for (let index = 0; index < document.countPages(); index++) {
		const page = document.loadPage(index)

		marks.push(...pageRedactionMarks(page, index))
		page.destroy()
	}

	return marks
}

// Removes the mark `id` from `page`. Returns whether it was there. Touches `page` only.
export function removeRedactionMark(page: Mupdf.PDFPage, id: number): boolean {
	const annotation = page.getAnnotations().find(candidate => isRedaction(candidate) && candidate.getObject().asIndirect() === id)

	if (annotation === undefined) return false

	page.deleteAnnotation(annotation)

	return true
}

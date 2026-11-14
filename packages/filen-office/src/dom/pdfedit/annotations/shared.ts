import type { PDFAnnotation, PDFDocument, PDFObject, PDFPage } from "mupdf"
import { normalizeRect, rgbOf, type PdfAnnotationRef, type PdfRect, type PdfRgb } from "../../../core/pdfedit/annotations"

// What every annotation function shares: finding an annotation by its ref, stamping who changed it and when, and the
// flag bits. Pages are loaded per call (MuPDF hands back the page it already holds open), never cached across calls:
// a JS page wrapper caches its annotation list, which an undo or redo would leave stale.

// Annotation flags (ISO 32000-2 §12.5.3, table 167).
export const FLAG_HIDDEN = 1 << 1
export const FLAG_PRINT = 1 << 2
export const FLAG_NO_ZOOM = 1 << 3
export const FLAG_NO_ROTATE = 1 << 4
export const FLAG_NO_VIEW = 1 << 5
export const FLAG_READ_ONLY = 1 << 6
export const FLAG_LOCKED = 1 << 7

// Types whose geometry is a rect the select tool moves and resizes.
export const RECT_TYPES = new Set(["FreeText", "Square", "Circle", "Stamp", "Text", "Redact", "Caret"])
// Types whose geometry is points (moved by translating them, resized by scaling them).
export const POINT_TYPES = new Set(["Ink", "Line", "Polygon", "PolyLine"])
// Types that are never a comment thread's root.
export const NOT_COMMENTABLE = new Set([
	"Popup",
	"Link",
	"Widget",
	"Redact",
	"PrinterMark",
	"TrapNet",
	"Watermark",
	"Screen",
	"3D",
	"Projection"
])

export class PdfAnnotationError extends Error {
	readonly reason: "notFound" | "locked" | "unsupported" | "invalid"

	constructor(reason: "notFound" | "locked" | "unsupported" | "invalid", message: string) {
		super(message)
		this.name = "PdfAnnotationError"
		this.reason = reason
	}
}

// The pages loaded inside withPageScope, closed when it ends.
let scope: { readonly document: PDFDocument; readonly pages: Map<number, PDFPage> }[] = []

// Runs `run` with the pages it loads of `document` shared and closed at its end. MuPDF keeps a page open while any
// wrapper of it lives, and an open page's annotation list does not follow a change made beside it (a flatten): an
// engine runs every call in a scope so no page stays open between its requests.
export function withPageScope<T>(document: PDFDocument, run: () => T): T {
	const entry = { document, pages: new Map<number, PDFPage>() }

	scope = [...scope, entry]

	try {
		return run()
	} finally {
		scope = scope.filter(other => other !== entry)

		for (const page of entry.pages.values()) page.destroy()
	}
}

export function loadPage(document: PDFDocument, index: number): PDFPage {
	if (!Number.isInteger(index) || index < 0 || index >= document.countPages()) {
		throw new PdfAnnotationError("notFound", `no page ${String(index)}`)
	}

	const open = scope.findLast(entry => entry.document === document)

	if (open === undefined) return document.loadPage(index)

	let page = open.pages.get(index)

	if (page === undefined) {
		page = document.loadPage(index)
		open.pages.set(index, page)
	}

	return page
}

export function annotationId(annotation: PDFAnnotation): number {
	return annotation.getObject().asIndirect()
}

// The annotation `ref` names, or null.
export function findAnnotation(page: PDFPage, id: number): PDFAnnotation | null {
	for (const annotation of page.getAnnotations()) if (annotationId(annotation) === id) return annotation

	return null
}

export function requireAnnotation(document: PDFDocument, ref: PdfAnnotationRef): { page: PDFPage; annotation: PDFAnnotation } {
	const page = loadPage(document, ref.page)
	const annotation = findAnnotation(page, ref.id)

	if (annotation === null) throw new PdfAnnotationError("notFound", `no annotation ${String(ref.id)} on page ${String(ref.page)}`)

	return { page, annotation }
}

// Popups are not in MuPDF's annotation list: they are found and removed through the page's /Annots array.

// Removes the annotations whose object numbers are in `ids` from the page's /Annots array.
export function removeFromAnnots(page: PDFPage, ids: ReadonlySet<number>): void {
	const annots = page.getObject().get("Annots")

	if (!annots.isArray()) return

	for (let index = annots.length - 1; index >= 0; index--) {
		const entry = annots.get(index)

		if (entry.isIndirect() && ids.has(entry.asIndirect())) annots.delete(index)
	}
}

// The popups (by object number) of the annotations in `owners`, from the page's /Annots array.
export function popupsOf(page: PDFPage, owners: ReadonlySet<number>): Set<number> {
	const out = new Set<number>()
	const annots = page.getObject().get("Annots")

	if (!annots.isArray()) return out

	for (let index = 0; index < annots.length; index++) {
		const entry = annots.get(index)
		const parent = entry.get("Parent")

		if (entry.isIndirect() && textOf(entry.get("Subtype")) === "Popup" && parent.isIndirect() && owners.has(parent.asIndirect())) {
			out.add(entry.asIndirect())
		}
	}

	return out
}

// A delta in page space as a delta in the PDF's own user space (the page transform's linear part inverted).
export function userDelta(page: PDFPage, dx: number, dy: number): [number, number] {
	const [a, b, c, d] = page.getTransform()
	const det = a * d - b * c

	if (det === 0) return [dx, dy]

	return [(dx * d - dy * c) / det, (dy * a - dx * b) / det]
}

// A name or text string's value (writers disagree on which /State, /StateModel and /RT are), else null.
export function textOf(value: PDFObject): string | null {
	return value.isName() ? value.asName() : value.isString() ? value.asString() : null
}

export function isLocked(annotation: PDFAnnotation): boolean {
	return (annotation.getFlags() & (FLAG_LOCKED | FLAG_READ_ONLY)) !== 0
}

export function requireUnlocked(annotation: PDFAnnotation): void {
	if (isLocked(annotation)) throw new PdfAnnotationError("locked", "the annotation is locked")
}

// Who made it and when: /T, /CreationDate and /M (the modification date also goes on every later change).
export function stampCreated(annotation: PDFAnnotation, author: string, now: Date): void {
	if (author !== "") annotation.setAuthor(author)

	annotation.setCreationDate(now)
	annotation.setModificationDate(now)
}

export function stampModified(annotation: PDFAnnotation, now: Date): void {
	annotation.setModificationDate(now)
}

// MuPDF answers a missing date with a time before the epoch.
export function dateOf(read: () => Date): number | null {
	const time = read().getTime()

	return Number.isFinite(time) && time > 0 ? time : null
}

export function colorOf(components: readonly number[]): PdfRgb | null {
	return rgbOf(components)
}

export function rectOf(rect: readonly [number, number, number, number]): PdfRect {
	return normalizeRect(rect)
}

export function mutableRect(rect: PdfRect): [number, number, number, number] {
	return [rect[0], rect[1], rect[2], rect[3]]
}

export function mutableRgb(rgb: PdfRgb): [number, number, number] {
	return [rgb[0], rgb[1], rgb[2]]
}

export function finite(value: number, name: string): number {
	if (!Number.isFinite(value)) throw new PdfAnnotationError("invalid", `${name} is not a number`)

	return value
}

export function checkRect(rect: PdfRect): PdfRect {
	for (const value of rect) finite(value, "rect")

	const out = normalizeRect(rect)

	if (out[2] - out[0] <= 0 || out[3] - out[1] <= 0) throw new PdfAnnotationError("invalid", "empty rect")

	return out
}

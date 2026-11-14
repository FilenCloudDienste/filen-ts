import type { AnnotColor, PDFAnnotation, PDFPage, Point } from "mupdf"
import type { MupdfModule } from "../protocol"
import {
	fitBox,
	signatureAspect,
	strokesInBox,
	type PdfPageRect,
	type PdfSignatureRole,
	type PdfVisualSignature
} from "../../../core/pdfedit/visualSignature"

// Fill & Sign marks placed on a page as standard annotations, each with an appearance MuPDF generates (update()), the
// author and the dates set: text (FreeText), check / cross / dot marks, and a visual signature or initials (Stamp
// with the PNG, or Ink with the strokes). One call is one change; journal operations are the caller's. Boxes are page
// space, y down (MuPDF's), as PdfFormField.rect.

// The standard fonts a FreeText appearance can use without embedding.
export type PdfFillFont = "sans" | "serif" | "mono"
export type PdfFillMark = "check" | "cross" | "dot"
// [r, g, b], each 0..1.
export type PdfRgb = readonly [number, number, number]

export interface PdfAnnotationMeta {
	// The annotation's author (the user's author name); empty: none written.
	readonly author: string
	readonly date: Date
}

export interface PdfFillTextOptions extends PdfAnnotationMeta {
	readonly box: PdfPageRect
	readonly text: string
	readonly font: PdfFillFont
	// Points.
	readonly size: number
	readonly color: PdfRgb
}

export interface PdfFillMarkOptions extends PdfAnnotationMeta {
	readonly box: PdfPageRect
	readonly mark: PdfFillMark
	readonly color: PdfRgb
}

export interface PdfPlaceSignatureOptions extends PdfAnnotationMeta {
	// The signature is fitted into this box, aspect kept, centred.
	readonly box: PdfPageRect
	readonly role: PdfSignatureRole
	// Ink colour of drawn strokes (images keep their own); default near-black blue.
	readonly color?: PdfRgb
}

export const PDF_FILL_DEFAULT_INK: PdfRgb = [0.05, 0.1, 0.35]

const FONT_NAMES: Record<PdfFillFont, string> = { sans: "Helv", serif: "TiRo", mono: "Cour" }
// The subject written on signature annotations, so another viewer's comment list says what they are.
const SUBJECTS: Record<PdfSignatureRole, string> = { signature: "Signature", initials: "Initials" }
const PRINT_FLAG = 1 << 2

function color(rgb: PdfRgb): AnnotColor {
	return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])]
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function normalizedBox(box: PdfPageRect): [number, number, number, number] {
	const [a, b, c, d] = box

	return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

function stamp(annotation: PDFAnnotation, meta: PdfAnnotationMeta): void {
	if (meta.author !== "") annotation.setAuthor(meta.author)

	annotation.setCreationDate(meta.date)
	annotation.setModificationDate(meta.date)
	annotation.setFlags(annotation.getFlags() | PRINT_FLAG)
}

function points(flat: readonly number[]): Point[] {
	const result: Point[] = []

	for (let index = 0; index + 1 < flat.length; index += 2) result.push([flat[index] ?? 0, flat[index + 1] ?? 0])

	return result
}

// Text typed onto the page (not into a field): plain text in a standard font, no border, no fill.
export function addFillText(page: PDFPage, options: PdfFillTextOptions): PDFAnnotation {
	const annotation = page.createAnnotation("FreeText")

	annotation.setRect(normalizedBox(options.box))
	annotation.setContents(options.text)
	annotation.setDefaultAppearance(FONT_NAMES[options.font], Math.max(1, options.size), color(options.color))
	annotation.setBorderWidth(0)
	stamp(annotation, options)
	annotation.update()

	return annotation
}

// A check mark, a cross or a dot filling `box`.
export function addFillMark(page: PDFPage, options: PdfFillMarkOptions): PDFAnnotation {
	const [x0, y0, x1, y1] = normalizedBox(options.box)
	const width = x1 - x0
	const height = y1 - y0
	const line = Math.max(0.75, Math.min(width, height) * 0.12)

	if (options.mark === "dot") {
		const annotation = page.createAnnotation("Circle")

		annotation.setRect([x0, y0, x1, y1])
		annotation.setColor(color(options.color))
		annotation.setInteriorColor(color(options.color))
		annotation.setBorderWidth(0)
		stamp(annotation, options)
		annotation.update()

		return annotation
	}

	const annotation = page.createAnnotation("Ink")
	const at = (fx: number, fy: number): Point => [x0 + fx * width, y0 + fy * height]

	annotation.setInkList(
		options.mark === "check"
			? [[at(0.1, 0.55), at(0.38, 0.85), at(0.9, 0.15)]]
			: [
					[at(0.15, 0.15), at(0.85, 0.85)],
					[at(0.85, 0.15), at(0.15, 0.85)]
				]
	)
	annotation.setColor(color(options.color))
	annotation.setBorderWidth(line)
	stamp(annotation, options)
	annotation.update()

	return annotation
}

// A visual signature or initials: an image signature as a Stamp showing the PNG, drawn strokes as an Ink annotation.
export function placeVisualSignature(
	mupdf: Pick<MupdfModule, "Image">,
	page: PDFPage,
	signature: PdfVisualSignature,
	options: PdfPlaceSignatureOptions
): PDFAnnotation {
	const box = normalizedBox(options.box)
	const fitted = fitBox(signatureAspect(signature), box)
	let annotation: PDFAnnotation

	if (signature.kind === "image") {
		const image = new mupdf.Image(signature.png)

		annotation = page.createAnnotation("Stamp")
		annotation.setRect([...fitted])
		annotation.setStampImage(image)
		image.destroy()
	} else {
		const height = fitted[3] - fitted[1]

		annotation = page.createAnnotation("Ink")
		annotation.setInkList(strokesInBox(signature, box).map(points))
		annotation.setColor(color(options.color ?? PDF_FILL_DEFAULT_INK))
		// A pen line in proportion to the signature's size, within what reads as handwriting.
		annotation.setBorderWidth(Math.max(0.6, Math.min(2.5, height * 0.035)))
	}

	annotation.setSubject(SUBJECTS[options.role])
	stamp(annotation, options)
	annotation.update()

	return annotation
}

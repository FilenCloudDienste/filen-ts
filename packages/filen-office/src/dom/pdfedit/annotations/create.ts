import type { PDFAnnotation, PDFDocument } from "mupdf"
import type { MupdfModule } from "../protocol"
import {
	clamp01,
	type PdfAnnotationRef,
	type PdfLineEnding,
	type PdfMarkupKind,
	type PdfPoint,
	type PdfPresetStamp,
	type PdfQuad,
	type PdfRect,
	type PdfRgb,
	type PdfTextAlign,
	type PdfTextFont
} from "../../../core/pdfedit/annotations"
import {
	annotationId,
	checkRect,
	finite,
	loadPage,
	mutableRect,
	mutableRgb,
	PdfAnnotationError,
	requireAnnotation,
	requireUnlocked,
	stampCreated,
	stampModified
} from "./shared"

// Creating annotations. Each function is one command: it mutates the document (the caller wraps it in one journal
// operation), regenerates the new annotation's appearance, and returns the created ref and the pages it touched.

export interface PdfCreated {
	readonly ref: PdfAnnotationRef
	readonly pages: readonly number[]
}

// Who and when, for every created annotation.
export interface PdfAuthored {
	readonly page: number
	readonly author: string
	readonly now: Date
}

export const TEXT_ALIGN: Readonly<Record<PdfTextAlign, number>> = { left: 0, center: 1, right: 2 }

const DEFAULT_HIGHLIGHT: PdfRgb = [1, 0.85, 0]
const DEFAULT_INK: PdfRgb = [0, 0, 0]
const DEFAULT_NOTE: PdfRgb = [1, 0.85, 0]
const DEFAULT_SHAPE: PdfRgb = [0.9, 0, 0]
// A sticky note's icon is drawn this size whatever its rect.
const NOTE_SIDE = 20
// A text box's text size bounds (points).
const MIN_FONT_SIZE = 4
const MAX_FONT_SIZE = 144
// Ink beyond this is not handwriting.
const MAX_STROKE_POINTS = 10_000
const MAX_STROKES = 1000

function created(annotation: PDFAnnotation, page: number): PdfCreated {
	annotation.update()

	return { ref: { page, id: annotationId(annotation) }, pages: [page] }
}

function checkPoints(points: readonly PdfPoint[]): [number, number][] {
	if (points.length === 0 || points.length > MAX_STROKE_POINTS) throw new PdfAnnotationError("invalid", "stroke size")

	return points.map(([x, y]) => [finite(x, "point"), finite(y, "point")])
}

function strokesOf(strokes: readonly (readonly PdfPoint[])[]): [number, number][][] {
	if (strokes.length === 0 || strokes.length > MAX_STROKES) throw new PdfAnnotationError("invalid", "stroke count")

	return strokes.map(checkPoints)
}

export interface PdfTextBoxStyle {
	readonly font: PdfTextFont
	readonly size: number
	readonly color: PdfRgb
	readonly align: PdfTextAlign
}

export function fontSize(size: number): number {
	return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, finite(size, "size")))
}

// A text box (FreeText) of plain text in `rect`, without border or fill. Its text is drawn with a standard face
// (no font is embedded), so it shows what that face's encoding covers.
export function addTextBox(
	document: PDFDocument,
	input: PdfAuthored & PdfTextBoxStyle & { readonly rect: PdfRect; readonly text: string; readonly opacity?: number }
): PdfCreated {
	const annotation = loadPage(document, input.page).createAnnotation("FreeText")

	annotation.setRect(mutableRect(checkRect(input.rect)))
	annotation.setContents(input.text)
	annotation.setDefaultAppearance(input.font, fontSize(input.size), mutableRgb(input.color))
	annotation.setQuadding(TEXT_ALIGN[input.align])
	annotation.setBorderWidth(0)

	if (input.opacity !== undefined) annotation.setOpacity(clamp01(input.opacity))

	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

export interface PdfStrokeStyle {
	readonly color?: PdfRgb
	readonly width?: number
	readonly opacity?: number
}

function applyStroke(annotation: PDFAnnotation, style: PdfStrokeStyle, fallback: PdfRgb): void {
	annotation.setColor(mutableRgb(style.color ?? fallback))
	annotation.setBorderWidth(Math.max(0, finite(style.width ?? 1, "width")))

	if (style.opacity !== undefined) annotation.setOpacity(clamp01(style.opacity))
}

// A freehand drawing (Ink) of one or more strokes, each a polyline in page space (already smoothed by the tool).
export function addInk(
	document: PDFDocument,
	input: PdfAuthored & PdfStrokeStyle & { readonly strokes: readonly (readonly PdfPoint[])[] }
): PdfCreated {
	const annotation = loadPage(document, input.page).createAnnotation("Ink")

	annotation.setInkList(strokesOf(input.strokes))
	applyStroke(annotation, { ...input, width: input.width ?? 2 }, DEFAULT_INK)
	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

// One more stroke on an existing drawing (the ink tool's next stroke: one journal operation per stroke).
export function addInkStroke(document: PDFDocument, ref: PdfAnnotationRef, stroke: readonly PdfPoint[], now: Date): readonly number[] {
	const { annotation } = requireAnnotation(document, ref)

	if (annotation.getType() !== "Ink") throw new PdfAnnotationError("unsupported", "not an ink annotation")

	requireUnlocked(annotation)

	const strokes = annotation.getInkList()

	if (strokes.length >= MAX_STROKES) throw new PdfAnnotationError("invalid", "stroke count")

	annotation.setInkList([...strokes, checkPoints(stroke)])
	stampModified(annotation, now)
	annotation.update()

	return [ref.page]
}

function quadOf(quad: PdfQuad): [number, number, number, number, number, number, number, number] {
	const [a, b, c, d, e, f, g, h] = quad

	return [
		finite(a, "quad"),
		finite(b, "quad"),
		finite(c, "quad"),
		finite(d, "quad"),
		finite(e, "quad"),
		finite(f, "quad"),
		finite(g, "quad"),
		finite(h, "quad")
	]
}

// A text markup over quads (from the structured text's highlight of a drag), with an optional note.
export function addTextMarkup(
	document: PDFDocument,
	input: PdfAuthored & {
		readonly kind: PdfMarkupKind
		readonly quads: readonly PdfQuad[]
		readonly color?: PdfRgb
		readonly opacity?: number
		readonly text?: string
	}
): PdfCreated {
	if (input.quads.length === 0) throw new PdfAnnotationError("invalid", "no quads")

	const annotation = loadPage(document, input.page).createAnnotation(input.kind)

	annotation.setQuadPoints(input.quads.map(quadOf))
	annotation.setColor(mutableRgb(input.color ?? DEFAULT_HIGHLIGHT))

	if (input.opacity !== undefined) annotation.setOpacity(clamp01(input.opacity))
	if (input.text !== undefined && input.text !== "") annotation.setContents(input.text)

	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

// A rectangle or ellipse in `rect`: stroked in `color`, filled with `fill` when given.
export function addShape(
	document: PDFDocument,
	input: PdfAuthored & PdfStrokeStyle & { readonly kind: "Square" | "Circle"; readonly rect: PdfRect; readonly fill?: PdfRgb | null }
): PdfCreated {
	const annotation = loadPage(document, input.page).createAnnotation(input.kind)

	annotation.setRect(mutableRect(checkRect(input.rect)))
	applyStroke(annotation, input, DEFAULT_SHAPE)

	if (input.fill !== undefined && input.fill !== null) annotation.setInteriorColor(mutableRgb(input.fill))

	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

// A line from `from` to `to` with its line endings (an arrow: "None" → "OpenArrow").
export function addLine(
	document: PDFDocument,
	input: PdfAuthored &
		PdfStrokeStyle & { readonly from: PdfPoint; readonly to: PdfPoint; readonly start?: PdfLineEnding; readonly end?: PdfLineEnding }
): PdfCreated {
	const [a, b] = checkPoints([input.from, input.to])

	if (a === undefined || b === undefined) throw new PdfAnnotationError("invalid", "line")

	const annotation = loadPage(document, input.page).createAnnotation("Line")

	annotation.setLine(a, b)
	annotation.setLineEndingStyles(input.start ?? "None", input.end ?? "None")
	applyStroke(annotation, input, DEFAULT_SHAPE)
	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

// Image size limits for a stamp: the decoded pixmap lives in the engine heap.
const MAX_STAMP_PIXELS = 25_000_000

// An image stamp: `image` is the encoded file (PNG, JPEG, …; HEIC converted by the host first) drawn into `rect`.
// The caller keeps `rect` at the image's aspect ratio.
export function addImageStamp(
	mupdf: MupdfModule,
	document: PDFDocument,
	input: PdfAuthored & { readonly rect: PdfRect; readonly image: Uint8Array; readonly opacity?: number }
): PdfCreated {
	const image = new mupdf.Image(input.image)

	if (image.getWidth() * image.getHeight() > MAX_STAMP_PIXELS) {
		image.destroy()

		throw new PdfAnnotationError("invalid", "image too large")
	}

	const annotation = loadPage(document, input.page).createAnnotation("Stamp")

	annotation.setRect(mutableRect(checkRect(input.rect)))
	annotation.setIntent("StampImage")
	annotation.setStampImage(image)
	image.destroy()

	if (input.opacity !== undefined) annotation.setOpacity(clamp01(input.opacity))

	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

// A standard stamp ("Approved", "Draft", …) placed at `rect`'s top-left; its height follows the stamp's aspect.
export function addPresetStamp(
	document: PDFDocument,
	input: PdfAuthored & { readonly rect: PdfRect; readonly name: PdfPresetStamp }
): PdfCreated {
	const annotation = loadPage(document, input.page).createAnnotation("Stamp")

	annotation.setIcon(input.name)
	annotation.setRect(mutableRect(checkRect(input.rect)))
	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

// A sticky note (Text with its popup) whose icon's top-left is `at`, carrying `text`.
export function addStickyNote(
	document: PDFDocument,
	input: PdfAuthored & { readonly at: PdfPoint; readonly text: string; readonly color?: PdfRgb }
): PdfCreated {
	const x = finite(input.at[0], "point")
	const y = finite(input.at[1], "point")
	const annotation = loadPage(document, input.page).createAnnotation("Text")

	annotation.setRect([x, y, x + NOTE_SIDE, y + NOTE_SIDE])
	annotation.setIcon("Comment")
	annotation.setColor(mutableRgb(input.color ?? DEFAULT_NOTE))
	annotation.setContents(input.text)
	stampCreated(annotation, input.author, input.now)

	return created(annotation, input.page)
}

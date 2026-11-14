import type { PDFAnnotation, PDFDocument, PDFPage } from "mupdf"
import {
	clamp01,
	mapPoint,
	normalizeRect,
	translateRect,
	type PdfAnnotationRef,
	type PdfLineEnding,
	type PdfPoint,
	type PdfRect,
	type PdfRgb,
	type PdfTextAlign,
	type PdfTextFont
} from "../../../core/pdfedit/annotations"
import { fontSize, TEXT_ALIGN } from "./create"
import {
	annotationId,
	checkRect,
	finite,
	mutableRect,
	mutableRgb,
	PdfAnnotationError,
	POINT_TYPES,
	RECT_TYPES,
	popupsOf,
	rectOf,
	removeFromAnnots,
	requireAnnotation,
	requireUnlocked,
	stampModified,
	userDelta
} from "./shared"

// Changing existing annotations. Each function is one command (the caller wraps it in one journal operation; a drag
// is one call at its end) and returns the pages it touched. Locked or read-only annotations are refused.

// The deepest reply chain deleted with its root.
const MAX_REPLY_DEPTH = 64

function points(annotation: PDFAnnotation): PdfPoint[][] {
	switch (annotation.getType()) {
		case "Ink":
			return annotation.getInkList()
		case "Line":
			return [annotation.getLine()]
		default:
			return [annotation.getVertices()]
	}
}

function setPoints(annotation: PDFAnnotation, next: PdfPoint[][]): void {
	const mutable = next.map(stroke => stroke.map(([x, y]): [number, number] => [x, y]))

	switch (annotation.getType()) {
		case "Ink":
			annotation.setInkList(mutable)
			break
		case "Line": {
			const [a, b] = mutable[0] ?? []

			if (a === undefined || b === undefined) throw new PdfAnnotationError("invalid", "line")

			annotation.setLine(a, b)
			break
		}
		default:
			annotation.setVertices(mutable[0] ?? [])
	}
}

function boundsOfPoints(all: readonly (readonly PdfPoint[])[]): PdfRect {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const stroke of all) {
		for (const [x, y] of stroke) {
			x0 = Math.min(x0, x)
			y0 = Math.min(y0, y)
			x1 = Math.max(x1, x)
			y1 = Math.max(y1, y)
		}
	}

	return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0]
}

function movePopup(page: PDFPage, annotation: PDFAnnotation, dx: number, dy: number): void {
	const popup = annotation.getObject().get("Popup")
	const rect = popup.isNull() ? popup : popup.get("Rect")

	if (!rect.isArray() || rect.length !== 4) return

	const [ux, uy] = userDelta(page, dx, dy)

	popup.put(
		"Rect",
		[0, 1, 2, 3].map(index => rect.get(index).asNumber() + (index % 2 === 0 ? ux : uy))
	)
}

function editable(document: PDFDocument, ref: PdfAnnotationRef): { page: PDFPage; annotation: PDFAnnotation } {
	const found = requireAnnotation(document, ref)

	requireUnlocked(found.annotation)

	return found
}

// Moves an annotation by (dx, dy) points: its rect, or its points (ink, line, polygon), and a sticky note's popup with
// it. Text markups follow their text and are refused.
export function moveAnnotation(document: PDFDocument, ref: PdfAnnotationRef, dx: number, dy: number, now: Date): readonly number[] {
	const { page, annotation } = editable(document, ref)
	const type = annotation.getType()
	const x = finite(dx, "dx")
	const y = finite(dy, "dy")

	if (RECT_TYPES.has(type)) {
		annotation.setRect(mutableRect(translateRect(rectOf(annotation.getRect()), x, y)))

		if (type === "Text") movePopup(page, annotation, x, y)
	} else if (POINT_TYPES.has(type)) {
		setPoints(
			annotation,
			points(annotation).map(stroke => stroke.map(([px, py]): PdfPoint => [px + x, py + y]))
		)
	} else {
		throw new PdfAnnotationError("unsupported", `${type} annotations can't be moved`)
	}

	stampModified(annotation, now)
	annotation.update()

	return [ref.page]
}

// Gives an annotation the bounds `rect` (as listAnnotations reports them): a rect type takes it as its rect; a points
// type has its points scaled into it, keeping the margin its stroke adds around them. Sticky notes keep their icon
// size and only move.
export function resizeAnnotation(document: PDFDocument, ref: PdfAnnotationRef, rect: PdfRect, now: Date): readonly number[] {
	const { annotation } = editable(document, ref)
	const type = annotation.getType()
	const target = checkRect(rect)

	if (type === "Text") {
		const current = rectOf(annotation.getRect())

		return moveAnnotation(document, ref, target[0] - current[0], target[1] - current[1], now)
	}

	if (RECT_TYPES.has(type)) {
		annotation.setRect(mutableRect(target))
	} else if (POINT_TYPES.has(type)) {
		const all = points(annotation)
		const inner = boundsOfPoints(all)
		const outer = rectOf(annotation.getBounds())
		const to = normalizeRect([
			target[0] + (inner[0] - outer[0]),
			target[1] + (inner[1] - outer[1]),
			target[2] - (outer[2] - inner[2]),
			target[3] - (outer[3] - inner[3])
		])

		setPoints(
			annotation,
			all.map(stroke => stroke.map(point => mapPoint(point, inner, to)))
		)
	} else {
		throw new PdfAnnotationError("unsupported", `${type} annotations can't be resized`)
	}

	stampModified(annotation, now)
	annotation.update()

	return [ref.page]
}

// What the popover and the text box toolbar change; omitted fields stay. `color` is a text box's text colour and
// every other type's stroke or markup colour; `fill` null removes a fill.
export interface PdfAnnotationStyle {
	readonly color?: PdfRgb
	readonly fill?: PdfRgb | null
	readonly opacity?: number
	readonly width?: number
	readonly font?: PdfTextFont
	readonly size?: number
	readonly align?: PdfTextAlign
	readonly lineEndings?: { readonly start: PdfLineEnding; readonly end: PdfLineEnding }
}

export function setAnnotationStyle(document: PDFDocument, ref: PdfAnnotationRef, style: PdfAnnotationStyle, now: Date): readonly number[] {
	const { annotation } = editable(document, ref)
	const type = annotation.getType()

	if (type === "FreeText") {
		const current = annotation.getDefaultAppearance()
		const font = style.font ?? current.font
		const size = style.size === undefined ? current.size : fontSize(style.size)

		annotation.setDefaultAppearance(font, size, style.color === undefined ? current.color : mutableRgb(style.color))

		if (style.align !== undefined) annotation.setQuadding(TEXT_ALIGN[style.align])
	} else if (style.color !== undefined) {
		annotation.setColor(mutableRgb(style.color))
	}

	if (style.fill !== undefined && annotation.hasInteriorColor())
		annotation.setInteriorColor(style.fill === null ? [] : mutableRgb(style.fill))
	if (style.opacity !== undefined) annotation.setOpacity(clamp01(style.opacity))
	if (style.width !== undefined && annotation.hasBorder() && type !== "FreeText")
		annotation.setBorderWidth(Math.max(0, finite(style.width, "width")))
	if (style.lineEndings !== undefined && annotation.hasLineEndingStyles()) {
		annotation.setLineEndingStyles(style.lineEndings.start, style.lineEndings.end)
	}

	stampModified(annotation, now)
	annotation.update()

	return [ref.page]
}

// Replaces an annotation's text: a text box's shown text, or any annotation's note. Rich text is dropped (it would
// otherwise disagree with the new plain text).
export function setAnnotationText(document: PDFDocument, ref: PdfAnnotationRef, text: string, now: Date): readonly number[] {
	const { annotation } = editable(document, ref)

	annotation.setContents(text)
	annotation.getObject().delete("RC")
	stampModified(annotation, now)
	annotation.update()

	return [ref.page]
}

// Deletes an annotation with every reply and review state of its thread on the page, and their popups.
export function deleteAnnotation(document: PDFDocument, ref: PdfAnnotationRef): readonly number[] {
	const { page, annotation } = editable(document, ref)
	const doomed = new Set([ref.id])
	const all = page.getAnnotations().slice()

	// Replies to anything doomed, until no new one joins (bounded by the chain depth).
	for (let depth = 0; depth < MAX_REPLY_DEPTH; depth++) {
		let grew = false

		for (const other of all) {
			const id = annotationId(other)
			const parent = other.getObject().get("IRT")

			if (!doomed.has(id) && parent.isIndirect() && doomed.has(parent.asIndirect())) {
				doomed.add(id)
				grew = true
			}
		}

		if (!grew) break
	}

	const popups = popupsOf(page, doomed)

	for (const other of all) if (other !== annotation && doomed.has(annotationId(other))) page.deleteAnnotation(other)

	page.deleteAnnotation(annotation)
	removeFromAnnots(page, popups)

	return [ref.page]
}

// Hides an annotation from rendering while an overlay editor stands in for it (a text box being typed into). An
// in-memory flag of the engine, never saved and never journaled: not a command.
export function setHiddenForEditing(document: PDFDocument, ref: PdfAnnotationRef, hidden: boolean): readonly number[] {
	requireAnnotation(document, ref).annotation.setHiddenForEditing(hidden)

	return [ref.page]
}

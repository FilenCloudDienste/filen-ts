import { rgbToHex, type PdfAnnotationInfo, type PdfPresetStamp, type PdfRgb } from "@filen/office/core/pdfedit/annotations"
import type { PreviewKey } from "@/lib/i18n"

// What the annotation popover offers for an annotation, and the stamp names it and the stamp picker show.

// Types drawn with lines whose width the popover sets.
const STROKED = new Set(["Ink", "Line", "Square", "Circle", "Polygon", "PolyLine"])

export const PDF_ANNOT_WIDTH_MIN = 0.5
export const PDF_ANNOT_WIDTH_MAX = 12
export const PDF_ANNOT_WIDTH_STEP = 0.5

export function hasStrokeWidth(info: Pick<PdfAnnotationInfo, "type">): boolean {
	return STROKED.has(info.type)
}

// A stamp's colour lives in its picture; a sticky note's, a markup's and every other's in /C (a text box's in its text).
export function hasColor(info: Pick<PdfAnnotationInfo, "type">): boolean {
	return info.type !== "Stamp" && info.type !== "FileAttachment"
}

// The colour grid's key for an annotation's colour ("RRGGBB"), undefined without one.
export function colorKey(color: PdfRgb | null): string | undefined {
	return color === null ? undefined : rgbToHex(color)
}

export function opacityPercent(opacity: number): number {
	return Math.round(Math.min(1, Math.max(0, opacity)) * 100)
}

export function clampWidth(width: number): number {
	return Math.min(PDF_ANNOT_WIDTH_MAX, Math.max(PDF_ANNOT_WIDTH_MIN, Math.round(width / PDF_ANNOT_WIDTH_STEP) * PDF_ANNOT_WIDTH_STEP))
}

export const PDF_STAMP_KEYS: Readonly<Record<PdfPresetStamp, PreviewKey>> = {
	Approved: "previewPdfAnnotStampApproved",
	Experimental: "previewPdfAnnotStampExperimental",
	NotApproved: "previewPdfAnnotStampNotApproved",
	AsIs: "previewPdfAnnotStampAsIs",
	Expired: "previewPdfAnnotStampExpired",
	NotForPublicRelease: "previewPdfAnnotStampNotForPublicRelease",
	Confidential: "previewPdfAnnotStampConfidential",
	Final: "previewPdfAnnotStampFinal",
	Sold: "previewPdfAnnotStampSold",
	Departmental: "previewPdfAnnotStampDepartmental",
	ForComment: "previewPdfAnnotStampForComment",
	TopSecret: "previewPdfAnnotStampTopSecret",
	Draft: "previewPdfAnnotStampDraft",
	ForPublicRelease: "previewPdfAnnotStampForPublicRelease"
}

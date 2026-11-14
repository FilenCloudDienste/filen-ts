import {
	PDF_PRESET_STAMPS,
	type PdfMarkupKind,
	type PdfPresetStamp,
	type PdfRgb,
	type PdfTextAlign,
	type PdfTextFont
} from "@filen/office/core/pdfedit/annotations"
import { stampSize, type RectSize, type ShapeKind } from "@filen/office/react/pdfedit/tools"
import {
	CircleIcon,
	HighlighterIcon,
	MinusIcon,
	MoveUpRightIcon,
	SquareIcon,
	StrikethroughIcon,
	UnderlineIcon,
	WavesIcon,
	type LucideIcon
} from "lucide-react"
import type { PreviewKey } from "@/lib/i18n"

// The annotation tools' choices: which overlay mode a tool draws with, what its variants (the ribbon's ▾ menus) are
// and the defaults new annotations get.

export type AnnotationMode = "select" | "hand" | "textBox" | "draw" | "markup" | "shape" | "stamp" | "note"

// A new text box: Helvetica 12 pt, black, left-aligned (the popover changes its colour and opacity afterwards).
export const ANNOTATION_TEXT_STYLE: {
	readonly font: PdfTextFont
	readonly size: number
	readonly color: PdfRgb
	readonly align: PdfTextAlign
} = { font: "Helv", size: 12, color: [0, 0, 0], align: "left" }

interface Variant<Id extends string> {
	readonly id: Id
	readonly labelKey: PreviewKey
	readonly icon: LucideIcon
}

export const MARKUP_VARIANTS: readonly Variant<PdfMarkupKind>[] = [
	{ id: "Highlight", labelKey: "previewPdfAnnotToolHighlight", icon: HighlighterIcon },
	{ id: "Underline", labelKey: "previewPdfAnnotToolUnderline", icon: UnderlineIcon },
	{ id: "StrikeOut", labelKey: "previewPdfAnnotToolStrikeOut", icon: StrikethroughIcon },
	{ id: "Squiggly", labelKey: "previewPdfAnnotToolSquiggly", icon: WavesIcon }
]

export type ShapeVariant = "Square" | "Circle" | "Line" | "Arrow"

export const SHAPE_VARIANTS: readonly Variant<ShapeVariant>[] = [
	{ id: "Square", labelKey: "previewPdfAnnotToolRectangle", icon: SquareIcon },
	{ id: "Circle", labelKey: "previewPdfAnnotToolEllipse", icon: CircleIcon },
	{ id: "Line", labelKey: "previewPdfAnnotToolLine", icon: MinusIcon },
	{ id: "Arrow", labelKey: "previewPdfAnnotToolArrow", icon: MoveUpRightIcon }
]

// An image from this device or from Filen, or one of the standard stamps.
export type StampVariant = "image" | "imageFilen" | PdfPresetStamp

export function markupKindOf(variant: string | null): PdfMarkupKind {
	return MARKUP_VARIANTS.find(entry => entry.id === variant)?.id ?? "Highlight"
}

export function shapeKindOf(variant: string | null): ShapeKind {
	return variant === "Circle" || variant === "Line" ? variant : variant === "Arrow" ? "Line" : "Square"
}

export function stampVariantOf(variant: string | null): StampVariant {
	if (variant === "imageFilen") return "imageFilen"

	return PDF_PRESET_STAMPS.find(name => name === variant) ?? "image"
}

// A standard stamp's placed size (its drawn proportions), and a picture's before it is chosen.
export const PRESET_STAMP_SIZE: RectSize = stampSize(150, 45)

// The tool a keyboard placement places, for its live region.
export function placementToolKey(mode: AnnotationMode, variant: string | null): PreviewKey {
	switch (mode) {
		case "textBox":
			return "previewPdfAnnotToolTextBox"
		case "stamp":
			return stampVariantOf(variant) === "image" || stampVariantOf(variant) === "imageFilen"
				? "previewPdfAnnotToolImage"
				: "previewPdfAnnotToolStamp"
		case "note":
			return "previewPdfAnnotToolNote"
		default:
			return SHAPE_VARIANTS.find(entry => entry.id === variant)?.labelKey ?? "previewPdfAnnotToolRectangle"
	}
}

// A file name for an attachment saved from a PDF: the name the file gives, without any directory part or control
// characters, never empty.
export function attachmentFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? ""
	// Control characters (below U+0020, and U+007F) go.
	const clean = Array.from(base)
		.filter(char => {
			const code = char.codePointAt(0) ?? 0

			return code >= 0x20 && code !== 0x7f
		})
		.join("")
		.trim()

	return clean === "" || clean === "." || clean === ".." ? "attachment" : clean
}

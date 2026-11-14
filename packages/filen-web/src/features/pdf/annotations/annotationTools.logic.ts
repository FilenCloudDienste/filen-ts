import {
	attachmentDisplayName,
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

// What an annotation is called in its accessible name, by PDF subtype; any other is an "Annotation".
const ANNOTATION_KINDS: ReadonlyMap<string, PreviewKey> = new Map([
	["FreeText", "previewPdfAnnotToolTextBox"],
	["Ink", "previewPdfAnnotKindInk"],
	["Highlight", "previewPdfAnnotToolHighlight"],
	["Underline", "previewPdfAnnotToolUnderline"],
	["StrikeOut", "previewPdfAnnotToolStrikeOut"],
	["Squiggly", "previewPdfAnnotToolSquiggly"],
	["Square", "previewPdfAnnotToolRectangle"],
	["Circle", "previewPdfAnnotToolEllipse"],
	["Line", "previewPdfAnnotToolLine"],
	["Stamp", "previewPdfAnnotToolStamp"],
	["Text", "previewPdfAnnotToolNote"],
	["FileAttachment", "previewPdfAnnotKindAttachment"],
	["Redact", "previewPdfAnnotKindRedact"]
])

// The longest part of an annotation's text its accessible name repeats.
const LABEL_TEXT_MAX = 80

export interface AnnotationLabel {
	readonly key: "previewPdfAnnotLabel" | "previewPdfAnnotLabelAuthor" | "previewPdfAnnotLabelText" | "previewPdfAnnotLabelAuthorText"
	readonly kind: PreviewKey
	readonly author: string
	readonly text: string
}

// An annotation's accessible name: its kind, then who wrote it and the start of its text when it has them.
export function annotationLabel(info: { readonly type: string; readonly author: string; readonly text: string }): AnnotationLabel {
	const author = info.author.trim()
	const flat = info.text.replace(/\s+/gu, " ").trim()
	const text = flat.length > LABEL_TEXT_MAX ? `${flat.slice(0, LABEL_TEXT_MAX - 1).trimEnd()}…` : flat
	const kind = ANNOTATION_KINDS.get(info.type) ?? "previewPdfAnnotPopover"

	return {
		key:
			author === ""
				? text === ""
					? "previewPdfAnnotLabel"
					: "previewPdfAnnotLabelText"
				: text === ""
					? "previewPdfAnnotLabelAuthor"
					: "previewPdfAnnotLabelAuthorText",
		kind,
		author,
		text
	}
}

// A page's annotations in reading order (top to bottom, then left to right), the order Tab visits them in. Rects are in
// page space (y down).
export function readingOrder<T extends { readonly rect: readonly [number, number, number, number] }>(annotations: readonly T[]): T[] {
	return [...annotations].sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
}

// A file name for an attachment saved from a PDF: the name the file gives, without any directory part or hidden and
// reordering characters (attachmentDisplayName), never empty.
export function attachmentFileName(name: string): string {
	const clean = attachmentDisplayName(name.split(/[\\/]/).pop() ?? "")

	return clean === "" || clean === "." || clean === ".." ? "attachment" : clean
}

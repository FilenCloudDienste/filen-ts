import type { PdfFontAssets } from "../../../core/pdfwrite/fonts"
import { layoutTextOverlay, type TextOverlayFrame } from "../../../core/pdfedit/textLayout"
import type { PdfAbortSignal } from "../../../core/pdfwrite/writer"
import type { TextEditTarget } from "./target"

// The overlay PDF for a text edit, made before the journal operation opens (font files load asynchronously; the
// apply that follows is synchronous): the new text in the target's frame and style, with the editor's changes to
// size, colour, bold or italic. Null for empty text (the edit only deletes).

export interface TextEditStyle {
	readonly size?: number
	readonly color?: number
	readonly bold?: boolean
	readonly italic?: boolean
	// BCP 47 language of the new text (picks the CJK fallback face).
	readonly language?: string
}

// What laying out new text needs of a target ("Add text" makes one: newTextFrame, a matched font, the page's size).
export type TextEditSource = Pick<TextEditTarget, "frame" | "size" | "color" | "font" | "pageWidth" | "pageHeight">

export async function prepareTextEdit(
	target: TextEditSource,
	text: string,
	assets: PdfFontAssets,
	style: TextEditStyle = {},
	signal?: PdfAbortSignal
): Promise<Uint8Array | null> {
	if (text.trim().length === 0) return null

	const size = style.size ?? target.size
	const scale = size / target.size
	const frame: TextOverlayFrame = { ...target.frame, lineHeight: target.frame.lineHeight * scale }
	const overlay = await layoutTextOverlay({
		pageWidth: target.pageWidth,
		pageHeight: target.pageHeight,
		frame,
		style: {
			font: { ...target.font, bold: style.bold ?? target.font.bold, italic: style.italic ?? target.font.italic },
			size,
			color: style.color ?? target.color,
			...(style.language === undefined ? {} : { language: style.language })
		},
		text,
		assets,
		...(signal === undefined ? {} : { signal })
	})

	return overlay.bytes
}

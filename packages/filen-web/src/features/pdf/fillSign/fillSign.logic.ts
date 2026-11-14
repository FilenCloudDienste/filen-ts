import type { PdfFillMark } from "@filen/office/dom/pdfedit/fillSign"
import type { PdfPageRect, PdfSignatureRole, PdfVisualSignature } from "@filen/office/core/pdfedit/visualSignature"
import { signatureAspect } from "@filen/office/core/pdfedit/visualSignature"
import type { PlacementRect } from "@filen/office/react/pdfedit"

// Fill & Sign's placement geometry: what each tool puts down by default, and the conversions between the page's
// bottom-left user space (the viewport's, keyboard placement's) and MuPDF's page space (y down) the commands take.
// All sizes in points.

export type FillSignMode =
	| { readonly kind: "text" }
	| { readonly kind: "mark"; readonly mark: PdfFillMark }
	| { readonly kind: "signature"; readonly role: PdfSignatureRole }

export const FILL_TEXT_SIZE = 12
// The text box a keyboard placement starts with (the typed text then sizes the box).
export const FILL_TEXT_BOX = { width: 160, height: 20 } as const
// Line height of placed text, in font sizes; and the room around it, so another viewer's layout never wraps it.
const LINE_HEIGHT = 1.2
const TEXT_PADDING = 4
const TEXT_SLACK = 1.1

const MARK_SIZES: Readonly<Record<PdfFillMark, number>> = { check: 14, cross: 12, dot: 8 }
const SIGNATURE_WIDTH: Readonly<Record<PdfSignatureRole, number>> = { signature: 160, initials: 60 }
const SIGNATURE_MAX_HEIGHT: Readonly<Record<PdfSignatureRole, number>> = { signature: 70, initials: 40 }

export function markSize(mark: PdfFillMark): { readonly width: number; readonly height: number } {
	return { width: MARK_SIZES[mark], height: MARK_SIZES[mark] }
}

// A signature's default size on the page: its role's width, its own aspect, no taller than its role allows.
export function signatureSize(signature: PdfVisualSignature, role: PdfSignatureRole): { readonly width: number; readonly height: number } {
	const aspect = signatureAspect(signature)
	const height = Math.min(SIGNATURE_WIDTH[role] / aspect, SIGNATURE_MAX_HEIGHT[role])

	return { width: height * aspect, height }
}

// A rectangle of the bottom-left user space as MuPDF's page space, on a page `height` points tall.
export function pageBox(rect: PlacementRect, height: number): PdfPageRect {
	return [rect.x, height - rect.y - rect.height, rect.x + rect.width, height - rect.y]
}

// The box typed text takes, its top left kept at `rect`'s: as wide as its longest line (measured), as tall as its lines.
export function textBox(rect: PlacementRect, lineWidths: readonly number[], size: number): PlacementRect {
	const width = Math.max(...lineWidths, size) * TEXT_SLACK + TEXT_PADDING * 2
	const height = Math.max(1, lineWidths.length) * size * LINE_HEIGHT + TEXT_PADDING
	const top = rect.y + rect.height

	return { x: rect.x, y: top - height, width, height }
}

let measure: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null

// Widths of `text`'s lines in a Helvetica-like face at `size` points (the FreeText appearance's Helv).
export function lineWidths(text: string, size: number): number[] {
	measure ??=
		typeof OffscreenCanvas === "function"
			? new OffscreenCanvas(1, 1).getContext("2d")
			: document.createElement("canvas").getContext("2d")

	const context = measure

	if (context === null) return text.split("\n").map(line => line.length * size * 0.55)

	context.font = `${String(size)}px Helvetica, Arial, sans-serif`

	return text.split("\n").map(line => context.measureText(line).width)
}

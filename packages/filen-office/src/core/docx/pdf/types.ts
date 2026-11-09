import type { Paint, Stroke } from "../../drawingml/index"
import type { PdfDrawingData } from "../../drawingml/pdf"
import type { RenderEffects } from "../../presentation/output"
import type { BundledFamily } from "../../fonts/substitutes"
import type { FontSlot } from "../../fonts/slots"
import type { MathElement } from "../../math/index"
import type { PdfDocumentProperties } from "../../pdfwrite/index"
import type { DecorationValue } from "../layout/styles"

// What the PDF painter reads: a laid-out document as plain data (numbers, strings, typed arrays), so it can
// be built where the layout lives (a worker, or the editor's page) and painted in a worker. Pages carry the
// same arrays the renderer draws, plus each paragraph's role for the structure tree.

// One text style of the layout (fragment STYLE ints index these).
export interface DocxPdfStyle {
	// Index into DocxPdfDocument.faces.
	readonly face: number
	readonly bold: boolean
	readonly italic: boolean
	readonly slot: FontSlot
	// BCP 47 of the run's text in this slot.
	readonly language: string | undefined
	// The em size drawn, px (the substitute's scale applied).
	readonly size: number
	// 0xRRGGBBAA; the automatic colour is black.
	readonly color: number
	readonly letterSpacing: number
	readonly scaleX: number
	// Baseline raised (positive) or lowered, px.
	readonly shift: number
	// Fit to the layout's width by spreading the glyphs, or by scaling them (a face drawn in place of an
	// installed font the layout measured).
	readonly fit: "spread" | "scale"
	// A symbol font (Symbol, Wingdings...) drawn on screen from an installed copy and in the PDF by a bundled
	// face: its codes are drawn as the Unicode characters they show (core/fonts/symbols.ts).
	readonly symbolFont?: string | undefined
	// A document run's character effect (RunEffect) and emphasis mark (Emphasis), layout/effects.ts; absent for none.
	// `markY`: the marks' centre below the baseline, px (negative above it).
	readonly effect?: number
	readonly emphasis?: number
	readonly markY?: number
	// DrawingML text (presentations; DocxTextStyle's fields of the same names): the fill drawn in place of `color`
	// (DocxPdfDocument.paints index), the glyphs' opacity, their outline (DocxPdfDocument.strokes index) and effects
	// (DocxPdfDocument.textEffects index). Absent, the run draws exactly as without them.
	readonly paint?: number
	readonly alpha?: number
	readonly outline?: number
	readonly effects?: number
}

// Where a style's glyphs come from: a bundled family (substitutes, and faces a document may not have
// embedded again), or a face the document embeds that allows embedding.
export type DocxPdfFace =
	| { readonly kind: "bundled"; readonly family: BundledFamily; readonly weight: number; readonly italic: boolean }
	| {
			readonly kind: "embedded"
			readonly key: string
			readonly bytes: Uint8Array
			readonly fsType: number
			readonly weight: number
			readonly italic: boolean
			readonly substitute: BundledFamily
	  }

export type DocxPdfLinkTarget =
	{ readonly kind: "external"; readonly href: string } | { readonly kind: "internal"; readonly anchor: string }

// The structure a paragraph belongs to. Table cells are listed from the outermost table in.
export interface DocxPdfRole {
	// "artifact": headers, footers, page numbers, line numbers, repeated header rows.
	readonly kind: "paragraph" | "heading" | "listItem" | "artifact"
	// Heading level 1-9 (outline level + 1).
	readonly level: number
	// List items: the list they belong to (consecutive items of one list share an L element).
	readonly list: number
	readonly cells: readonly DocxPdfCell[]
	// Artifacts: header or footer.
	readonly artifact?: "Header" | "Footer" | undefined
}

export interface DocxPdfCell {
	// The table, unique in the document.
	readonly table: number
	readonly row: number
	// Index into `columns`.
	readonly cell: number
	// The row repeats as a header row (w:tblHeader): its cells are TH.
	readonly header: boolean
	// The row's cells as the structure tree has them: every grid position of the row, so every row of a table
	// tags as many columns (ISO 14289-1 §7.5).
	readonly columns: readonly DocxPdfColumn[]
}

// A cell of a row: the grid columns it spans (w:gridSpan; also what w:gridBefore and w:gridAfter skip), and the
// rows of its vertical merge (w:vMerge; top = end = its own row without one). A cell below the first of a merge
// is covered by it: tagged once, with RowSpan, on the first.
export interface DocxPdfColumn {
	readonly span: number
	readonly top: number
	readonly end: number
}

// linkInts per range: source, text start, text end, link index into DocxPdfDocument.links.
export const PDF_LINK_INTS = 4

// clipInts: first line, end line, first object, end object (placed objects; inline ones are never clipped).
export const PDF_CLIP_FLOATS = 4
export const PDF_CLIP_INTS = 4

// One page: the display list's arrays (core/docx/layout/output.ts, core/text/displayList.ts), with the page's
// inline objects appended to its placed ones (objectFloats x, y, width, height; objectInts id, layer, source).
export interface DocxPdfPage {
	readonly index: number
	readonly width: number
	readonly height: number
	readonly lineCount: number
	readonly fragmentCount: number
	readonly decorationCount: number
	readonly lineFloats: Float32Array
	readonly lineInts: Int32Array
	readonly fragmentFloats: Float32Array
	readonly fragmentInts: Int32Array
	readonly decorationFloats: Float32Array
	readonly decorationInts: Int32Array
	readonly graphicCount: number
	readonly graphicFloats: Float32Array
	readonly graphicInts: Int32Array
	readonly objectCount: number
	readonly objectFloats: Float32Array
	readonly objectInts: Int32Array
	readonly sourceCount: number
	readonly sourceInts: Int32Array
	readonly sourceTexts: readonly string[]
	// Per source, the object (by id) whose text box its paragraph is laid out in, -1 for none; absent when the page
	// has no text box text. The text is drawn with its box.
	readonly sourceOwners?: Int32Array
	readonly linkCount: number
	readonly linkInts: Int32Array
	readonly clipCount: number
	readonly clipFloats: Float32Array
	readonly clipInts: Int32Array
	// Text turned sideways in a box (layout/turns.ts), and per object the turn it is drawn through (-1 for none); absent
	// on a page without turns.
	readonly turnCount?: number
	readonly turnFloats?: Float32Array
	readonly turnInts?: Int32Array
	readonly objectTurns?: Int32Array
	// Per source: its role, and the key of its paragraph in the document ("" for generated text).
	readonly roles: readonly DocxPdfRole[]
	readonly keys: readonly string[]
}

// A drawing's display list as data (core/drawingml/pdf.ts paints it), scaled from its frame onto the object box.
export type DocxPdfDrawing = PdfDrawingData

export type DocxPdfObject =
	| { readonly kind: "drawing"; readonly id: number; readonly drawing: DocxPdfDrawing; readonly alt?: string }
	| { readonly kind: "math"; readonly id: number; readonly tree: MathElement; readonly fontSize: number }
	| { readonly kind: "separator"; readonly id: number }
	| { readonly kind: "checkbox"; readonly id: number; readonly checked: boolean }
	| { readonly kind: "placeholder"; readonly id: number; readonly reason: string }

export interface DocxPdfOutlineEntry {
	readonly title: string
	// 1 = top.
	readonly level: number
	readonly page: number
	// px from the page's top.
	readonly y: number
}

export interface DocxPdfDocument {
	readonly pages: readonly DocxPdfPage[]
	readonly styles: readonly DocxPdfStyle[]
	readonly faces: readonly DocxPdfFace[]
	readonly decorations: readonly DecorationValue[]
	readonly links: readonly DocxPdfLinkTarget[]
	// Objects by id (DocxPdfPage objectInts ids).
	readonly objects: ReadonlyMap<number, DocxPdfObject>
	// Image bytes by part name, for the drawings' images.
	readonly media: ReadonlyMap<string, Uint8Array>
	// Bookmarks (internal link targets) by name.
	readonly destinations: ReadonlyMap<string, { readonly page: number; readonly y: number }>
	readonly outline: readonly DocxPdfOutlineEntry[]
	// BCP 47 language of the document's text, and its title (its own, else its file name's).
	readonly lang: string | undefined
	readonly title: string
	// Its core properties' author, subject and keywords (Info /Author, /Subject, /Keywords).
	readonly properties?: PdfDocumentProperties
	// The tables DrawingML text styles index (DocxPdfStyle.paint, .outline, .effects); absent for documents.
	readonly paints?: readonly Paint[]
	readonly strokes?: readonly Stroke[]
	readonly textEffects?: readonly RenderEffects[]
}

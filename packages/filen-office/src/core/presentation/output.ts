import type { DrawingData, Paint, Rgba, Stroke } from "../drawingml/index"
import type { DecorationValue, DocxLinkTarget, DocxPageData, DocxTextStyle } from "../docx/layout/index"
import type { Action, LockReason, ParaProps, RunProps, ShapeLocks, ShapeNode, ShapeRef, SlideRef, TextBody, Xfrm } from "./model"

// What the presentation engine hands a painter: plain data (numbers, strings, typed arrays) that crosses a worker
// boundary by structured clone with its typed arrays transferred, never copied. The text and drawing data are the
// docx engine's own page and drawing data (core/docx/layout/pageData.ts, core/drawingml/data.ts), so paintPage, paintDrawing, DocxPagePainter and
// paintDrawingPdf draw them unchanged.

// An effect on text or a shape as drawn: colours resolved, sizes in px.
export type RenderEffect =
	| {
			readonly kind: "outerShadow" | "innerShadow"
			readonly color: Rgba
			readonly blur: number
			readonly dx: number
			readonly dy: number
			readonly sx: number
			readonly sy: number
	  }
	| { readonly kind: "glow"; readonly color: Rgba; readonly radius: number }
	| { readonly kind: "softEdge"; readonly radius: number }
	| { readonly kind: "blur"; readonly radius: number }
	| {
			readonly kind: "reflection"
			readonly blur: number
			readonly startAlpha: number
			readonly endAlpha: number
			readonly endPos: number
			readonly distance: number
			readonly direction: number
	  }

export type RenderEffects = readonly RenderEffect[]

// One text body laid out: a complete page (its size is the body's box, its graphic and object arrays empty) with
// the tables its styles index (DocxTextStyle.paint → paints, .outline → strokes, .effects → textEffects; a stroke's
// `paint` indexes paints too).
export interface TextPage {
	readonly page: DocxPageData
	readonly styles: readonly DocxTextStyle[]
	readonly paints: readonly Paint[]
	readonly strokes: readonly Stroke[]
	readonly textEffects: readonly RenderEffects[]
	readonly decorations: readonly DecorationValue[]
	readonly links: readonly DocxLinkTarget[]
}

// A TextLayout (core/text/displayList.ts) with the StyleTable rows HitTester reads, as typed arrays the page
// rebuilds a hit tester from (caret and selection on the main thread over the worker's layout).
export interface TransferableTextLayout {
	readonly lineCount: number
	readonly fragmentCount: number
	readonly decorationCount: number
	readonly lineFloats: Float32Array
	readonly lineInts: Int32Array
	readonly fragmentFloats: Float32Array
	readonly fragmentInts: Int32Array
	readonly decorationFloats: Float32Array
	readonly decorationInts: Int32Array
	readonly styleCount: number
	// Per style, TEXT_STYLE_INTS ints: font key, small-caps font key, caps.
	readonly styleInts: Int32Array
	// Per style, TEXT_STYLE_FLOATS floats: letter spacing, horizontal scale, em, ascent, descent.
	readonly styleFloats: Float64Array
	// Per font key, the CSS font the main thread measures prefixes with (the faces of the "fonts" event).
	readonly fonts: readonly string[]
	// Per paragraph source, its text (line and fragment offsets index it).
	readonly texts: readonly string[]
	// Per paragraph, the length of the generated marker (bullet or number and its tab) its text starts with.
	readonly prefixes?: Int32Array
	// Per paragraph p, its model runs' end offsets in texts[p] are runEnds[runStarts[p] .. runStarts[p + 1]).
	readonly runStarts?: Int32Array
	readonly runEnds?: Int32Array
	// Per font key, 1 when the font is measured with kerning.
	readonly kerning?: Uint8Array
}

export const TEXT_STYLE_INTS = 3
export const TextStyleInt = { FONT: 0, SMALL_FONT: 1, CAPS: 2 } as const
export const TEXT_STYLE_FLOATS = 5
export const TextStyleFloat = { LETTER_SPACING: 0, SCALE_X: 1, EM: 2, ASCENT: 3, DESCENT: 4 } as const

// What a layer is, for painting order, selection and the show.
export type LayerRole =
	"master" | "layout" | "placeholder" | "shape" | "picture" | "table" | "chart" | "smartart" | "media" | "ole" | "ink" | "group"

// A shape's actions as the page may show and activate them (judged again on click, never on paint).
export interface ActionSummary {
	readonly click?: Action
	readonly hover?: Action
}

export interface SlideLayer {
	// The shape the layer draws, named in the node that owns it: a layout's or master's shape drawn on a slide names
	// that layout or master (never the slide, whose own shapes may repeat its ids).
	readonly shape: ShapeRef
	readonly drawing: DrawingData
	readonly text?: TextPage
	// Slide px: a b c d e f, placing the layer's drawing on the slide.
	readonly matrix: readonly number[]
	// TextPage px → slide px: the text box (geometry text rectangle minus insets, turned for vert/vert270); absent =
	// `matrix`. A slide's top-level shape that can hold text has it even with no text to paint (the editor enters it).
	readonly textMatrix?: readonly number[]
	// Shape effects drawn around the drawing (glow, soft edge, reflection…).
	readonly effects?: RenderEffects
	readonly role: LayerRole
	readonly alt?: string
	readonly actions?: ActionSummary
	// Paragraph or character runs of the text the timing animates on their own.
	readonly subLayers?: readonly { readonly target: "para" | "char"; readonly range: readonly [number, number] }[]
	readonly lock?: LockReason
	// The slide's own top-level shape this layer draws (absent on master and layout layers): its id (a group's for a
	// layer of one of its children), its box as the model resolves it (EMU; a placeholder's inherited box when it has
	// none of its own) and its alt text. What the editor's selection and arrange commands start from.
	// `locks`: the file's own locks; `line`: drawn from the box's top-left to its bottom-right corner (flips swap the
	// ends), a connector or a line preset: the editor drags its two ends, not its box.
	readonly box?: {
		readonly id: number
		readonly xfrm: Xfrm
		readonly alt?: ShapeNode["alt"]
		readonly locks?: ShapeLocks
		readonly line?: true
	}
}

export interface SlideRender {
	readonly ref: SlideRef
	readonly index: number
	readonly revision: number
	readonly hidden: boolean
	// The slide's layout (its parent), when it has one.
	readonly layout?: SlideRef
	// Drawn over the deck's size (OpenInfo.size, EMU / 9525 px).
	readonly background: DrawingData
	readonly layers: readonly SlideLayer[]
	readonly notesText: string
	readonly animated: boolean
}

// What the text editor view starts from on entering a body: the body as the model holds it, the effective props
// per paragraph and run (inheritance applied, for the ribbon), and the worker's layout of it.
export interface TextSeed {
	readonly shape: ShapeRef
	readonly revision: number
	readonly body: TextBody
	readonly resolved: readonly { readonly pPr: ParaProps; readonly runs: readonly RunProps[] }[]
	readonly page: TextPage
	readonly layout: TransferableTextLayout
	// The body's text matrix (SlideLayer.textMatrix): TextPage px → slide px.
	readonly matrix: readonly number[]
}

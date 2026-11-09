// What the DOCX layout gives a renderer for one page, as plain data (numbers, enums, strings and typed arrays) that
// crosses a worker boundary by structured clone with the typed arrays transferred. The presentation engine lays its
// text bodies out into the same page data, so the docx painters draw both. dom/docx/protocol.ts re-exports these.

// One text style of the layout (the fragment STYLE ints index these).
export interface DocxTextStyle {
	// CSS font shorthand naming an internal alias (never a document's family name).
	readonly font: string
	// The font for the lower-case letters of a small-caps fragment.
	readonly smallCapsFont: string
	// Six hex digits, or "" for the document's automatic colour.
	readonly color: string
	readonly kerning: boolean
	// px added after every character.
	readonly letterSpacing: number
	// Horizontal glyph scale.
	readonly scaleX: number
	// Baseline raised (positive) or lowered.
	readonly shift: number
	// The drawn font's ascent and descent as the browser lays it out (px), to put the baseline exactly.
	readonly ascent: number
	readonly descent: number
	// TrackedLook of the run (0 none).
	readonly revision: number
	// Hidden text (w:vanish, w:specVanish), laid out while formatting marks show it; absent for visible text.
	readonly hidden?: true
	// The colour slot (1..8) of the tracked change's author, 0 without one: inserted and deleted text is drawn
	// in --fo-revision-<slot>.
	readonly author?: number
	// A document run's character effect (RunEffect) and emphasis mark (Emphasis), layout/effects.ts; absent for none.
	readonly effect?: number
	readonly emphasis?: number
	// DrawingML text (presentations) carries more than a colour; with every field below absent the run draws exactly
	// as it does without them. The fill drawn in place of `color` (index into the page's paints table).
	readonly paint?: number
	// Opacity of the glyphs, 0..1.
	readonly alpha?: number
	// The glyph outline (index into the page's strokes table).
	readonly outline?: number
	// Shadow, glow and the other text effects (index into the page's textEffects table).
	readonly effects?: number
}

export type DocxLinkTarget =
	| { readonly kind: "external"; readonly href: string; readonly tooltip: string | undefined }
	| { readonly kind: "internal"; readonly anchor: string; readonly tooltip: string | undefined }

// linkInts per range: source, text start, text end, link (index into the session's link table).
export const LINK_INTS = 4

export interface DocxPageData {
	readonly index: number
	readonly number: number
	readonly numberText: string
	readonly section: number
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
	// ObjectKind of each object entry.
	readonly objectKinds: Uint8Array
	readonly sourceCount: number
	readonly sourceInts: Int32Array
	readonly sourceTexts: readonly string[]
	// Per source, the object (by id) whose text box its paragraph is laid out in, -1 for none; absent when the page
	// has no text box text. The text is drawn with its box.
	readonly sourceOwners?: Int32Array
	// What formatting marks need of each source (SOURCE_MARK_FLOATS per source, output.ts); absent for text laid out
	// without them (a presentation's).
	readonly sourceMarks?: Float32Array
	readonly linkCount: number
	readonly linkInts: Int32Array
	// Text turned sideways in a box (layout/turns.ts: TURN_FLOATS and TURN_INTS each), and per object the turn it is
	// drawn through (-1 for none); all absent on a page without turns.
	readonly turnCount?: number
	readonly turnFloats?: Float32Array
	readonly turnInts?: Int32Array
	readonly objectTurns?: Int32Array
}

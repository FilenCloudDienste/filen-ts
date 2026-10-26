import { rgba, type Paint, type Stroke } from "../../../core/drawingml/index"
import { SOURCE_INTS } from "../../../core/docx/layout/output"
import { FRAGMENT_FLOATS, FRAGMENT_INTS, FragmentKind, LINE_FLOATS, LINE_INTS, LineFlag } from "../../../core/text/displayList"
import {
	TEXT_STYLE_FLOATS,
	TEXT_STYLE_INTS,
	type RenderEffects,
	type TextPage,
	type TransferableTextLayout
} from "../../../core/presentation/output"
import type { DocxTextStyle } from "../../../dom/docx/protocol"

// A laid-out text body as the presentation worker sends it: one line per paragraph, one text fragment per line,
// widths from a fixed advance per character. Style 0 is plain; style 1 uses every optional DrawingML field (a
// gradient fill, an outline, a glow and an alpha), so painters and the canvas path see all of them. Every call
// builds new arrays: a message transfers the buffers of the typed arrays it carries.

export const FIXTURE_ADVANCE = 9
export const FIXTURE_LINE_HEIGHT = 24
export const FIXTURE_ASCENT = 18

const PLAIN: DocxTextStyle = {
	font: '400 20px "fo-carlito", sans-serif',
	smallCapsFont: '400 14px "fo-carlito", sans-serif',
	color: "1F2937",
	kerning: true,
	letterSpacing: 0,
	scaleX: 1,
	shift: 0,
	ascent: FIXTURE_ASCENT,
	descent: 6,
	revision: 0
}

const DECORATED: DocxTextStyle = { ...PLAIN, font: '700 20px "fo-carlito", sans-serif', paint: 1, alpha: 0.8, outline: 0, effects: 0 }

function paints(): readonly Paint[] {
	return [
		{ kind: "solid", color: rgba("1F2937") },
		{
			kind: "linear",
			stops: { offsets: new Float32Array([0, 1]), colors: new Uint32Array([rgba("4472C4"), rgba("ED7D31")]) },
			angle: 90,
			scaled: false
		}
	]
}

const STROKES: readonly Stroke[] = [
	{ width: 1, paint: 0, dash: "solid", customDash: null, cap: "flat", join: "round", miterLimit: 8, compound: "sng", inset: false }
]

const EFFECTS: readonly RenderEffects[] = [[{ kind: "glow", color: rgba("FFC000", 0.6), radius: 4 }]]

export interface FixtureTextOptions {
	readonly width?: number
	// Paragraphs drawn with the decorated style.
	readonly decorated?: readonly number[]
	// A link over the first paragraph's text.
	readonly link?: string
}

export function fixtureTextPage(paragraphs: readonly string[], options: FixtureTextOptions = {}): TextPage {
	const lines = paragraphs.length
	const lineFloats = new Float32Array(LINE_FLOATS * lines)
	const lineInts = new Int32Array(LINE_INTS * lines)
	const fragmentFloats = new Float32Array(FRAGMENT_FLOATS * lines)
	const fragmentInts = new Int32Array(FRAGMENT_INTS * lines)
	const sourceInts = new Int32Array(SOURCE_INTS * lines)
	const decorated = new Set(options.decorated ?? [])
	let widest = 0

	paragraphs.forEach((text, line) => {
		const width = text.length * FIXTURE_ADVANCE
		const top = line * FIXTURE_LINE_HEIGHT

		widest = Math.max(widest, width)
		lineFloats.set([top, FIXTURE_LINE_HEIGHT, top + FIXTURE_ASCENT, 0, width], line * LINE_FLOATS)
		lineInts.set([line, 1, 0, text.length, LineFlag.FIRST | LineFlag.LAST, line, 0], line * LINE_INTS)
		fragmentFloats.set([0, width, 0, 0], line * FRAGMENT_FLOATS)
		fragmentInts.set([0, text.length, decorated.has(line) ? 1 : 0, FragmentKind.TEXT, 0], line * FRAGMENT_INTS)
		sourceInts.set([0, 0, line, 0], line * SOURCE_INTS)
	})

	const link = options.link

	return {
		page: {
			index: 0,
			number: 1,
			numberText: "1",
			section: 0,
			width: options.width ?? Math.max(1, widest),
			height: Math.max(1, lines * FIXTURE_LINE_HEIGHT),
			lineCount: lines,
			fragmentCount: lines,
			decorationCount: 0,
			lineFloats,
			lineInts,
			fragmentFloats,
			fragmentInts,
			decorationFloats: new Float32Array(0),
			decorationInts: new Int32Array(0),
			graphicCount: 0,
			graphicFloats: new Float32Array(0),
			graphicInts: new Int32Array(0),
			objectCount: 0,
			objectFloats: new Float32Array(0),
			objectInts: new Int32Array(0),
			objectKinds: new Uint8Array(0),
			sourceCount: lines,
			sourceInts,
			sourceTexts: paragraphs,
			linkCount: link === undefined ? 0 : 1,
			linkInts: link === undefined ? new Int32Array(0) : new Int32Array([0, 0, paragraphs[0]?.length ?? 0, 0])
		},
		styles: [PLAIN, DECORATED],
		paints: paints(),
		strokes: STROKES,
		textEffects: EFFECTS,
		decorations: [],
		links: link === undefined ? [] : [{ kind: "external", href: link, tooltip: undefined }]
	}
}

// The layout behind fixtureTextPage, as the text editor view receives it.
export function fixtureTextLayout(paragraphs: readonly string[]): TransferableTextLayout {
	const page = fixtureTextPage(paragraphs).page
	const styleFloats = new Float64Array(TEXT_STYLE_FLOATS * 2)
	const styleInts = new Int32Array(TEXT_STYLE_INTS * 2)

	for (let style = 0; style < 2; style++) {
		styleInts.set([style, style, 0], style * TEXT_STYLE_INTS)
		styleFloats.set([0, 1, 20, FIXTURE_ASCENT, 6], style * TEXT_STYLE_FLOATS)
	}

	return {
		lineCount: page.lineCount,
		fragmentCount: page.fragmentCount,
		decorationCount: 0,
		lineFloats: page.lineFloats,
		lineInts: page.lineInts,
		fragmentFloats: page.fragmentFloats,
		fragmentInts: page.fragmentInts,
		decorationFloats: page.decorationFloats,
		decorationInts: page.decorationInts,
		styleCount: 2,
		styleInts,
		styleFloats,
		fonts: [PLAIN.font, DECORATED.font],
		texts: paragraphs
	}
}

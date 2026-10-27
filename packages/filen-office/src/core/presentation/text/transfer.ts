import { TEXT_STYLE_FLOATS, TEXT_STYLE_INTS, TextStyleFloat, TextStyleInt, type TransferableTextLayout } from "../output"
import type { BodyLayout } from "./body"

// A body's layout as typed arrays the page rebuilds a hit tester from (caret and selection over the worker's
// layout): the page's lines, fragments and decorations (own copies: a message transfers each buffer once, and the
// page's are transferred too), the StyleTable rows HitTester reads, the CSS font per measuring key and the
// paragraph texts.
export function transferableLayout(result: BodyLayout): TransferableTextLayout {
	const page = result.page.page
	const styles = result.styles
	const count = styles.count
	const styleInts = new Int32Array(count * TEXT_STYLE_INTS)
	const styleFloats = new Float64Array(count * TEXT_STYLE_FLOATS)
	let fontCount = 0

	for (let id = 0; id < count; id++) {
		const font = styles.fontKey[id] ?? 0
		const small = styles.smallFontKey[id] ?? font

		styleInts[id * TEXT_STYLE_INTS + TextStyleInt.FONT] = font
		styleInts[id * TEXT_STYLE_INTS + TextStyleInt.SMALL_FONT] = small
		styleInts[id * TEXT_STYLE_INTS + TextStyleInt.CAPS] = styles.caps[id] ?? 0
		styleFloats[id * TEXT_STYLE_FLOATS + TextStyleFloat.LETTER_SPACING] = styles.letterSpacing[id] ?? 0
		styleFloats[id * TEXT_STYLE_FLOATS + TextStyleFloat.SCALE_X] = styles.scaleX[id] ?? 1
		styleFloats[id * TEXT_STYLE_FLOATS + TextStyleFloat.EM] = styles.em[id] ?? 0
		styleFloats[id * TEXT_STYLE_FLOATS + TextStyleFloat.ASCENT] = styles.ascent[id] ?? 0
		styleFloats[id * TEXT_STYLE_FLOATS + TextStyleFloat.DESCENT] = styles.descent[id] ?? 0
		fontCount = Math.max(fontCount, font + 1, small + 1)
	}

	const fonts: string[] = []

	for (let key = 0; key < fontCount; key++) fonts.push(styles.cache.css(key))

	return {
		lineCount: page.lineCount,
		fragmentCount: page.fragmentCount,
		decorationCount: page.decorationCount,
		lineFloats: page.lineFloats.slice(),
		lineInts: page.lineInts.slice(),
		fragmentFloats: page.fragmentFloats.slice(),
		fragmentInts: page.fragmentInts.slice(),
		decorationFloats: page.decorationFloats.slice(),
		decorationInts: page.decorationInts.slice(),
		styleCount: count,
		styleInts,
		styleFloats,
		fonts,
		texts: page.sourceTexts,
		prefixes: result.prefixes.slice(),
		runStarts: result.runStarts.slice(),
		runEnds: result.runEnds.slice(),
		kerning: Uint8Array.from(fonts, (_, key) => (styles.cache.kerning(key) ? 1 : 0))
	}
}

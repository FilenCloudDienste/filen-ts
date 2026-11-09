import { drawingSlotOf } from "../fonts/drawingSlots"
import {
	DECORATION_FLOATS,
	DECORATION_INTS,
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FRAGMENT_LEVEL_SHIFT,
	FragmentFlag,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS,
	TextLayout,
	type DecorationKind
} from "./displayList"
import { nextCluster } from "./layout"
import type { MeasureCache } from "./measure"

// East Asian characters standing upright in text that runs sideways (vertical DrawingML text, a table cell's tbRlV
// and tbLrV text direction): what measures them is the style table's font keys and width cache.
export interface UprightMeasure {
	readonly fontKey: ArrayLike<number>
	readonly cache: MeasureCache
}

// East Asian brackets, the long vowel mark and the wave dash whose vertical forms are the horizontal glyph turned
// (Unicode UAX #50 Vertical_Orientation Tr): drawn sideways with the line, they show exactly that form.
const TURNED: readonly (readonly [number, number])[] = [
	[0x3008, 0x3011],
	[0x3014, 0x301f],
	[0x3030, 0x3030],
	[0x30a0, 0x30a0],
	[0x30fc, 0x30fc],
	[0xff08, 0xff09],
	[0xff3b, 0xff3b],
	[0xff3d, 0xff3d],
	[0xff5b, 0xff5b],
	[0xff5d, 0xff60]
]

// Every East Asian range of the slot table starts at or above U+1100; a surrogate pair stands for a supplementary
// ideograph, which codePointAt reads whole.
export function isUpright(text: string, at: number): boolean {
	const code = text.codePointAt(at) ?? 0

	if (code < 0x1100 || drawingSlotOf(code, false) !== "ea") return false

	for (const [first, last] of TURNED) if (code >= first && code <= last) return false

	return true
}

export function anyUpright(text: string, start: number, end: number): boolean {
	for (let at = start; at < end; at++) if (text.charCodeAt(at) >= 0x1100 && isUpright(text, at)) return true

	return false
}

// The East Asian clusters of every text fragment become fragments of their own flagged UPRIGHT, placed by their
// measured advance within the fragment's laid-out span (so justification is kept). Returns `out` itself when the
// text has none.
export function splitUpright(out: TextLayout, texts: readonly string[], measure: UprightMeasure): TextLayout {
	if (!texts.some(text => anyUpright(text, 0, text.length))) return out

	const cache = measure.cache
	const fontKeys = measure.fontKey
	const split = new TextLayout()
	// Runs of sideways clusters and single upright clusters of one fragment: start, end, upright, advance.
	const pieces: number[] = []

	for (let line = 0; line < out.lineCount; line++) {
		const lf = line * LINE_FLOATS
		const li = line * LINE_INTS
		const source = out.lineInts[li + 5] ?? 0
		const text = texts[source] ?? ""
		const first = out.lineInts[li] ?? 0
		const count = out.lineInts[li + 1] ?? 0

		split.addLine(
			out.lineFloats[lf] ?? 0,
			out.lineFloats[lf + 1] ?? 0,
			out.lineFloats[lf + 2] ?? 0,
			out.lineFloats[lf + 3] ?? 0,
			out.lineFloats[lf + 4] ?? 0,
			out.lineInts[li + 2] ?? 0,
			out.lineInts[li + 3] ?? 0,
			out.lineInts[li + 4] ?? 0,
			source
		)

		for (let k = first; k < first + count; k++) {
			const ff = k * FRAGMENT_FLOATS
			const fi = k * FRAGMENT_INTS
			const x = out.fragmentFloats[ff] ?? 0
			const width = out.fragmentFloats[ff + 1] ?? 0
			const wordSpacing = out.fragmentFloats[ff + 2] ?? 0
			const letterSpacing = out.fragmentFloats[ff + 3] ?? 0
			const start = out.fragmentInts[fi] ?? 0
			const end = out.fragmentInts[fi + 1] ?? 0
			const style = out.fragmentInts[fi + 2] ?? 0
			const info = out.fragmentInts[fi + 3] ?? 0
			const aux = out.fragmentInts[fi + 4] ?? 0
			const rtl = ((info >> FRAGMENT_LEVEL_SHIFT) & 1) === 1

			// Tabs, objects and right-to-left runs (no East Asian script is one) stay whole.
			if ((info & FRAGMENT_KIND_MASK) !== FragmentKind.TEXT || rtl || !anyUpright(text, start, end)) {
				split.addFragment(x, width, wordSpacing, letterSpacing, start, end, style, info, aux)
				continue
			}

			pieces.length = 0

			for (let at = start; at < end;) {
				const next = nextCluster(text, at, end)
				const upright = isUpright(text, at)
				const last = pieces.length - 4

				if (!upright && last >= 0 && pieces[last + 2] === 0) pieces[last + 1] = next
				else pieces.push(at, next, upright ? 1 : 0, 0)

				at = next
			}

			const fontKey = fontKeys[style] ?? 0
			let total = 0

			for (let p = 0; p < pieces.length; p += 4) {
				const advance = cache.width(fontKey, text, pieces[p] ?? 0, pieces[p + 1] ?? 0)

				pieces[p + 3] = advance
				total += advance
			}

			const ratio = total > 0 ? width / total : 0
			let offset = x

			for (let p = 0; p < pieces.length; p += 4) {
				const piece = (pieces[p + 3] ?? 0) * ratio
				const upright = pieces[p + 2] === 1
				const flags = (upright ? info | FragmentFlag.UPRIGHT : info) & (p + 4 < pieces.length ? ~FragmentFlag.HYPHEN : ~0)

				split.addFragment(
					offset,
					piece,
					upright ? 0 : wordSpacing,
					letterSpacing,
					pieces[p] ?? 0,
					pieces[p + 1] ?? 0,
					style,
					flags,
					aux
				)
				offset += piece
			}
		}

		const firstDecoration = out.lineInts[li + 6] ?? 0
		const endDecoration = line + 1 < out.lineCount ? (out.lineInts[(line + 1) * LINE_INTS + 6] ?? 0) : out.decorationCount

		for (let d = firstDecoration; d < endDecoration; d++) {
			const df = d * DECORATION_FLOATS
			const di = d * DECORATION_INTS

			split.addDecoration(
				(out.decorationInts[di] ?? 0) as DecorationKind,
				out.decorationInts[di + 1] ?? 0,
				out.decorationFloats[df] ?? 0,
				out.decorationFloats[df + 1] ?? 0,
				out.decorationFloats[df + 2] ?? 0,
				out.decorationFloats[df + 3] ?? 0
			)
		}
	}

	return split
}

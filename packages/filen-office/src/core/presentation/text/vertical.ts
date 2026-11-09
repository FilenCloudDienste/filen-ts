import {
	DECORATION_FLOATS,
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS,
	LineFlag,
	TextLayout,
	nextCluster,
	splitUpright as splitUprightClusters
} from "../../text/index"
import type { TextPage } from "../output"
import type { BodySession } from "./body"
import { pageOf } from "./page"

// Vertical DrawingML text (a:bodyPr@vert, ECMA-376 §20.1.10.83 ST_TextVerticalType). core/text has no vertical
// writing mode, so both kinds below are built from the horizontal layout of the same body and measurer.
//
// - eaVert and mongolianVert: "some fonts are displayed as if rotated by 90 degrees while some fonts (mostly East
//   Asian) are displayed vertical". The body is laid out in the turned box as vert is (lines wrap across the box's
//   height and run top to bottom), and its East Asian characters (the ea font slot, by script) become one fragment
//   per cluster flagged UPRIGHT, which the painters turn back upright in their cell. eaVert lines follow each other
//   right to left, as vert's do; mongolianVert's run "top down then LEFT RIGHT", so its lines are mirrored across
//   the turned page.
// - wordArtVert and wordArtVertRtl: "one letter on top of another". Each line of the horizontal layout (laid out
//   across the column's length) becomes a column, its characters drawn upright one under the other, each advancing
//   by its em; wordArtVert columns run from the left edge rightwards, wordArtVertRtl ones from the right edge
//   leftwards. Every character is its own line on the page (the painters place a line's fragments on one baseline),
//   so selection and find still map to the paragraph text.

// How a body's page is turned onto its box: vert, eaVert and mongolianVert lines run top to bottom (90°), vert270
// bottom to top; horizontal and stacked WordArt text is not turned.
export function turnOf(vertical: string): 0 | 90 | 270 {
	if (vertical === "vert" || vertical === "eaVert" || vertical === "mongolianVert") return 90
	if (vertical === "vert270") return 270

	return 0
}

export function stackUpright(
	out: TextLayout,
	texts: readonly string[],
	session: BodySession,
	// The horizontal layout's width (the column length, the box's height) and height (the box's width).
	length: number,
	across: number,
	leftToRight: boolean
): TextPage {
	const styles = session.styles
	const cache = session.env.cache
	const stacked = new TextLayout()

	for (let line = 0; line < out.lineCount; line++) {
		const lf = line * LINE_FLOATS
		const li = line * LINE_INTS
		const top = out.lineFloats[lf] ?? 0
		const height = out.lineFloats[lf + 1] ?? 0
		const flags = out.lineInts[li + 4] ?? 0
		const source = out.lineInts[li + 5] ?? 0
		const text = texts[source] ?? ""
		const columnX = leftToRight ? top : across - top - height
		const center = columnX + height / 2
		const first = out.lineInts[li] ?? 0
		const count = out.lineInts[li + 1] ?? 0
		let y = out.lineFloats[lf + 3] ?? 0

		for (let k = first; k < first + count; k++) {
			const fi = k * FRAGMENT_INTS
			const start = out.fragmentInts[fi] ?? 0
			const end = out.fragmentInts[fi + 1] ?? 0
			const style = out.fragmentInts[fi + 2] ?? 0
			const info = out.fragmentInts[fi + 3] ?? 0

			if ((info & FRAGMENT_KIND_MASK) !== FragmentKind.TEXT) {
				y += out.fragmentFloats[k * FRAGMENT_FLOATS + 1] ?? 0
				continue
			}

			const em = styles.em[style] ?? 0
			const ascent = styles.ascent[style] ?? 0
			const fontKey = styles.fontKey[style] ?? 0

			for (let at = start; at < end;) {
				const next = nextCluster(text, at, end)
				const width = cache.width(fontKey, text, at, next)
				const last = next >= end && k === first + count - 1
				const x = center - width / 2

				stacked.addLine(y, em, y + ascent, x, width, at, next, last ? flags : flags & ~LineFlag.LAST, source)
				stacked.addFragment(x, width, 0, 0, at, next, style, info, 0)
				y += em
				at = next
			}
		}
	}

	return pageOf(stacked.compact(), texts, session, across, length)
}

// eaVert and mongolianVert: the East Asian clusters of every text fragment become fragments of their own flagged
// UPRIGHT (core/text/upright.ts). Returns `out` itself when the body has none.
export function splitUpright(out: TextLayout, texts: readonly string[], session: BodySession): TextLayout {
	return splitUprightClusters(out, texts, { fontKey: session.styles.fontKey, cache: session.env.cache })
}

// mongolianVert: every line moved to its mirror place across the turned page's height (its decorations with it),
// so the first line ends up at the bottom, which is the left edge once the page is turned.
export function mirrorLines(out: TextLayout, height: number): void {
	for (let line = 0; line < out.lineCount; line++) {
		const lf = line * LINE_FLOATS
		const top = out.lineFloats[lf] ?? 0
		const dy = height - (out.lineFloats[lf + 1] ?? 0) - 2 * top

		out.lineFloats[lf] = top + dy
		out.lineFloats[lf + 2] = (out.lineFloats[lf + 2] ?? 0) + dy

		const firstDecoration = out.lineInts[line * LINE_INTS + 6] ?? 0
		const endDecoration = line + 1 < out.lineCount ? (out.lineInts[(line + 1) * LINE_INTS + 6] ?? 0) : out.decorationCount

		for (let d = firstDecoration; d < endDecoration; d++) {
			const at = d * DECORATION_FLOATS + 1

			out.decorationFloats[at] = (out.decorationFloats[at] ?? 0) + dy
		}
	}
}

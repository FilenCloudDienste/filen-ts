// The lines of a multi-line border (ST_Border, ECMA-376 Part 1 §17.18.2) across its drawn width (borderWidth):
// alternating line and gap shares summing to 1, in order from the top (horizontal) or left (vertical) edge,
// whichever side of a box the border is on, as Word draws them. Undefined for styles a single stroke (or CSS
// double) draws. Word does not publish the shares: thin and thick lines keep a fixed proportion per gap size.
const THIN_THICK_SMALL_GAP: readonly number[] = [0.25, 0.125, 0.625]
const THIN_THICK_MEDIUM_GAP: readonly number[] = [0.25, 0.25, 0.5]
const THIN_THICK_LARGE_GAP: readonly number[] = [0.2, 0.5, 0.3]
const THICK_THIN_SMALL_GAP: readonly number[] = [0.625, 0.125, 0.25]
const THICK_THIN_MEDIUM_GAP: readonly number[] = [0.5, 0.25, 0.25]
const THICK_THIN_LARGE_GAP: readonly number[] = [0.3, 0.5, 0.2]
const TRIPLE: readonly number[] = [0.2, 0.2, 0.2, 0.2, 0.2]

export function borderLines(style: string): readonly number[] | undefined {
	switch (style) {
		case "triple":
			return TRIPLE
		case "thinThickSmallGap":
			return THIN_THICK_SMALL_GAP
		case "thickThinSmallGap":
			return THICK_THIN_SMALL_GAP
		case "thinThickMediumGap":
			return THIN_THICK_MEDIUM_GAP
		case "thickThinMediumGap":
			return THICK_THIN_MEDIUM_GAP
		case "thinThickLargeGap":
			return THIN_THICK_LARGE_GAP
		case "thickThinLargeGap":
			return THICK_THIN_LARGE_GAP
		default:
			return undefined
	}
}

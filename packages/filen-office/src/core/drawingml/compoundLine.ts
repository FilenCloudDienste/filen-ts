import type { Stroke } from "./displayList"

// ST_CompoundLine (ECMA-376 Part 1 §20.1.10.15) as the lines a stroke draws across its width: [from, to] fractions
// of the width, 0 at the edge outside the path and 1 at the edge inside it. The gaps between bands are unpainted.
export type CompoundBand = readonly [number, number]

const SINGLE: readonly CompoundBand[] = [[0, 1]]
const DOUBLE: readonly CompoundBand[] = [
	[0, 1 / 3],
	[2 / 3, 1]
]
const THICK_THIN: readonly CompoundBand[] = [
	[0, 0.5],
	[0.75, 1]
]
const THIN_THICK: readonly CompoundBand[] = [
	[0, 0.25],
	[0.5, 1]
]
// Thin, thick, thin.
const TRIPLE: readonly CompoundBand[] = [
	[0, 1 / 6],
	[1 / 3, 2 / 3],
	[5 / 6, 1]
]

export function compoundBands(compound: Stroke["compound"]): readonly CompoundBand[] {
	switch (compound) {
		case "dbl":
			return DOUBLE
		case "thickThin":
			return THICK_THIN
		case "thinThick":
			return THIN_THICK
		case "tri":
			return TRIPLE
		default:
			return SINGLE
	}
}

// A band as distances from the path on one side: [far, near], far > near >= 0.
export type BandRadii = readonly [number, number]

export interface CompoundRadii {
	// The pen width that covers every band, centred on the path: the line width, or twice it for an inset pen.
	readonly pen: number
	// Bands outside and inside the path, each sorted far to near.
	readonly outer: readonly BandRadii[]
	readonly inner: readonly BandRadii[]
	// Both sides alike, so a painter needs no inside/outside split.
	readonly symmetric: boolean
}

// The bands of a `width` line as distances from the path on each side. A centred pen (ln@algn="ctr") straddles
// the path; an inset one (algn="in", ST_PenAlignment) lies wholly inside it, so only closed paths take `inset`.
export function compoundRadii(compound: Stroke["compound"], width: number, inset: boolean): CompoundRadii {
	const centre = inset ? 0 : 0.5
	const outer: BandRadii[] = []
	const inner: BandRadii[] = []

	for (const [from, to] of compoundBands(compound)) {
		const start = (from - centre) * width
		const end = (to - centre) * width

		if (start < 0) outer.push([-start, Math.max(0, -end)])
		if (end > 0) inner.push([end, Math.max(0, start)])
	}

	outer.sort((a, b) => b[0] - a[0])
	inner.sort((a, b) => b[0] - a[0])

	const symmetric =
		outer.length === inner.length &&
		outer.every((band, k) => {
			const other = inner[k]

			return other !== undefined && Math.abs(band[0] - other[0]) < 1e-9 && Math.abs(band[1] - other[1]) < 1e-9
		})

	return { pen: inset ? width * 2 : width, outer, inner, symmetric }
}

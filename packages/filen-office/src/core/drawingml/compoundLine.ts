import { PATH_COMMAND_COORDS, PathCommand, type Stroke } from "./displayList"

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

// One stroke of an outline's mask, centred on the path: it keeps what lies under it, or clears it.
export interface MaskStroke {
	readonly width: number
	readonly keep: boolean
}

// How every painter draws a compound or inset outline: the full pen (dashed as the line is) shown only where the
// mask keeps it. `outer` strokes go down in order over the whole path; `inner`, for bands that differ on the two
// sides, then go down clipped to the path's interior after clearing it.
export interface CompoundMask {
	readonly pen: number
	readonly outer: readonly MaskStroke[]
	readonly inner: readonly MaskStroke[] | null
}

function maskStrokes(side: readonly BandRadii[]): MaskStroke[] {
	const strokes: MaskStroke[] = []

	for (const [far, near] of side) {
		strokes.push({ width: far * 2, keep: true })

		if (near > 0) strokes.push({ width: near * 2, keep: false })
	}

	return strokes
}

// The mask of a `width` line; undefined for one centred single line, which is stroked as is. `inset` only for
// closed paths (see closedCommands).
export function compoundMask(compound: Stroke["compound"], width: number, inset: boolean): CompoundMask | undefined {
	if (!inset && compoundBands(compound).length === 1) return undefined

	const radii = compoundRadii(compound, width, inset)

	return { pen: radii.pen, outer: maskStrokes(radii.outer), inner: radii.symmetric ? null : maskStrokes(radii.inner) }
}

// Whether every subpath of a display-list command range is closed.
export function closedCommands(commands: ArrayLike<number>, first: number, count: number): boolean {
	const end = Math.min(commands.length, first + count)

	if (first < 0 || end <= first || commands[end - 1] !== PathCommand.CLOSE) return false

	for (let k = first + 1; k < end; k++) if (commands[k] === PathCommand.MOVE && commands[k - 1] !== PathCommand.CLOSE) return false

	return true
}

// The bounds [minX, minY, maxX, maxY] of a command range's points and control points (which hold its curves);
// undefined for none.
export function commandBounds(
	commands: ArrayLike<number>,
	coords: ArrayLike<number>,
	first: number,
	count: number,
	firstCoord: number
): [number, number, number, number] | undefined {
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	let at = firstCoord
	const end = Math.min(commands.length, first + count)

	for (let k = Math.max(0, first); k < end && at >= 0; k++) {
		const needed = PATH_COMMAND_COORDS[commands[k] ?? -1] ?? -1

		if (needed < 0 || at + needed > coords.length) break

		for (let c = at; c < at + needed; c += 2) {
			const x = coords[c] ?? 0
			const y = coords[c + 1] ?? 0

			if (!Number.isFinite(x) || !Number.isFinite(y)) continue

			minX = Math.min(minX, x)
			minY = Math.min(minY, y)
			maxX = Math.max(maxX, x)
			maxY = Math.max(maxY, y)
		}

		at += needed
	}

	return minX <= maxX ? [minX, minY, maxX, maxY] : undefined
}

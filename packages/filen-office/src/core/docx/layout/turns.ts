// Text turned sideways in a box of the page: a table cell's w:textDirection (ECMA-376 §17.4.72, ST_TextDirection
// §17.18.93) and a text box's wps:bodyPr@vert (§20.1.10.83). The lines, graphics and objects of a turn are laid out
// upright in the box's own frame: their x runs along the text from the box's left edge (the box's height is the
// line width), their y across it from the box's top (the box's width is the room for lines). A painter draws
// them through turnMatrix(); a page without turns has none of these records, so upright text costs nothing.
//
// turnFloats: x, y, width, height (the box on the page). turnInts: angle (90: text runs top to bottom, the first
// line at the box's right; 270: bottom to top, the first line at its left), then the lines, graphics and objects
// drawn turned as [from, to) ranges.

export const TURN_FLOATS = 4
export const TURN_INTS = 7

export const TurnInt = { ANGLE: 0, LINE_FROM: 1, LINE_TO: 2, GRAPHIC_FROM: 3, GRAPHIC_TO: 4, OBJECT_FROM: 5, OBJECT_TO: 6 } as const

export type TurnAngle = 90 | 270

// [a, b, c, d, e, f]: (x, y) in the turn's frame is drawn at (a x + c y + e, b x + d y + f) on the page (the PDF and
// CSS matrix order).
export type TurnMatrix = readonly [number, number, number, number, number, number]

// How a table cell's text runs (ST_TextDirection, the transitional names and the strict ones): 90 for text read top
// to bottom (tbRl, tbRlV, tbLrV), 270 for bottom to top (btLr), 0 for horizontal text (lrTb, and lrTbV: horizontal
// lines whose East Asian characters lie sideways, which horizontal layout draws upright).
export function textDirectionTurn(value: string | undefined): 0 | TurnAngle {
	switch (value) {
		case "tbRl":
		case "rl":
		case "tbRlV":
		case "rlV":
		case "tbLrV":
		case "lrV":
			return 90
		case "btLr":
		case "lr":
			return 270
		default:
			return 0
	}
}

// Whether East Asian characters stand upright in a top to bottom cell (the "rotated" values, tbRlV and tbLrV: East
// Asian vertical writing) rather than lie sideways with the rest.
export function textDirectionUpright(value: string | undefined): boolean {
	return value === "tbRlV" || value === "rlV" || value === "tbLrV" || value === "lrV"
}

// Whether the lines of a top to bottom cell follow each other left to right (tbLrV) rather than right to left.
export function textDirectionLeftToRight(value: string | undefined): boolean {
	return value === "tbLrV" || value === "lrV"
}

// How a text box's text runs (ST_TextVerticalType): vert, eaVert and mongolianVert top to bottom, vert270 bottom to
// top; stacked WordArt text and horizontal text are not turned.
export function verticalTurn(value: string | undefined): 0 | TurnAngle {
	if (value === "vert" || value === "eaVert" || value === "mongolianVert") return 90
	if (value === "vert270") return 270

	return 0
}

export function turnMatrix(angle: number, x: number, y: number, width: number, height: number): TurnMatrix {
	// Turned about the box's corner, then moved back onto the box.
	return angle === 270 ? [0, -1, 1, 0, x - y, y + height + x] : [0, 1, -1, 0, x + width + y, y - x]
}

export function turnMatrixAt(floats: ArrayLike<number>, ints: ArrayLike<number>, turn: number): TurnMatrix {
	const f = turn * TURN_FLOATS

	return turnMatrix(ints[turn * TURN_INTS] ?? 90, floats[f] ?? 0, floats[f + 1] ?? 0, floats[f + 2] ?? 0, floats[f + 3] ?? 0)
}

// A point of the turn's frame on the page.
export function turnX(m: TurnMatrix, x: number, y: number): number {
	return m[0] * x + m[2] * y + m[4]
}

export function turnY(m: TurnMatrix, x: number, y: number): number {
	return m[1] * x + m[3] * y + m[5]
}

// A page point in the turn's frame (the matrix is a quarter turn: its inverse is its transpose).
export function unturnX(m: TurnMatrix, x: number, y: number): number {
	return m[0] * (x - m[4]) + m[1] * (y - m[5])
}

export function unturnY(m: TurnMatrix, x: number, y: number): number {
	return m[2] * (x - m[4]) + m[3] * (y - m[5])
}

export interface TurnedRect {
	x: number
	y: number
	width: number
	height: number
}

// A box of the turn's frame as the box it covers on the page (written into `out`).
export function turnRect(m: TurnMatrix, x: number, y: number, width: number, height: number, out: TurnedRect): TurnedRect {
	const x0 = turnX(m, x, y)
	const y0 = turnY(m, x, y)
	const x1 = turnX(m, x + width, y + height)
	const y1 = turnY(m, x + width, y + height)

	out.x = Math.min(x0, x1)
	out.y = Math.min(y0, y1)
	out.width = Math.abs(x1 - x0)
	out.height = Math.abs(y1 - y0)

	return out
}

// The turn each of `count` items is drawn through, -1 for none: items [from, to) of each turn, the ranges at
// `fromInt` and `fromInt + 1` of its ints. Undefined when the page has no turns.
export function turnsOf(
	turnCount: number,
	turnInts: ArrayLike<number> | undefined,
	count: number,
	fromInt: number
): Int32Array | undefined {
	if (turnCount <= 0 || turnInts === undefined) return undefined

	const out = new Int32Array(count).fill(-1)

	for (let t = 0; t < turnCount; t++) {
		const to = Math.min(count, turnInts[t * TURN_INTS + fromInt + 1] ?? 0)

		for (let k = Math.max(0, turnInts[t * TURN_INTS + fromInt] ?? 0); k < to; k++) out[k] = t
	}

	return out
}

// Per object of a page's object list (its `placed` objects, then the inline objects of lines `inlineLines`), the turn
// it is drawn through, -1 for none; undefined when the page has no turns.
export function objectTurnsOf(
	turnCount: number,
	turnInts: ArrayLike<number>,
	lineCount: number,
	placed: number,
	inlineLines: readonly number[]
): Int32Array | undefined {
	const lines = turnsOf(turnCount, turnInts, lineCount, TurnInt.LINE_FROM)
	const objects = turnsOf(turnCount, turnInts, placed, TurnInt.OBJECT_FROM)

	if (lines === undefined || objects === undefined) return undefined

	const out = new Int32Array(placed + inlineLines.length)

	out.set(objects)

	for (let k = 0; k < inlineLines.length; k++) out[placed + k] = lines[inlineLines[k] ?? -1] ?? -1

	return out
}

// The CSS transform placing an element whose box starts at (x, y) of the page through matrix `m`, about the
// element's top left corner (transform-origin 0 0).
export function turnTransform(m: TurnMatrix, x: number, y: number): string {
	const round = (value: number): number => Math.round(value * 100) / 100

	return `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${round(turnX(m, x, y) - x)},${round(turnY(m, x, y) - y)})`
}

// turnTransform() as declarations to add to an element's style.
export function turnCss(m: TurnMatrix, x: number, y: number): string {
	return `transform:${turnTransform(m, x, y)};transform-origin:0 0;`
}

import { describe, expect, it } from "vitest"
import { bottomEdge, endEdge, heavier, startEdge, topEdge } from "../core/docx/layout/table"
import type { ResolvedBorder, ResolvedCellBorders, ResolvedTableBorders } from "../core/docx/props/types"

// Word's rule for two borders meeting on one edge (MS-OI29500 notes on ISO/IEC 29500-1 §17.4.66): a "nil" hides
// both, then the heavier wins (width in eighths of a point times the style's border number, dotted and dashed
// weighing 1), then the style earlier in the precedence list, then the darker colour on three brightness tests
// (R + B + 2G, B + 2G, G), and a full tie shows the first in reading order.

function border(style: string, size: number, color?: string): ResolvedBorder {
	return { style, size, space: 0, color, shadow: false, frame: false }
}

function cell(sides: Partial<ResolvedTableBorders> = {}): ResolvedCellBorders {
	return {
		top: sides.top,
		start: sides.start,
		bottom: sides.bottom,
		end: sides.end,
		insideH: sides.insideH,
		insideV: sides.insideV,
		tl2br: undefined,
		tr2bl: undefined
	}
}

// The border numbers from the MS-OI29500 note, in precedence order (dotted and dashed, which weigh 1, sit between
// double and dotDash in the precedence list).
const NUMBERED: readonly (readonly [string, number])[] = [
	["single", 1],
	["thick", 2],
	["double", 3],
	["dotDash", 8],
	["dotDotDash", 9],
	["triple", 10],
	["thinThickSmallGap", 11],
	["thickThinSmallGap", 12],
	["thinThickThinSmallGap", 13],
	["thinThickMediumGap", 14],
	["thickThinMediumGap", 15],
	["thinThickThinMediumGap", 16],
	["thinThickLargeGap", 17],
	["thickThinLargeGap", 18],
	["thinThickThinLargeGap", 19],
	["wave", 20],
	["doubleWave", 21],
	["dashSmallGap", 22],
	["dashDotStroked", 23],
	["threeDEmboss", 24],
	["threeDEngrave", 25],
	["outset", 26],
	["inset", 27]
]

// Both orders: the winner does not depend on which side comes first unless the two tie.
function wins(winner: ResolvedBorder, loser: ResolvedBorder): void {
	expect(heavier(winner, loser)).toBe(winner)
	expect(heavier(loser, winner)).toBe(winner)
}

describe("heavier", () => {
	it("hides both borders when either is nil", () => {
		const single = border("single", 24)

		expect(heavier(border("nil", 0), single)).toBeUndefined()
		expect(heavier(single, border("nil", 0))).toBeUndefined()
		expect(heavier(border("nil", 0), undefined)).toBeUndefined()
		expect(heavier(undefined, border("nil", 0))).toBeUndefined()
	})

	it("takes the other border when one side has none", () => {
		const single = border("single", 4)

		expect(heavier(undefined, single)).toBe(single)
		expect(heavier(single, undefined)).toBe(single)
		expect(heavier(undefined, undefined)).toBeUndefined()
	})

	it("lets the wider of two single borders win", () => {
		wins(border("single", 8), border("single", 4))
	})

	it("weighs width times the border number", () => {
		// double: 4 * 3 = 12 over single: 8 * 1 = 8.
		wins(border("double", 4), border("single", 8))
		// thick: 6 * 2 = 12 over single: 10 * 1 = 10.
		wins(border("thick", 6), border("single", 10))
		// triple: 2 * 10 = 20 over double: 6 * 3 = 18.
		wins(border("triple", 2), border("double", 6))
		// dotDash: 2 * 8 = 16 over single: 12.
		wins(border("dotDash", 2), border("single", 12))
		// inset: 1 * 27 = 27 over outset: 1 * 26 = 26.
		wins(border("inset", 1), border("outset", 1))
		// thinThickThinLargeGap: 1 * 19 over thickThinLargeGap: 1 * 18.
		wins(border("thinThickThinLargeGap", 1), border("thickThinLargeGap", 1))
	})

	it.each(NUMBERED.filter(([, number]) => number > 1))("gives %s border number %i", (style, number) => {
		// Width 1 weighs the number: it beats a single border one lighter and ties a single border of the same weight,
		// which single takes on precedence.
		wins(border(style, 1), border("single", number - 1))
		wins(border("single", number), border(style, 1))
	})

	it.each(NUMBERED.slice(1).map(([style, number], at) => [NUMBERED[at]?.[0] ?? "", style, NUMBERED[at]?.[1] ?? 0, number] as const))(
		"puts %s before %s in precedence",
		(earlier, later, earlierNumber, laterNumber) => {
			// Each at the other's number: equal weight, so precedence decides.
			wins(border(earlier, laterNumber), border(later, earlierNumber))
		}
	)

	it("weighs dotted and dashed borders 1 whatever their width", () => {
		// single: 2 over dotted or dashed at any width.
		wins(border("single", 2), border("dotted", 48))
		wins(border("single", 2), border("dashed", 48))
		// Weight 1 against single 1: equal, single is first in precedence.
		wins(border("single", 1), border("dotted", 48))
		wins(border("single", 1), border("dashed", 48))
		// Two weight-1 borders: dotted precedes dashed whatever their widths.
		wins(border("dotted", 2), border("dashed", 48))
	})

	it("resolves equal weight by the precedence list", () => {
		// 8 each: single 8, thick 4, dotDash 1.
		wins(border("single", 8), border("thick", 4))
		wins(border("thick", 4), border("dotDash", 1))
		wins(border("single", 8), border("dotDash", 1))
		// 120 each: triple 12 and wave 6.
		wins(border("triple", 12), border("wave", 6))
		// 22 each: thinThickSmallGap 2 and dashSmallGap 1.
		wins(border("thinThickSmallGap", 2), border("dashSmallGap", 1))
	})

	it("resolves equal weight and style by the darker colour on each brightness test", () => {
		// First test, R + B + 2G: red 255 over green 510.
		wins(border("single", 4, "FF0000"), border("single", 4, "00FF00"))
		// Red and blue tie on the first test (255); the second, B + 2G: red 0 over blue 255.
		wins(border("single", 4, "FF0000"), border("single", 4, "0000FF"))
		// 000002 and 000100 tie on the first two tests (2 each); the third, G: 0 over 1.
		wins(border("single", 4, "000002"), border("single", 4, "000100"))
	})

	it("counts the automatic colour as black", () => {
		wins(border("single", 4), border("single", 4, "000001"))

		const automatic = border("single", 4)
		const black = border("single", 4, "000000")

		expect(heavier(automatic, black)).toBe(automatic)
		expect(heavier(black, automatic)).toBe(black)
	})

	it("gives a style off the list border number 1 and the last place in precedence", () => {
		// Weight 4 * 1 = 4 over single 2.
		wins(border("apples", 4), border("single", 2))
		// Weight 8 each: single precedes the unknown style.
		wins(border("single", 8), border("apples", 8))
		// inset is the last listed style and still precedes an unknown one: 1 * 27 against 27 * 1.
		wins(border("inset", 1), border("apples", 27))
	})

	it("shows the first border in reading order on a full tie", () => {
		const a = border("double", 6, "336699")
		const b = border("double", 6, "336699")

		expect(heavier(a, b)).toBe(a)
		expect(heavier(b, a)).toBe(b)
	})
})

describe("table cell edges", () => {
	const top = border("single", 4, "000001")
	const bottom = border("single", 4, "000002")
	const start = border("single", 4, "000003")
	const end = border("single", 4, "000004")
	const insideH = border("single", 4, "000005")
	const insideV = border("single", 4, "000006")
	const table = cell({ top, start, bottom, end, insideH, insideV })
	const own = border("double", 4)

	it("draws the table's top above the first row and the inside border above the others", () => {
		expect(topEdge(cell(), table, true)).toBe(top)
		expect(topEdge(cell(), table, false)).toBe(insideH)
		expect(topEdge(cell({ top: own }), table, true)).toBe(own)
		expect(topEdge(cell({ top: own }), table, false)).toBe(own)
		// No inside border: the table's top (a row first on its page).
		expect(topEdge(cell(), cell({ top }), false)).toBe(top)
	})

	it("draws the table's bottom below the last row and the inside border below the others", () => {
		expect(bottomEdge(cell(), table, true, undefined)).toBe(bottom)
		expect(bottomEdge(cell(), table, false, undefined)).toBe(insideH)
		expect(bottomEdge(cell({ bottom: own }), table, true, undefined)).toBe(own)
		expect(bottomEdge(cell(), cell({ bottom }), false, undefined)).toBeUndefined()
	})

	it("resolves a bottom edge against the top of the cell below it", () => {
		const heavy = border("single", 24)

		expect(bottomEdge(cell(), table, false, cell({ top: heavy }))).toBe(heavy)
		expect(bottomEdge(cell({ bottom: heavy }), table, false, cell({ top: own }))).toBe(heavy)
		expect(bottomEdge(cell(), table, false, cell())).toBe(insideH)
		expect(bottomEdge(cell({ bottom: heavy }), table, false, cell({ top: border("nil", 0) }))).toBeUndefined()

		// A tie keeps the upper cell's border (first in reading order).
		const below = border("single", 4, "000005")

		expect(bottomEdge(cell(), table, false, cell({ top: below }))).toBe(insideH)
	})

	it("draws a row's first cell with the table's start and the others against the cell before them", () => {
		expect(startEdge(cell(), table, undefined, true)).toBe(start)
		expect(startEdge(cell({ start: own }), table, undefined, true)).toBe(own)
		expect(startEdge(cell(), table, undefined, false)).toBe(insideV)
		expect(startEdge(cell(), table, cell(), false)).toBe(insideV)

		const heavy = border("single", 24)

		expect(startEdge(cell(), table, cell({ end: heavy }), false)).toBe(heavy)
		expect(startEdge(cell({ start: heavy }), table, cell({ end: own }), false)).toBe(heavy)
		expect(startEdge(cell({ start: own }), table, cell({ end: border("nil", 0) }), false)).toBeUndefined()
		expect(startEdge(cell(), cell(), cell(), false)).toBeUndefined()
		// The cell before has no end: its side falls back to the inside border, which outweighs a dotted start.
		expect(startEdge(cell({ start: border("dotted", 4) }), table, cell(), false)).toBe(insideV)
	})

	it("keeps this cell's start on a full tie with the end of the cell before it", () => {
		// This cell is the later one in reading order; heavier() gets its start as `a`, so the later border wins the
		// tie (unlike bottomEdge, which keeps the upper cell's).
		const mine = border("single", 4, "336699")
		const before = border("single", 4, "336699")

		expect(startEdge(cell({ start: mine }), table, cell({ end: before }), false)).toBe(mine)
	})

	it("draws a row's last cell with its own end or the table's", () => {
		expect(endEdge(cell(), table)).toBe(end)
		expect(endEdge(cell({ end: own }), table)).toBe(own)
		expect(endEdge(cell(), cell())).toBeUndefined()
	})
})

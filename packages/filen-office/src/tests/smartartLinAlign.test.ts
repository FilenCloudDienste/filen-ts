import { describe, expect, it } from "vitest"
import { MM, boxes, data, layout, round, run } from "./smartartFixtures"

// The linear algorithm's alignment of the whole line in its box (horzAlign for rows, vertAlign for columns) is
// where the line sits, whichever end it starts from: a column from the bottom aligned to the bottom rests on the
// box's bottom edge, its first node lowest; aligned to the top it hangs from the top edge.

const THREE = data([
	{ id: "a", text: "A" },
	{ id: "b", text: "B" },
	{ id: "c", text: "C" }
])

function line(dir: string, align: string, nested: boolean): string {
	const alignParam = dir === "fromT" || dir === "fromB" ? "vertAlign" : "horzAlign"
	const item = nested
		? '<dgm:layoutNode name="cell"><dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="mark" val="20"/><dgm:constr type="h" for="ch" forName="mark" val="10"/></dgm:constrLst><dgm:layoutNode name="mark"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:layoutNode>'
		: '<dgm:layoutNode name="mark"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>'
	const sizes = nested
		? '<dgm:constr type="w" for="ch" forName="cell" val="20"/><dgm:constr type="h" for="ch" forName="cell" val="10"/>'
		: '<dgm:constr type="w" for="ch" forName="mark" val="20"/><dgm:constr type="h" for="ch" forName="mark" val="10"/>'

	return layout(
		`<dgm:alg type="lin"><dgm:param type="linDir" val="${dir}"/><dgm:param type="${alignParam}" val="${align}"/></dgm:alg>` +
			`<dgm:constrLst>${sizes}</dgm:constrLst><dgm:forEach axis="ch" ptType="node">${item}</dgm:forEach>`
	)
}

// The marks' starts along the line, in data order (millimetres).
function starts(dir: string, align: string, nested: boolean): number[] {
	const vertical = dir === "fromT" || dir === "fromB"

	return boxes(run(THREE, line(dir, align, nested), 100 * MM, 100 * MM), "mark").map(box =>
		Math.round((vertical ? round(box).y : round(box).x) / MM)
	)
}

describe("SmartArt line alignment", () => {
	for (const nested of [false, true]) {
		const kind = nested ? "a line of lines" : "a line of shapes"

		it(`rests ${kind} from the bottom on the bottom edge when aligned to the bottom, first node lowest`, () => {
			expect(starts("fromB", "b", nested)).toEqual([90, 80, 70])
		})

		it(`hangs ${kind} from the bottom from the top edge when aligned to the top`, () => {
			expect(starts("fromB", "t", nested)).toEqual([20, 10, 0])
		})

		it(`centres ${kind} from the bottom by default`, () => {
			expect(starts("fromB", "mid", nested)).toEqual([55, 45, 35])
		})

		it(`puts ${kind} from the right against the right edge when aligned right, against the left when aligned left`, () => {
			expect(starts("fromR", "r", nested)).toEqual([80, 60, 40])
			expect(starts("fromR", "l", nested)).toEqual([40, 20, 0])
		})

		it(`keeps ${kind} from the top or left where its alignment puts it`, () => {
			expect(starts("fromT", "b", nested)).toEqual([70, 80, 90])
			expect(starts("fromL", "r", nested)).toEqual([40, 60, 80])
		})
	}
})

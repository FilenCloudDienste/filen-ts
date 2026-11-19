import { describe, expect, it } from "vitest"
import type { AxisEdit } from "../core/sheet/model/edits"
import { shiftFormula } from "../core/sheet/refs/formulaRefs"
import { quickShift } from "../core/xlsx/refs/quick"
import { rng } from "./mulberry32"

// The quick scan that moves plain formulas for an inserted or deleted run gives the formula parser's text, or
// leaves the formula to it.

const COLS = ["A", "B", "C", "Z", "AA", "XFD", "xfe", "b", "TAX"]
const TOKENS = [
	"SUM(",
	"LOG10(",
	"1E5",
	"2.5E-3",
	"_x1",
	"a.b1",
	"TRUE",
	"R1C1",
	"1:3",
	"A:C",
	"'S'!A1",
	'"A1"',
	"#REF!",
	"{1,2}",
	"-",
	"+",
	"*",
	"&",
	",",
	")",
	" "
]

function formula(random: () => number): string {
	const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
	const ref = (): string =>
		`${random() < 0.3 ? "$" : ""}${pick(COLS)}${random() < 0.3 ? "$" : ""}${String(1 + Math.floor(random() * (random() < 0.1 ? 1_048_600 : 120)))}`
	let text = ""

	for (let i = 0, n = 1 + Math.floor(random() * 6); i < n; i++) {
		const r = random()

		text += r < 0.5 ? ref() : r < 0.7 ? `${ref()}:${ref()}` : pick(TOKENS)

		if (random() < 0.6) text += pick(["+", "*", ",", "-", "&"])
	}

	return text
}

describe("quick formula moves", () => {
	it("match the parser's moves wherever they take a formula", () => {
		const random = rng(7)
		let quick = 0

		for (let i = 0; i < 40_000; i++) {
			const text = formula(random)
			const edit: AxisEdit = {
				type: random() < 0.5 ? "insert" : "delete",
				axis: random() < 0.6 ? "rows" : "cols",
				at: Math.floor(random() * 100),
				count: 1 + Math.floor(random() * 5)
			}
			const fast = quickShift(text, edit)

			if (fast === null) continue

			quick++
			expect(fast, `${text} ${JSON.stringify(edit)}`).toBe(shiftFormula(text, "S", "S", edit).formula)
		}

		expect(quick).toBeGreaterThan(5_000)
		expect(quickShift("B51*D51", { type: "insert", axis: "rows", at: 49, count: 1 })).toBe("B52*D52")
		expect(quickShift("SUM(A1:A3)*2", { type: "delete", axis: "rows", at: 0, count: 3 })).toBe("SUM(#REF!)*2")
	})

	it("read a run of name characters beside a non-ASCII one as the parser does", () => {
		const edits: AxisEdit[] = [
			{ type: "delete", axis: "rows", at: 0, count: 1 },
			{ type: "insert", axis: "rows", at: 0, count: 1 },
			{ type: "insert", axis: "cols", at: 0, count: 1 }
		]

		// Latin, Greek and Cyrillic whole, then a stride over the rest of the code units (surrogates included).
		const codes = [...Array.from({ length: 0x500 - 128 }, (_, i) => 128 + i)]

		for (let code = 0x500; code <= 0xffff; code += 61) codes.push(code)

		for (const code of [...codes, 0xd800, 0xdfff, 0xfeff, 0xffff]) {
			const char = String.fromCharCode(code)

			for (const text of [`${char}A1+1`, `A1${char}+1`, `_xlpm.x${char}e1*2`]) {
				for (const edit of edits) {
					const fast = quickShift(text, edit)

					if (fast !== null) expect(fast, `${text} ${JSON.stringify(edit)}`).toBe(shiftFormula(text, "S", "S", edit).formula)
				}
			}
		}

		expect(quickShift("_xlfn.LET(_xlpm.größe1,5,_xlpm.größe1*2)", edits[0] as AxisEdit) ?? "parser").not.toContain("#REF!")
	})
})

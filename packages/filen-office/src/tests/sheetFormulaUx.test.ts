import { describe, expect, it } from "vitest"
import { ARGUMENT_LABELS, sheetFunction } from "../core/sheet/functions/catalogue"
import {
	acceptSuggestion,
	argumentAt,
	formulaContext,
	functionSuggestions,
	highlightedReferences,
	insertReference,
	pointedReference,
	signatureParts
} from "../core/sheet/functions/formulaEditing"

describe("the formula being typed", () => {
	it("knows the word at the caret, the call and the argument it is in", () => {
		expect(formulaContext("=SU", 3)).toEqual({ word: { start: 1, end: 3, text: "SU" }, call: null, points: false })
		expect(formulaContext("=IF(A1>0,SUM(B1,", 16)).toEqual({ word: null, call: { name: "SUM", open: 12, argument: 1 }, points: true })
		expect(formulaContext("=IF(A1>0,", 9)).toEqual({ word: null, call: { name: "IF", open: 3, argument: 1 }, points: true })
		expect(formulaContext('=IF(A1="a,b",', 13)?.call).toEqual({ name: "IF", open: 3, argument: 1 })
		expect(formulaContext("=SUM({1,2},", 11)?.call).toEqual({ name: "SUM", open: 4, argument: 1 })
		expect(formulaContext("=_xlfn.XLOOKUP(", 15)?.call?.name).toBe("XLOOKUP")
		expect(formulaContext("=SUMME(A1;", 10, ";")?.call).toEqual({ name: "SUMME", open: 6, argument: 1 })
		expect(formulaContext("hello", 2)).toBeNull()
	})

	it("offers nothing inside a string, and no word for a sheet's cell", () => {
		expect(formulaContext('=IF(A1="SU', 10)).toEqual({ word: null, call: { name: "IF", open: 3, argument: 0 }, points: false })
		expect(formulaContext("=Data!A", 7)?.word).toBeNull()
	})

	it("points after an operator, a separator, an open parenthesis or the =", () => {
		expect(formulaContext("=", 1)?.points).toBe(true)
		expect(formulaContext("=A1+", 4)?.points).toBe(true)
		expect(formulaContext("=A1 + ", 6)?.points).toBe(true)
		expect(formulaContext("=A1", 3)?.points).toBe(false)
		expect(formulaContext("=SUM(A1)", 8)?.points).toBe(false)
	})

	it("suggests functions by their names' start and takes one", () => {
		expect(functionSuggestions("sumi").map(entry => entry.name)).toEqual(["SUMIF", "SUMIFS"])
		expect(functionSuggestions("")).toEqual([])
		expect(acceptSuggestion("=1+su", { start: 3, end: 5, text: "su" }, "SUM")).toEqual({ text: "=1+SUM(", caret: 7 })
		expect(acceptSuggestion("=su(A1)", { start: 1, end: 3, text: "su" }, "SUM")).toEqual({ text: "=SUM(A1)", caret: 5 })
	})

	it("lays out a signature and finds the argument in a repeating group", () => {
		const sum = sheetFunction("SUM")
		const ifs = sheetFunction("IF")

		if (sum === undefined || ifs === undefined) throw new Error("catalogue")

		expect(
			signatureParts(ifs)
				.map(part => part.text)
				.join("")
		).toBe("IF(logical test, value if true, [value if false])")
		expect(
			signatureParts(sum, ";")
				.map(part => part.text)
				.join("")
		).toMatch(/^SUM\(number; \[number\]; …\)$/)
		// Each argument part carries the id that keys its label, so the app can show it translated.
		expect(
			signatureParts(ifs)
				.filter(part => part.argument !== undefined)
				.map(part => [part.id, part.optional, part.id === undefined ? "" : ARGUMENT_LABELS[part.id]])
		).toEqual([
			["logical_test", false, "logical test"],
			["value_if_true", false, "value if true"],
			["value_if_false", true, "value if false"]
		])
		expect(signatureParts(ifs).filter(part => part.argument === undefined && part.id !== undefined)).toEqual([])
		expect([0, 1, 2, 5].map(index => argumentAt(sum, index))).toEqual([0, 1, 1, 1])
		expect(argumentAt(ifs, 3)).toBe(-1)
	})

	it("puts a pointed reference at the caret, and moves it on a further click", () => {
		const first = insertReference("=SUM(", 5, "B2")

		expect(first).toEqual({ text: "=SUM(B2", caret: 7, span: { start: 5, end: 7 } })
		expect(insertReference(first.text, first.caret, "B2:C4", first.span)).toEqual({
			text: "=SUM(B2:C4",
			caret: 10,
			span: { start: 5, end: 10 }
		})
		expect(
			pointedReference(
				{
					kind: "cell",
					range: false,
					startRow: 0,
					startCol: 0,
					endRow: 0,
					endCol: 0,
					startRowAbs: false,
					startColAbs: false,
					endRowAbs: false,
					endColAbs: false
				},
				"My Data"
			)
		).toBe("'My Data'!A1")
	})

	it("colours each distinct reference, the same one alike", () => {
		const spans = highlightedReferences("=A1+$A$1+Data!B2:C3+'x y'!A1", 8)

		expect(spans.map(span => [span.start, span.end, span.color, span.sheet])).toEqual([
			[1, 3, 0, null],
			[4, 8, 0, null],
			[9, 19, 1, "Data"],
			[20, 28, 2, "x y"]
		])
	})
})

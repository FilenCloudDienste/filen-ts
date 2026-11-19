import { describe, expect, it } from "vitest"
import {
	cellName,
	columnIndex,
	columnName,
	expandToMerges,
	gridMove,
	malformedFormula,
	parseTsv,
	rangeName,
	wellFormedFormula,
	type GridBounds
} from "../core/sheet/index"

describe("cell names", () => {
	it("names columns and ranges as spreadsheets do", () => {
		expect([columnName(0), columnName(25), columnName(26), columnName(701), columnName(702)]).toEqual(["A", "Z", "AA", "ZZ", "AAA"])
		expect(cellName(0, 0)).toBe("A1")
		expect(rangeName({ startRow: 1, startCol: 1, endRow: 6, endCol: 3 })).toBe("B2:D7")
		expect(rangeName({ startRow: 4, startCol: 2, endRow: 4, endCol: 2 })).toBe("C5")
	})

	it("parses column letters in either case back to their index", () => {
		expect(["A", "Z", "AA", "ZZ", "AAA", "xfd", "aB"].map(columnIndex)).toEqual([0, 25, 26, 701, 702, 16383, 27])
	})

	it("grows a selection over the merges it touches, and the ones those reach", () => {
		const merges = [
			{ startRow: 0, startCol: 1, endRow: 2, endCol: 1 },
			{ startRow: 2, startCol: 1, endRow: 2, endCol: 4 }
		]

		expect(expandToMerges({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, merges)).toEqual({
			startRow: 0,
			startCol: 0,
			endRow: 2,
			endCol: 4
		})
	})
})

describe("gridMove", () => {
	const bounds: GridBounds = { rowCount: 200, colCount: 40, lastUsedRow: 9, lastUsedCol: 4, pageRows: 20 }
	const at = (row: number, col: number) => ({ anchor: { row, col }, focus: { row, col } })
	const key = (name: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
		key: name,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...extra
	})

	it("moves, clamps and extends", () => {
		expect(gridMove(key("ArrowRight"), at(0, 0), bounds)).toEqual(at(0, 1))
		expect(gridMove(key("ArrowUp"), at(0, 0), bounds)).toEqual(at(0, 0))
		expect(gridMove(key("ArrowDown", { shiftKey: true }), at(3, 3), bounds)).toEqual({
			anchor: { row: 3, col: 3 },
			focus: { row: 4, col: 3 }
		})
	})

	it("leaves mod+arrow to the data region's jump, AltGr (Ctrl+Alt) included, and goes to the used area's end on mod+End", () => {
		for (const name of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
			expect(gridMove(key(name, { ctrlKey: true }), at(2, 0), bounds)).toBeNull()
			expect(gridMove(key(name, { metaKey: true, shiftKey: true }), at(2, 0), bounds)).toBeNull()
			expect(gridMove(key(name, { ctrlKey: true, altKey: true }), at(2, 0), bounds)).toBeNull()
		}

		expect(gridMove(key("End", { ctrlKey: true }), at(0, 0), bounds)?.focus).toEqual({ row: 9, col: 4 })
		expect(gridMove(key("Home", { ctrlKey: true }), at(5, 3), bounds)?.focus).toEqual({ row: 0, col: 0 })
		expect(gridMove(key("End"), at(5, 0), bounds)?.focus).toEqual({ row: 5, col: 4 })
	})

	it("steps with Tab and Enter, collapsing the selection", () => {
		expect(gridMove(key("Tab", { shiftKey: true }), { anchor: { row: 0, col: 0 }, focus: { row: 2, col: 2 } }, bounds)).toEqual(
			at(2, 1)
		)
		expect(gridMove(key("Enter"), at(2, 2), bounds)).toEqual(at(3, 2))
	})

	it("selects the used area on mod+A and leaves other keys alone", () => {
		expect(gridMove(key("a", { ctrlKey: true }), at(5, 5), bounds)).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 9, col: 4 } })
		expect(gridMove(key("a"), at(5, 5), bounds)).toBeNull()
		expect(gridMove(key("Escape"), at(5, 5), bounds)).toBeNull()
	})
})

describe("TSV", () => {
	it("reads pasted TSV back, quotes and a trailing line end included", () => {
		expect(parseTsv('name\t"say ""hi"""\r\n"two\nlines"\t3\r\n')).toEqual([
			["name", 'say "hi"'],
			["two\nlines", "3"]
		])
		expect(parseTsv("a\t\tb")).toEqual([["a", "", "b"]])
	})
})

describe("formula syntax", () => {
	it("reads what Excel's grammar allows, however the engine fares with it", () => {
		const formulas = [
			"SUM(A1,B1)",
			"NOW()",
			"IF(A1,,)",
			"SUM( , 1,,2)",
			"{1,2;3,4}",
			'{-1, 2.5 ; "a",TRUE}+{#N/A,1E+5;.5,false}',
			"A:A+1:1",
			"'My Sheet'!A1+Sheet1!$A$1:$B$2",
			"Table1[@Col]+Table1[[#This Row],[Col]]+[@Col]",
			"[1]Sheet1!A1+'[Book.xlsx]S 1'!A1+Sheet1:Sheet3!A1",
			"LET(x,1,x+1)+LAMBDA(x,x+1)(2)",
			"-A1%^-2",
			'"a ""b"""&TRUE',
			"A1<>B1",
			"A1<=B1",
			"_xlfn.XLOOKUP(1,A:A,B:B)",
			"SUM(A1:A3 B2:B4)",
			" SUM( A1 , B1 ) ",
			"A1#+@A1:A10",
			"Sheet1!#REF!+#N/A+#DIV/0!",
			"1E+5+.5",
			"(1+2)*SUM((A1,B1))",
			"A1\n+B1",
			"'O''Brien'!A1",
			// What Excel leaves of a reference into a deleted sheet.
			"#REF!A1",
			"SUM(#REF!A1:B2)"
		]

		for (const formula of formulas) expect([formula, wellFormedFormula(formula)]).toEqual([formula, true])
	})

	it("refuses text that is not a formula: locale separators, unclosed parts, operators without operands", () => {
		const formulas = [
			"SUM(A1;B1)",
			"SUM(A1",
			"SUM(A1))",
			"1+",
			"",
			" ",
			"=A1",
			"()",
			"(1+)",
			'"abc',
			"'Sheet1'",
			"A1!",
			"{1,}",
			"{}",
			"(,)",
			"*A1",
			"A1**B1",
			"#",
			"Table1[[a]",
			"A1@",
			"!A1",
			// An operator before ")" or "," is not an argument left empty.
			"SUM(A1+)",
			"IF(A1>,1,2)",
			"IF(A1=,1,2)",
			"SUM(1,-)",
			"SUM(A1&)",
			"SUM(-)",
			// An array constant holds constants only.
			"{A1,B1}",
			"{SUM(1)}",
			"{(1)}",
			"{1,{2}}",
			"{1 2}",
			"{1+2}",
			"{-}"
		]

		for (const formula of formulas) expect([formula, wellFormedFormula(formula)]).toEqual([formula, false])
	})

	it("tells which entries would be stored as a malformed formula", () => {
		expect(malformedFormula("=SUM(A1;B1)")).toBe(true)
		expect(malformedFormula("=SUM(A1,B1)")).toBe(false)
		// Text: not a formula at all, or kept as typed.
		expect(malformedFormula("SUM(A1;B1)")).toBe(false)
		expect(malformedFormula("'=SUM(A1;B1)")).toBe(false)
		expect(malformedFormula("=")).toBe(false)
		expect(malformedFormula("=SUM(A1;B1)", true)).toBe(false)
	})
})

import { describe, expect, it } from "vitest"
import { rangeAddress, translateFormula } from "../core/ods/formula/toXlsx"
import { wellFormedFormula } from "../core/sheet/refs/formulaRefs"
import { budget } from "./timing"

// OpenFormula (ODF 1.3 Part 4) as the store's Excel grammar: the cases of Part 4 §5 the corpus lacks, and the ones it
// has.

function text(formula: string): string {
	const translated = translateFormula(formula)

	if ("refused" in translated) throw new Error(translated.refused)

	expect(wellFormedFormula(translated.text)).toBe(true)

	return translated.text
}

function refused(formula: string): string {
	const translated = translateFormula(formula)

	return "refused" in translated ? translated.refused : `translated: ${translated.text}`
}

describe("OpenFormula to Excel's grammar", () => {
	it("reads references: same sheet, other sheets quoted or not, absolute, whole columns and rows (§5.8)", () => {
		expect(text("of:=[.A1]+[.$B$2]")).toBe("A1+$B$2")
		expect(text("of:=SUM([.A1:.B2])")).toBe("SUM(A1:B2)")
		expect(text("of:=['Sheet 2'.A1]")).toBe("'Sheet 2'!A1")
		expect(text("of:=SUM([$Sheet1.$A$1:.$A$3])")).toBe("SUM(Sheet1!$A$1:$A$3)")
		expect(text("of:=SUM([.A:.A])")).toBe("SUM(A:A)")
		expect(text("of:=SUM([.2:.3])")).toBe("SUM(2:3)")
		expect(text("of:=['It''s'.A1]")).toBe("'It''s'!A1")
		expect(text("of:=[.#REF!]+1")).toBe("#REF!+1")
	})

	it("reads separators, inline arrays, strings, errors and constants (§5.12-§5.13)", () => {
		expect(text('of:=IF([.A1]>0;"a;b";"c""d")')).toBe('IF(A1>0,"a;b","c""d")')
		expect(text("of:=SUM({1;2|3;4})")).toBe("SUM({1,2;3,4})")
		expect(text("of:=IFERROR(1/0;#N/A)")).toBe("IFERROR(1/0,#N/A)")
		expect(text("of:=AND(TRUE();FALSE())")).toBe("AND(TRUE,FALSE)")
		expect(text('of:=[.A1]&amp;"x"'.replace("&amp;", "&"))).toBe('A1&"x"')
		expect(text("of:=MyName*2")).toBe("MyName*2")
	})

	it("reads the union and intersection operators", () => {
		expect(text("of:=SUM([.A1]~[.B1])")).toBe("SUM((A1,B1))")
		expect(text("of:=[.A1:.C3]![.B2:.D4]")).toBe("A1:C3 B2:D4")
	})

	it("binds the union tighter than every other operator (§5.5)", () => {
		expect(text("of:=SUM([.A1]~[.B1]+1)")).toBe("SUM((A1,B1)+1)")
		expect(text("of:=SUM(1+[.A1]~[.B1]~[.C1];2)")).toBe("SUM(1+(A1,B1,C1),2)")
		expect(text("of:=SUM(-[.A1]~[.B1])")).toBe("SUM(-(A1,B1))")
		expect(text("of:=([.A1]~[.B1])")).toBe("(A1,B1)")
		expect(text("of:=([.A1]~[.B1]%)")).toBe("((A1,B1)%)")
		expect(text("of:=INDEX([.A1]~[.B1]![.B1:.C1];1)")).toBe("INDEX((A1,B1 B1:C1),1)")
		expect(text("of:=SUM([.A1] ~ [.B1])")).toBe("SUM((A1 , B1))")
	})

	it("refuses a union whose operand is not a reference: a postfix % binds looser than ~ (§5.5)", () => {
		expect(refused("of:=SUM([.A1]%~[.B1])")).toBe("union")
		expect(refused("of:=SUM([.A1]~-[.B1])")).toBe("union")
		expect(refused("of:=SUM(1~[.B1])")).toBe("union")
		expect(refused("of:=SUM(~[.B1])")).toBe("union")
		expect(refused("of:=SUM([.A1]~)")).toBe("union")
		expect(refused('of:=SUM([.A1]~"x")')).toBe("union")
	})

	it("reads CEILING and FLOOR with one, two or three arguments as LibreOffice writes them for Excel (§6.17)", () => {
		expect(text("of:=CEILING(-4.5)")).toBe("_xlfn.CEILING.MATH(-4.5)")
		expect(text("of:=CEILING(-4.5;-1)")).toBe("_xlfn.CEILING.MATH(-4.5,-1)")
		expect(text("of:=CEILING(-4.5;;1)")).toBe("_xlfn.CEILING.MATH(-4.5,1,1)")
		expect(text("of:=FLOOR(-4.5;-1;1)")).toBe("_xlfn.FLOOR.MATH(-4.5,-1,1)")
		expect(text("of:=CEILING([.A1];0)")).toBe("_xlfn.CEILING.MATH(A1,0)")
		expect(text("of:=COM.MICROSOFT.CEILING(4.5;2)")).toBe("CEILING(4.5,2)")
	})

	it("gives CEILING and FLOOR's error where the signs differ, as Part 4 §6.17.1 and §6.17.3 do", () => {
		// Literal arguments: decided here. LibreOffice 7.5 gives Err:502 and writes it to SpreadsheetML as #VALUE!.
		expect(text("of:=CEILING(2.5;-2)")).toBe("#VALUE!")
		expect(text("of:=CEILING(-2.5;2;1)")).toBe("#VALUE!")
		expect(text("of:=FLOOR(-2.5;2)")).toBe("#VALUE!")
		expect(text("of:=FLOOR(2.5;-2;0)")).toBe("#VALUE!")
		expect(text("of:=1+CEILING(-2.5;+2)")).toBe("1+#VALUE!")
		// Arguments whose sign is known only when calculated: guarded, each read once more by SIGN.
		expect(text("of:=CEILING([.A1];2)")).toBe("IF(SIGN(A1)*SIGN(2)<0,#VALUE!,_xlfn.CEILING.MATH(A1,2))")
		expect(text("of:=FLOOR([.A1]*1.1;[$Data.B$2];1)")).toBe(
			"IF(SIGN(A1*1.1)*SIGN(Data!B$2)<0,#VALUE!,_xlfn.FLOOR.MATH(A1*1.1,Data!B$2,1))"
		)
		// A mode from a cell: its error comes before the signs' (LibreOffice reads it first).
		expect(text("of:=CEILING(2.5;-2;[.C1])")).toBe("IF(SIGN(2.5)*SIGN(-2)*((C1)*0+1)<0,#VALUE!,_xlfn.CEILING.MATH(2.5,-2,C1))")
		// A significance left out takes the number's sign; one of 0 gives 0.
		expect(text("of:=CEILING([.A1];;1)")).toBe("_xlfn.CEILING.MATH(A1,1,1)")
		expect(text("of:=FLOOR([.A1]; )")).toBe("_xlfn.FLOOR.MATH(A1,1)")
		expect(text("of:=FLOOR(SUM([.A1:.A3]);0)")).toBe("_xlfn.FLOOR.MATH(SUM(A1:A3),0)")
		// Calls are not read twice (a volatile one would give another value): refused, the cell keeps its result.
		expect(refused("of:=CEILING(SUM([.A1:.A3]);2)")).toBe("CEILING sign")
		expect(refused("of:=FLOOR([.A1];RAND())")).toBe("FLOOR sign")
		expect(refused("of:=CEILING([.A1:.A3];2)")).toBe("CEILING sign")
		expect(refused("of:=CEILING(e;2)")).toBe("CEILING sign")
		expect(text("of:=CEILING(1e1;-2;TRUE())")).toBe("#VALUE!")
	})

	it("refuses references off the grid", () => {
		expect(refused("of:=SUM([.A9999999])")).toBe("reference")
		expect(refused("of:=SUM([.XFE1])")).toBe("reference")
		expect(refused("of:=SUM([.ZZZ1])")).toBe("reference")
		expect(refused("of:=SUM([.A1:.XFE1])")).toBe("reference")
		expect(text("of:=SUM([.XFD1048576])")).toBe("SUM(XFD1048576)")
	})

	it("refuses a formula longer than a cell's at once, and reads the longest it takes in one pass", () => {
		const long = (count: number): string => `of:=${Array.from({ length: count }, () => "SUM([.A1]~[.B1])").join("+")}`
		let started = performance.now()

		expect(refused(long(200_000))).toBe("formula too long")
		expect(refused(`msoxl:=${"A1+".repeat(5_000)}1`)).toBe("formula too long")
		expect(performance.now() - started).toBeLessThan(budget(100))

		// Just under the source bound: read through, then refused for its translated length.
		const longest = long(1_900)

		started = performance.now()
		expect(refused(longest)).toBe("formula too long")
		expect(performance.now() - started).toBeLessThan(budget(100))
	})

	it("spells functions as Excel stores them", () => {
		expect(text("of:=COM.MICROSOFT.IFS([.A1]=1;1)")).toBe("_xlfn.IFS(A1=1,1)")
		expect(text("of:=IFNA([.A1];0)")).toBe("_xlfn.IFNA(A1,0)")
		expect(text("of:=LEGACY.NORMSDIST(1)")).toBe("NORMSDIST(1)")
		expect(text("of:=COM.MICROSOFT.FILTER([.A1:.A3];[.B1:.B3])")).toBe("_xlfn._xlws.FILTER(A1:A3,B1:B3)")
		expect(text("of:=SUMPRODUCT([.A1:.A2];[.B1:.B2])")).toBe("SUMPRODUCT(A1:A2,B1:B2)")
	})

	it("takes LibreOffice's own Excel-grammar formulas as they are", () => {
		expect(text("msoxl:=SUM(A1:A3)")).toBe("SUM(A1:A3)")
	})

	it("refuses what has no Excel equivalent, never guessing", () => {
		expect(refused("of:=ORG.OPENOFFICE.WEEKS(1;2;0)")).toBe("function ORG.OPENOFFICE.WEEKS")
		expect(refused("of:=MULTIPLE.OPERATIONS([.A1];[.B1];1)")).toBe("function MULTIPLE.OPERATIONS")
		expect(refused("of:=FORMULA([.A1])")).toBe("function FORMULA")
		expect(refused("of:=SUM([Sheet1.A1:Sheet2.B2])")).toBe("3D reference")
		expect(refused("of:=['file:///x.ods'#$Sheet1.A1]")).toBe("external reference")
		expect(refused("of:=[.A1]&#rif!")).toBe("error literal #rif!")
		expect(refused("xyz:=1")).toBe("formula grammar xyz")
	})

	it("reads cell range addresses of names and print ranges", () => {
		expect(rangeAddress("$Sheet1.$A$1:.$B$5")).toEqual({ text: "Sheet1!$A$1:$B$5" })
		expect(rangeAddress("Sheet1.A1:Sheet1.D20 'Sheet 2'.B2")).toEqual({ text: "Sheet1!A1:D20,'Sheet 2'!B2" })
	})
})

describe("LET and LAMBDA names", () => {
	it("reads OpenFormula's bare names as the store's _xlpm. names, scope by scope", () => {
		expect(text("of:=COM.MICROSOFT.LET(x;1;x+1)")).toBe("_xlfn.LET(_xlpm.x,1,_xlpm.x+1)")
		expect(text("of:=COM.MICROSOFT.LAMBDA(a;b;a*b)")).toBe("_xlfn.LAMBDA(_xlpm.a,_xlpm.b,_xlpm.a*_xlpm.b)")
		expect(text("of:=COM.MICROSOFT.LET(f;COM.MICROSOFT.LAMBDA(n;n*2);x;[.A1];f(3)+x)")).toBe(
			// A call takes a function name's case: the engine reads names in any case.
			"_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.n,_xlpm.n*2),_xlpm.x,A1,_xlpm.F(3)+_xlpm.x)"
		)
		// Already prefixed: left as it is.
		expect(text("of:=COM.MICROSOFT.LET(_xlpm.x;1;_xlpm.x+1)")).toBe("_xlfn.LET(_xlpm.x,1,_xlpm.x+1)")
		// Outside a scope a name stays a defined name.
		expect(text("of:=x+COM.MICROSOFT.LET(x;1;x)")).toBe("x+_xlfn.LET(_xlpm.x,1,_xlpm.x)")
	})
})

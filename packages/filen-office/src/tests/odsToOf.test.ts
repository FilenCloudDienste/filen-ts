import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { canonicalFormula, openFormula } from "../core/ods/formula/toOf"
import { translateFormula } from "../core/ods/formula/toXlsx"
import { CORPUS_DIR } from "./corpusDir"

// The store's grammar written back as OpenFormula (ODF 1.3 Part 4): every formula reads back as it was, and what an
// .ods cannot hold is refused.

function written(text: string): string {
	const result = openFormula(text)

	if ("refused" in result) throw new Error(result.refused)

	const back = translateFormula(result.text)

	expect("text" in back && canonicalFormula(back.text)).toBe(canonicalFormula(text))

	return result.text
}

function refusal(text: string): string {
	const result = openFormula(text)

	return "refused" in result ? result.refused : `written: ${result.text}`
}

describe("Formulas written as OpenFormula", () => {
	it("writes LET and LAMBDA names bare, without SpreadsheetML's _xlpm. prefix", () => {
		expect(written("_xlfn.LET(_xlpm.x,1,_xlpm.x+1)")).toBe("of:=COM.MICROSOFT.LET(x;1;x+1)")
		expect(written("_xlfn.LAMBDA(_xlpm.a,_xlpm.b,_xlpm.a*_xlpm.b)")).toBe("of:=COM.MICROSOFT.LAMBDA(a;b;a*b)")
		expect(written("_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.n,_xlpm.n*2),_xlpm.f(3))")).toBe(
			"of:=COM.MICROSOFT.LET(f;COM.MICROSOFT.LAMBDA(n;n*2);F(3))"
		)
	})

	it("writes references on the sheet and on others, quoted where needed, whole columns and rows (§5.8)", () => {
		expect(written("A1+$B$2")).toBe("of:=[.A1]+[.$B$2]")
		expect(written("SUM(A1:B2)")).toBe("of:=SUM([.A1:.B2])")
		expect(written("'Sheet 2'!A1")).toBe("of:=[$'Sheet 2'.A1]")
		expect(written("SUM(Sheet1!$A$1:$A$3)")).toBe("of:=SUM([$Sheet1.$A$1:.$A$3])")
		expect(written("SUM(A:A)+SUM(2:3)")).toBe("of:=SUM([.A:.A])+SUM([.2:.3])")
		expect(written("'It''s'!A1")).toBe("of:=[$'It''s'.A1]")
	})

	it("writes separators, arrays, strings, booleans and errors (§5.12-§5.13)", () => {
		expect(written('IF(A1>0,"a,b","c""d")')).toBe('of:=IF([.A1]>0;"a,b";"c""d")')
		expect(written("SUM({1,2;3,4})")).toBe("of:=SUM({1;2|3;4})")
		expect(written("AND(TRUE,FALSE)")).toBe("of:=AND(TRUE();FALSE())")
		expect(written("IFERROR(1/0,#N/A)")).toBe("of:=IFERROR(1/0;#N/A)")
		expect(written("1.5E+10*-2%")).toBe("of:=1.5E+10*-2%")
		expect(written("MyName*2")).toBe("of:=MyName*2")
	})

	it("writes the union and the intersection as Part 4's ~ and ! (§5.5)", () => {
		expect(written("SUM((A1,B1))")).toBe("of:=SUM(([.A1]~[.B1]))")
		expect(written("A1:C3 B2:D4")).toBe("of:=[.A1:.C3]![.B2:.D4]")
		expect(written("SUM(A1 + B1)")).toBe("of:=SUM([.A1] + [.B1])")
	})

	it("writes OpenFormula's names, and Excel's own under COM.MICROSOFT", () => {
		expect(written("_xlfn.IFS(A1>0,1)")).toBe("of:=COM.MICROSOFT.IFS([.A1]>0;1)")
		expect(written("CHIDIST(1,2)")).toBe("of:=LEGACY.CHIDIST(1;2)")
		expect(written("_xlfn.F.DIST(1,2,3,TRUE)")).toBe("of:=FDIST(1;2;3;TRUE())")
		expect(written("_xlfn.XLOOKUP(1,A1:A3,B1:B3)")).toBe("of:=COM.MICROSOFT.XLOOKUP(1;[.A1:.A3];[.B1:.B3])")
		expect(written("_xlfn.IFNA(A1,0)")).toBe("of:=IFNA([.A1];0)")
	})

	it("writes CEILING and FLOOR back as Part 4's where the reader takes them so, and their sign guard as the call", () => {
		expect(written("_xlfn.CEILING.MATH(5,2)")).toBe("of:=CEILING(5;2)")
		expect(written("IF(SIGN(A1)*SIGN(2)<0,#VALUE!,_xlfn.CEILING.MATH(A1,2))")).toBe("of:=CEILING([.A1];2)")
		expect(written("IF(SIGN(A1)*SIGN(B1)*((C1)*0+1)<0,#VALUE!,_xlfn.FLOOR.MATH(A1,B1,C1))")).toBe("of:=FLOOR([.A1];[.B1];[.C1])")
		// Part 4's CEILING would read back guarded: Excel's own is written.
		expect(written("_xlfn.CEILING.MATH(A1,1)")).toBe("of:=COM.MICROSOFT.CEILING.MATH([.A1];1)")
		expect(written("CEILING(A1,2)")).toBe("of:=COM.MICROSOFT.CEILING([.A1];2)")
	})

	it("writes Part 4's three-argument CEILING and FLOOR back as they were read, a literal mode as well as a reference", () => {
		for (const source of [
			"of:=CEILING([.C1];[.C2];1)",
			"of:=CEILING([.C1];[.C2];0)",
			"of:=FLOOR([.C1];[.C2];1)",
			"of:=FLOOR([.C1];[.C2];TRUE())",
			"of:=CEILING([.C1];[.C2];FALSE())",
			"of:=FLOOR([.C1];[.C2];[.C3])"
		]) {
			const read = translateFormula(source)

			if (!("text" in read)) throw new Error(read.refused)

			expect(written(read.text)).toBe(source)
		}
	})

	it("reads Part 4's FDIST, FINV and SKEWP as Excel's F.DIST, F.INV and SKEW.P, Cumulative defaulting to TRUE (§6.18.22)", () => {
		expect(translateFormula("of:=FDIST(1;2;3)")).toEqual({ text: "_xlfn.F.DIST(1,2,3,TRUE)" })
		expect(translateFormula("of:=FDIST(1;2;3;FALSE())")).toEqual({ text: "_xlfn.F.DIST(1,2,3,FALSE)" })
		expect(translateFormula("of:=LEGACY.FDIST(1;2;3)")).toEqual({ text: "FDIST(1,2,3)" })
		expect(translateFormula("of:=FINV(0.5;2;3)+SKEWP([.A1:.A3])")).toEqual({ text: "_xlfn.F.INV(0.5,2,3)+_xlfn.SKEW.P(A1:A3)" })
	})

	it("compares spellings of one formula as equal", () => {
		expect(canonicalFormula("sum('Sheet1'!a1)")).toBe(canonicalFormula("SUM(Sheet1!A1)"))
	})

	it("refuses what an .ods cannot hold", () => {
		expect(refusal("SUM(Sheet1:Sheet3!A1)")).toBe("reference")
		expect(refusal("SUM(Table1[Amount])")).toBe("reference")
		expect(refusal("[1]Sheet1!A1")).toBe("reference")
		expect(refusal("Sheet1!Name")).toBe("reference")
		expect(refusal("@A1:A3")).toBe("reference")
		expect(refusal("A1#")).toBe("reference")
	})
})

const DIR = join(CORPUS_DIR, "ods")
const FILES = existsSync(DIR) ? readdirSync(DIR).filter(name => name.endsWith(".ods")) : []

function unescape(text: string): string {
	return text.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}

describe.skipIf(FILES.length === 0)("Corpus formulas written back", () => {
	it("writes every formula the reader takes so that it reads back the same", { timeout: 300_000 }, () => {
		const failures: string[] = []
		let count = 0

		for (const name of FILES) {
			let content: Uint8Array | undefined

			try {
				content = unzipSync(new Uint8Array(readFileSync(join(DIR, name))), { filter: file => file.name === "content.xml" })[
					"content.xml"
				]
			} catch {
				continue
			}

			if (content === undefined) continue

			const seen = new Set<string>()

			for (const match of strFromU8(content).matchAll(/table:formula="([^"]*)"/g)) {
				const source = unescape(match[1] ?? "")

				if (seen.has(source)) continue

				seen.add(source)

				const read = translateFormula(source)

				if ("refused" in read) continue

				count++

				const result = openFormula(read.text)
				const back = "text" in result ? translateFormula(result.text) : result

				if (!("text" in back) || canonicalFormula(back.text) !== canonicalFormula(read.text))
					failures.push(`${name}: ${source} -> ${read.text} -> ${"text" in result ? result.text : result.refused}`)
			}
		}

		expect(count).toBeGreaterThan(80_000)
		expect(failures.slice(0, 20)).toEqual([])
	})
})

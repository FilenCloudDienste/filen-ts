import { describe, expect, it } from "vitest"
import {
	ARGUMENT_LABELS,
	MAX_FUNCTION_ARGUMENTS,
	sheetFunction,
	sheetFunctions,
	type FunctionVolatility
} from "../core/sheet/functions/catalogue"
import {
	LAMBDA_HELPERS,
	RESIZED_FUNCTIONS,
	SIZED_FUNCTIONS,
	mayReturnArray,
	shownFormula,
	storedFormula
} from "../core/sheet/refs/formulaRefs"

// The future functions of [MS-XLSX] 2.2.3 (learn.microsoft.com, revised 2024-02-20), as the list writes them: a
// name without a prefix is one ISO/IEC 29500 already defines.
const MS_XLSX_FUTURE_FUNCTIONS = `
_xlfn._xlws.FILTER _xlfn._xlws.PY _xlfn._xlws.SORT _xlfn.ACOT _xlfn.ACOTH _xlfn.AGGREGATE _xlfn.ARABIC _xlfn.BASE
_xlfn.BETA.DIST _xlfn.BETA.INV _xlfn.BINOM.DIST _xlfn.BINOM.DIST.RANGE _xlfn.BINOM.INV _xlfn.BITAND _xlfn.BITLSHIFT
_xlfn.BITOR _xlfn.BITRSHIFT _xlfn.BITXOR _xlfn.BYCOL _xlfn.BYROW _xlfn.CEILING.MATH _xlfn.CEILING.PRECISE _xlfn.CHISQ.DIST
_xlfn.CHISQ.DIST.RT _xlfn.CHISQ.INV _xlfn.CHISQ.INV.RT _xlfn.CHISQ.TEST _xlfn.CHOOSECOLS _xlfn.CHOOSEROWS _xlfn.COMBINA
_xlfn.CONCAT _xlfn.CONFIDENCE.NORM _xlfn.CONFIDENCE.T _xlfn.COT _xlfn.COTH _xlfn.COVARIANCE.P _xlfn.COVARIANCE.S _xlfn.CSC
_xlfn.CSCH _xlfn.DAYS _xlfn.DECIMAL _xlfn.DROP ECMA.CEILING _xlfn.ERF.PRECISE _xlfn.ERFC.PRECISE _xlfn.EXPAND
_xlfn.EXPON.DIST _xlfn.F.DIST _xlfn.F.DIST.RT _xlfn.F.INV _xlfn.F.INV.RT _xlfn.F.TEST _xlfn.FIELDVALUE _xlfn.FILTERXML
_xlfn.FLOOR.MATH _xlfn.FLOOR.PRECISE _xlfn.FORECAST.ETS _xlfn.FORECAST.ETS.CONFINT _xlfn.FORECAST.ETS.SEASONALITY
_xlfn.FORECAST.ETS.STAT _xlfn.FORECAST.LINEAR _xlfn.FORMULATEXT _xlfn.GAMMA _xlfn.GAMMA.DIST _xlfn.GAMMA.INV
_xlfn.GAMMALN.PRECISE _xlfn.GAUSS _xlfn.HSTACK _xlfn.HYPGEOM.DIST _xlfn.IFNA _xlfn.IFS _xlfn.IMCOSH _xlfn.IMCOT _xlfn.IMCSC
_xlfn.IMCSCH _xlfn.IMSEC _xlfn.IMSECH _xlfn.IMSINH _xlfn.IMTAN _xlfn.ISFORMULA ISO.CEILING _xlfn.ISOMITTED
_xlfn.ISOWEEKNUM _xlfn.LAMBDA _xlfn.LET _xlfn.LOGNORM.DIST _xlfn.LOGNORM.INV _xlfn.MAKEARRAY _xlfn.MAP _xlfn.MAXIFS
_xlfn.MINIFS _xlfn.MODE.MULT _xlfn.MODE.SNGL _xlfn.MUNIT _xlfn.NEGBINOM.DIST NETWORKDAYS.INTL _xlfn.NORM.DIST
_xlfn.NORM.INV _xlfn.NORM.S.DIST _xlfn.NORM.S.INV _xlfn.NUMBERVALUE _xlfn.PDURATION _xlfn.PERCENTILE.EXC
_xlfn.PERCENTILE.INC _xlfn.PERCENTRANK.EXC _xlfn.PERCENTRANK.INC _xlfn.PERMUTATIONA _xlfn.PHI _xlfn.POISSON.DIST
_xlfn.PQSOURCE _xlfn.PYTHON_STR _xlfn.PYTHON_TYPE _xlfn.PYTHON_TYPENAME _xlfn.QUARTILE.EXC _xlfn.QUARTILE.INC
_xlfn.QUERYSTRING _xlfn.RANDARRAY _xlfn.RANK.AVG _xlfn.RANK.EQ _xlfn.REDUCE _xlfn.RRI _xlfn.SCAN _xlfn.SEC _xlfn.SECH
_xlfn.SEQUENCE _xlfn.SHEET _xlfn.SHEETS _xlfn.SKEW.P _xlfn.SORTBY _xlfn.STDEV.P _xlfn.STDEV.S _xlfn.SWITCH _xlfn.T.DIST
_xlfn.T.DIST.2T _xlfn.T.DIST.RT _xlfn.T.INV _xlfn.T.INV.2T _xlfn.T.TEST _xlfn.TAKE _xlfn.TEXTAFTER _xlfn.TEXTBEFORE
_xlfn.TEXTJOIN _xlfn.TEXTSPLIT _xlfn.TOCOL _xlfn.TOROW _xlfn.UNICHAR _xlfn.UNICODE _xlfn.UNIQUE _xlfn.VAR.P _xlfn.VAR.S
_xlfn.VSTACK _xlfn.WEBSERVICE _xlfn.WEIBULL.DIST WORKDAY.INTL _xlfn.WRAPCOLS _xlfn.WRAPROWS _xlfn.XLOOKUP _xlfn.XOR
_xlfn.Z.TEST
`
	.split(/\s+/u)
	.filter(name => name !== "")

// On Microsoft's list but newer than [MS-XLSX]'s, or missing from it and from [MS-XLSB]'s built-in function table.
const UNLISTED_FUTURE_FUNCTIONS = [
	"ARRAYTOTEXT",
	"DETECTLANGUAGE",
	"ENCODEURL",
	"GROUPBY",
	"IMAGE",
	"PERCENTOF",
	"PIVOTBY",
	"REGEXEXTRACT",
	"REGEXREPLACE",
	"REGEXTEST",
	"TRANSLATE",
	"TRIMRANGE",
	"VALUETOTEXT",
	"XMATCH"
]

// Volatile per "Excel Recalculation" (learn.microsoft.com), with RAND and RANDARRAY.
const VOLATILE: Record<string, FunctionVolatility> = {
	NOW: "always",
	TODAY: "always",
	RAND: "always",
	RANDARRAY: "always",
	RANDBETWEEN: "always",
	OFFSET: "always",
	INDIRECT: "always",
	INFO: "arguments",
	CELL: "arguments",
	SUMIF: "arguments"
}

// Not calculable here: a network service, an add-in, an OLAP connection or a locale's character tables.
const CACHED = [
	"ASC",
	"CALL",
	"CUBEKPIMEMBER",
	"CUBEMEMBER",
	"CUBEMEMBERPROPERTY",
	"CUBERANKEDMEMBER",
	"CUBESET",
	"CUBESETCOUNT",
	"CUBEVALUE",
	"DBCS",
	"DETECTLANGUAGE",
	"EUROCONVERT",
	"FILTERXML",
	"IMAGE",
	"JIS",
	"PHONETIC",
	"REGISTER.ID",
	"RTD",
	"STOCKHISTORY",
	"TRANSLATE",
	"WEBSERVICE"
]

const functions = sheetFunctions()

function arity(name: string): [number, number] {
	const found = sheetFunction(name)

	if (found === undefined) {
		throw new Error(`no ${name}`)
	}

	return [found.minArgs, found.maxArgs]
}

describe("sheet function catalogue", () => {
	it("holds the 521 functions of Microsoft's alphabetical list, each once, in order", () => {
		const names = functions.map(entry => entry.name)

		expect(names).toHaveLength(521)
		expect(new Set(names).size).toBe(521)
		expect(names).toEqual([...names].sort())

		for (const name of names) {
			expect(name).toMatch(/^[A-Z][A-Z0-9.]*$/u)
		}

		for (const name of ["SUM", "XLOOKUP", "LEFTB", "FINDB", "FORECAST.ETS.STAT", "CUBEVALUE", "TRIMRANGE", "Z.TEST"]) {
			expect(names).toContain(name)
		}
	})

	it("stores each future function under the prefix [MS-XLSX] gives it, and the newest under _xlfn.", () => {
		const listed = new Map<string, string>()

		for (const stored of MS_XLSX_FUTURE_FUNCTIONS) {
			const prefix = /^_xlfn\.(_xlws\.)?/u.exec(stored)?.[0] ?? ""

			listed.set(stored.slice(prefix.length), prefix)
		}

		for (const entry of functions) {
			const expected = listed.get(entry.name) ?? (UNLISTED_FUTURE_FUNCTIONS.includes(entry.name) ? "_xlfn." : "")

			expect(`${entry.prefix}${entry.name}`).toBe(`${expected}${entry.name}`)
		}

		for (const name of UNLISTED_FUTURE_FUNCTIONS) {
			expect(listed.has(name)).toBe(false)
		}
	})

	it("finds a function by its name as typed or as stored", () => {
		expect(sheetFunction("stdev.s")?.name).toBe("STDEV.S")
		expect(sheetFunction("_xlfn.STDEV.S")?.prefix).toBe("_xlfn.")
		expect(sheetFunction("_xlfn._xlws.FILTER")?.prefix).toBe("_xlfn._xlws.")
		expect(sheetFunction("_xlfn.SUM")?.name).toBe("SUM")
		expect(sheetFunction("NOSUCH")).toBeUndefined()
	})

	it("gives each function's arity within Excel's limit", () => {
		for (const entry of functions) {
			expect(entry.minArgs).toBeGreaterThanOrEqual(0)
			expect(entry.minArgs).toBeLessThanOrEqual(entry.maxArgs)
			expect(entry.maxArgs).toBeLessThanOrEqual(MAX_FUNCTION_ARGUMENTS)
			expect(entry.args.length).toBeLessThanOrEqual(entry.maxArgs)
			expect(entry.args.filter(arg => !arg.optional).length).toBeLessThanOrEqual(entry.minArgs)
		}

		expect(arity("NOW")).toEqual([0, 0])
		expect(arity("ABS")).toEqual([1, 1])
		expect(arity("IF")).toEqual([2, 3])
		expect(arity("SUM")).toEqual([1, 255])
		expect(arity("CHOOSE")).toEqual([2, 255])
		expect(arity("SUMIFS")).toEqual([3, 255])
		expect(arity("ACCRINT")).toEqual([6, 8])
		expect(arity("XLOOKUP")).toEqual([3, 6])
		expect(arity("FILTER")).toEqual([2, 3])
		expect(arity("INDEX")).toEqual([2, 4])
		// Future functions that repeat stop where the [MS-XLSX] grammar stops them.
		expect(arity("STDEV.S")).toEqual([1, 254])
		expect(arity("MAXIFS")).toEqual([3, 253])
		expect(arity("LET")).toEqual([3, 253])
		expect(arity("LAMBDA")).toEqual([1, 253])
		expect(arity("SWITCH")).toEqual([3, 254])
		expect(arity("REDUCE")).toEqual([3, 3])
	})

	it("reads each signature into arguments, optional groups and the group that repeats", () => {
		expect(sheetFunction("SUMIFS")?.args).toEqual([
			{ id: "sum_range", optional: false, repeats: false },
			{ id: "criteria_range", optional: false, repeats: false },
			{ id: "criteria", optional: false, repeats: false },
			{ id: "criteria_range", optional: true, repeats: true },
			{ id: "criteria", optional: true, repeats: true }
		])
		expect(sheetFunction("F.DIST")?.args.map(arg => arg.id)).toEqual(["x", "deg_freedom1", "deg_freedom2", "cumulative"])
		expect(sheetFunction("SWITCH")?.args.at(-1)).toEqual({ id: "default", optional: true, repeats: false })
	})

	it("labels every argument, and nothing else", () => {
		const used = new Set(functions.flatMap(entry => entry.args.map(arg => arg.id)))

		expect([...used].sort()).toEqual(Object.keys(ARGUMENT_LABELS).sort())

		for (const label of Object.values(ARGUMENT_LABELS)) {
			expect(label.trim()).toBe(label)
			expect(label).not.toBe("")
		}
	})

	it("marks volatile only the functions Excel recalculates every time", () => {
		const volatile = Object.fromEntries(
			functions.filter(entry => entry.volatility !== "none").map(entry => [entry.name, entry.volatility])
		)

		expect(volatile).toEqual(VOLATILE)
	})

	it("keeps the cached result of the functions that cannot be calculated here", () => {
		expect(functions.filter(entry => entry.support === "cached").map(entry => entry.name)).toEqual(CACHED)
		expect(functions.filter(entry => entry.support === "hyperformula")).toHaveLength(384)
		expect(functions.filter(entry => entry.support === "plugin" || entry.support === "missing")).toHaveLength(116)
	})

	it("stores a typed call under the catalogue's prefix, and shows it without", () => {
		const wrong: string[] = []

		for (const entry of functions) {
			const typed = `${entry.name}(1)`
			const stored = `${entry.prefix}${entry.name}(1)`

			if (storedFormula(typed) !== stored) wrong.push(`stored ${typed}: ${storedFormula(typed)}`)
			if (shownFormula(stored) !== typed) wrong.push(`shown ${stored}: ${shownFormula(stored)}`)
		}

		expect(wrong).toEqual([])
		expect(storedFormula("single(A1:A3)")).toBe("_xlfn.SINGLE(A1:A3)")
		expect(shownFormula("_xlfn.SINGLE(A1:A3)")).toBe("@A1:A3")
		expect(storedFormula("@A1:A3")).toBe("_xlfn.SINGLE(A1:A3)")
	})

	it("shows a stored SINGLE or ANCHORARRAY it cannot spell as @ or # as a call, once, and stores it back", () => {
		const unconverted: Record<string, string> = {
			"_xlfn.SINGLE(A1+B1)": "SINGLE(A1+B1)",
			'"_xlfn.SINGLE("&A1': '"_xlfn.SINGLE("&A1',
			"_xlfn.ANCHORARRAY(A1:B2)": "_xlfn.ANCHORARRAY(A1:B2)",
			"_xlfn.SINGLE(A1,B1)": "SINGLE(A1,B1)"
		}
		const converted: Record<string, string> = {
			"SUM(_xlfn.ANCHORARRAY(MyName))": "SUM(MyName#)",
			"_xlfn.SINGLE(Table1[Amount])": "@Table1[Amount]",
			"_xlfn.SINGLE(Table1[[#This Row],[Amount]])": "@Table1[[#This Row],[Amount]]",
			"_xlfn.SINGLE(Sheet1!MyName)": "@Sheet1!MyName",
			"_xlfn.ANCHORARRAY(Sheet1!MyName)": "Sheet1!MyName#",
			"_xlfn.SINGLE(_xlfn.ANCHORARRAY(A1))": "@A1#"
		}

		for (const [stored, shown] of Object.entries({ ...unconverted, ...converted })) {
			expect(shownFormula(stored)).toBe(shown)
			expect(shownFormula(shownFormula(stored))).toBe(shown)
			expect(storedFormula(shown)).toBe(stored)
		}
	})

	it("stores @ and # around names, structured references and sheets, leaving a structured reference's own @ and #", () => {
		const stored: Record<string, string> = {
			"@Table1[Amount]": "_xlfn.SINGLE(Table1[Amount])",
			"@Sheet1!MyName": "_xlfn.SINGLE(Sheet1!MyName)",
			"@A1#": "_xlfn.SINGLE(_xlfn.ANCHORARRAY(A1))",
			"MyName#": "_xlfn.ANCHORARRAY(MyName)",
			"SUM('My Sheet'!MyName#)": "SUM(_xlfn.ANCHORARRAY('My Sheet'!MyName))",
			"SUM(Sheet2!B3#)": "SUM(_xlfn.ANCHORARRAY(Sheet2!B3))",
			"[@Amount]*2": "[@Amount]*2",
			"Table1[@Amount]": "Table1[@Amount]",
			"Table1[[#This Row],[Amount]]": "Table1[[#This Row],[Amount]]",
			"A1+#REF!": "A1+#REF!",
			"MyName+#N/A": "MyName+#N/A",
			'"MyName#"&A1': '"MyName#"&A1',
			"[1]Sheet1!A1#": "[1]Sheet1!A1#"
		}

		for (const [typed, file] of Object.entries(stored)) {
			expect(storedFormula(typed)).toBe(file)
			expect(shownFormula(storedFormula(typed))).toBe(typed)
		}
	})

	it("names only catalogue functions the engine calculates in its tables of calls", () => {
		for (const name of [...LAMBDA_HELPERS, ...SIZED_FUNCTIONS, ...RESIZED_FUNCTIONS, "LOOKUP"]) {
			expect(["hyperformula", "plugin"]).toContain(sheetFunction(name)?.support)
		}

		for (const name of LAMBDA_HELPERS) {
			expect(storedFormula(`${name}(A1:A3,SUM)`)).toBe(`${sheetFunction(name)?.prefix ?? ""}${name}(A1:A3,_xleta.SUM)`)
		}
	})

	it("finds an array-returning call by its whole name outside strings, stored with or without its prefixes", () => {
		expect(mayReturnArray('IF(A1="unique(x)",1,2)')).toBe(false)
		expect(mayReturnArray("MyFilter(A1)")).toBe(false)
		expect(mayReturnArray("MODEXMULT(A1)")).toBe(false)
		expect(mayReturnArray("_xlfn.UNIQUE(A1:A9)")).toBe(true)
		expect(mayReturnArray("_xlfn._xlws.FILTER(A1:A9,B1:B9)")).toBe(true)
		expect(mayReturnArray("_xlfn.MODE.MULT(A1:A9)")).toBe(true)
		expect(mayReturnArray('IF(A1="x",UNIQUE(B1:B9),1)')).toBe(true)
	})
})

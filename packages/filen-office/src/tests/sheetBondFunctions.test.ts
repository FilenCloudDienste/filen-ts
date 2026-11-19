import { describe, expect, it } from "vitest"
import { FormulaEngine, type EngineSheet } from "../core/sheet/formula/index"
import { engineCellFormula } from "../core/sheet/refs/formulaRefs"
import { budget } from "./timing"

// The bond and depreciation functions against each function's page on support.microsoft.com (its example, cited by
// the test) and the conditions the page gives #NUM! and #VALUE! for.

type Typed = string | number | boolean | null

// Builds an engine over one sheet from cells as typed ("=..." a formula in Excel's syntax) and returns the value of
// each formula cell by its A1 name, an error as "!#NUM!".
function calculate(rows: Typed[][]): Record<string, unknown> {
	const sheets: EngineSheet[] = [
		{
			name: "S",
			rows: rows.map(row =>
				row.map(cell => (typeof cell === "string" && cell.startsWith("=") ? (engineCellFormula(cell.slice(1)) ?? "") : cell))
			),
			formulas: []
		}
	]
	const engine = new FormulaEngine(sheets, [])
	const out: Record<string, unknown> = {}

	try {
		rows.forEach((row, r) =>
			row.forEach((cell, c) => {
				if (typeof cell !== "string" || !cell.startsWith("=")) return

				const result = engine.result(0, r, c)

				out[`${String.fromCharCode(65 + c)}${String(r + 1)}`] = result.error === true ? `!${String(result.value)}` : result.value
			})
		)
	} finally {
		engine.destroy()
	}

	return out
}

// The value of one formula.
function value(formula: string): unknown {
	return calculate([[formula]])["A1"]
}

// The values of formulas, each to the decimals given.
function values(formulas: readonly string[], decimals: number): unknown[] {
	return formulas.map(formula => {
		const result = value(formula)

		return typeof result === "number" ? Number(result.toFixed(decimals)) : result
	})
}

describe("ACCRINT", () => {
	// support.microsoft.com "ACCRINT function", its example: issue 39508 (2008-03-01), first interest 39691
	// (2008-08-31), settlement 39569 (2008-05-01), 10%, par 1000, semiannual, 30/360.
	it("accrues the quasi-coupon periods from issue to settlement", () => {
		expect(
			values(
				[
					"=ACCRINT(39508,39691,39569,0.1,1000,2,0)",
					"=ACCRINT(DATE(2008,3,5),39691,39569,0.1,1000,2,0,FALSE)",
					"=ACCRINT(DATE(2008,4,5),39691,39569,0.1,1000,2,0,TRUE)"
				],
				6
			)
		).toEqual([16.666667, 15.555556, 7.222222])
	})

	it("counts each quasi-coupon period by its own length in actual/actual", () => {
		// 2008-03-03 to 2009-01-01 is 304 days of the 365-day quasi-coupon period that ends at 2009-03-03.
		expect(value("=ACCRINT(DATE(2008,3,3),DATE(2009,3,3),DATE(2009,1,1),0.0433,10000000,1,1)")).toBeCloseTo((433000 * 304) / 365, 6)
		// 2012-02-02 to 2012-03-30 spans the quarters ending 2012-03-04 (91 days) and 2012-06-04 (92 days).
		expect(value("=ACCRINT(DATE(2012,2,2),DATE(2012,12,4),DATE(2012,3,30),0.1,1000,4,1)")).toBeCloseTo(25 * (31 / 91 + 26 / 92), 9)
	})

	it("accrues from first_interest when calc_method is FALSE and settlement is after it", () => {
		// "A value of FALSE (0) returns the accrued interest from first_interest to settlement."
		expect(value("=ACCRINT(DATE(2012,2,2),DATE(2012,3,30),DATE(2013,12,4),0.1,1000,1,0,FALSE)")).toBeCloseTo((100 * 604) / 360, 9)
		expect(value("=ACCRINT(DATE(2012,2,2),DATE(2012,3,30),DATE(2013,12,4),0.1,1000,1,0,TRUE)")).toBeCloseTo((100 * 662) / 360, 9)
		expect(value("=ACCRINT(DATE(2012,2,2),DATE(2012,3,30),DATE(2013,12,4),0.1,1000,1,0)")).toBeCloseTo((100 * 662) / 360, 9)
	})

	it("uses a par of 1000 when par is left empty", () => {
		// "If you omit par, ACCRINT uses $1,000."
		expect(values(["=ACCRINT(39508,39691,39569,0.1,,2,0)"], 6)).toEqual([16.666667])
	})

	it("gives #NUM! and #VALUE! where the page says", () => {
		expect(
			[
				"=ACCRINT(39508,39691,39569,0,1000,2,0)",
				"=ACCRINT(39508,39691,39569,0.1,-1,2,0)",
				"=ACCRINT(39508,39691,39569,0.1,1000,3,0)",
				"=ACCRINT(39508,39691,39569,0.1,1000,2,5)",
				"=ACCRINT(39569,39691,39569,0.1,1000,2,0)",
				'=ACCRINT("x",39691,39569,0.1,1000,2,0)',
				"=ACCRINT(-1,39691,39569,0.1,1000,2,0)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#VALUE!", "!#VALUE!"])
	})

	it("truncates the dates, frequency and basis", () => {
		expect(values(["=ACCRINT(39508.9,39691.2,39569.7,0.1,1000,2.9,0.5)"], 6)).toEqual([16.666667])
	})
})

describe("ACCRINTM", () => {
	// support.microsoft.com "ACCRINTM function": issue 39539, maturity 39614, 10%, 1000, actual/365.
	it("accrues interest at maturity", () => {
		expect(values(["=ACCRINTM(39539,39614,0.1,1000,3)"], 8)).toEqual([20.54794521])
	})

	it("gives #NUM! where the page says", () => {
		expect(
			[
				"=ACCRINTM(39539,39614,0,1000,3)",
				"=ACCRINTM(39539,39614,0.1,0,3)",
				"=ACCRINTM(39539,39614,0.1,1000,5)",
				"=ACCRINTM(39614,39539,0.1,1000,3)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})
})

describe("AMORDEGRC and AMORLINC", () => {
	// support.microsoft.com "AMORDEGRC function" and "AMORLINC function": cost 2400, purchased 39679, first period
	// ends 39813, salvage 300, period 1, rate 0.15, actual basis.
	it("depreciate the first period", () => {
		expect(value("=AMORDEGRC(2400,39679,39813,300,1,0.15,1)")).toBe(776)
		expect(value("=AMORLINC(2400,39679,39813,300,1,0.15,1)")).toBe(360)
	})

	it("refuse a life of assets the coefficients do not cover, and the actual/360 basis the pages do not list", () => {
		// "If the life of assets is between 0 (zero) and 1, 1 and 2, 2 and 3, or 4 and 5, the #NUM! error value is
		// returned." Basis 2 is not in either page's table.
		expect(
			[
				"=AMORDEGRC(2400,39679,39813,300,1,0.5,1)",
				"=AMORDEGRC(2400,39679,39813,300,1,0.22,1)",
				"=AMORDEGRC(2400,39679,39813,300,1,0.15,2)",
				"=AMORLINC(2400,39679,39813,300,1,0.15,2)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})

	it("depreciate nothing past the asset's end", () => {
		expect(value("=AMORLINC(2400,39679,39813,300,10,0.15,1)")).toBe(0)
		expect(value("=AMORDEGRC(2400,39679,39813,300,20,0.15,1)")).toBe(0)
	})

	it("answer at once for a far period once the write-down rounds to nothing", () => {
		// A rate of 1e-7 writes down less than half a unit of 1000 a period: 0 from the first period on.
		const started = performance.now()

		expect(value("=AMORDEGRC(1000,1,2,0,1E9,1E-7)")).toBe(0)
		expect(value("=AMORDEGRC(2400,39679,39813,300,1E9,0.15,1)")).toBe(0)
		expect(performance.now() - started).toBeLessThan(budget(1_000))
	})
})

describe("the coupon functions", () => {
	// support.microsoft.com "COUPDAYBS function", "COUPDAYS function", "COUPDAYSNC function", "COUPNCD function",
	// "COUPPCD function": settlement 2011-01-25, maturity 2011-11-15, semiannual, actual/actual.
	it("give the coupon period around settlement", () => {
		const args = "DATE(2011,1,25),DATE(2011,11,15),2,1"

		expect(
			[`=COUPDAYBS(${args})`, `=COUPDAYS(${args})`, `=COUPDAYSNC(${args})`, `=COUPNCD(${args})`, `=COUPPCD(${args})`].map(value)
		).toEqual([71, 181, 110, 40678, 40497])
	})

	it("count the coupons to maturity", () => {
		// support.microsoft.com "COUPNUM function": settlement 2007-01-25, maturity 2008-11-15.
		expect(value("=COUPNUM(DATE(2007,1,25),DATE(2008,11,15),2,1)")).toBe(4)
	})

	it("count the 30/360 and fixed-length bases", () => {
		const args = "DATE(2011,1,25),DATE(2011,11,15)"

		expect(
			[`=COUPDAYS(${args},2,0)`, `=COUPDAYS(${args},2,3)`, `=COUPDAYBS(${args},2,0)`, `=COUPDAYSNC(${args},4,4)`].map(value)
		).toEqual([180, 182.5, 70, 20])
	})

	it("keep a maturity on a month's last day on the last days", () => {
		expect([value("=COUPPCD(DATE(2011,4,15),DATE(2011,8,31),4,1)"), value("=COUPNCD(DATE(2011,4,15),DATE(2011,8,31),4,1)")]).toEqual([
			40602, 40694
		])
	})

	it("give #NUM! and #VALUE! where the pages say", () => {
		expect(
			[
				"=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),3,1)",
				"=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,5)",
				"=COUPNUM(DATE(2011,11,15),DATE(2011,11,15),2,1)",
				'=COUPNCD("x",DATE(2011,11,15),2,1)'
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#VALUE!"])
	})
})

describe("the discount securities", () => {
	it("give the page examples", () => {
		expect(
			values(
				[
					// support.microsoft.com "INTRATE function": 2008-02-15 to 2008-05-15, 1,000,000 for 1,014,420, actual/360.
					"=INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,2)",
					// "PRICEDISC function": 2008-02-16 to 2008-03-01, 5.25%, 100, actual/360.
					"=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)",
					// "YIELDDISC function": 2008-02-16 to 2008-03-01, 99.795, 100, actual/360.
					"=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,2)"
				],
				6
			)
		).toEqual([0.05768, 99.795833, 0.052823])
		// "RECEIVED function": 2008-02-15 to 2008-05-15, 1,000,000 at 5.75%, actual/360.
		expect(values(["=RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,2)"], 3)).toEqual([1014584.654])
	})

	it("discount at the rate the price gives", () => {
		expect(value("=DISC(DATE(2018,7,1),DATE(2019,7,1),97.975,100,0)")).toBeCloseTo(0.02025, 12)
	})

	it("give #NUM! where the pages say", () => {
		expect(
			[
				"=DISC(DATE(2018,7,1),DATE(2019,7,1),0,100,1)",
				"=DISC(DATE(2019,7,1),DATE(2018,7,1),97,100,1)",
				"=INTRATE(DATE(2008,2,15),DATE(2008,5,15),0,1014420,2)",
				"=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0,100,2)",
				"=RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0,2)",
				"=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,-1,2)",
				"=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,-1)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})
})

describe("PRICE and YIELD", () => {
	it("price and yield the page examples", () => {
		// support.microsoft.com "PRICE function": 2008-02-15 to 2017-11-15, 5.75%, 6.5%, 100, semiannual, 30/360.
		expect(values(["=PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,0)"], 2)).toEqual([94.63])
		// "YIELD function": 2008-02-15 to 2016-11-15, 5.75%, 95.04287, 100, semiannual, 30/360.
		expect(values(["=YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,0)"], 6)).toEqual([0.065])
	})

	it("yields the price back", () => {
		const price = value("=PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,1)") as number

		expect(value(`=YIELD(DATE(2008,2,15),DATE(2017,11,15),0.0575,${String(price)},100,2,1)`)).toBeCloseTo(0.065, 12)
	})

	it("price and yield one coupon period to redemption in closed form", () => {
		// PRICE: "one equation when N > 1 and another when N = 1"; YIELD's one for one coupon period or less.
		const price = value("=PRICE(DATE(2008,2,15),DATE(2008,6,15),0.0575,0.065,100,2,0)") as number

		expect(price).toBeCloseTo((100 + 2.875) / (1 + (120 / 180) * 0.0325) - 2.875 * (60 / 180), 12)
		expect(value(`=YIELD(DATE(2008,2,15),DATE(2008,6,15),0.0575,${String(price)},100,2,0)`)).toBeCloseTo(0.065, 12)
	})

	it("give #NUM! where the pages say", () => {
		const args = "DATE(2008,2,15),DATE(2017,11,15),0.0575"

		expect(
			[
				`=PRICE(${args},-0.01,100,2,0)`,
				`=PRICE(${args},0.065,0,2,0)`,
				`=PRICE(${args},0.065,100,3,0)`,
				`=YIELD(${args},0,100,2,0)`,
				`=YIELD(${args},95,100,2,-1)`,
				"=YIELD(DATE(2008,2,15),DATE(2017,11,15),-0.01,95,100,2,0)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})
})

describe("DURATION and MDURATION", () => {
	it("give the page examples", () => {
		// support.microsoft.com "DURATION function": 2018-07-01 to 2048-01-01, 8%, 9%, semiannual, actual/actual.
		expect(values(["=DURATION(DATE(2018,7,1),DATE(2048,1,1),0.08,0.09,2,1)"], 7)).toEqual([10.9191453])
		// "MDURATION function": 2008-01-01 to 2016-01-01, 8%, 9%, semiannual, actual/actual.
		expect(values(["=MDURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)"], 3)).toEqual([5.736])
	})

	it("give #NUM! where the pages say", () => {
		expect(
			[
				"=DURATION(DATE(2018,7,1),DATE(2048,1,1),-0.08,0.09,2,1)",
				"=MDURATION(DATE(2018,7,1),DATE(2048,1,1),0.08,-0.09,2,1)",
				"=MDURATION(DATE(2048,1,1),DATE(2018,7,1),0.08,0.09,2,1)",
				"=DURATION(DATE(2018,7,1),DATE(2048,1,1),0.08,0.09,12,1)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})
})

describe("the odd-period bonds", () => {
	it("give the page examples", () => {
		// support.microsoft.com "ODDFPRICE function": settlement 2008-11-11, maturity 2021-03-01, issue 2008-10-15,
		// first coupon 2009-03-01, 7.85%, 6.25%, 100, semiannual, actual/actual.
		expect(values(["=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)"], 2)).toEqual([
			113.6
		])
		// "ODDFYIELD function": the same dates, 5.75%, 84.50, 100, semiannual, 30/360.
		expect(values(["=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0575,84.5,100,2,0)"], 4)).toEqual([
			0.0772
		])
		// "ODDLPRICE function": settlement 2008-02-07, maturity 2008-06-15, last interest 2007-10-15, 3.75%, 4.05%.
		expect(values(["=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,0)"], 8)).toEqual([99.87828601])
		// "ODDLYIELD function": settlement 2008-04-20, maturity 2008-06-15, last interest 2007-12-24, 3.75%, 99.875.
		expect(values(["=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,100,2,0)"], 5)).toEqual([0.04519])
	})

	it("price a long first period over its quasi-coupon periods, and yield it back", () => {
		const args = "DATE(2008,11,11),DATE(2021,3,1),DATE(2008,1,15),DATE(2009,3,1),0.0785"
		const price = value(`=ODDFPRICE(${args},0.0625,100,2,1)`) as number

		expect(price).toBeGreaterThan(100)
		expect(value(`=ODDFYIELD(${args},${String(price)},100,2,1)`)).toBeCloseTo(0.0625, 10)
	})

	it("give #NUM! where the pages say", () => {
		expect(
			[
				"=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),-0.01,0.0625,100,2,1)",
				"=ODDFPRICE(DATE(2009,3,1),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)",
				"=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0575,0,100,2,0)",
				"=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2008,2,7),0.0375,0.0405,100,2,0)",
				"=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,0,100,2,0)",
				"=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,5)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})

	it("price a zero coupon rate", () => {
		// "If rate < 0 or if yld < 0, ODDLPRICE returns the #NUM! error value": a rate of 0 prices.
		expect(typeof value("=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0,0.0405,100,2,0)")).toBe("number")
	})
})

describe("PRICEMAT and YIELDMAT", () => {
	it("give the page examples", () => {
		// support.microsoft.com "PRICEMAT function": settlement 2008-02-15, maturity 2008-04-13, issue 2007-11-11,
		// 6.1%, 6.1%, 30/360.
		expect(values(["=PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)"], 8)).toEqual([99.98449888])
		// "YIELDMAT function": settlement 2008-03-15, maturity 2008-11-03, issue 2007-11-08, 6.25%, 100.0123, 30/360.
		expect(values(["=YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)"], 6)).toEqual([0.060954])
	})

	it("give #NUM! where the pages say", () => {
		expect(
			[
				"=PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),-0.061,0.061,0)",
				"=PRICEMAT(DATE(2008,4,13),DATE(2008,2,15),DATE(2007,11,11),0.061,0.061,0)",
				"=YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,0,0)",
				"=YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100,5)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})
})

describe("VDB", () => {
	// support.microsoft.com "VDB function": cost 2400, salvage 300, life 10 years.
	it("gives the page examples", () => {
		expect(
			values(
				[
					"=VDB(2400,300,10*365,0,1)",
					"=VDB(2400,300,10*12,0,1)",
					"=VDB(2400,300,10,0,1)",
					"=VDB(2400,300,10*12,6,18)",
					"=VDB(2400,300,10*12,6,18,1.5)",
					"=VDB(2400,300,10,0,0.875,1.5)"
				],
				2
			)
		).toEqual([1.32, 40, 480, 396.31, 311.81, 315])
	})

	it("switches to straight line unless no_switch", () => {
		expect(values(["=VDB(100000,20000,10,4,5,1)", "=VDB(100000,20000,10,4,5,1,TRUE)"], 6)).toEqual([7557.142857, 6561])
	})

	it("prorates fractional start and end periods, with and without the switch", () => {
		expect(
			values(
				[
					"=VDB(2400,300,10,0.5,3.75,2,TRUE)",
					"=VDB(2400,300,10,2.5,9.25,2)",
					"=VDB(2400,300,10,8.25,9.75,1.5)",
					"=VDB(2400,300,10,6.5,9.5,2,TRUE)",
					"=VDB(2400,300,3,0.5,2.5,10,TRUE)",
					"=VDB(2400,300,10,0.5,9.5,4,TRUE)"
				],
				6
			)
		).toEqual([1115.52, 1065.80809, 226.934564, 255.169766, 1050, 1620])
	})

	it("ends within a bounded time for any life", () => {
		const started = performance.now()

		expect(
			values(
				["=VDB(1000,0,1E13,0,1E13)", "=VDB(1000,0,1E13,0,1E13,2,TRUE)", "=VDB(1000,0,1E6,0,1E6)", "=VDB(1000,0,1E6,0,1E6,2,TRUE)"],
				6
			)
		).toEqual(["!#NUM!", "!#NUM!", 1000, 864.664987])
		expect(performance.now() - started).toBeLessThan(budget(1_000))
	})

	it("gives #NUM! for arguments that are not positive", () => {
		// "All arguments except no_switch must be positive numbers."
		expect(
			[
				"=VDB(-1,300,10,0,1)",
				"=VDB(2400,-1,10,0,1)",
				"=VDB(2400,300,0,0,1)",
				"=VDB(2400,300,10,-1,1)",
				"=VDB(2400,300,10,0,1,0)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})
})

describe("the 1904 date system", () => {
	it("reads and gives coupon dates as the workbook's serials", () => {
		const sheets: EngineSheet[] = [
			{ name: "S", rows: [[engineCellFormula("COUPNCD(DATE(2011,1,25),DATE(2011,11,15),2,1)") ?? ""]], formulas: [] }
		]
		const engine = new FormulaEngine(sheets, [], true)

		try {
			expect(engine.result(0, 0, 0).value).toBe(40678 - 1462)
		} finally {
			engine.destroy()
		}
	})
})

// Where Microsoft's pages give no algorithm, LibreOffice's analysis add-in decides (its function workbooks' results).
describe("the conventions the pages leave open", () => {
	it("count the US 30/360 basis of the discount securities by month, February its own length within a year", () => {
		expect(value("=INTRATE(DATE(2009,2,2),DATE(2009,12,3),1000,1080,0)")).toBeCloseTo(0.0963210702341138, 14)
	})

	it("read a 31st as the 30th in the European basis", () => {
		expect(value("=PRICEDISC(DATE(2023,1,5),DATE(2023,1,31),0.038,100,4)")).toBeCloseTo(100 * (1 - (0.038 * 25) / 360), 12)
	})

	it("round each degressive write-down to a whole number", () => {
		expect(value("=AMORDEGRC(10000,DATE(2012,3,1),DATE(2012,12,31),1500,1,0.31,1)")).toBe(2848)
	})

	it("count a coupon period's actual days to the next coupon in actual/360", () => {
		expect(value("=COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,2)")).toBe(110)
	})

	it("refuse what has no meaning: a yield before issue, a redemption of 0, a salvage above cost", () => {
		expect(
			[
				"=YIELDMAT(DATE(2007,11,1),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)",
				"=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,0,2,0)",
				"=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,0,2,0)",
				"=VDB(2400,3000,10,0,1)"
			].map(value)
		).toEqual(["!#NUM!", "!#NUM!", "!#NUM!", "!#NUM!"])
	})
})

describe("the yield solvers", () => {
	it("end within their bounded steps for any price, in a yield or #NUM!", () => {
		const args = "DATE(2008,2,15),DATE(2097,11,15),0.0575"

		for (const price of ["1E-300", "0.0001", "100000", "1E+300"]) {
			const result = value(`=YIELD(${args},${price},100,4,1)`)

			expect(typeof result === "number" ? Number.isFinite(result) : result === "!#NUM!").toBe(true)
		}
	})

	it("yield below zero for a price above the cash flows", () => {
		expect(value("=YIELD(DATE(2008,2,15),DATE(2017,11,15),0.0575,200,100,2,0)")).toBeLessThan(0)
	})
})

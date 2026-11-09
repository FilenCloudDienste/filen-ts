import { afterEach, describe, expect, it, vi } from "vitest"
import { FormulaEngine } from "../core/sheet/formula/index"
import { textDateParser } from "../core/sheet/formula/textDates"
import type { SheetLocale } from "../core/sheet/protocol"

// Text read as a date inside a formula, as Excel reads it by the system's date settings and as a typed entry reads
// it here: support.microsoft.com "DATEVALUE function" gives =DATEVALUE("8/22/2011") as 40777 (en-US).

function results(formulas: readonly string[], locale?: SheetLocale, date1904 = false): unknown[] {
	const engine = new FormulaEngine([{ name: "S", rows: [[...formulas]], formulas: [] }], [], date1904, undefined, undefined, locale)

	try {
		return formulas.map((_, col) => engine.result(0, 0, col).value)
	} finally {
		engine.destroy()
	}
}

describe("text dates in formulas", () => {
	it("read month first in en-US, and ISO dates", () => {
		expect(
			results([
				'=DATEVALUE("8/22/2011")',
				'=MONTH("5/1/2020")',
				'=DATEVALUE("2011-08-22")',
				'=MONTH("13/1/2020")',
				'=DATEVALUE("2/30/2020")'
			])
		).toEqual([40777, 5, 40777, "#VALUE!", "#VALUE!"])
	})

	it("read day first where the locale writes dates so, ISO dates still", () => {
		const de: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }

		expect(results(['=DATEVALUE("22.8.2011")', '=MONTH("5/1/2020")', '=DATEVALUE("2011-08-22")'], de)).toEqual([40777, 1, 40777])
	})

	it("read times alone and after a date, with AM and PM", () => {
		const [half, evening, both, bad] = results([
			'=TIMEVALUE("12:00")',
			'=TIMEVALUE("6:30 PM")',
			'=DATEVALUE("8/22/2011 6:30 PM")+TIMEVALUE("8/22/2011 6:30 PM")',
			'=TIMEVALUE("10:75")'
		])

		expect(half).toBe(0.5)
		expect(evening).toBeCloseTo(18.5 / 24, 12)
		expect(both).toBeCloseTo(40777 + 18.5 / 24, 9)
		expect(bad).toBe("#VALUE!")
	})

	it("read text in arithmetic as a date, as a typed date reads", () => {
		expect(results(['="1/2/2020"+1', '="2020-01-02"-1'])).toEqual([43833, 43831])
	})
})

// support.microsoft.com "DATEVALUE function" and "TIMEVALUE function": their own examples.
describe("text dates with month names and without a year", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("read Microsoft's DATEVALUE and TIMEVALUE examples", () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date(2011, 5, 15, 12))

		const [may, july, time, plus] = results([
			'=DATEVALUE("22-MAY-2011")',
			'=DATEVALUE("5-JUL")',
			'=TIMEVALUE("22-Aug-2011 6:35 AM")',
			'="5-Jan-2024"+0'
		])

		expect(may).toBe(40685)
		expect(july).toBe(40729)
		expect(time).toBeCloseTo(0.2743, 4)
		expect(plus).toBe(45296)
	})

	it("read 1900-02-29 as serial 60 in the 1900 date system only", () => {
		expect(results(['=DATEVALUE("2/29/1900")', '=DATEVALUE("3/1/1900")'])).toEqual([60, 61])
		expect(results(['=DATEVALUE("2/29/1900")'], undefined, true)).toEqual(["#VALUE!"])
		expect(results(['=DATEVALUE("2/29/1901")'])).toEqual(["#VALUE!"])
	})

	it("read month names before or after the day, in full or short, any case", () => {
		const parse = textDateParser(undefined, () => new Date(2024, 0, 10).getTime())

		expect(parse("January 5, 2024")).toEqual({ year: 2024, month: 1, day: 5 })
		expect(parse("jan 5 2024")).toEqual({ year: 2024, month: 1, day: 5 })
		expect(parse("5 January 2024")).toEqual({ year: 2024, month: 1, day: 5 })
		expect(parse("5/Sept/24")).toEqual({ year: 2024, month: 9, day: 5 })
		expect(parse("Jan-24")).toEqual({ year: 2024, month: 1, day: 24 })
		expect(parse("Feb-32")).toEqual({ year: 1932, month: 2, day: 1 })
		expect(parse("Mar-2023")).toEqual({ year: 2023, month: 3, day: 1 })
		expect(parse("5 Jan 2024 6:35 PM")).toEqual({ year: 2024, month: 1, day: 5, hours: 18, minutes: 35, seconds: 0 })
		expect(parse("31-Feb-2024")).toBeUndefined()
		expect(parse("5-Janu-2024")).toBeUndefined()
		expect(parse("Ma 5")).toBeUndefined()
	})

	it("read a day and month without a year in the clock's year, in the locale's order", () => {
		const now = (): number => new Date(2024, 6, 1).getTime()
		const us = textDateParser(undefined, now)
		const gb = textDateParser({ decimal: ".", group: ",", argument: ",", dateOrder: "dmy" }, now)

		expect(us("1/2")).toEqual({ year: 2024, month: 1, day: 2 })
		expect(gb("1/2")).toEqual({ year: 2024, month: 2, day: 1 })
		expect(us("5/32")).toEqual({ year: 1932, month: 5, day: 1 })
		expect(us("1/2024")).toEqual({ year: 2024, month: 1, day: 1 })
		expect(us("2024-3")).toEqual({ year: 2024, month: 3, day: 1 })
		expect(us("13/5")).toBeUndefined()
		expect(us("1.5")).toBeUndefined()
	})
})

import { describe, expect, it } from "vitest"
import { parseCellInput } from "../core/sheet/input/cellInput"
import { entryNumber } from "../core/sheet/input/locale"
import type { SheetLocale } from "../core/sheet/protocol"
import { readEntry } from "../core/xlsx/edit/cells"

// Entries Excel recognises as numbers, times and dates when typed, with the format each implies.

const US: SheetLocale = { decimal: ".", group: ",", argument: ",", dateOrder: "mdy" }
const DE: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy", currencies: ["€"] }
const YEAR = 2025

function entry(input: string, locale: SheetLocale = US, year: number | null = YEAR) {
	return readEntry(input, false, false, locale, year ?? undefined)
}

describe("numbers typed with currency, parentheses, fractions and exponents", () => {
	it("read in en-US with the format each implies", () => {
		expect(entry("$1,234.50")).toEqual({ type: "number", value: 1234.5, format: "$#,##0.00" })
		expect(entry("$5")).toEqual({ type: "number", value: 5, format: "$#,##0" })
		expect(entry("-$5")).toEqual({ type: "number", value: -5, format: "$#,##0" })
		expect(entry("($5.25)")).toEqual({ type: "number", value: -5.25, format: "$#,##0.00" })
		expect(entry("(123)")).toEqual({ type: "number", value: -123 })
		expect(entry("(1,000)")).toEqual({ type: "number", value: -1000, format: "#,##0" })
		expect(entry("1 1/2")).toEqual({ type: "number", value: 1.5, format: "# ?/?" })
		expect(entry("0 1/2")).toEqual({ type: "number", value: 0.5, format: "# ?/?" })
		expect(entry("-2 3/16")).toEqual({ type: "number", value: -2.1875, format: "# ??/??" })
		expect(entry("1e5")).toEqual({ type: "number", value: 100000, format: "0.00E+00" })
		expect(entry("1,000%")).toEqual({ type: "number", value: 10, format: "#,##0%" })
	})

	it("keep a trailing sign, a fraction past two digits and words as text", () => {
		expect(entry("5-")).toEqual({ type: "text", text: "5-" })
		expect(entry("1 1/128")).toEqual({ type: "text", text: "1 1/128" })
		expect(entry("$")).toEqual({ type: "text", text: "$" })
		expect(entry("(5")).toEqual({ type: "text", text: "(5" })
		expect(entry("hello")).toEqual({ type: "text", text: "hello" })
	})

	it("read with a ',' decimal and the locale's currency after the number", () => {
		expect(entry("1.234,50 €", DE)).toEqual({ type: "number", value: 1234.5, format: '#,##0.00\\ "€"' })
		expect(entry("(1.000)", DE)).toEqual({ type: "number", value: -1000, format: "#,##0" })
		expect(entry("1 1/2", DE)).toEqual({ type: "number", value: 1.5, format: "# ?/?" })
		expect(entry("1,5e3", DE)).toEqual({ type: "number", value: 1500, format: "0.00E+00" })
		// No "$" where it is not the locale's currency.
		expect(entryNumber("$5", DE)).toBeNull()
	})
})

describe("times typed", () => {
	it("read AM/PM and elapsed hours", () => {
		expect(entry("2:30 PM")).toEqual({ type: "number", value: 14.5 / 24, format: "h:mm AM/PM" })
		expect(entry("9:30 am")).toEqual({ type: "number", value: 9.5 / 24, format: "h:mm AM/PM" })
		expect(entry("12:00 AM")).toEqual({ type: "number", value: 0, format: "h:mm AM/PM" })
		expect(entry("2 p")).toEqual({ type: "number", value: 14 / 24, format: "h AM/PM" })
		expect(entry("25:00")).toEqual({ type: "number", value: 25 / 24, format: "[h]:mm:ss" })
		expect(entry("14:30")).toEqual({ type: "number", value: 14.5 / 24, format: "h:mm" })
		expect(entry("13:30 PM")).toEqual({ type: "text", text: "13:30 PM" })
	})

	it("read the same without a locale", () => {
		expect(readEntry("2:30 PM", false, false)).toEqual({ type: "number", value: 14.5 / 24, format: "h:mm AM/PM" })
		expect(readEntry("2024-03-05 14:30", false, false)).toEqual({
			type: "number",
			value: 45356 + 14.5 / 24,
			format: "yyyy-mm-dd hh:mm"
		})
	})
})

describe("dates typed", () => {
	// 2025-01-01 is serial 45658.
	it("read month names, with or without a year or a day", () => {
		expect(entry("15-Mar-2025")).toEqual({ type: "number", value: 45731, format: "d-mmm-yy" })
		expect(entry("March 15, 2025")).toEqual({ type: "number", value: 45731, format: "d-mmm-yy" })
		expect(entry("1-Jan")).toEqual({ type: "number", value: 45658, format: "d-mmm" })
		expect(entry("Jan-2025")).toEqual({ type: "number", value: 45658, format: "mmm-yy" })
		expect(entry("Jan-32")).toEqual({ type: "number", value: 11689, format: "mmm-yy" })
	})

	it("read a day and month in the clock's year, in the locale's order", () => {
		expect(entry("3/15")).toEqual({ type: "number", value: 45731, format: "d-mmm" })
		expect(entry("15/3", DE)).toEqual({ type: "number", value: 45731, format: "d-mmm" })
		expect(entry("3/2025")).toEqual({ type: "number", value: 45717, format: "mmm-yy" })
		expect(entry("1/13", DE)).toEqual({ type: "number", value: 41275, format: "mmm-yy" })
		// "." is en-US's decimal point, "," de-DE's: numbers, not dates.
		expect(entry("1.5")).toEqual({ type: "number", value: 1.5 })
		expect(entry("1,5", DE)).toEqual({ type: "number", value: 1.5 })
	})

	it("leave a date without a year as text when no clock year is given", () => {
		expect(entry("3/15", US, null)).toEqual({ type: "text", text: "3/15" })
		expect(entry("1-Jan", US, null)).toEqual({ type: "text", text: "1-Jan" })
		expect(entry("12/31/2025", US, null)).toEqual({ type: "number", value: 46022, format: "m/d/yyyy" })
	})

	it("read a date with a time after it", () => {
		expect(entry("12/31/2025 14:30")).toEqual({ type: "number", value: 46022 + 14.5 / 24, format: "m/d/yyyy h:mm" })
		expect(entry("31.12.2025 14:30", DE)).toEqual({ type: "number", value: 46022 + 14.5 / 24, format: "dd/mm/yyyy h:mm" })
		expect(entry("12/31/2025 2:30 PM")).toEqual({ type: "number", value: 46022 + 14.5 / 24, format: "m/d/yyyy h:mm AM/PM" })
		expect(entry("12/31/2025 25:00")).toEqual({ type: "text", text: "12/31/2025 25:00" })
		expect(entry("Meeting at 10:30")).toEqual({ type: "text", text: "Meeting at 10:30" })
	})

	it("carry the time of day in the parsed value", () => {
		const parsed = parseCellInput("12/31/2025 14:30", US)

		expect(parsed.type === "value" && parsed.value instanceof Date ? parsed.value.toISOString() : null).toBe("2025-12-31T14:30:00.000Z")
	})
})

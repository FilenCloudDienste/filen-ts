import { describe, expect, it } from "vitest"
import { formatValue, NUMFMT_EN_US, SYSTEM_DATE_TIME, SYSTEM_SHORT_DATE, type NumFmtLocale } from "@filen/office/core/sheet"
import { numFmtLocaleOf } from "@/features/spreadsheet/formulaBar/numFmtLocale"
import { sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"

// 2023-03-15 18:00 (a Wednesday).
const EVENING = 45000.75

function shown(locale: NumFmtLocale): { short: string; dateTime: string; long: string; time: string } {
	return {
		short: formatValue(EVENING, SYSTEM_SHORT_DATE, { locale }).text,
		dateTime: formatValue(EVENING, SYSTEM_DATE_TIME, { locale }).text,
		long: formatValue(EVENING, "[$-F800]dddd, mmmm dd, yyyy", { locale }).text,
		time: formatValue(EVENING, "[$-F400]h:mm:ss AM/PM", { locale }).text
	}
}

describe("the number format locale built from Intl", () => {
	it("gives en-US Excel's own patterns and names", () => {
		const locale = numFmtLocaleOf("en-US", ".", ",")

		expect(locale.shortDate).toBe('m"/"d"/"yyyy')
		expect(locale.months).toEqual(NUMFMT_EN_US.months)
		expect(locale.daysShort).toEqual(NUMFMT_EN_US.daysShort)
		expect([locale.am, locale.pm]).toEqual(["AM", "PM"])
		expect(shown(locale)).toEqual({
			short: "3/15/2023",
			dateTime: "3/15/2023 18:00",
			long: "Wednesday, March 15, 2023",
			time: "6:00:00 PM"
		})
	})

	it("shows dates in the locale's order, separators and names", () => {
		expect(shown(numFmtLocaleOf("en-GB", ".", ","))).toMatchObject({
			short: "15/03/2023",
			long: "Wednesday, 15 March 2023",
			time: "18:00:00"
		})
		expect(shown(numFmtLocaleOf("de-DE", ",", "."))).toMatchObject({ short: "15.3.2023", long: "Mittwoch, 15. März 2023" })
		expect(shown(numFmtLocaleOf("ja-JP", ".", ","))).toMatchObject({ short: "2023/3/15", long: "2023年3月15日水曜日" })
		expect(formatValue(EVENING, "d mmmm yyyy", { locale: numFmtLocaleOf("ru-RU", ",", " ") }).text).toBe("15 марта 2023")
		expect(numFmtLocaleOf("ja-JP", ".", ",").months[10]).toBe("11月")
	})

	it("reads Gregorian dates in Latin digits whatever the locale's calendar", () => {
		expect(shown(numFmtLocaleOf("fa-IR", "٫", "٬")).short).toBe("2023/3/15")
		expect(shown(numFmtLocaleOf("th-TH", ".", ",")).short).toBe("15/3/2023")
	})

	it("falls back to en-US's for an unknown tag, with the given separators", () => {
		expect(numFmtLocaleOf("not a tag", ",", ".")).toEqual({ ...NUMFMT_EN_US, decimal: ",", group: "." })
	})
})

describe("the sheet locale", () => {
	it("carries the number format locale with its own separators, built once per language", () => {
		const locale = sheetLocaleOf("de-DE")

		expect(locale.numFmt).toMatchObject({ decimal: ",", group: ".", shortDate: 'd"."m"."yyyy' })
		expect(sheetLocaleOf("de-DE")).toBe(locale)
	})
})

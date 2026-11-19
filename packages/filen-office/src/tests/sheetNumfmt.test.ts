import { describe, expect, it } from "vitest"
import {
	builtinFormatCode,
	NUMFMT_EN_US,
	formatGeneral,
	formatNumberInto,
	formatValue,
	IMPLIED_BUILTINS,
	numFmt,
	NumFmtOutput,
	parseNumFmt,
	type NumFmtLocale,
	type NumFmtOptions
} from "../core/sheet/numfmt"
import { budget } from "./timing"

const FIGURE = " "

function text(value: number | string | boolean, code: string, options?: NumFmtOptions): string {
	return formatValue(value, code, options).text
}

// Seconds of a day as a serial.
function time(hours: number, minutes: number, seconds: number): number {
	return (hours * 3600 + minutes * 60 + seconds) / 86400
}

describe("number format codes: support.microsoft.com examples", () => {
	it("shows digits through 0, # and ?", () => {
		expect(text(1234.59, "####.#")).toBe("1234.6")
		expect(text(8.9, "#.000")).toBe("8.900")
		expect(text(0.631, "0.#")).toBe("0.6")
		expect(text(12, "#.0#")).toBe("12.0")
		expect(text(1234.568, "#.0#")).toBe("1234.57")
		expect(text(0.631, "#.0")).toBe(".6")
	})

	it("aligns decimals and fractions with ?", () => {
		expect(text(44.398, "???.???")).toBe(`${FIGURE}44.398`)
		expect(text(102.65, "???.???")).toBe(`102.65${FIGURE}`)
		expect(text(2.8, "???.???")).toBe(`${FIGURE}${FIGURE}2.8${FIGURE}${FIGURE}`)
		expect(text(5.25, "# ???/???")).toBe(`5 ${FIGURE}${FIGURE}1/4${FIGURE}${FIGURE}`)
		expect(text(5.3, "# ???/???")).toBe(`5 ${FIGURE}${FIGURE}3/10${FIGURE}`)
	})

	it("groups thousands and scales by trailing commas", () => {
		expect(text(12000, "#,###")).toBe("12,000")
		expect(text(12000, "#,")).toBe("12")
		expect(text(12200000, "0.0,,")).toBe("12.2")
		expect(text(1234567.891, "#,##0.00")).toBe("1,234,567.89")
	})

	it("shows leading zeros", () => {
		expect(text(12, "00000")).toBe("00012")
		expect(text(123, '"000"#')).toBe("000123")
		expect(text(123, '"0"#')).toBe("0123")
	})

	it("shows text in quotes, after a backslash, and through @", () => {
		expect(text(5, '$0.00" Surplus";$-0.00" Shortage"')).toBe("$5.00 Surplus")
		expect(text(-5, '$0.00" Surplus";$-0.00" Shortage"')).toBe("$-5.00 Shortage")
		expect(text("Q1", '"gross receipts for "@')).toBe("gross receipts for Q1")
		expect(text(3, "0\\ \\h")).toBe("3 h")
	})

	it("hides zeros or everything with empty sections", () => {
		expect(text(0, "0;-0;;@")).toBe("")
		expect(text(-4, "0;-0;;@")).toBe("-4")
		expect(text("x", "0;-0;;@")).toBe("x")
		expect(text(5, ";;;")).toBe("")
		expect(text("x", ";;;")).toBe("")
	})

	it("pads with _x and repeats with *x", () => {
		expect(text(1234, "#,##0_);(#,##0)")).toBe("1,234 ")
		expect(text(-1234, "#,##0_);(#,##0)")).toBe("(1,234)")
		expect(formatValue(5, "0*-")).toEqual({ text: "5", repeat: { offset: 1, char: "-" } })
		expect(formatValue(5, "*00")).toEqual({ text: "5", repeat: { offset: 0, char: "0" } })
	})

	it("multiplies percentages by 100 and shows scientific notation", () => {
		expect(text(0.08, "0%")).toBe("8%")
		expect(text(0.123, "0.0%")).toBe("12.3%")
		expect(text(12345, "0.00E+00")).toBe("1.23E+04")
		expect(text(0.000123, "0.00E-00")).toBe("1.23E-04")
		expect(text(12345, "0.00E-00")).toBe("1.23E04")
	})

	it("applies colours and conditions", () => {
		expect(formatValue(50, "[Red][<=100];[Blue][>100]").color).toBe(0xff0000)
		expect(formatValue(150, "[Red][<=100];[Blue][>100]").color).toBe(0x0000ff)
		expect(formatValue(-3, "0;[Red]0").color).toBe(0xff0000)
		expect(formatValue(3, "[Color10]0").color).toBe(0x008000)
		expect(formatValue(3, "[Color10]0", { palette: [...Array(64).keys()] }).color).toBe(17)
	})

	it("shows dates through the date codes", () => {
		const day = 45000 // 2023-03-15, a Wednesday

		expect(text(day, "yy")).toBe("23")
		expect(text(day, "yyyy")).toBe("2023")
		expect(text(day, "m")).toBe("3")
		expect(text(day, "mm")).toBe("03")
		expect(text(day, "mmm")).toBe("Mar")
		expect(text(day, "mmmm")).toBe("March")
		expect(text(day, "mmmmm")).toBe("M")
		expect(text(day, "d")).toBe("15")
		expect(text(day, "dd")).toBe("15")
		expect(text(day, "ddd")).toBe("Wed")
		expect(text(day, "dddd")).toBe("Wednesday")
	})

	it("shows times, 12-hour clocks and fractions of a second", () => {
		const pm = time(16, 36, 3.75)

		expect(text(time(4, 36, 0), "h AM/PM")).toBe("4 AM")
		expect(text(pm, "h:mm AM/PM")).toBe("4:36 PM")
		expect(text(pm, "h:mm:ss A/P")).toBe("4:36:03 P")
		expect(text(pm, "h:mm:ss.00")).toBe("16:36:03.75")
		expect(text(pm, "h")).toBe("16")
		expect(text(time(4, 5, 6), "hh:mm:ss")).toBe("04:05:06")
		expect(text(time(4, 5, 6), "h:m:s")).toBe("4:5:6")
	})

	it("shows elapsed time", () => {
		const elapsed = 3735.8 / 86400

		expect(text(elapsed, "[h]:mm")).toBe("1:02")
		expect(text(elapsed, "[mm]:ss")).toBe("62:16")
		expect(text(elapsed, "[ss].00")).toBe("3735.80")
		expect(text(1.5, "[h]:mm:ss")).toBe("36:00:00")
	})

	it("reads m as minutes after h or before s, else as the month", () => {
		const value = 45000 + time(10, 7, 9)

		expect(text(value, "h:m")).toBe("10:7")
		expect(text(value, "m:ss")).toBe("7:09")
		expect(text(value, "m/d h:mm")).toBe("3/15 10:07")
		expect(text(value, "yyyy-mm-dd hh:mm:ss")).toBe("2023-03-15 10:07:09")
	})
})

describe("built-in formats", () => {
	it("are Excel's (MS-OI29500 §2.1.712)", () => {
		expect(builtinFormatCode(14, NUMFMT_EN_US)).toBe("m/d/yyyy")
		expect(builtinFormatCode(22, NUMFMT_EN_US)).toBe("m/d/yyyy h:mm")
		expect(builtinFormatCode(37, NUMFMT_EN_US)).toBe("#,##0_);(#,##0)")
		expect(builtinFormatCode(47, NUMFMT_EN_US)).toBe("mm:ss.0")
		expect(builtinFormatCode(49, NUMFMT_EN_US)).toBe("@")
		expect(builtinFormatCode(23, NUMFMT_EN_US)).toBeUndefined()
		expect(text(45000.5, builtinFormatCode(22, NUMFMT_EN_US) ?? "")).toBe("3/15/2023 12:00")
		expect(text(-1234, builtinFormatCode(38, NUMFMT_EN_US) ?? "")).toBe("(1,234)")
		expect(formatValue(-1234, builtinFormatCode(38, NUMFMT_EN_US) ?? "").color).toBe(0xff0000)
	})

	it("take language-dependent ids from the locale", () => {
		const ko: NumFmtLocale = { ...NUMFMT_EN_US, builtins: IMPLIED_BUILTINS["ko-KR"] }

		expect(builtinFormatCode(55, ko)).toBe("yyyy/mm/dd")
		expect(builtinFormatCode(44, NUMFMT_EN_US)).toBe('_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)')
		expect(text(45000, builtinFormatCode(31, ko) ?? "")).toBe("2023년 03월 15일")
		expect(text(45000, IMPLIED_BUILTINS["th-TH"][71] ?? "")).toBe("15/3/2023")
		expect(text(1234, IMPLIED_BUILTINS["th-TH"][61] ?? "")).toBe("๑,๒๓๔")
		expect(text(time(14, 5, 0), IMPLIED_BUILTINS["zh-CN"][32] ?? "")).toBe("14时05分")
		expect(text(time(14, 5, 0), IMPLIED_BUILTINS["zh-TW"][34] ?? "")).toBe("下午02時05分")
	})

	it("show the accounting formats as Excel writes them", () => {
		const accounting = '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'

		expect(formatValue(1234.5, accounting)).toEqual({ text: " 1,234.50 ", repeat: { offset: 1, char: " " } })
		expect(formatValue(-1234.5, accounting)).toEqual({ text: " (1,234.50)", repeat: { offset: 1, char: " " } })
		expect(formatValue(0, accounting)).toEqual({ text: ` -${FIGURE}${FIGURE} `, repeat: { offset: 1, char: " " } })
		expect(formatValue("x", accounting)).toEqual({ text: " x " })
	})
})

describe("General", () => {
	it("shows at most 11 characters, the sign excluded (ECMA-376 Part 1 §18.8.30)", () => {
		expect(formatGeneral(0)).toBe("0")
		expect(formatGeneral(1 / 3)).toBe("0.333333333")
		expect(formatGeneral(12345678901)).toBe("12345678901")
		expect(formatGeneral(123456789012)).toBe("1.23457E+11")
		expect(formatGeneral(1234.5678901234)).toBe("1234.56789")
		expect(formatGeneral(99999999999.9)).toBe("1E+11")
		expect(formatGeneral(0.1 + 0.2)).toBe("0.3")
		expect(formatGeneral(1e21)).toBe("1E+21")
		expect(text(-1 / 3, "General")).toBe("-0.333333333")
	})

	it("goes exponential below 1e-4 when that shows more digits", () => {
		expect(formatGeneral(0.0001234567)).toBe("0.000123457")
		expect(formatGeneral(0.00001234567)).toBe("1.23457E-05")
		expect(formatGeneral(0.00001)).toBe("0.00001")
		expect(formatGeneral(0.000012345)).toBe("0.000012345")
		expect(formatGeneral(1e-10)).toBe("1E-10")
	})

	it("is the format of a code that only holds text", () => {
		expect(text(5, "@")).toBe("5")
		expect(text(1.5, '"x"@')).toBe("1.5")
		expect(text(-1.23, "General_)")).toBe("-1.23 ")
		expect(text(123, "GENERAL")).toBe("123")
	})
})

describe("rounding", () => {
	it("rounds half away from zero on the 15 digits a cell holds", () => {
		expect(text(1.005, "0.00")).toBe("1.01")
		expect(text(2.5, "0")).toBe("3")
		expect(text(-2.5, "0")).toBe("-3")
		expect(text(0.5, "#")).toBe("1")
		expect(text(9.995, "0.00")).toBe("10.00")
		expect(text(1e100, "0.0E+0")).toBe("1.0E+100")
		expect(text(123456789012345680000, "0")).toBe("123456789012346000000")
	})

	it("rounds a computed value that is halfway at 15 digits up, as a cell holds it", () => {
		// 549.955 as a double is 549.9549999999999; Excel keeps 15 significant digits (549.955000000000).
		expect(text(549.9549999999999, '"£"#,##0.00')).toBe("£549.96")
		expect(text(-549.9549999999999, '"£"#,##0.00')).toBe("-£549.96")
	})

	it("shows the percent sign where the code writes it", () => {
		const code = "#,##0.0%;[Red]\\(#,##0.0%\\)"

		expect(text(-0.017301502126146694, code)).toBe("(1.7%)")
		expect(formatValue(-0.017301502126146694, code).color).toBe(0xff0000)
		expect(text(0.017301502126146694, code)).toBe("1.7%")
		expect(text(-0.0173, "0.0%;(0.0)%")).toBe("(1.7)%")
	})

	it("adds no sign to a negative shown as zero", () => {
		expect(text(-0.001, "0.00")).toBe("0.00")
		expect(text(-0.4, "0")).toBe("0")
		expect(text(-0.01, "# ?/?")).toBe(`0 ${FIGURE} ${FIGURE}`)
		expect(text(-0.001, "0.00;(0.00)")).toBe("(0.00)")
		expect(text(-0.000388, "0.0%")).toBe("0.0%")
		expect(text(-1.83772268236293e-16, "0.000")).toBe("0.000")
	})

	it("shows the point only when a fraction place follows it", () => {
		expect(text(5, "0.")).toBe("5")
		expect(text(5, "#,##0.##")).toBe("5")
		expect(text(5.5, "#,##0.##")).toBe("5.5")
		expect(text(5, "0.?")).toBe(`5.${FIGURE}`)
	})
})

describe("sections and conditions", () => {
	it("splits positive, negative, zero and text", () => {
		const code = '0.0;(0.0);"zero";"<"@">"'

		expect(text(1, code)).toBe("1.0")
		expect(text(-1, code)).toBe("(1.0)")
		expect(text(0, code)).toBe("zero")
		expect(text("a", code)).toBe("<a>")
		expect(text("a", '0;0;0;"T"')).toBe("T")
		expect(text("a", "0.00")).toBe("a")
		expect(text(-5, "0;")).toBe("")
		expect(text(-5, '"a"')).toBe("a")
	})

	it("tests conditions in order, the last section taking the rest", () => {
		const phone = "[<=9999999]###-####;(###) ###-####"

		expect(text(5551234, phone)).toBe("555-1234")
		expect(text(5551234567, phone)).toBe("(555) 123-4567")
		expect(text(50, "[>100]0;0;0.00")).toBe("50.00")
		expect(text(-5, "[>100]0;0;0.00")).toBe("5")
		expect(text(150, "[>100]0;0;0.00")).toBe("150")
		expect(text(7, "[<5]0;[>10]0.0")).toBe("7")
		expect(text(-5, "[>0]0.00")).toBe("5")
	})

	it("adds a sign only in the first section, unless it takes the negatives", () => {
		expect(text(-5, "[<-1]0;0")).toBe("-5")
		expect(text(-5, "[<0]0;0")).toBe("5")
		expect(text(-5, "[<=0]0;[>0]0.0")).toBe("5")
		expect(text(-5, "[<0]0;[<-1]0.0")).toBe("-5")
		expect(text(-5, "[<0]0;0;0.00")).toBe("-5")
		expect(text(-7, "[>5]0;[>-10]0.0")).toBe("7.0")
	})
})

describe("fractions", () => {
	it("finds the closest fraction with the denominator's digits", () => {
		expect(text(0.5, "# ?/?")).toBe(" 1/2")
		expect(text(-2.25, "# ?/?")).toBe("-2 1/4")
		expect(text(Math.PI, "# ??/??")).toBe("3 14/99")
		expect(text(Math.PI, "# ???/???")).toBe(`3 ${FIGURE}16/113`)
		expect(text(Math.PI, "# ?/?")).toBe("3 1/7")
		expect(text(5.5, "?/?")).toBe("11/2")
		expect(text(0, "?/?")).toBe("0/1")
	})

	it("uses a fixed denominator", () => {
		expect(text(0.1, "# ??/16")).toBe(` ${FIGURE}2/16`)
		expect(text(0.3, "0/100")).toBe("30/100")
		expect(text(1.5, "?/4")).toBe("6/4")
		expect(text(0.5, "# ?/8")).toBe(" 4/8")
	})

	it("leaves the fraction's place blank when nothing is left", () => {
		expect(text(3, "# ?/?")).toBe(`3 ${FIGURE} ${FIGURE}`)
		expect(text(0, "# ?/?")).toBe(`0 ${FIGURE} ${FIGURE}`)
		expect(text(0.99, "# ?/?")).toBe(`1 ${FIGURE} ${FIGURE}`)
		expect(text(5, "# ??/16")).toBe(`5 ${FIGURE}${FIGURE} `)
	})
})

describe("scientific notation", () => {
	it("puts exponents at multiples of two or more integer placeholders", () => {
		expect(text(12345, "##0.0E+0")).toBe("12.3E+3")
		expect(text(0.0012, "##0.0E+0")).toBe("1.2E-3")
		expect(text(123.45, "00.00E+00")).toBe("01.23E+02")
		expect(text(1234.5, "00.00E+00")).toBe("12.35E+02")
		expect(text(0, "0.00E+00")).toBe("0.00E+00")
		expect(text(9.99, "0.0E+0")).toBe("1.0E+1")
		expect(text(-0.00001, "0.0E+0")).toBe("-1.0E-5")
	})
})

describe("dates", () => {
	it("keeps the 1900 system's leap day and day zero (ECMA-376 Part 1 §18.17.4.1)", () => {
		expect(text(0, "m/d/yyyy")).toBe("1/0/1900")
		expect(text(1, "m/d/yyyy dddd")).toBe("1/1/1900 Sunday")
		expect(text(59, "m/d/yyyy")).toBe("2/28/1900")
		expect(text(60, "m/d/yyyy dddd")).toBe("2/29/1900 Wednesday")
		expect(text(61, "m/d/yyyy dddd")).toBe("3/1/1900 Thursday")
		expect(text(2958465, "yyyy-mm-dd")).toBe("9999-12-31")
	})

	it("counts the 1904 system from 1904-01-01 (§18.17.4.2)", () => {
		expect(text(0, "yyyy-mm-dd dddd", { date1904: true })).toBe("1904-01-01 Friday")
		expect(text(43538, "yyyy-mm-dd", { date1904: true })).toBe("2023-03-15")
	})

	it("fills the cell with # for a date it cannot show", () => {
		expect(formatValue(-1, "m/d/yyyy")).toEqual({ text: "", repeat: { offset: 0, char: "#" } })
		expect(formatValue(2958466, "yyyy")).toEqual({ text: "", repeat: { offset: 0, char: "#" } })
		expect(formatValue(-0.5, "[h]:mm")).toEqual({ text: "", repeat: { offset: 0, char: "#" } })
	})

	it("cuts a clock down to the second shown and rounds its decimals within it", () => {
		expect(text(0.4374999, "h:mm:ss")).toBe("10:29:59")
		expect(text(0.43749, "h:mm")).toBe("10:29")
		expect(text(0.123456, "s.0")).toBe("46.6")
		expect(text(0.4374999, "hh:mm:ss.0")).toBe("10:29:59.9")
		expect(text(1 / 3, "h:mm:ss")).toBe("8:00:00")
		expect(text(0.7, "h:mm:ss")).toBe("16:48:00")
		expect(text(0.4374999, "[h]:mm:ss")).toBe("10:30:00")
	})

	it("shows AM/PM in the locale's words and A/P as written", () => {
		expect(text(0.25, "hh:mm am/pm")).toBe("06:00 AM")
		expect(text(0.75, "h a/p")).toBe("6 p")
		expect(text(0.5, "h AM/PM")).toBe("12 PM")
		expect(text(0, "h AM/PM")).toBe("12 AM")
	})

	it("reads e as the year and b as the Buddhist year (MS-OI29500 §2.1.713 f)", () => {
		expect(text(45000, "e")).toBe("2023")
		expect(text(45000, "bbbb")).toBe("2566")
		expect(text(45000, "d/m/bb")).toBe("15/3/66")
	})

	it("shows the system long date and time of [$-F800] and [$-F400] in the locale's patterns", () => {
		expect(text(45000, "[$-F800]dddd, mmmm dd, yyyy")).toBe("Wednesday, March 15, 2023")
		expect(text(45000.5, "[$-F400]h:mm:ss AM/PM")).toBe("12:00:00 PM")
		expect(text(45000, "[$-x-sysdate]dddd, mmmm dd, yyyy", { locale: { ...NUMFMT_EN_US, longDate: "yyyy-mm-dd" } })).toBe("2023-03-15")
	})
})

describe("locale data", () => {
	const de: NumFmtLocale = {
		...NUMFMT_EN_US,
		decimal: ",",
		group: ".",
		months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
		monthsShort: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
		days: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
		daysShort: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]
	}

	it("shows separators and names of the injected locale", () => {
		expect(text(1234567.891, "#,##0.00", { locale: de })).toBe("1.234.567,89")
		expect(text(0.123, "0.0%", { locale: de })).toBe("12,3%")
		expect(text(1 / 3, "General", { locale: de })).toBe("0,333333333")
		expect(text(45000, "dddd, d. mmmm yyyy", { locale: de })).toBe("Mittwoch, 15. März 2023")
	})

	it("shows a [$-xxxx] language's names when the app has them", () => {
		const localeFor = (lcid: number): NumFmtLocale | undefined => (lcid === 0x407 ? de : undefined)

		expect(text(45000, "[$-407]mmmm dddd", { localeFor })).toBe("März Mittwoch")
		expect(text(45000, "[$-40C]mmmm", { localeFor })).toBe("March")
		expect(text(1234, "[$€-407]#,##0.00")).toBe("€1,234.00")
		expect(text(1, "[$€-x-euro2] 0")).toBe("€ 1")
		expect(text(1, "0 [$EUR]")).toBe("1 EUR")
	})
})

describe("compiling", () => {
	it("compiles a code once", () => {
		expect(numFmt("0.00;[Red]-0.00")).toBe(numFmt("0.00;[Red]-0.00"))
	})

	it("tells dates and text apart for input", () => {
		expect(parseNumFmt("m/d/yyyy").isDate).toBe(true)
		expect(parseNumFmt("[h]:mm").isDate).toBe(true)
		expect(parseNumFmt("0.00").isDate).toBe(false)
		expect(parseNumFmt("@").isText).toBe(true)
		expect(parseNumFmt('"x"@').isText).toBe(true)
		expect(parseNumFmt("General").isText).toBe(false)
	})

	it("never throws on a malformed code", () => {
		for (const code of [
			"[",
			'"',
			"\\",
			"_",
			"*",
			"[$",
			"[>",
			"E+",
			"0/",
			"/0",
			";;;;;;",
			"[Color99]0",
			"[<abc]0",
			"0.0.0",
			"##,,,",
			"?/",
			"[h"
		])
			expect(() => text(1.5, code)).not.toThrow()
	})

	it("compiles in time linear in the code's length", () => {
		const pathological = [
			"[".repeat(100_000),
			'"'.repeat(100_001),
			"0" + ",".repeat(100_000),
			"#,".repeat(50_000) + "0",
			"0e+".repeat(30_000),
			"m ".repeat(50_000) + "s",
			"0." + "0".repeat(100_000),
			"0/" + "?".repeat(100_000),
			"0 " + "?".repeat(50_000) + "/" + "?".repeat(50_000),
			"h" + ".0".repeat(50_000)
		]

		for (const code of pathological) {
			const started = Date.now()

			parseNumFmt(code)

			expect(Date.now() - started).toBeLessThan(budget(1000))
		}
	})

	it("formats without allocating beyond the text", () => {
		const out = new NumFmtOutput()
		const format = numFmt("#,##0.00")

		expect(formatNumberInto(format, 1234.5, out).text).toBe("1,234.50")
		expect(formatNumberInto(format, -2, out)).toBe(out)
		expect(out.text).toBe("-2.00")
		expect(out.color).toBe(-1)
	})

	it("shows booleans as TRUE and FALSE whatever the format", () => {
		expect(text(true, "0.00")).toBe("TRUE")
		expect(text(false, "@")).toBe("FALSE")
	})
})

describe("the compiled-format cache", () => {
	it("compiles a short code once, and a code longer than a cell's format each time it is asked for", () => {
		const long = `${"0".repeat(299)}.`
		const short = "0.00"
		const kept = numFmt(short)

		expect(numFmt(short)).toBe(kept)
		expect(numFmt(long)).not.toBe(numFmt(long))
		expect(text(5, long)).toBe(formatNumberInto(parseNumFmt(long), 5, new NumFmtOutput()).text)
		// Asking for long codes does not take the short ones out.
		expect(numFmt(short)).toBe(kept)
	})
})

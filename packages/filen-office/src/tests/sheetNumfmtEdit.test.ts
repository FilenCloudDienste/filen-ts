import { describe, expect, it } from "vitest"
import {
	EXCEL_BUILTIN_FORMATS,
	NUMBER_FORMAT_PRESETS,
	NUMFMT_EN_US,
	builtinFormatCode,
	changedDecimals,
	fitGeneral,
	formatGeneral,
	generalWithin,
	isPlainGeneral,
	numFmt,
	numberFormatPresets,
	numFmtCategory,
	numFmtProblem
} from "../core/sheet/numfmt"

// A cell that takes `chars` characters of equal width.
function within(chars: number): (text: string) => boolean {
	return text => text.length <= chars
}

describe("General in a narrow cell", () => {
	it("is formatGeneral's text at 11 characters", () => {
		for (const value of [0, 1, -1, 0.1, 1 / 3, 123456.789, 12345678901, 123456789012, 0.0001234, 1.5e-7, 98765.4321, 1e100, 2 / 3])
			expect(generalWithin(value, 11)).toBe(formatGeneral(value))
	})

	it("drops decimal places to fit, rounding half away from zero", () => {
		expect(fitGeneral(3.14159, ".", within(4))).toBe("3.14")
		expect(fitGeneral(3.14159, ".", within(3))).toBe("3.1")
		expect(fitGeneral(3.14159, ".", within(1))).toBe("3")
		expect(fitGeneral(2.5, ".", within(1))).toBe("3")
		expect(fitGeneral(1234.5678, ".", within(6))).toBe("1234.6")
		expect(fitGeneral(9999.96, ".", within(6))).toBe("10000")
	})

	it("rounds the stored value, not the text General would show", () => {
		// 2.44999999999 shows "2.45" in a wide cell; one place of it is 2.4.
		expect(fitGeneral(2.44999999999, ".", within(3))).toBe("2.4")
	})

	it("counts the sign as a character of the cell", () => {
		expect(fitGeneral(-3.14159, ".", within(4))).toBe("-3.1")
		expect(fitGeneral(-0.4, ".", within(1))).toBe("0")
	})

	it("goes exponential when the whole number does not fit", () => {
		expect(fitGeneral(123456789, ".", within(8))).toBe("1.23E+08")
		expect(fitGeneral(123456789, ".", within(5))).toBe("1E+08")
		expect(fitGeneral(123456789012, ".", within(9))).toBe("1.235E+11")
	})

	it("shows small numbers exponentially when no place after the point fits", () => {
		expect(fitGeneral(0.0004, ".", within(5))).toBe("4E-04")
		expect(fitGeneral(0.0123, ".", within(4))).toBe("0.01")
		expect(fitGeneral(0.6, ".", within(1))).toBe("1")
	})

	it("fills with # when nothing fits", () => {
		expect(fitGeneral(12345, ".", within(4))).toBeNull()
		expect(fitGeneral(123456789, ".", within(4))).toBeNull()
	})

	it("uses the locale's point", () => {
		expect(fitGeneral(3.14159, ",", within(4))).toBe("3,14")
		expect(fitGeneral(123456789, ",", within(8))).toBe("1,23E+08")
	})

	it("tells plain General from a General with more to it", () => {
		expect(isPlainGeneral(numFmt("General"))).toBe(true)
		expect(isPlainGeneral(numFmt("[Red]General"))).toBe(false)
		expect(isPlainGeneral(numFmt('General" kg"'))).toBe(false)
		expect(isPlainGeneral(numFmt("0.00"))).toBe(false)
	})
})

describe("number format categories", () => {
	it("names every built-in format as the Format Cells dialog lists it", () => {
		const expected: Record<number, string> = {
			0: "general",
			1: "number",
			2: "number",
			3: "number",
			4: "number",
			9: "percentage",
			10: "percentage",
			11: "scientific",
			12: "fraction",
			13: "fraction",
			14: "date",
			15: "date",
			16: "date",
			17: "date",
			18: "time",
			19: "time",
			20: "time",
			21: "time",
			22: "date",
			37: "number",
			38: "number",
			39: "number",
			40: "number",
			45: "time",
			46: "time",
			47: "time",
			48: "scientific",
			49: "text"
		}

		for (const id of EXCEL_BUILTIN_FORMATS.keys())
			expect(numFmtCategory(EXCEL_BUILTIN_FORMATS.get(id) ?? ""), String(id)).toBe(expected[id])

		for (const id of [5, 6, 7, 8]) expect(numFmtCategory(builtinFormatCode(id, NUMFMT_EN_US) ?? "")).toBe("currency")
		for (const id of [41, 42, 43, 44]) expect(numFmtCategory(builtinFormatCode(id, NUMFMT_EN_US) ?? "")).toBe("accounting")
	})

	it("names each Home tab preset by its own category", () => {
		for (const preset of NUMBER_FORMAT_PRESETS) expect(numFmtCategory(preset.code), preset.code).toBe(preset.category)
	})

	it("builds the Home tab list in a locale's currency, still naming each preset and the dollar files", () => {
		expect(numberFormatPresets("$")).toStrictEqual([
			{ category: "general", code: "General" },
			{ category: "number", code: "0.00" },
			{ category: "currency", code: '"$"#,##0.00' },
			{ category: "accounting", code: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)' },
			{ category: "date", code: "m/d/yyyy" },
			{ category: "date", code: "[$-F800]dddd, mmmm dd, yyyy" },
			{ category: "time", code: "[$-F400]h:mm:ss AM/PM" },
			{ category: "percentage", code: "0.00%" },
			{ category: "fraction", code: "# ?/?" },
			{ category: "scientific", code: "0.00E+00" },
			{ category: "text", code: "@" }
		])
		expect(numberFormatPresets("$")).toBe(NUMBER_FORMAT_PRESETS)

		const euro = numberFormatPresets("€")

		expect(euro.find(preset => preset.category === "currency")?.code).toBe('"€"#,##0.00')
		expect(euro.find(preset => preset.category === "accounting")?.code).toBe(
			'_("€"* #,##0.00_);_("€"* \\(#,##0.00\\);_("€"* "-"??_);_(@_)'
		)
		expect(numberFormatPresets("CHF").find(preset => preset.category === "currency")?.code).toBe("[$CHF]#,##0.00")

		for (const symbol of ["€", "£", "￥", "₺", "zł", "CHF", "kr", "R$"])
			for (const preset of numberFormatPresets(symbol)) expect(numFmtCategory(preset.code), preset.code).toBe(preset.category)

		expect(numFmt("[$CHF]#,##0.00").sections[0]?.tokens.some(token => token.text === "CHF")).toBe(true)
		expect(numFmtCategory('"$"#,##0.00')).toBe("currency")
		expect(numFmtCategory('_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)')).toBe("accounting")
	})

	it("names a locale's currency and a code it cannot place", () => {
		expect(numFmtCategory("[$€-407] #,##0.00")).toBe("currency")
		expect(numFmtCategory('#,##0.00 "€"')).toBe("currency")
		expect(numFmtCategory('"Total"')).toBe("custom")
	})
})

describe("Increase and Decrease Decimal", () => {
	it("start a General cell from the places it shows", () => {
		expect(changedDecimals("General", 1, "1.25")).toBe("0.000")
		expect(changedDecimals("General", -1, "1.25")).toBe("0.0")
		expect(changedDecimals("General", 1, "7")).toBe("0.0")
		expect(changedDecimals("General", -1, "7")).toBe("0")
		expect(changedDecimals("General", 1, "1,5", ",")).toBe("0.00")
		expect(changedDecimals("General", 1, "1.2E+05")).toBe("0.00E+00")
	})

	it("add and take a place after the last one, in every number section", () => {
		expect(changedDecimals("0.00", 1)).toBe("0.000")
		expect(changedDecimals("0.00", -1)).toBe("0.0")
		expect(changedDecimals("0.0", -1)).toBe("0")
		expect(changedDecimals("0", 1)).toBe("0.0")
		expect(changedDecimals("0", -1)).toBeNull()
		expect(changedDecimals("#,##0.00_);[Red](#,##0.00)", 1)).toBe("#,##0.000_);[Red](#,##0.000)")
		expect(changedDecimals("0.00%", 1)).toBe("0.000%")
		expect(changedDecimals("0.00E+00", -1)).toBe("0.0E+00")
		expect(changedDecimals('"$"#,##0.00', 1)).toBe('"$"#,##0.000')
	})

	it("keep accounting's zero section in step", () => {
		const accounting = builtinFormatCode(44, NUMFMT_EN_US) ?? ""

		expect(changedDecimals(accounting, 1)).toBe('_("$"* #,##0.000_);_("$"* \\(#,##0.000\\);_("$"* "-"???_);_(@_)')
		expect(changedDecimals(accounting, -1)).toBe('_("$"* #,##0.0_);_("$"* \\(#,##0.0\\);_("$"* "-"?_);_(@_)')
	})

	it("leave quoted text, escapes and brackets alone", () => {
		expect(changedDecimals('0.0" pts."', 1)).toBe('0.00" pts."')
		expect(changedDecimals("[<=99]0.0;0", 1)).toBe("[<=99]0.00;0.0")
	})

	it("change nothing in dates, times, fractions or text", () => {
		expect(changedDecimals("m/d/yyyy", 1)).toBeNull()
		expect(changedDecimals("h:mm:ss", 1)).toBeNull()
		expect(changedDecimals("# ?/?", 1)).toBeNull()
		expect(changedDecimals("@", 1)).toBeNull()
	})
})

describe("custom codes", () => {
	it("take what Excel takes and name what it refuses", () => {
		expect(numFmtProblem('#,##0.00 "kg";[Red]-0;"-";@')).toBeNull()
		expect(numFmtProblem("")).toBe("empty")
		expect(numFmtProblem("0".repeat(256))).toBe("tooLong")
		expect(numFmtProblem("0;0;0;@;0")).toBe("sections")
		expect(numFmtProblem('0" kg')).toBe("unclosed")
		expect(numFmtProblem("[Red0")).toBe("unclosed")
		expect(numFmtProblem("0\\\\")).toBeNull()
		expect(numFmtProblem("0_")).toBe("unclosed")
		// Characters XML cannot carry, which a paste can bring: a control character and a lone surrogate.
		expect(numFmtProblem("0.0\u0001")).toBe("characters")
		expect(numFmtProblem("0\ud800")).toBe("characters")
		expect(numFmtProblem("0\t0")).toBeNull()
		expect(numFmtProblem('0 "\ud83d\ude00"')).toBeNull()
	})
})

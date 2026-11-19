import { describe, expect, it } from "vitest"
import { parseCellInput } from "../core/sheet/input/cellInput"
import {
	delocalizeFormula,
	formulaTextDate,
	localizedDate,
	localizedInput,
	localizedNumber,
	localizeFormula,
	textNumber
} from "../core/sheet/input/locale"
import { textDateParser } from "../core/sheet/formula/textDates"
import { NUMFMT_EN_US } from "../core/sheet/numfmt/locale"
import type { SheetLocale } from "../core/sheet/protocol"

const DE: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }
const FR: SheetLocale = { decimal: ",", group: " ", argument: ";", dateOrder: "dmy" }
const US: SheetLocale = { decimal: ".", group: ",", argument: ",", dateOrder: "mdy" }
const GB: SheetLocale = { decimal: ".", group: ",", argument: ",", dateOrder: "dmy" }

describe("formulas typed in a locale", () => {
	it("store en-US separators, leaving strings, sheet names and structured references as typed", () => {
		expect(delocalizeFormula('SUMME(A1;1,5;"a;b,c")', DE)).toBe('SUMME(A1,1.5,"a;b,c")')
		expect(delocalizeFormula("IF('Q1;2'!A1>0,5;{1,5\\2;3\\4};Table1[[#This Row];[a,b]])", DE)).toBe(
			"IF('Q1;2'!A1>0.5,{1.5,2;3,4},Table1[[#This Row];[a,b]])"
		)
		expect(delocalizeFormula("LOG10(2)+STDEV.S(A1:A3;,5)", DE)).toBe("LOG10(2)+STDEV.S(A1:A3,.5)")
	})

	it("show back as typed", () => {
		for (const formula of ['SUM(A1,1.5,"a;b,c")', "IF(A1>0.5,{1.5,2;3,4},0)", "ROUND(LOG10(B2),2)"])
			expect(delocalizeFormula(localizeFormula(formula, DE), DE)).toBe(formula)

		expect(localizeFormula("IF(A1>0.5,{1.5,2;3,4},0)", DE)).toBe("IF(A1>0,5;{1,5\\2;3\\4};0)")
	})

	it("change nothing in en-US", () => {
		expect(delocalizeFormula("SUM(A1,1.5)", US)).toBe("SUM(A1,1.5)")
		expect(localizeFormula("SUM(A1,1.5)", GB)).toBe("SUM(A1,1.5)")
	})
})

describe("values typed in a locale", () => {
	it("read numbers with the locale's point and grouping", () => {
		expect(localizedNumber("1,5", DE)).toEqual({ value: 1.5 })
		expect(localizedNumber("1.234,5", DE)).toEqual({ value: 1234.5, impliedFormat: "#,##0.00" })
		expect(localizedNumber("12,5%", DE)).toEqual({ value: 0.125, impliedFormat: "0.00%" })
		expect(localizedNumber("1 234", FR)).toEqual({ value: 1234, impliedFormat: "#,##0" })
		expect(localizedNumber("1.5", DE)).toBeNull()
		expect(localizedNumber("1,234.5", US)).toEqual({ value: 1234.5, impliedFormat: "#,##0.00" })
	})

	it("read dates in the locale's order, two-digit years as Excel does", () => {
		expect(localizedDate("3/5/2024", US)).toEqual({ year: 2024, month: 3, day: 5 })
		expect(localizedDate("3/5/2024", GB)).toEqual({ year: 2024, month: 5, day: 3 })
		expect(localizedDate("31.12.29", DE)).toEqual({ year: 2029, month: 12, day: 31 })
		expect(localizedDate("1.1.30", DE)).toEqual({ year: 1930, month: 1, day: 1 })
		expect(localizedDate("2024-02-30", DE)).toBeNull()
		expect(localizedDate("2024-02-29", US)).toEqual({ year: 2024, month: 2, day: 29 })
		expect(localizedDate("1.5.2024", US)).toBeNull()
	})

	it("parse an entry", () => {
		expect(parseCellInput("=SUMME(A1;2,5)", DE)).toEqual({ type: "formula", formula: "SUMME(A1,2.5)" })
		expect(parseCellInput("2,5", DE)).toEqual({ type: "value", value: 2.5 })
		expect(parseCellInput("31.12.2024", DE)).toEqual({
			type: "value",
			value: new Date(Date.UTC(2024, 11, 31)),
			impliedFormat: "dd/mm/yyyy"
		})
		expect(parseCellInput("12/31/2024", US)).toEqual({
			type: "value",
			value: new Date(Date.UTC(2024, 11, 31)),
			impliedFormat: "m/d/yyyy"
		})
		expect(parseCellInput("'2,5", DE)).toEqual({ type: "value", value: "2,5" })
		expect(parseCellInput("wahr", DE)).toEqual({ type: "value", value: "wahr" })
		// Without a locale, as before: ISO dates only.
		expect(parseCellInput("12/31/2024")).toEqual({ type: "value", value: "12/31/2024" })
	})

	it("show a cell's input as the locale types it", () => {
		expect(localizedInput("1.5", DE)).toBe("1,5")
		expect(localizedInput("=ROUND(A1,2)+0.5", DE)).toBe("=ROUND(A1;2)+0,5")
		expect(localizedInput("a.b", DE)).toBe("a.b")
		expect(localizedInput("2024-01-02", DE)).toBe("2024-01-02")
		expect(localizedInput("1.5", US)).toBe("1.5")
	})
})

describe("numbers typed with an Arabic decimal separator locale", () => {
	// Intl's ar-EG, ar-SA, fa-IR and ps-AF: U+066B as the decimal point, U+066C between groups.
	const AR: SheetLocale = { decimal: "٫", group: "٬", argument: ",", dateOrder: "dmy" }

	it("take '.' as the decimal point too, as LibreOffice 7.5 reads entries in ar-EG and fa-IR", () => {
		expect(parseCellInput("3.5", AR)).toEqual({ type: "value", value: 3.5 })
		expect(parseCellInput("3٫5", AR)).toEqual({ type: "value", value: 3.5 })
		expect(localizedNumber("1٬234.5", AR)?.value).toBe(1234.5)
		expect(localizedNumber("12.5%", AR)?.value).toBe(0.125)
	})

	it("read text in formulas with either decimal point", () => {
		expect(textNumber("3.5", AR)).toBe(3.5)
		expect(textNumber(".5", AR)).toBe(0.5)
		expect(textNumber("3٫5", AR)).toBe(3.5)
	})

	it("keep '.' as no decimal point where the locale's is a comma", () => {
		expect(localizedNumber("3.5", DE)).toBeNull()
	})
})

// Month names as Intl gives them for de and fr (full, then short).
const DE_NAMED: SheetLocale = {
	...DE,
	numFmt: {
		...NUMFMT_EN_US,
		decimal: ",",
		group: ".",
		months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
		monthsShort: ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."]
	}
}
const FR_NAMED: SheetLocale = {
	...FR,
	numFmt: {
		...NUMFMT_EN_US,
		decimal: ",",
		group: " ",
		months: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
		monthsShort: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
	}
}

// Hindi as Intl gives it: names with combining marks, short names ending in U+0970.
const HI_NAMED: SheetLocale = {
	...GB,
	numFmt: {
		...NUMFMT_EN_US,
		months: ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"],
		monthsShort: ["जन॰", "फ़र॰", "मार्च", "अप्रैल", "मई", "जून", "जुल॰", "अग॰", "सित॰", "अक्तू॰", "नव॰", "दिस॰"]
	}
}

describe("month names typed in a locale", () => {
	const year = (): number => 2024
	const date = (text: string, locale: SheetLocale): unknown => formulaTextDate(text, locale, year, false)

	it("read the session language's names, full and short, with or without the short name's dot, any case", () => {
		expect(date("5-Dez-24", DE_NAMED)).toEqual({ year: 2024, month: 12, day: 5 })
		expect(date("5. März 2024", DE_NAMED)).toEqual({ year: 2024, month: 3, day: 5 })
		expect(date("5 MÄRZ 2024", DE_NAMED)).toEqual({ year: 2024, month: 3, day: 5 })
		expect(date("1 Okt. 2024", DE_NAMED)).toEqual({ year: 2024, month: 10, day: 1 })
		expect(date("Oktober 3, 2024", DE_NAMED)).toEqual({ year: 2024, month: 10, day: 3 })
		expect(date("15 mai 2025", FR_NAMED)).toEqual({ year: 2025, month: 5, day: 15 })
		expect(date("3 déc. 2024", FR_NAMED)).toEqual({ year: 2024, month: 12, day: 3 })
		expect(date("3 déc 2024", FR_NAMED)).toEqual({ year: 2024, month: 12, day: 3 })
		expect(date("14 juil. 2024", FR_NAMED)).toEqual({ year: 2024, month: 7, day: 14 })
		expect(date("1 février 2024", FR_NAMED)).toEqual({ year: 2024, month: 2, day: 1 })
		expect(parseCellInput("5-Dez-24", DE_NAMED)).toEqual({
			type: "value",
			value: new Date(Date.UTC(2024, 11, 5)),
			impliedFormat: "d-mmm-yy"
		})
	})

	it("still read English names, and only the exact names Intl shows", () => {
		expect(date("5-Dec-24", DE_NAMED)).toEqual({ year: 2024, month: 12, day: 5 })
		expect(date("January 5, 2024", FR_NAMED)).toEqual({ year: 2024, month: 1, day: 5 })
		// Not a 3-letter prefix of "juillet" or "juin": "jui" is neither.
		expect(date("5 jui 2024", FR_NAMED)).toBeNull()
		// Without the language's names, as before.
		expect(date("5-Dez-24", DE)).toBeNull()
		expect(parseCellInput("5-Dez-24", DE)).toEqual({ type: "value", value: "5-Dez-24" })
	})

	it("read names that carry combining marks", () => {
		expect(date("5 जनवरी 2024", HI_NAMED)).toEqual({ year: 2024, month: 1, day: 5 })
		expect(date("मार्च 5, 2024", HI_NAMED)).toEqual({ year: 2024, month: 3, day: 5 })
		expect(date("12 फ़रवरी 2025", HI_NAMED)).toEqual({ year: 2025, month: 2, day: 12 })
	})

	it("read short names ending in the Devanagari abbreviation sign, with or without it", () => {
		expect(date("5 जन॰ 2024", HI_NAMED)).toEqual({ year: 2024, month: 1, day: 5 })
		expect(date("5 जन 2024", HI_NAMED)).toEqual({ year: 2024, month: 1, day: 5 })
		expect(date("अक्तू॰ 3, 2024", HI_NAMED)).toEqual({ year: 2024, month: 10, day: 3 })
	})

	it("imply a format from a name in any script", () => {
		const implied = (text: string, locale: SheetLocale): unknown => {
			// The clock's year, for an entry without one.
			const result = parseCellInput(text, locale, 2024)

			return "impliedFormat" in result ? result.impliedFormat : undefined
		}

		expect(implied("5-März-24", DE_NAMED)).toBe("d-mmm-yy")
		expect(implied("März 2024", DE_NAMED)).toBe("mmm-yy")
		expect(implied("5. März", DE_NAMED)).toBe("d-mmm")
		expect(implied("5 जनवरी 2024", HI_NAMED)).toBe("d-mmm-yy")
		expect(implied("जनवरी 5", HI_NAMED)).toBe("d-mmm")
	})

	it("prefer the session language where a word names another month in English", () => {
		const shifted: SheetLocale = {
			...DE,
			numFmt: { ...NUMFMT_EN_US, monthsShort: ["x", "y", "z", "w", "mar", "v", "u", "t", "s", "r", "q", "p"] }
		}

		expect(date("5 mar 2024", shifted)).toEqual({ year: 2024, month: 5, day: 5 })
		expect(date("5 mar 2024", DE)).toEqual({ year: 2024, month: 3, day: 5 })
	})

	it("leave entries that read as numbers or times as they were", () => {
		expect(parseCellInput("1,5", DE_NAMED)).toEqual({ type: "value", value: 1.5 })
		expect(parseCellInput("5.3", DE_NAMED)).toEqual(parseCellInput("5.3", DE))
		expect(parseCellInput("5 PM", DE_NAMED)).toEqual(parseCellInput("5 PM", DE))
		expect(parseCellInput("12:30", DE_NAMED)).toEqual(parseCellInput("12:30", DE))
		expect(parseCellInput("31.12.2024", DE_NAMED)).toEqual({
			type: "value",
			value: new Date(Date.UTC(2024, 11, 31)),
			impliedFormat: "m/d/yyyy"
		})
	})

	it("reach DATEVALUE's reading of text", () => {
		const parse = textDateParser(DE_NAMED, () => new Date(2024, 0, 10).getTime())

		expect(parse("5-Dez-2024")).toEqual({ year: 2024, month: 12, day: 5 })
		expect(parse("5. März 2024 6:35")).toEqual({ year: 2024, month: 3, day: 5, hours: 6, minutes: 35, seconds: 0 })
		expect(textDateParser(DE, () => 0)("5-Dez-2024")).toBeUndefined()
	})
})

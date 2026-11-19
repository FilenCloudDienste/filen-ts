import { describe, expect, it } from "vitest"
import { FormulaEngine } from "../core/sheet/formula/index"
import { parseCellInput } from "../core/sheet/input/cellInput"
import { localizedNumber, territoryCurrency, textNumber } from "../core/sheet/input/locale"
import type { SheetLocale } from "../core/sheet/protocol"
import { engineCellFormula } from "../core/sheet/refs/formulaRefs"
import { firstTile, openFixture, tileEntry } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"

// Text read as a number where a formula takes one, as Excel reads text "that looks like an accepted number format"
// (support.microsoft.com "Calculation operators and precedence in Excel": ="1"+"2" is 3, =1+"$4.00" is 5), in the
// session's locale; where the page is silent, as LibreOffice 7.5 reads the same text in en-US and de-DE.

const EN_US: SheetLocale = { decimal: ".", group: ",", argument: ",", dateOrder: "mdy" }
const DE_DE: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy", currencies: ["€"] }

// Each formula (en-US syntax, as files store it) alone in column A of an engine in the locale, its value by formula.
function results(locale: SheetLocale | undefined, formulas: readonly string[]): Record<string, unknown> {
	const engine = new FormulaEngine(
		[{ name: "S", rows: formulas.map(formula => [engineCellFormula(formula) ?? ""]), formulas: [] }],
		[],
		false,
		undefined,
		undefined,
		locale
	)

	try {
		return Object.fromEntries(
			formulas.map((formula, row) => {
				const result = engine.result(0, row, 0)
				const value = result.error === true ? `!${String(result.value)}` : result.value

				return [formula, typeof value === "number" ? Number(value.toFixed(9)) : value]
			})
		)
	} finally {
		engine.destroy()
	}
}

function expectResults(locale: SheetLocale | undefined, cases: Readonly<Record<string, unknown>>): void {
	expect(results(locale, Object.keys(cases))).toEqual(cases)
}

describe("text read as a number in formulas", () => {
	it("reads the page's examples and en-US's grouping, currency, percent and signs", () => {
		const cases = {
			'"1"+"2"': 3,
			'1+"$4.00"': 5,
			'"6/1/2001"-"5/1/2001"': 31,
			'SQRT("8+1")': "!#VALUE!",
			'"1,000"*1': 1000,
			'"1,000.5"*1': 1000.5,
			'"1,000,000"*1': 1000000,
			'"$1,000.50"*1': 1000.5,
			'"-$5"*1': -5,
			'"$-5"*1': -5,
			'"$ 5"*1': 5,
			'"5$"*1': 5,
			'"(1,000)"*1': -1000,
			'"($5)"*1': -5,
			'"1,000%"*1': 10,
			'"50 %"*1': 0.5,
			'"5-"*1': -5,
			'"+5"*1': 5,
			'" 12 "*1': 12,
			'"1e3"*1': 1000,
			'".5"*1': 0.5,
			'"5."*1': 5,
			'"1 1/2"*1': 1.5,
			'"12:30"*1': 0.520833333,
			'ABS("-1,000")': 1000,
			'VALUE("1,000")': 1000,
			'"1,00"*1': "!#VALUE!",
			'"1,0000"*1': "!#VALUE!",
			'"1 000"*1': "!#VALUE!",
			'"(5%)"*1': "!#VALUE!",
			'"(-5)"*1': "!#VALUE!",
			'"--5"*1': "!#VALUE!",
			'"€5"*1': "!#VALUE!",
			'"TRUE"*1': "!#VALUE!",
			'"abc"*1': "!#VALUE!",
			'""*1': "!#VALUE!",
			// Text past what a number holds is no number ("1e400" and 400 digits): #VALUE!, not #NUM!.
			'"1e400"*1': "!#VALUE!",
			'REPT("1",400)*1': "!#VALUE!",
			'("1"&REPT("0",400))*1': "!#VALUE!",
			// A comparison converts nothing: text is never equal to a number.
			'"1,000"=1000': false
		}

		expectResults(undefined, cases)
		expectResults(EN_US, cases)
	})

	it("reads de-DE's comma decimal point, point grouping and euro sign", () => {
		expectResults(DE_DE, {
			'"1.000,5"*1': 1000.5,
			'"1.000"*1': 1000,
			'"1,5"*1': 1.5,
			'"1,000"*1': 1,
			'"1,000%"*1': 0.01,
			'"(1.000)"*1': -1000,
			'"€5"*1': 5,
			'"5 €"*1': 5,
			'"5€"*1': 5,
			'"-5 €"*1': -5,
			'"1.2.2020"*1': 43862,
			'ABS("1.000,5")': 1000.5,
			'"1,000.5"*1': "!#VALUE!",
			'"1.5"*1': "!#VALUE!",
			'"$5"*1': "!#VALUE!",
			'".5"*1': "!#VALUE!"
		})
	})

	it("rejects text that cannot start a number at its first character", () => {
		expect(textNumber("abc", EN_US)).toBeUndefined()
		expect(textNumber("#N/A", EN_US)).toBeUndefined()
		expect(textNumber("   ", EN_US)).toBeUndefined()
		expect(textNumber("1e999", EN_US)).toBeUndefined()
		expect(textNumber(" 1,234 ", EN_US)).toBe(1234)
	})
})

describe("text numbers after the session's locale changes", () => {
	// A formula reading text in the locale, typed again after each change so the session calculates it anew.
	async function shownAfter(first: SheetLocale, second: SheetLocale, formula: string): Promise<[string, string]> {
		const { session, info } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] }, { settings: { locale: first } })
		const sheet = info.sheets[0]!.id
		const shown = async (): Promise<string> => {
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: [formula] }
			})

			return tileEntry(await firstTile(session, sheet), 0, 0)?.text ?? ""
		}
		const before = await shown()

		session.configure({ locale: second })

		return [before, await shown()]
	}

	it("reads a new group separator alone", async () => {
		const swiss: SheetLocale = { ...EN_US, group: "'" }

		expect(await shownAfter(EN_US, swiss, '="1\'000"*1')).toEqual(["#VALUE!", "1000"])
	})

	it("reads a new currency symbol alone", async () => {
		expect(await shownAfter(DE_DE, { ...DE_DE, currencies: ["CHF"] }, '="CHF 5"*1')).toEqual(["#VALUE!", "5"])
	})
})

describe("territory currencies (Unicode CLDR)", () => {
	it("names each territory's current currency", () => {
		expect(territoryCurrency("DE")).toBe("EUR")
		expect(territoryCurrency("gb")).toBe("GBP")
		expect(territoryCurrency("JP")).toBe("JPY")
		expect(territoryCurrency("US")).toBe("USD")
		expect(territoryCurrency("CH")).toBe("CHF")
		expect(territoryCurrency("AQ")).toBeUndefined()
		expect(territoryCurrency("ZZ")).toBeUndefined()
		expect(territoryCurrency("")).toBeUndefined()
	})
})

describe("numbers as typed, read in linear time", () => {
	// What a typed entry is read as: its number, or null when it is not one.
	const typed = (text: string, locale?: SheetLocale): number | null => {
		const parsed = parseCellInput(text, locale)

		return parsed.type === "value" && typeof parsed.value === "number" ? parsed.value : null
	}

	it("accepts the same numbers as before, with and without a locale", () => {
		const cases: Readonly<Record<string, number | null>> = {
			"1": 1,
			"1.": 1,
			"1.5": 1.5,
			".5": 0.5,
			"15": 15,
			"-1e5": -100000,
			"+2.5E-1": 0.25,
			"1.5%": 0.015,
			"5.%": 0.05,
			"1.2.3": null,
			".": null,
			e5: null,
			"1e": null,
			"%": null
		}

		for (const [text, value] of Object.entries(cases)) {
			expect(typed(text), text).toBe(value)
			expect(typed(text, EN_US), text).toBe(value)
			expect(localizedNumber(text, EN_US)?.value ?? null, text).toBe(value)
		}

		expect(localizedNumber("1,5", DE_DE)?.value).toBe(1.5)
		expect(localizedNumber("1,", DE_DE)?.value).toBe(1)
		expect(localizedNumber(",5", DE_DE)?.value).toBe(0.5)
		expect(localizedNumber("1,5%", DE_DE)?.value).toBe(0.015)
		expect(localizedNumber("1,2,3", DE_DE)).toBeNull()
		expect(localizedNumber(",", DE_DE)).toBeNull()
	})

	it("rejects a long run of digits that ends in a letter at once", () => {
		const text = `${"1".repeat(32_000)}x`
		const start = cpuMs()

		expect(typed(text)).toBeNull()
		expect(typed(text, EN_US)).toBeNull()
		expect(localizedNumber(text, DE_DE)).toBeNull()
		expectResults(undefined, { ['NUMBERVALUE(REPT("1",32000)&"x")']: "!#VALUE!" })
		expect(cpuMs() - start).toBeLessThan(budget(300))
	})
})

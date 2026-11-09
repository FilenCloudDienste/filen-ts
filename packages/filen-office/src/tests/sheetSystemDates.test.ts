import { describe, expect, it } from "vitest"
import { parseCellInput } from "../core/sheet/input/cellInput"
import { formatValue, numFmt, NUMFMT_EN_US, SYSTEM_DATE_TIME, SYSTEM_SHORT_DATE, type NumFmtLocale } from "../core/sheet/numfmt/index"
import type { SheetLocale, SheetSessionApi } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { odsBytes, table } from "./odsFixtures"
import { SheetStyles } from "../core/sheet/style/resolve"
import { IMMEDIATE, firstTile, openFixture, savedBytes, tileTexts } from "./sheetSessionFixtures"
import { parts } from "./xlsxWriteFixtures"

// Built-in 14 and 22 and the system long date and time show in the app's locale, as Excel shows them in the system's
// regional settings; the codes the file keeps do not change.

const DE_FORMAT: NumFmtLocale = {
	...NUMFMT_EN_US,
	decimal: ",",
	group: ".",
	months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
	monthsShort: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
	days: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
	daysShort: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
	shortDate: 'dd"."mm"."yyyy',
	longDate: 'dddd"," d"." mmmm yyyy',
	longTime: "hh:mm:ss"
}
const DE: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy", numFmt: DE_FORMAT }
const DE_PLAIN: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }

// 2023-03-15 12:00 (a Wednesday).
const NOON = 45000.5

describe("the system short date of built-in 14 and 22", () => {
	it("shows in the locale's pattern, en-US's without one", () => {
		expect(formatValue(NOON, SYSTEM_SHORT_DATE).text).toBe("3/15/2023")
		expect(formatValue(NOON, SYSTEM_DATE_TIME).text).toBe("3/15/2023 12:00")
		expect(formatValue(NOON, SYSTEM_SHORT_DATE, { locale: DE_FORMAT }).text).toBe("15.03.2023")
		expect(formatValue(NOON, SYSTEM_DATE_TIME, { locale: DE_FORMAT }).text).toBe("15.03.2023 12:00")
	})

	it("keeps the table's code and dates", () => {
		expect(SYSTEM_SHORT_DATE.code).toBe("m/d/yyyy")
		expect(SYSTEM_DATE_TIME.code).toBe("m/d/yyyy h:mm")
		expect(SYSTEM_SHORT_DATE.isDate).toBe(true)
		// The code written out shows the same in any locale.
		expect(formatValue(NOON, "m/d/yyyy", { locale: DE_FORMAT }).text).toBe("3/15/2023")
	})

	it("follows a change of locale", () => {
		const other: NumFmtLocale = { ...NUMFMT_EN_US, shortDate: "yyyy/mm/dd" }

		expect(formatValue(NOON, SYSTEM_SHORT_DATE, { locale: DE_FORMAT }).text).toBe("15.03.2023")
		expect(formatValue(NOON, SYSTEM_SHORT_DATE, { locale: other }).text).toBe("2023/03/15")
		expect(formatValue(NOON, SYSTEM_SHORT_DATE, { locale: DE_FORMAT }).text).toBe("15.03.2023")
	})

	it("shows the long date and time, month and day names and separators in the locale", () => {
		expect(formatValue(NOON, "[$-F800]dddd, mmmm dd, yyyy", { locale: DE_FORMAT }).text).toBe("Mittwoch, 15. März 2023")
		expect(formatValue(NOON, "[$-F400]h:mm:ss AM/PM", { locale: DE_FORMAT }).text).toBe("12:00:00")
		expect(formatValue(NOON, "d-mmm-yy", { locale: DE_FORMAT }).text).toBe("15-Mär-23")
		expect(formatValue(1234.5, "#,##0.00", { locale: DE_FORMAT }).text).toBe("1.234,50")
	})
})

describe("SheetStyles", () => {
	const source = {
		numFmts: new Map([[22, "yyyy-mm-dd hh:mm"]]),
		fonts: [],
		fills: [],
		borders: [],
		cellStyleXfs: [],
		cellXfs: [14, 22, 15].map(numFmtId => ({ numFmtId, fontId: 0, fillId: 0, borderId: 0, xfId: 0, flags: 0 })),
		indexedColors: null
	}

	it("hands out built-in 14 as the system short date, its code unchanged", () => {
		const styles = new SheetStyles(source, null)

		expect(styles.numFmt(0)).toBe(SYSTEM_SHORT_DATE)
		expect(styles.numFmtCode(0)).toBe("m/d/yyyy")
		expect(styles.numFmt(2)).toBe(numFmt("d-mmm-yy"))
	})

	it("keeps a file's own record for a built-in id", () => {
		expect(new SheetStyles(source, null).numFmt(1).code).toBe("yyyy-mm-dd hh:mm")
	})

	it("shows the table's code where the source names its own patterns", () => {
		expect(new SheetStyles(source, null, { systemDates: false }).numFmt(0)).toBe(numFmt("m/d/yyyy"))
	})
})

describe("dates typed in the locale", () => {
	it("take built-in 14 (22 with h:mm) where the session shows the locale's short date", () => {
		expect(parseCellInput("31.12.2024", DE)).toEqual({
			type: "value",
			value: new Date(Date.UTC(2024, 11, 31)),
			impliedFormat: "m/d/yyyy"
		})
		expect(parseCellInput("31.12.2024 14:30", DE)).toMatchObject({ impliedFormat: "m/d/yyyy h:mm" })
		expect(parseCellInput("31.12.2024 14:30:15", DE)).toMatchObject({ impliedFormat: "dd/mm/yyyy h:mm:ss" })
		expect(parseCellInput("31.12.2024 2:30 PM", DE)).toMatchObject({ impliedFormat: "dd/mm/yyyy h:mm AM/PM" })
	})

	it("keep their order as a code without the locale's patterns", () => {
		expect(parseCellInput("31.12.2024", DE_PLAIN)).toMatchObject({ impliedFormat: "dd/mm/yyyy" })
		expect(parseCellInput("31.12.2024 14:30", DE_PLAIN)).toMatchObject({ impliedFormat: "dd/mm/yyyy h:mm" })
	})
})

const STYLES =
	'<numFmts count="1"><numFmt numFmtId="164" formatCode="[$-F800]dddd, mmmm d, yyyy"/></numFmts>' +
	'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
	'<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'

const FIXTURE = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1" s="1"><v>45000.5</v></c><c r="B1" s="2"><v>45000.5</v></c>' +
				'<c r="C1" s="3"><v>45000.5</v></c><c r="D1"><v>1234.5</v></c></row></sheetData>'
		}
	],
	styles: STYLES
}

describe("a session in a locale", () => {
	it("shows built-in 14 and 22 and the system long date in it, and saves the codes as they were", async () => {
		const { session, info } = await openFixture(FIXTURE, { settings: { locale: DE } })
		const sheet = info.sheets[0]!.id
		const texts = tileTexts(await firstTile(session, sheet))

		expect(texts.get("0,0")).toBe("15.03.2023")
		expect(texts.get("0,1")).toBe("15.03.2023 12:00")
		expect(texts.get("0,2")).toBe("Mittwoch, 15. März 2023")
		expect(texts.get("0,3")).toBe("1234,5")

		await session.command({
			type: "cells.set",
			sheet,
			cells: { rows: Uint32Array.of(1), cols: Uint16Array.of(0), inputs: ["31.12.2024"] }
		})

		expect(tileTexts(await firstTile(session, sheet)).get("1,0")).toBe("31.12.2024")

		const saved = parts(await savedBytes(session))
		const styles = saved["xl/styles.xml"] ?? ""

		expect(styles).not.toContain("dd.mm")
		expect(styles).not.toContain("dd/mm")
		expect(styles).toContain('formatCode="[$-F800]dddd, mmmm d, yyyy"')
		expect(saved["xl/worksheets/sheet1.xml"]).toMatch(/<c r="A2" s="1"/)
	})

	it("shows en-US's patterns after the locale is taken away", async () => {
		const { session, info } = await openFixture(FIXTURE, { settings: { locale: DE } })
		const sheet = info.sheets[0]!.id

		session.configure({ locale: DE_PLAIN })

		expect(tileTexts(await firstTile(session, sheet)).get("0,0")).toBe("3/15/2023")
	})
})

describe("an OpenDocument session in a locale", () => {
	async function openOdsSession(): Promise<{ session: SheetSessionApi; sheet: number }> {
		const rows =
			'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
		const result = await inThreadSheetHost().open(
			odsBytes({ body: table("S", rows) }),
			{ kind: "ods", slicing: IMMEDIATE, settings: { locale: DE } },
			() => undefined
		)

		if (result.kind !== "opened") throw new Error(result.kind)

		return { session: result.session, sheet: result.info.sheets[0]?.id ?? 0 }
	}

	it("keeps a date typed in the locale's order as its own pattern, also after other settings change", async () => {
		const { session, sheet } = await openOdsSession()
		const type = async (row: number, input: string): Promise<string | undefined> => {
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(0), inputs: [input] }
			})

			return tileTexts(await firstTile(session, sheet)).get(`${String(row)},0`)
		}

		expect(await type(1, "31.12.2024")).toBe("31/12/2024")

		session.configure({ author: "Someone" })

		expect(await type(2, "15.03.2023")).toBe("15/03/2023")
		expect(await type(3, "1234,5")).toBe("1234,5")
	})
})

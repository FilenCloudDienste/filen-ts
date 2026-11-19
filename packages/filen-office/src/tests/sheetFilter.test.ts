import { describe, expect, it, vi } from "vitest"
import { readAutoFilter, writeAutoFilter, columnMarkup, criteriaMarkup, parseA1Range } from "../core/sheet/filter/autoFilter"
import { FilterTest, datePeriod, filterContext, type FilterCell, type SheetFilterCriteria } from "../core/sheet/filter/criteria"
import { AxisFlag, type SheetCommandResult, type SheetLayout, type SheetOpened } from "../core/sheet/protocol"
import { SortType } from "../core/sheet/sort/order"
import { slotValue } from "../core/sheet/cf/host"
import { dateSerial, isoSerial } from "../core/sheet/numfmt/date"
import { RenderStyleTable } from "../core/sheet/session"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { readCell } from "../core/xlsx/edit/filter"
import type { SheetStore } from "../core/xlsx/model/store"
import { bytesSource } from "../core/opc/index"
import { openXlsx } from "../core/xlsx/read/index"
import { buildXlsx } from "./oracles/sheet/synthetic"
import { inThreadSheetHost } from "../dom/sheet/host"
import { IMMEDIATE, savedBytes } from "./sheetSessionFixtures"
import { buildFixture, parts, type Fixture } from "./xlsxWriteFixtures"
import { TYPES, relationship } from "./xlsxRefsFixtures"

// Autofilters: what each kind of criteria lets through (§18.3.2), the element read and written back with what it
// held kept, and the filter commands over a workbook: rows hidden and shown, the _FilterDatabase name, a table's
// filter, the values list, undo, protection and the refusals.

const textCell = (text: string): FilterCell => ({ type: SortType.TEXT, number: 0, text, date: false })
const numberCell = (number: number, text = String(number), date = false): FilterCell => ({ type: SortType.NUMBER, number, text, date })
const blankCell: FilterCell = { type: SortType.BLANK, number: 0, text: "", date: false }
const NONE = { threshold: Number.NaN, average: Number.NaN, from: Number.NaN, to: Number.NaN }
const calendar = (serial: number) => {
	const date = new Date((serial - 25_569) * 86_400_000)

	return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, second: 0 }
}

function test(criteria: SheetFilterCriteria, numbers: number[] = [], today = 45_000): FilterTest {
	return new FilterTest(criteria, filterContext(criteria, numbers, today, false), calendar)
}

describe("filter criteria", () => {
	it("lets checked values through by what the cells show, any case, with blanks when asked", () => {
		const list = test({ kind: "values", values: ["Apple", "1,000.00"], blank: false, dates: [] })

		expect(list.passes(textCell("apple"))).toBe(true)
		expect(list.passes(numberCell(1000, "1,000.00"))).toBe(true)
		expect(list.passes(textCell("pear"))).toBe(false)
		expect(list.passes(blankCell)).toBe(false)
		expect(test({ kind: "values", values: [], blank: true, dates: [] }).passes(blankCell)).toBe(true)
	})

	it("matches dates by their group", () => {
		const list = test({ kind: "values", values: [], blank: false, dates: [{ grouping: "month", year: 2023, month: 3 }] })

		// 45000 is 2023-03-15.
		expect(list.passes(numberCell(45_000, "3/15/2023", true))).toBe(true)
		expect(list.passes(numberCell(45_100, "6/23/2023", true))).toBe(false)
		// A number that is not a date is matched by its text alone.
		expect(list.passes(numberCell(45_000))).toBe(false)
	})

	it("matches wildcards in custom conditions (contains, begins with, ~ escapes)", () => {
		const contains = test({ kind: "custom", and: false, conditions: [{ operator: "equal", value: "*an*" }] })

		expect(contains.passes(textCell("Banana"))).toBe(true)
		expect(contains.passes(textCell("kiwi"))).toBe(false)
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "notEqual", value: "b*" }] }).passes(textCell("Banana"))).toBe(
			false
		)
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "equal", value: "a~*b" }] }).passes(textCell("a*b"))).toBe(true)
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "equal", value: "a~*b" }] }).passes(textCell("axb"))).toBe(false)
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "equal", value: "?b" }] }).passes(textCell("ab"))).toBe(true)
	})

	it("compares numbers as numbers, text in sort order, and never a number with text", () => {
		const between = test({
			kind: "custom",
			and: true,
			conditions: [
				{ operator: "greaterThanOrEqual", value: "10" },
				{ operator: "lessThanOrEqual", value: "20" }
			]
		})

		expect(between.passes(numberCell(10))).toBe(true)
		expect(between.passes(numberCell(21))).toBe(false)
		expect(between.passes(textCell("15"))).toBe(false)
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "greaterThan", value: "m" }] }).passes(textCell("Pear"))).toBe(
			true
		)
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "greaterThan", value: "m" }] }).passes(numberCell(5))).toBe(
			false
		)
		// "Does not equal" lets other types and blanks through.
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "notEqual", value: "5" }] }).passes(textCell("x"))).toBe(true)
	})

	it("reads Excel's blank and non-blank conditions", () => {
		const nonBlank = test({ kind: "custom", and: false, conditions: [{ operator: "notEqual", value: " " }] })

		expect(nonBlank.passes(blankCell)).toBe(false)
		expect(nonBlank.passes(textCell("a"))).toBe(true)
		expect(test({ kind: "custom", and: false, conditions: [{ operator: "equal", value: "" }] }).passes(blankCell)).toBe(true)
	})

	it("keeps the top or bottom items or percent, ties at the threshold included", () => {
		const numbers = [5, 1, 9, 9, 3, 7]

		expect(test({ kind: "top10", top: true, percent: false, value: 2 }, numbers).passes(numberCell(9))).toBe(true)
		expect(test({ kind: "top10", top: true, percent: false, value: 2 }, numbers).passes(numberCell(7))).toBe(false)
		expect(test({ kind: "top10", top: true, percent: false, value: 3 }, numbers).passes(numberCell(7))).toBe(true)
		expect(test({ kind: "top10", top: false, percent: false, value: 2 }, numbers).passes(numberCell(3))).toBe(true)
		// 50 % of six items is three.
		expect(test({ kind: "top10", top: true, percent: true, value: 50 }, numbers).passes(numberCell(7))).toBe(true)
		expect(test({ kind: "top10", top: true, percent: true, value: 50 }, numbers).passes(numberCell(5))).toBe(false)
		expect(test({ kind: "top10", top: true, percent: false, value: 2 }, numbers).passes(textCell("9"))).toBe(false)
	})

	it("works out averages and date periods (weeks from Sunday)", () => {
		expect(test({ kind: "dynamic", type: "aboveAverage" }, [1, 2, 3, 6]).passes(numberCell(4))).toBe(true)
		expect(test({ kind: "dynamic", type: "belowAverage" }, [1, 2, 3, 6]).passes(numberCell(2))).toBe(true)
		expect(test({ kind: "dynamic", type: "belowAverage" }, [1, 2, 3, 6]).passes(numberCell(3))).toBe(false)
		// 45000 is Wednesday 2023-03-15.
		expect(datePeriod("thisWeek", 45_000)).toEqual([44_997, 45_004])
		expect(datePeriod("lastMonth", 45_000)).toEqual([44_958, 44_986])
		expect(datePeriod("thisQuarter", 45_000)).toEqual([44_927, 45_017])
		expect(datePeriod("yearToDate", 45_000)).toEqual([44_927, 45_001])
		expect(test({ kind: "dynamic", type: "today" }).passes(numberCell(45_000.5))).toBe(true)
		expect(test({ kind: "dynamic", type: "yesterday" }).passes(numberCell(45_000))).toBe(false)
		expect(test({ kind: "dynamic", type: "Q1" }).passes(numberCell(45_000))).toBe(true)
		expect(test({ kind: "dynamic", type: "M4" }).passes(numberCell(45_000))).toBe(false)
		expect(filterContext({ kind: "dynamic", type: "today" }, [], 45_000, true)).toEqual({ ...NONE, from: 45_000, to: 45_001 })
	})
})

describe('a t="d" cell\'s ISO 8601 text', () => {
	it("reads as a serial: a date, its time, seconds with their fraction, in either date system", () => {
		expect(isoSerial("2024-01-02", false)).toBe(dateSerial(2024, 1, 2, false))
		expect(isoSerial("2024-01-02T06:00", false)).toBe(dateSerial(2024, 1, 2, false) + 0.25)
		expect(isoSerial("2024-01-02T12:00:00.5", false)).toBe(dateSerial(2024, 1, 2, false) + 43_200.5 / 86_400)
		expect(isoSerial("1904-01-02", true)).toBe(1)
		expect(isoSerial("1900-01-01", false)).toBe(1)
		expect(isoSerial("noon", false)).toBeNaN()
	})

	it("has one serial for filters, conditional formats and the cell view", async () => {
		const opened = await openXlsx(
			bytesSource(
				buildXlsx({
					sheets: [
						{ name: "One", body: '<sheetData><row r="1"><c r="A1" t="d"><v>2024-01-02T12:00:00.5</v></c></row></sheetData>' }
					]
				})
			)
		)

		if (!opened.ok) throw new Error(opened.reason)

		const document = new XlsxDocument(opened.workbook, new RenderStyleTable(), { kind: "xlsx" })

		try {
			const model = await document.ready(document.worksheets()[0]?.id ?? 0)
			const slot = (model.store as SheetStore).locate(0, 0)
			const serial = dateSerial(2024, 1, 2, false) + 43_200.5 / 86_400

			expect(readCell(document, model, 0, 0, slot, false).number).toBe(serial)
			expect(slotValue(document, model, 0, 0, slot)).toBe(serial)
			expect(document.engineCell(model, 0, 0).content).toBe(serial)
		} finally {
			document.close()
		}
	})
})

describe("autofilter markup", () => {
	it("reads a range reference: reversed corners put in order, nothing past the grid", () => {
		expect(parseA1Range("c5:$A$2")).toEqual({ startRow: 1, startCol: 0, endRow: 4, endCol: 2 })
		expect(parseA1Range("B3")).toEqual({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 })
		expect(parseA1Range("XFD1048576")).toEqual({ startRow: 1_048_575, startCol: 16_383, endRow: 1_048_575, endCol: 16_383 })
		expect(parseA1Range("XFE1")).toBeNull()
		expect(parseA1Range("A1:A1048577")).toBeNull()
		expect(parseA1Range("A0")).toBeNull()
		expect(parseA1Range("A:A")).toBeNull()
	})

	it("reads every kind of criteria, and keeps what it does not know", () => {
		const filter = readAutoFilter(
			'<autoFilter ref="A1:F9" xr:uid="{1}"><filterColumn colId="0"><filters blank="1"><filter val="a"/><dateGroupItem year="2024" month="2" dateTimeGrouping="month"/></filters></filterColumn>' +
				'<filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="1"/><customFilter operator="lessThan" val="5"/></customFilters></filterColumn>' +
				'<filterColumn colId="2"><top10 top="0" percent="1" val="10"/></filterColumn><filterColumn colId="3"><dynamicFilter type="thisMonth"/></filterColumn>' +
				'<filterColumn colId="4" hiddenButton="1"><colorFilter dxfId="2" cellColor="0"/></filterColumn><filterColumn colId="5"><x:future/></filterColumn>' +
				'<sortState ref="A2:F9"><sortCondition descending="1" ref="B2:B9"/></sortState><extLst><ext uri="{X}"/></extLst></autoFilter>'
		)

		expect(filter?.ref).toEqual({ startRow: 0, startCol: 0, endRow: 8, endCol: 5 })
		expect(filter?.columns.map(column => column.criteria?.kind ?? (column.unknown ? "unknown" : "none"))).toEqual([
			"values",
			"custom",
			"top10",
			"dynamic",
			"color",
			"unknown"
		])
		expect(filter?.columns[0]?.criteria).toEqual({
			kind: "values",
			values: ["a"],
			blank: true,
			dates: [{ grouping: "month", year: 2024, month: 2 }]
		})
		expect(filter?.columns[4]).toMatchObject({ hiddenButton: true, dxfId: 2 })
		expect(filter?.sort?.conditions).toEqual([
			{ ref: { startRow: 1, startCol: 1, endRow: 8, endCol: 1 }, descending: true, byValue: true }
		])

		const written = writeAutoFilter(filter, "", {
			ref: { startRow: 0, startCol: 0, endRow: 8, endCol: 5 },
			columns: new Map([
				[
					1,
					columnMarkup(
						"",
						filter?.columns[1] ?? null,
						1,
						criteriaMarkup("", { kind: "dynamic", type: "aboveAverage" }, { val: 2.5 })
					)
				],
				[5, filter?.columns[5]?.markup ?? ""]
			])
		})

		expect(written).toBe(
			'<autoFilter ref="A1:F9" xr:uid="{1}"><filterColumn colId="1"><dynamicFilter type="aboveAverage" val="2.5"/></filterColumn>' +
				'<filterColumn colId="5"><x:future/></filterColumn><sortState ref="A2:F9"><sortCondition descending="1" ref="B2:B9"/></sortState><extLst><ext uri="{X}"/></extLst></autoFilter>'
		)
	})
})

// --- Sessions ---

async function open(fixture: Fixture, clock = () => Date.UTC(2023, 2, 15, 12)): Promise<SheetOpened & { readonly bytes: Uint8Array }> {
	const bytes = buildFixture(fixture)
	const host = inThreadSheetHost()
	const result = await host.open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE, settings: { clock } }, () => undefined)

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	await result.session.intent()

	return { session: result.session, info: result.info, bytes }
}

function ok(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} (${result.refusal.detail ?? ""})`)
}

function hiddenRows(layout: SheetLayout): number[] {
	const out: number[] = []

	layout.rows.indices.forEach((row, k) => {
		if (((layout.rows.flags[k] ?? 0) & AxisFlag.HIDDEN) !== 0) out.push(row)
	})

	return out
}

const STRINGS = (values: readonly string[]): string =>
	`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">${values.map(value => `<si><t>${value}</t></si>`).join("")}</sst>`

const FRUIT: Fixture = {
	sheets: [
		{
			name: "Data",
			body:
				'<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
				'<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c></row>' +
				'<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>7</v></c></row>' +
				'<row r="4"><c r="A4" t="s"><v>2</v></c><c r="B4"><v>1</v></c></row>' +
				'<row r="5"><c r="B5"><v>5</v></c></row>' +
				'<row r="6"><c r="A6" t="s"><v>4</v></c><c r="B6"><v>9</v></c></row>' +
				"</sheetData>"
		}
	],
	sharedStrings: STRINGS(["Fruit", "Count", "apple", "pear", "fig"])
}

describe("filter commands", () => {
	it("puts a filter on a range, hides the rows a column's criteria fail, and takes it all back", async () => {
		const opened = await open(FRUIT)
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "filter.toggle",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
				active: { row: 0, col: 0 }
			})
		)
		ok(
			await opened.session.command({
				type: "filter.column",
				sheet,
				row: 0,
				col: 0,
				criteria: { kind: "values", values: ["apple"], blank: true, dates: [] }
			})
		)

		expect(hiddenRows(await opened.session.layout(sheet))).toEqual([2, 5])

		const saved = parts(await savedBytes(opened.session))

		expect(saved["xl/worksheets/sheet1.xml"]).toContain(
			'<autoFilter ref="A1:B6"><filterColumn colId="0"><filters blank="1"><filter val="apple"/></filters></filterColumn></autoFilter>'
		)
		expect(saved["xl/worksheets/sheet1.xml"]).toContain('<row r="3" hidden="1">')
		expect(saved["xl/workbook.xml"]).toContain(
			'<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$B$6</definedName>'
		)

		const layout = await opened.session.layout(sheet)

		expect([...(layout.extensions?.filters?.ranges[0]?.buttons ?? [])]).toEqual([3, 1])

		// The top four counts of the whole column (9, 7, 5, 3), and apple or blank in the first: rows 2 and 5.
		ok(
			await opened.session.command({
				type: "filter.column",
				sheet,
				row: 0,
				col: 1,
				criteria: { kind: "top10", top: true, percent: false, value: 4 }
			})
		)
		expect(hiddenRows(await opened.session.layout(sheet))).toEqual([2, 3, 5])
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toContain(
			'<filterColumn colId="1"><top10 val="4" filterVal="3"/></filterColumn>'
		)

		ok(await opened.session.command({ type: "filter.clear", sheet, row: 3, col: 1 }))
		expect(hiddenRows(await opened.session.layout(sheet))).toEqual([])
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toContain('<autoFilter ref="A1:B6"/>')

		ok(
			await opened.session.command({
				type: "filter.toggle",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
				active: { row: 0, col: 0 }
			})
		)
		expect((await opened.session.layout(sheet)).extensions?.filters).toBeUndefined()

		for (let k = 0; k < 5; k++) ok(await opened.session.undo())

		const reverted = parts(await savedBytes(opened.session))

		expect(reverted["xl/worksheets/sheet1.xml"]).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])
		expect(reverted["xl/workbook.xml"]).toBe(parts(opened.bytes)["xl/workbook.xml"])
		opened.session.close()
	})

	it("keeps the sheet in filter mode while a filter hides rows (sheetPr filterMode), and undoes byte for byte", async () => {
		const opened = await open(FRUIT)
		const sheet = opened.info.sheets[0]!.id
		const sheetXml = async (): Promise<string> => parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"] ?? ""

		ok(
			await opened.session.command({
				type: "filter.toggle",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
				active: { row: 0, col: 0 }
			})
		)
		expect(await sheetXml()).not.toContain("filterMode")

		ok(
			await opened.session.command({
				type: "filter.column",
				sheet,
				row: 0,
				col: 1,
				criteria: { kind: "dynamic", type: "aboveAverage" }
			})
		)
		expect(await sheetXml()).toMatch(/^[^]*<worksheet [^>]*><sheetPr filterMode="1"\/>/)

		ok(await opened.session.command({ type: "filter.clear", sheet, row: 0, col: 0 }))
		expect(await sheetXml()).not.toContain("filterMode")

		for (let k = 0; k < 3; k++) ok(await opened.session.undo())

		expect(await sheetXml()).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])
		opened.session.close()
	})

	it("takes filter mode off a sheet whose filter is cleared, and puts the source back on undo", async () => {
		const body = FRUIT.sheets[0]!.body!.replace(
			"<sheetData>",
			'<sheetPr filterMode="1"><tabColor rgb="FFFF0000"/></sheetPr><sheetData>'
		).replace('<row r="3">', '<row r="3" hidden="1">')
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body: `${body}<autoFilter ref="A1:B6"><filterColumn colId="0"><filters><filter val="apple"/><filter val="fig"/></filters></filterColumn></autoFilter>`
				}
			],
			sharedStrings: FRUIT.sharedStrings!
		})
		const sheet = opened.info.sheets[0]!.id

		ok(await opened.session.command({ type: "filter.clear", sheet, row: 0, col: 0 }))

		const cleared = parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(cleared).toContain('<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>')

		ok(await opened.session.undo())
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])
		opened.session.close()
	})

	it("puts the source's filter mode back on undo and redo, also where it disagrees with the rows the filter hides", async () => {
		const sources = [
			// Rows hidden by a filter, and no filterMode.
			{ sheetPr: "", hidden: true },
			{ sheetPr: '<sheetPr codeName="X"/>', hidden: true },
			// filterMode set, and nothing hidden.
			{ sheetPr: '<sheetPr filterMode="1"/>', hidden: false }
		]

		for (const { sheetPr, hidden } of sources) {
			const body = FRUIT.sheets[0]!.body!.replace("<sheetData>", `${sheetPr}<sheetData>`)
			const opened = await open({
				sheets: [
					{
						name: "Data",
						body: `${hidden ? body.replace('<row r="3">', '<row r="3" hidden="1">') : body}<autoFilter ref="A1:B6"><filterColumn colId="0"><filters><filter val="apple"/><filter val="fig"/></filters></filterColumn></autoFilter>`
					}
				],
				sharedStrings: FRUIT.sharedStrings!
			})
			const sheet = opened.info.sheets[0]!.id
			const source = parts(opened.bytes)["xl/worksheets/sheet1.xml"]
			const sheetXml = async (): Promise<string | undefined> => parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]
			const edits = [
				{ type: "filter.clear", sheet, row: 0, col: 0 },
				{ type: "filter.toggle", sheet, range: { startRow: 0, startCol: 0, endRow: 5, endCol: 1 }, active: { row: 0, col: 0 } },
				{ type: "filter.column", sheet, row: 0, col: 0, criteria: { kind: "values", values: ["pear"], blank: false, dates: [] } }
			] as const

			for (const edit of edits) {
				ok(await opened.session.command(edit))

				const edited = await sheetXml()

				ok(await opened.session.undo())
				expect(await sheetXml()).toBe(source)
				ok(await opened.session.redo())
				expect(await sheetXml()).toBe(edited)
				ok(await opened.session.undo())
			}

			opened.session.close()
		}
	})

	it("stops formatting values once the list is full, still counting every cell's kind", async () => {
		// Three texts, then numbers, a blank and more numbers: the list holds the first values, the kind is the counts'.
		const rows = ['<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row>']

		for (let r = 2; r <= 2_001; r++)
			rows.push(
				r <= 4
					? `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>t${r}</t></is></c></row>`
					: r === 10
						? `<row r="${r}"><c r="B${r}"><v>1</v></c></row>`
						: `<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`
			)

		const opened = await open({ sheets: [{ name: "Data", body: `<sheetData>${rows.join("")}</sheetData>` }] })
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "filter.toggle",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 2_000, endCol: 1 },
				active: { row: 0, col: 0 }
			})
		)

		const views = vi.spyOn(XlsxDocument.prototype, "cellView")

		try {
			const values = await opened.session.query("filter.values", { sheet, row: 0, col: 0, limit: 4 })

			expect(values?.items.map(item => item.text)).toEqual(["5", "t2", "t3", "t4"])
			expect(values?.more).toBe(true)
			expect(values?.blank).toEqual({ checked: true })
			expect(values?.kind).toBe("number")
			// The header and the cells up to the first one past the limit.
			expect(views.mock.calls.length).toBeLessThan(10)
		} finally {
			views.mockRestore()
			opened.session.close()
		}
	})

	it("lists a column's values once each in sort order, by the rows other columns let through", async () => {
		const opened = await open(FRUIT)
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "filter.toggle",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
				active: { row: 0, col: 0 }
			})
		)

		const all = await opened.session.query("filter.values", { sheet, row: 0, col: 0, limit: 100 })

		expect(all?.items.map(item => item.text)).toEqual(["apple", "fig", "pear"])
		expect(all?.blank).toEqual({ checked: true })
		expect(all?.header).toBe("Fruit")
		expect(all?.kind).toBe("text")

		ok(
			await opened.session.command({
				type: "filter.column",
				sheet,
				row: 0,
				col: 1,
				criteria: { kind: "custom", and: false, conditions: [{ operator: "lessThan", value: "6" }] }
			})
		)

		const narrowed = await opened.session.query("filter.values", { sheet, row: 0, col: 0, limit: 100 })

		expect(narrowed?.items.map(item => item.text)).toEqual(["apple"])

		const counts = await opened.session.query("filter.values", { sheet, row: 0, col: 1, limit: 100 })

		expect(counts?.items.map(item => [item.text, item.checked])).toEqual([
			["1", true],
			["3", true],
			["5", true],
			["7", false],
			["9", false]
		])
		expect(counts?.kind).toBe("number")
		opened.session.close()
	})

	it("filters a table through its own part", async () => {
		const opened = await open({
			sheets: [
				{
					...FRUIT.sheets[0]!,
					body: `${FRUIT.sheets[0]!.body!}<tableParts count="1"><tablePart r:id="rId1"/></tableParts>`,
					rels: relationship("rId1", "table", "../tables/table1.xml")
				}
			],
			sharedStrings: FRUIT.sharedStrings!,
			parts: {
				"xl/tables/table1.xml": {
					type: TYPES.table,
					text: '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Fruit" displayName="Fruit" ref="A1:B6"><autoFilter ref="A1:B6"/><tableColumns count="2"><tableColumn id="1" name="Fruit"/><tableColumn id="2" name="Count"/></tableColumns></table>'
				}
			}
		})
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "filter.column",
				sheet,
				row: 0,
				col: 1,
				criteria: { kind: "dynamic", type: "aboveAverage" }
			})
		)
		expect(hiddenRows(await opened.session.layout(sheet))).toEqual([1, 3, 4])

		const saved = parts(await savedBytes(opened.session))

		expect(saved["xl/tables/table1.xml"]).toContain(
			'<autoFilter ref="A1:B6"><filterColumn colId="1"><dynamicFilter type="aboveAverage" val="5"/></filterColumn></autoFilter>'
		)
		expect(saved["xl/workbook.xml"]).not.toContain("_FilterDatabase")
		expect((await opened.session.layout(sheet)).extensions?.filters?.ranges[0]?.table).toBe("Fruit")

		// The table's buttons go off and on with the toggle.
		ok(
			await opened.session.command({
				type: "filter.toggle",
				sheet,
				range: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
				active: { row: 2, col: 0 }
			})
		)
		expect(parts(await savedBytes(opened.session))["xl/tables/table1.xml"]).not.toContain("autoFilter")
		expect(hiddenRows(await opened.session.layout(sheet))).toEqual([])
		opened.session.close()
	})

	it("refuses criteria it cannot work out, and follows sheet protection", async () => {
		const withIcons = await open({
			sheets: [
				{
					name: "Data",
					body: `${FRUIT.sheets[0]!.body!}<autoFilter ref="A1:B6"><filterColumn colId="1"><iconFilter iconSet="3Arrows" iconId="0"/></filterColumn></autoFilter>`
				}
			],
			sharedStrings: FRUIT.sharedStrings!
		})
		const iconSheet = withIcons.info.sheets[0]!.id
		const refused = await withIcons.session.command({
			type: "filter.column",
			sheet: iconSheet,
			row: 0,
			col: 0,
			criteria: { kind: "values", values: ["fig"], blank: false, dates: [] }
		})

		expect(refused.ok ? null : refused.refusal).toEqual({ reason: "filterCriteria", detail: "iconFilter" })
		withIcons.session.close()

		const guarded = `${FRUIT.sheets[0]!.body!}<sheetProtection sheet="1" autoFilter="0"/><autoFilter ref="A1:B6"/>`
		const protectedSheet = await open({ sheets: [{ name: "Data", body: guarded }], sharedStrings: FRUIT.sharedStrings! })
		const sheet = protectedSheet.info.sheets[0]!.id

		ok(
			await protectedSheet.session.command({
				type: "filter.column",
				sheet,
				row: 0,
				col: 0,
				criteria: { kind: "values", values: ["fig"], blank: false, dates: [] }
			})
		)

		const toggle = await protectedSheet.session.command({
			type: "filter.toggle",
			sheet,
			range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
			active: { row: 0, col: 0 }
		})

		expect(toggle.ok ? null : toggle.refusal.reason).toBe("protectedSheet")
		protectedSheet.session.close()
	})

	it("filters by colour", async () => {
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2" s="2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData>' +
						'<autoFilter ref="A1:A3"/>'
				}
			],
			styles:
				'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>' +
				'<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" applyFill="1"/></cellXfs>'
		})
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "filter.column",
				sheet,
				row: 0,
				col: 0,
				criteria: { kind: "color", cell: true, color: 0xffff00 }
			})
		)
		expect(hiddenRows(await opened.session.layout(sheet))).toEqual([2])
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toMatch(
			/<filterColumn colId="0"><colorFilter dxfId="\d+"\/><\/filterColumn>/
		)
		opened.session.close()
	})

	it("refuses a colour filter over cells a conditional format may colour, a whole column or a list that does not read", async () => {
		const refusal = async (sqref: string): Promise<string | null> => {
			const opened = await open({
				sheets: [
					{
						name: "Data",
						body:
							'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>2</v></c></row></sheetData>' +
							'<autoFilter ref="A1:B2"/>' +
							`<conditionalFormatting sqref="${sqref}"><cfRule type="cellIs" priority="1" operator="greaterThan" dxfId="0"><formula>1</formula></cfRule></conditionalFormatting>`
					}
				]
			})
			const result = await opened.session.command({
				type: "filter.column",
				sheet: opened.info.sheets[0]!.id,
				row: 0,
				col: 1,
				criteria: { kind: "color", cell: true, color: 0xffff00 }
			})

			opened.session.close()

			return result.ok ? null : `${result.refusal.reason}:${result.refusal.detail ?? ""}`
		}

		expect(await refusal("B:B")).toBe("filterCriteria:colorFilter")
		expect(await refusal("B2")).toBe("filterCriteria:colorFilter")
		expect(await refusal("D1 B:")).toBe("filterCriteria:colorFilter")
		// Over another column, it does not colour column B.
		expect(await refusal("A:A")).toBeNull()
	})
})

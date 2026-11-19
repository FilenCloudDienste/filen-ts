import { HyperFormula } from "hyperformula"
import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "../core/opc/index"
import type { SheetCommandResult, SheetOpened, SheetTile } from "../core/sheet/protocol"
import type { SheetChangeSink } from "../core/sheet/registry"
import { RenderStyleTable } from "../core/sheet/session"
import { SortType, compareSortValues, sortOrder, textSortKey, type SortValue } from "../core/sheet/sort/order"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { sortRange } from "../core/xlsx/edit/sort"
import { CellKind } from "../core/xlsx/model/types"
import { SheetStore, StoreBuilder, openXlsx } from "../core/xlsx/read/index"
import { inThreadSheetHost } from "../dom/sheet/host"
import { buildXlsx } from "./oracles/sheet/synthetic"
import { IMMEDIATE, savedBytes, tileTexts } from "./sheetSessionFixtures"
import { buildFixture, parts, type Fixture } from "./xlsxWriteFixtures"

// Sorting: Excel's order of values (numbers, text, logical values, errors, then blanks in either direction; text
// character by character, apostrophes and hyphens ignored, case only when asked), and sort.apply over a workbook:
// the header row, several keys, formulas moved as copies, formats along, hidden rows left in place, the sort state of
// an autofilter, and the refusals.

const text = (value: string, caseSensitive = false): SortValue => ({
	type: SortType.TEXT,
	number: 0,
	key: textSortKey(value, caseSensitive)
})
const num = (value: number): SortValue => ({ type: SortType.NUMBER, number: value, key: "" })
const bool = (value: boolean): SortValue => ({ type: SortType.BOOLEAN, number: value ? 1 : 0, key: "" })
const error: SortValue = { type: SortType.ERROR, number: 0, key: "" }
const blank: SortValue = { type: SortType.BLANK, number: 0, key: "" }

function sorted(values: readonly SortValue[], descending = false): number[] {
	return [...sortOrder(values.length, [{ descending }], (_, item) => values[item] as SortValue)]
}

function textsSorted(values: readonly string[], caseSensitive = false): string[] {
	return [...sortOrder(values.length, [{ descending: false }], (_, item) => text(values[item] as string, caseSensitive))].map(
		index => values[index] as string
	)
}

describe("Excel's sort order", () => {
	it("puts numbers, text, logical values and errors in that order, and blanks last either way", () => {
		const values = [blank, error, bool(true), text("b"), num(2), bool(false), text("a"), num(-1), error]

		expect(sorted(values)).toEqual([7, 4, 6, 3, 5, 2, 1, 8, 0])
		// Descending reverses all but the blanks; equal errors keep their order.
		expect(sorted(values, true)).toEqual([1, 8, 2, 5, 3, 6, 4, 7, 0])
	})

	it("orders text character by character in the documented order, case-insensitively", () => {
		expect(textsSorted(["A11", "A100", "A1"])).toEqual(["A1", "A100", "A11"])
		expect(textsSorted(["b", "!", "1", " ", "~", "+", "A", ">"])).toEqual(["1", " ", "!", "~", "+", ">", "A", "b"])
		expect(textsSorted(["B", "a", "A", "b"])).toEqual(["a", "A", "B", "b"])
	})

	it("ignores apostrophes and hyphens, but sorts the hyphenated of two otherwise equal texts last", () => {
		expect(textsSorted(["co-op", "coop", "cop"])).toEqual(["coop", "co-op", "cop"])
		expect(textsSorted(["it's", "its", "itself"])).toEqual(["its", "it's", "itself"])
	})

	it("sorts lowercase before uppercase only when case counts", () => {
		expect(textsSorted(["B", "a", "A", "b"], true)).toEqual(["a", "A", "b", "B"])
		expect(compareSortValues(text("a", true), text("A", true), false)).toBe(-1)
		expect(compareSortValues(text("a"), text("A"), false)).toBe(0)
	})

	it("sorts accented letters with their base letter, after it", () => {
		expect(textsSorted(["eb", "éa", "ea", "f"])).toEqual(["ea", "éa", "eb", "f"])
	})

	it("keeps other scripts' letters in code point order after Z, Hangul and the compatibility blocks included", () => {
		const hangul = ["\uac00", "\uce74", "\ucfe0", "\ud0c0", "\ud30c", "\ud558"]

		expect(textsSorted([...hangul].reverse())).toEqual(hangul)
		// A CJK ideograph, a compatibility ideograph and an astral one after Z, in that order.
		expect(textsSorted(["\u{20000}", "\uf900", "\u4e00", "Z"])).toEqual(["Z", "\u4e00", "\uf900", "\u{20000}"])
		// Fullwidth Latin letters keep their order, either case.
		expect(textsSorted(["\uff5a", "\uff22", "\uff41"])).toEqual(["\uff41", "\uff22", "\uff5a"])
	})

	it("weighs the other scripts' letters from U+0180 to U+D7FF and up to U+FFFF in code point order, below the surrogates", () => {
		const weight = (code: number): number => textSortKey(String.fromCharCode(code), false).charCodeAt(0)
		let previous = 0
		let decreases = 0

		for (const [from, to] of [
			[0x180, 0xd7ff],
			[0xf900, 0xffff]
		] as const)
			for (let code = from; code <= to; code++) {
				const char = String.fromCharCode(code)

				// Upper case letters weigh as their lower case; symbols have weights of their own.
				if (char.toLowerCase() !== char.toUpperCase() && char.toLowerCase() !== char) continue
				if ((code >= 0x2000 && code <= 0x2bff) || (code >= 0x3000 && code <= 0x303f)) continue
				if ((code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff0f)) continue

				const at = weight(code)

				if (at < previous) decreases++

				expect(at).toBeLessThan(0xd800)
				previous = at
			}

		expect(decreases).toBe(0)
		expect(textSortKey("\u{1f600}\u{20000}", false).charCodeAt(0)).toBeLessThan(0xd800)
	})

	it("ranks an accent alike in either case, and every accent apart", () => {
		expect(textsSorted(["\u00e9cole", "\u00c9cole"])).toEqual(["\u00e9cole", "\u00c9cole"])
		expect(textsSorted(["\u00c9cole", "\u00e9cole"])).toEqual(["\u00c9cole", "\u00e9cole"])
		expect(sorted([text("\u00c9cole"), text("\u00e9cole")], true)).toEqual([0, 1])
		expect(sorted([text("\u00e9cole"), text("\u00c9cole")], true)).toEqual([0, 1])
		// Lowercase first when case counts.
		expect(textsSorted(["\u00c9cole", "\u00e9cole"], true)).toEqual(["\u00e9cole", "\u00c9cole"])
		expect(textSortKey("\u00e9", false)).not.toBe(textSortKey("\u00ea", false))
		expect(textSortKey("\u00e9", false)).not.toBe(textSortKey("\u00ca", false))
		expect(textSortKey("\u0139", false)).toBe(textSortKey("\u013a", false))
		expect(textSortKey("\u0179", false)).toBe(textSortKey("\u017a", false))
		expect(textSortKey("\u0178", false)).toBe(textSortKey("\u00ff", false))
		// İ and Ÿ sort with their base letters.
		expect(textsSorted(["j", "\u0130", "h"])).toEqual(["h", "\u0130", "j"])
		expect(textsSorted(["z", "\u0178", "x"])).toEqual(["x", "\u0178", "z"])
	})

	it("is stable over equal keys", () => {
		expect(sorted([num(1), num(0), num(1), num(0)])).toEqual([1, 3, 0, 2])
	})
})

// --- Sessions ---

async function open(fixture: Fixture): Promise<SheetOpened & { readonly bytes: Uint8Array }> {
	const bytes = buildFixture(fixture)
	const host = inThreadSheetHost()
	const result = await host.open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	await result.session.intent()

	return { session: result.session, info: result.info, bytes }
}

function ok(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} (${result.refusal.detail ?? ""})`)
}

async function texts(opened: SheetOpened, sheet = opened.info.sheets[0]?.id ?? 0): Promise<Map<string, string>> {
	const { tiles } = await opened.session.tiles(sheet, Uint32Array.of(0, 0))

	return tileTexts(tiles[0] as SheetTile)
}

function column(cells: Map<string, string>, col: number, from: number, to: number): string[] {
	const out: string[] = []

	for (let row = from; row <= to; row++) out.push(cells.get(`${row},${col}`) ?? "")

	return out
}

const STRINGS = (values: readonly string[]): string =>
	`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">${values.map(value => `<si><t>${value}</t></si>`).join("")}</sst>`

// Name | Score | Double, with a formula per row reading its own row.
const TABLE: Fixture = {
	sheets: [
		{
			name: "Data",
			body:
				'<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
				'<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>30</v></c><c r="C2"><f>B2*2</f><v>60</v></c></row>' +
				'<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>10</v></c><c r="C3"><f>B3*2</f><v>20</v></c></row>' +
				'<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"><v>20</v></c><c r="C4"><f>B4*2</f><v>40</v></c></row>' +
				'<row r="5"><c r="A5" t="s"><v>6</v></c><c r="C5"><f>$B$2+1</f><v>31</v></c></row>' +
				"</sheetData>"
		}
	],
	sharedStrings: STRINGS(["Name", "Score", "Double", "carol", "alice", "bob", "dave"])
}

describe("sort.apply", () => {
	it("sorts rows under the header by a column, formulas moving as copies and formats along", async () => {
		const opened = await open(TABLE)
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
				orientation: "rows",
				header: true,
				caseSensitive: false,
				keys: [{ index: 1, descending: false }]
			})
		)

		const cells = await texts(opened)

		expect(column(cells, 0, 0, 4)).toEqual(["Name", "alice", "bob", "carol", "dave"])
		// B2 holds a date format (s="1"), which travels with its value.
		expect(column(cells, 1, 0, 4)).toEqual(["Score", "10", "20", "1/30/1900", ""])

		const sheetXml = parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain('<c r="C2"><f>B2*2</f>')
		expect(sheetXml).toContain('<c r="C4"><f>B4*2</f>')
		// The absolute reference stays; the blank score sorts last.
		expect(sheetXml).toContain('<c r="C5"><f>$B$2+1</f>')
		// B2's format (s="1") went with its value to row 4.
		expect(sheetXml).toContain('<c r="B4" s="1"><v>30</v></c>')
		expect(column(cells, 2, 1, 4)).toEqual(["20", "40", "60", "11"])

		ok(await opened.session.undo())
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])

		ok(await opened.session.redo())
		expect(column(await texts(opened), 0, 1, 4)).toEqual(["alice", "bob", "carol", "dave"])
		opened.session.close()
	})

	it("sorts by several keys, descending, and leaves hidden rows where they are", async () => {
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body:
						"<sheetData>" +
						'<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c></row>' +
						'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>5</v></c></row>' +
						'<row r="3" hidden="1"><c r="A3"><v>9</v></c><c r="B3"><v>9</v></c></row>' +
						'<row r="4"><c r="A4"><v>1</v></c><c r="B4"><v>3</v></c></row>' +
						'<row r="5"><c r="A5"><v>2</v></c><c r="B5"><v>4</v></c></row>' +
						"</sheetData>"
				}
			]
		})
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
				orientation: "rows",
				header: false,
				caseSensitive: false,
				keys: [
					{ index: 0, descending: true },
					{ index: 1, descending: false }
				]
			})
		)

		const cells = await texts(opened)

		expect(column(cells, 0, 0, 4)).toEqual(["2", "2", "9", "1", "1"])
		expect(column(cells, 1, 0, 4)).toEqual(["4", "5", "9", "1", "3"])
		opened.session.close()
	})

	it("sorts columns left to right by a row", async () => {
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body: '<sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1"><v>1</v></c><c r="C1"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row></sheetData>'
				}
			],
			sharedStrings: STRINGS(["three", "one", "two"])
		})
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
				orientation: "cols",
				header: false,
				caseSensitive: false,
				keys: [{ index: 0, descending: false }]
			})
		)

		const cells = await texts(opened)

		expect([cells.get("1,0"), cells.get("1,1"), cells.get("1,2")]).toEqual(["one", "two", "three"])
		opened.session.close()
	})

	it("writes the sort state of the autofilter it sorts", async () => {
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body: TABLE.sheets[0]!.body!.replace("</sheetData>", "</sheetData>") + '<autoFilter ref="A1:C5"/>'
				}
			],
			sharedStrings: TABLE.sharedStrings!
		})
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
				orientation: "rows",
				header: true,
				caseSensitive: false,
				keys: [{ index: 0, descending: true }]
			})
		)

		const sheetXml = parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain(
			'<autoFilter ref="A1:C5"><sortState ref="A2:C5"><sortCondition descending="1" ref="A2:A5"/></sortState></autoFilter>'
		)

		const layout = await opened.session.layout(sheet)

		expect([...(layout.extensions?.filters?.ranges[0]?.buttons ?? [])]).toEqual([1 | 8, 1, 1])
		opened.session.close()
	})

	it("undoes to the source a shared formula reaching from outside the sorted rows into them", async () => {
		// B1:B5 one shared formula reading the first sorted value; A3:B5 sorted, B1 and B2 left where they are.
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B5" si="0">A1+A$3</f><v>4</v></c></row>' +
						'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>5</v></c></row>' +
						'<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>6</v></c></row>' +
						'<row r="4"><c r="A4"><v>5</v></c><c r="B4"><f t="shared" si="0"/><v>8</v></c></row>' +
						'<row r="5"><c r="A5"><v>4</v></c><c r="B5"><f t="shared" si="0"/><v>7</v></c></row></sheetData>'
				}
			]
		})
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 2, startCol: 0, endRow: 4, endCol: 1 },
				orientation: "rows",
				header: false,
				caseSensitive: false,
				keys: [{ index: 0, descending: true }]
			})
		)
		expect(column(await texts(opened), 1, 0, 1)).toEqual(["6", "7"])

		ok(await opened.session.undo())
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])
		expect(column(await texts(opened), 1, 0, 4)).toEqual(["4", "5", "6", "8", "7"])

		ok(await opened.session.redo())
		expect(column(await texts(opened), 1, 0, 1)).toEqual(["6", "7"])
		ok(await opened.session.undo())
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])
		opened.session.close()
	})

	it("undoes to the source after columns are inserted and cells edited past it", async () => {
		const opened = await open(TABLE)
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
				orientation: "rows",
				header: true,
				caseSensitive: false,
				keys: [{ index: 0, descending: false }]
			})
		)
		// Columns inserted inside the sorted rows shift their blocks' cells in place.
		ok(await opened.session.command({ type: "axis.insert", sheet, axis: "cols", at: 0, count: 3 }))
		ok(
			await opened.session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(2, 6), cols: Uint16Array.of(4, 1), inputs: ["edited", "7"] }
			})
		)

		for (let k = 0; k < 3; k++) ok(await opened.session.undo())

		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])
		expect(column(await texts(opened), 0, 0, 4)).toEqual(["Name", "carol", "alice", "bob", "dave"])
		opened.session.close()
	})

	it("undoes to the source when a column insert and a cell edit came after it", async () => {
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body: '<sheetData><row r="4"><c r="F4"><v>2</v></c></row><row r="5"><c r="F5"><v>1</v></c></row></sheetData>'
				}
			]
		})
		const sheet = opened.info.sheets[0]!.id

		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 3, startCol: 5, endRow: 4, endCol: 5 },
				orientation: "rows",
				header: false,
				caseSensitive: false,
				keys: [{ index: 5, descending: false }]
			})
		)
		// The insert shifts the blocks the sort's undo holds in place; the edit then copies one of them.
		ok(await opened.session.command({ type: "axis.insert", sheet, axis: "cols", at: 1, count: 3 }))
		ok(
			await opened.session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(3), cols: Uint16Array.of(4), inputs: ["x"] }
			})
		)

		for (let k = 0; k < 3; k++) ok(await opened.session.undo())

		const cells = await texts(opened)

		expect([cells.get("3,5"), cells.get("4,5"), cells.get("3,8")]).toEqual(["2", "1", undefined])
		expect(parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]).toBe(parts(opened.bytes)["xl/worksheets/sheet1.xml"])
		opened.session.close()
	})

	it("sorts, undoes and redoes rows of formulas in slices, recalculating once per step, giving the same workbook as at once", async () => {
		const count = 3_000
		const rowsXml: string[] = [
			'<row r="1"><c r="A1" t="inlineStr"><is><t>Key</t></is></c><c r="E1"><f>SUM(C2:C3001)</f><v>0</v></c></row>'
		]

		for (let r = 2; r <= count + 1; r++)
			rowsXml.push(
				`<row r="${r}"><c r="A${r}"><v>${(r * 7919) % 3001}</v></c><c r="B${r}"><v>${r}</v></c><c r="C${r}"><f>B${r}*2+D${r}</f><v>${r * 2 + r}</v></c><c r="D${r}"><v>${r}</v></c></row>`
			)

		const fixture: Fixture = { sheets: [{ name: "Data", body: `<sheetData>${rowsXml.join("")}</sheetData>` }] }
		const sort = (sheet: number) =>
			({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: count, endCol: 2 },
				orientation: "rows",
				header: true,
				caseSensitive: false,
				keys: [{ index: 0, descending: false }]
			}) as const
		const sheetXml = async (opened: SheetOpened): Promise<string | undefined> =>
			parts(await savedBytes(opened.session))["xl/worksheets/sheet1.xml"]

		const atOnce = await open(fixture)

		ok(await atOnce.session.command(sort(atOnce.info.sheets[0]!.id)))

		const expected = await sheetXml(atOnce)

		atOnce.session.close()

		let pauses = 0
		const bytes = buildFixture(fixture)
		const result = await inThreadSheetHost().open(
			bytes.slice(),
			{ kind: "xlsx", slicing: { sliceMs: 0, now: () => 0, pause: () => (pauses++, Promise.resolve()) } },
			() => undefined
		)

		if (result.kind !== "opened") throw new Error(result.kind)

		await result.session.intent()

		const sheet = result.info.sheets[0]!.id
		const resumes = vi.spyOn(HyperFormula.prototype, "resumeEvaluation")
		// Pauses and recalculations a step makes: the totals over the moved rows are worked out once per step.
		const counted = async (work: () => Promise<SheetCommandResult>): Promise<{ pauses: number; recalculations: number }> => {
			const from = pauses

			resumes.mockClear()
			ok(await work())

			return { pauses: pauses - from, recalculations: resumes.mock.calls.length }
		}

		const sorted = await counted(() => result.session.command(sort(sheet)))

		expect(sorted.pauses).toBeGreaterThan(4)
		expect(sorted.recalculations).toBe(1)
		expect(await sheetXml(result)).toBe(expected)
		const undone = await counted(() => result.session.undo())

		expect(undone.pauses).toBeGreaterThan(1)
		expect(undone.recalculations).toBe(1)
		expect(await sheetXml(result)).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		const redone = await counted(() => result.session.redo())

		expect(redone.pauses).toBeGreaterThan(1)
		expect(redone.recalculations).toBe(1)
		expect(await sheetXml(result)).toBe(expected)
		resumes.mockRestore()
		result.session.close()
	})

	it("gives the engine the moved cells, blank ones included, and marks results held alone over them stale", async () => {
		// A2:B4 sorted by A; D reads the sorted area (D1 a cell that turns blank), E1 is held alone over it.
		const opened = await open({
			sheets: [
				{
					name: "Data",
					body:
						'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Key</t></is></c><c r="D1"><f>B2</f><v>30</v></c>' +
						'<c r="E1"><f>_xlfn.FORECAST.ETS.SEASONALITY(A2:A4,B2:B4)</f><v>5</v></c></row>' +
						'<row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>30</v></c><c r="D2"><f>SUM(B2:B4)</f><v>50</v></c></row>' +
						'<row r="3"><c r="A3"><v>1</v></c><c r="D3"><f>A2*10</f><v>30</v></c></row>' +
						'<row r="4"><c r="A4"><v>2</v></c><c r="B4"><v>20</v></c></row></sheetData>'
				}
			]
		})
		const sheet = opened.info.sheets[0]!.id
		const fullCalc = async (): Promise<boolean> =>
			/<calcPr[^>]*\sfullCalcOnLoad="(?:1|true)"/.test(parts(await savedBytes(opened.session))["xl/workbook.xml"] ?? "")

		expect(await fullCalc()).toBe(false)
		ok(
			await opened.session.command({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
				orientation: "rows",
				header: true,
				caseSensitive: false,
				keys: [{ index: 0, descending: false }]
			})
		)

		const sortedCells = await texts(opened)

		expect(column(sortedCells, 1, 1, 3)).toEqual(["", "20", "30"])
		expect(column(sortedCells, 3, 0, 2)).toEqual(["0", "50", "10"])
		expect(await fullCalc()).toBe(true)

		ok(await opened.session.undo())
		expect(column(await texts(opened), 3, 0, 2)).toEqual(["30", "50", "30"])

		ok(await opened.session.redo())
		expect(column(await texts(opened), 3, 0, 2)).toEqual(["0", "50", "10"])
		expect(await fullCalc()).toBe(true)
		opened.session.close()
	})

	it("refuses merged cells, array formulas, a hyperlink over moved rows and locked cells on a protected sheet", async () => {
		const base = TABLE.sheets[0]!.body!
		const command = (sheet: number) =>
			({
				type: "sort.apply",
				sheet,
				range: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
				orientation: "rows",
				header: true,
				caseSensitive: false,
				keys: [{ index: 1, descending: false }]
			}) as const
		const refused = async (body: string) => {
			const opened = await open({ sheets: [{ name: "Data", body }], sharedStrings: TABLE.sharedStrings! })
			const result = await opened.session.command(command(opened.info.sheets[0]!.id))

			opened.session.close()

			return result.ok ? undefined : result.refusal
		}
		const refusal = async (body: string): Promise<string | undefined> => (await refused(body))?.reason

		expect(await refusal(`${base}<mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>`)).toBe("merged")
		expect(await refusal(base.replace("<f>B3*2</f>", '<f t="array" ref="C3:C4">B3:B4*2</f>'))).toBe("arrayFormula")
		expect(await refusal(`${base}<sheetProtection sheet="1" sort="0"/>`)).toBe("protectedSheet")
		// A hyperlink over two moved rows cannot go anywhere whole.
		expect(await refusal(`${base}<hyperlinks><hyperlink ref="A3:A4" display="x" location="Data!A1"/></hyperlinks>`)).toBe(
			"structureLocked"
		)
		// A conditional format over the whole column moves nothing it covers unevenly.
		expect(
			await refusal(
				`${base}<conditionalFormatting sqref="B1:B9"><cfRule type="cellIs" priority="1" operator="greaterThan" dxfId="0"><formula>1</formula></cfRule></conditionalFormatting>`
			)
		).toBeUndefined()
		expect(
			await refusal(
				`${base}<conditionalFormatting sqref="B3"><cfRule type="cellIs" priority="1" operator="greaterThan" dxfId="0"><formula>1</formula></cfRule></conditionalFormatting>`
			)
		).toBe("structureLocked")
		// Whole rows (rows 3-6, past the sorted rows 2-5 on one side) cover them unevenly, as does a list that does not read.
		const cf = (sqref: string): string =>
			`<conditionalFormatting sqref="${sqref}"><cfRule type="cellIs" priority="1" operator="greaterThan" dxfId="0"><formula>1</formula></cfRule></conditionalFormatting>`
		const dv = (sqref: string): string =>
			`<dataValidations count="1"><dataValidation type="whole" operator="greaterThan" sqref="${sqref}"><formula1>0</formula1></dataValidation></dataValidations>`

		expect(await refusal(`${base}${cf("3:6")}`)).toBe("structureLocked")
		expect(await refused(`${base}${dv("3:6")}`)).toMatchObject({ reason: "structureLocked", detail: "dataValidations" })
		expect(await refusal(`${base}${cf("E1 B:")}`)).toBe("structureLocked")
		expect(await refusal(`${base}${dv("E1 B:")}`)).toBe("structureLocked")
		// A whole column, or whole rows over all of them, cover them evenly.
		expect(await refusal(`${base}${cf("B:B")}`)).toBeUndefined()
		expect(await refusal(`${base}${dv("1:9")}`)).toBeUndefined()
	})
})

const NO_CHANGES: SheetChangeSink = {
	content: () => undefined,
	look: () => undefined,
	moved: () => undefined,
	layout: () => undefined,
	sheets: () => undefined,
	select: () => undefined
}

describe("sort.apply over a large store", () => {
	it("moves every cell of a sheet past 256 blocks to its place", async () => {
		const opened = await openXlsx(bytesSource(buildXlsx({ sheets: [{ name: "Data", body: "<sheetData/>" }] })))

		if (!opened.ok) throw new Error(opened.reason)

		const document = new XlsxDocument(opened.workbook, new RenderStyleTable(), { kind: "xlsx" })

		try {
			const sheet = document.worksheets()[0]?.id ?? 0
			const model = await document.ready(sheet)
			// 300,000 one-cell rows (293 blocks of 1,024): slots of blocks 128 and up reach past 2^31.
			const count = 300_000
			const builder = new StoreBuilder()

			for (let row = 0; row < count; row++) {
				builder.beginRow()
				builder.cell(0, CellKind.NUMBER, row, 0, -1)
				builder.endRow(row, 0, 1, 0, Number.NaN, -1)
			}

			const before = model.store as SheetStore
			const store = new SheetStore(builder.finish(), before.strings, before.formulas)

			expect(store.blocks.length).toBeGreaterThan(256)
			Object.assign(model, { store })

			const result = await sortRange(
				document,
				{
					type: "sort.apply",
					sheet,
					range: { startRow: 0, startCol: 0, endRow: count - 1, endCol: 0 },
					orientation: "rows",
					header: false,
					caseSensitive: false,
					keys: [{ index: 0, descending: true }]
				},
				NO_CHANGES
			)

			expect(result !== null && "refused" in result).toBe(false)

			const sorted = model.store as SheetStore
			const valueAt = (row: number): number | null => {
				const slot = sorted.locate(row, 0)

				return slot < 0 ? null : sorted.value(slot)
			}

			// Rows from blocks 0-127, 128-255 (slots that wrapped negative) and 256 up (slots that aliased block b - 256).
			for (const row of [0, 1_000, 140_000, 200_000, 262_144, 270_000, 299_999]) expect(valueAt(row)).toBe(count - 1 - row)

			let wrong = 0

			for (let row = 0; row < count; row++) if (valueAt(row) !== count - 1 - row) wrong++

			expect(wrong).toBe(0)
		} finally {
			document.close()
		}
	}, 60_000)
})

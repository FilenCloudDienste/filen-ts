import { describe, expect, it } from "vitest"
import { CellFlag, EN_US_LOCALE, type SheetFilterItem, type SheetLayout, type SheetLocale } from "@filen/office/core/sheet"
import {
	DATE_CONDITIONS,
	NUMBER_CONDITIONS,
	TEXT_CONDITIONS,
	TEXT_OPERATORS,
	clearTarget,
	filterRows,
	groupState,
	dialogConditions,
	dialogCriteria,
	filterAt,
	guessHeader,
	headerCellKind,
	isoSerial,
	listCriteria,
	operatorKey,
	searchItems,
	serialIso,
	storedNumber,
	valueCriteria
} from "@/features/spreadsheet/data/sortFilter.logic"
import { previewSheetSortFilter } from "@/locales/en/previewSheet/sortFilter"

// What the sort and filter menus work out before they send a command: Excel's header guess, the criteria a values
// list and a condition dialog make (and read back), and which filter a cell is in.

const range = { startRow: 0, startCol: 0, endRow: 3, endCol: 1 }
const EN = EN_US_LOCALE
const DE: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }

describe("the header guess", () => {
	it("takes a row of text over values for a header, and data alike throughout for none", () => {
		const cells: Record<string, { kind: "empty" | "text" | "value"; style: number }> = {
			"0,0": { kind: "text", style: 0 },
			"0,1": { kind: "text", style: 0 },
			"1,0": { kind: "text", style: 0 },
			"1,1": { kind: "value", style: 0 }
		}
		const read = (row: number, col: number) => cells[`${String(row)},${String(col)}`] ?? { kind: "empty" as const, style: 0 }

		expect(guessHeader(range, read)).toBe(true)

		cells["1,1"] = { kind: "text", style: 0 }
		expect(guessHeader(range, read)).toBe(false)

		// A header formatted apart from its data (bold over plain).
		cells["0,0"] = { kind: "text", style: 4 }
		expect(guessHeader(range, read)).toBe(true)

		cells["0,1"] = { kind: "value", style: 0 }
		expect(guessHeader(range, read)).toBe(false)
		expect(guessHeader({ ...range, endRow: 0 }, read)).toBe(false)
	})

	it("reads a tile entry's kind from its flags", () => {
		expect(headerCellKind(0, "")).toBe("empty")
		expect(headerCellKind(0, "Name")).toBe("text")
		expect(headerCellKind(CellFlag.NUMBER, "3")).toBe("value")
		expect(headerCellKind(CellFlag.ERROR, "#N/A")).toBe("value")
	})
})

describe("the values list", () => {
	const items: SheetFilterItem[] = [
		{ text: "apple", checked: true },
		{ text: "3/1/2024", checked: true, date: { year: 2024, month: 3, day: 1 } },
		{ text: "pear", checked: true }
	]

	it("clears the filter when everything is checked, and names a date checked whole by its group", () => {
		expect(listCriteria(items, new Set([0, 1, 2]), { present: true, checked: true })).toBeNull()
		expect(listCriteria(items, new Set([0, 1, 2]), { present: false, checked: false })).toBeNull()
		expect(listCriteria(items, new Set([0, 1]), { present: true, checked: false })).toEqual({
			kind: "values",
			values: ["apple"],
			blank: false,
			dates: [{ grouping: "year", year: 2024 }]
		})
		expect(listCriteria(items, new Set([0, 1, 2]), { present: true, checked: false })).toEqual({
			kind: "values",
			values: ["apple", "pear"],
			blank: false,
			dates: [{ grouping: "year", year: 2024 }]
		})
	})

	it("searches any case", () => {
		expect(searchItems(items, "PE")).toEqual([2])
		expect(searchItems(items, " ")).toEqual([0, 1, 2])
	})

	it("filters by a value or by a blank", () => {
		expect(valueCriteria("fig")).toEqual({ kind: "values", values: ["fig"], blank: false, dates: [] })
		expect(valueCriteria("")).toEqual({ kind: "values", values: [], blank: true, dates: [] })
	})
})

describe("the dates tree", () => {
	const day = (year: number, month: number, d: number): SheetFilterItem => ({
		text: `${String(month)}/${String(d)}/${String(year)}`,
		checked: true,
		date: { year, month, day: d }
	})
	const items: SheetFilterItem[] = [day(2023, 12, 31), day(2024, 1, 2), day(2024, 1, 5), day(2024, 3, 1), { text: "n/a", checked: true }]
	const all = [0, 1, 2, 3, 4]

	it("groups dates by year, then month, then day, collapsed until opened", () => {
		expect(
			filterRows(items, all, new Set(), true, false).map(row =>
				row.kind === "group" ? row.key : row.kind === "item" ? row.index : row.kind
			)
		).toEqual(["all", "2023", "2024", 4, "blank"])

		const open = filterRows(items, all, new Set(["2024", "2024-1"]), false, false)

		expect(
			open.map(row =>
				row.kind === "group"
					? `${row.key}@${String(row.depth)}`
					: row.kind === "item"
						? `${String(row.index)}@${String(row.depth)}`
						: row.kind
			)
		).toEqual(["all", "2023@0", "2024@0", "2024-1@1", "1@2", "2@2", "2024-3@1", "4@0"])
	})

	it("opens every group a search reaches", () => {
		expect(
			filterRows(items, [2], new Set(), false, true).map(row =>
				row.kind === "group" ? row.key : row.kind === "item" ? row.index : row.kind
			)
		).toEqual(["all", "2024", "2024-1", 2])
	})

	it("checks a group as all, some or none of its days", () => {
		const year = filterRows(items, all, new Set(), false, false).find(row => row.kind === "group" && row.key === "2024")

		if (year?.kind !== "group") throw new Error("no 2024")

		expect(year.leaves).toEqual([1, 2, 3])
		expect(groupState(year.leaves, new Set([1, 2, 3]))).toBe("all")
		expect(groupState(year.leaves, new Set([2]))).toBe("some")
		expect(groupState(year.leaves, new Set([0]))).toBe("none")
	})

	it("names a whole year or month by its group, as Excel does", () => {
		expect(listCriteria(items, new Set([1, 2, 3, 4]), { present: false, checked: false })).toEqual({
			kind: "values",
			values: ["n/a"],
			blank: false,
			dates: [{ grouping: "year", year: 2024 }]
		})
		expect(
			listCriteria(items, new Set([0, 1, 2]), { present: false, checked: false })?.kind === "values" &&
				listCriteria(items, new Set([0, 1, 2]), { present: false, checked: false })
		).toMatchObject({
			dates: [
				{ grouping: "year", year: 2023 },
				{ grouping: "month", year: 2024, month: 1 }
			]
		})
		expect(listCriteria(items, new Set([1]), { present: false, checked: false })).toMatchObject({
			dates: [{ grouping: "day", year: 2024, month: 1, day: 2 }]
		})
	})
})

describe("condition dialogs", () => {
	it("wraps text conditions in wildcards and reads them back", () => {
		const contains = dialogCriteria([{ operator: "contains", value: "an" }], false, "text", false, EN)

		expect(contains).toEqual({ kind: "custom", and: false, conditions: [{ operator: "equal", value: "*an*" }] })
		expect(dialogConditions(contains, "text", false, EN)).toEqual({ conditions: [{ operator: "contains", value: "an" }], and: false })

		const ends = dialogCriteria(
			[
				{ operator: "notEndsWith", value: "x" },
				{ operator: "beginsWith", value: "b" }
			],
			true,
			"text",
			false,
			EN
		)

		expect(ends).toEqual({
			kind: "custom",
			and: true,
			conditions: [
				{ operator: "notEqual", value: "*x" },
				{ operator: "equal", value: "b*" }
			]
		})
		expect(dialogConditions(ends, "text", false, EN)?.conditions.map(condition => condition.operator)).toEqual([
			"notEndsWith",
			"beginsWith"
		])
	})

	it("reads numbers as the locale types them, en-US's form when the locale's does not read, and stores them in en-US form", () => {
		expect(storedNumber("1.5", EN)).toBe("1.5")
		expect(storedNumber(" 12 ", EN)).toBe("12")
		expect(storedNumber("1e3", EN)).toBe("1000")
		expect(storedNumber("1,000", EN)).toBe("1000")
		expect(storedNumber("1,234,567", EN)).toBe("1234567")
		expect(storedNumber("50%", EN)).toBe("0.5")
		expect(storedNumber("1,5", EN)).toBe("")
		expect(storedNumber("abc", EN)).toBe("")
		expect(storedNumber("1,5", DE)).toBe("1.5")
		expect(storedNumber("1.234,5", DE)).toBe("1234.5")
		expect(storedNumber("2.5", DE)).toBe("2.5")
		expect(dialogCriteria([{ operator: "greater", value: "x" }], false, "number", false, EN)).toBeNull()
		expect(dialogCriteria([{ operator: "greater", value: "1,234,567" }], false, "number", false, EN)).toEqual({
			kind: "custom",
			and: false,
			conditions: [{ operator: "greaterThan", value: "1234567" }]
		})
		expect(dialogCriteria([{ operator: "greater", value: "2,5" }], false, "number", false, DE)).toEqual({
			kind: "custom",
			and: false,
			conditions: [{ operator: "greaterThan", value: "2.5" }]
		})
		expect(
			dialogConditions({ kind: "custom", and: false, conditions: [{ operator: "greaterThan", value: "2.5" }] }, "number", false, DE)
		).toEqual({
			conditions: [{ operator: "greater", value: "2,5" }],
			and: false
		})
	})

	it("stores dates as serials (equality as a day), in either date system", () => {
		expect(isoSerial("2024-03-01", false)).toBe(45_352)
		expect(isoSerial("2024-03-01", true)).toBe(45_352 - 1462)
		expect(serialIso(45_352.75, false)).toBe("2024-03-01")
		expect(serialIso(45_352 - 1462, true)).toBe("2024-03-01")
		expect(serialIso(0, false)).toBe("1899-12-31")
		expect(isoSerial("1899-12-31", false)).toBe(0)
		expect(serialIso(2_958_465, false)).toBe("9999-12-31")
		expect(serialIso(2_958_465 - 1462, true)).toBe("9999-12-31")
		expect(dialogCriteria([{ operator: "less", value: "2024-03-01" }], false, "date", false, EN)).toEqual({
			kind: "custom",
			and: false,
			conditions: [{ operator: "lessThan", value: "45352" }]
		})
		expect(dialogCriteria([{ operator: "equals", value: "2024-03-01" }], false, "date", false, EN)).toEqual({
			kind: "values",
			values: [],
			blank: false,
			dates: [{ grouping: "day", year: 2024, month: 3, day: 1 }]
		})
		expect(
			dialogConditions({ kind: "custom", and: false, conditions: [{ operator: "greaterThan", value: "45352" }] }, "date", false, EN)
		).toEqual({
			conditions: [{ operator: "greater", value: "2024-03-01" }],
			and: false
		})
	})

	it("counts the 1900 system's 1900-02-29 as the engine does, around it and on it", () => {
		expect(isoSerial("1900-01-01", false)).toBe(1)
		expect(isoSerial("1900-02-15", false)).toBe(46)
		expect(isoSerial("1900-02-28", false)).toBe(59)
		expect(isoSerial("1900-03-01", false)).toBe(61)
		expect(serialIso(1, false)).toBe("1900-01-01")
		expect(serialIso(46, false)).toBe("1900-02-15")
		expect(serialIso(59, false)).toBe("1900-02-28")
		expect(serialIso(61, false)).toBe("1900-03-01")
		// 1900-02-29 is no day a date field takes.
		expect(serialIso(60, false)).toBe("")
		expect(serialIso(60.5, false)).toBe("")
		expect(isoSerial("1904-01-01", true)).toBe(0)
		expect(serialIso(0, true)).toBe("1904-01-01")
	})

	it("leaves a date field empty for a stored serial outside the date system", () => {
		for (const serial of [1e300, Number.POSITIVE_INFINITY, Number.NaN, 1e8, 2_958_466, -1]) expect(serialIso(serial, false)).toBe("")
		expect(serialIso(2_958_465 - 1461, true)).toBe("")
		expect(serialIso(-0.5, true)).toBe("")

		for (const value of ["1e300", "1e8", "-1"]) {
			expect(
				dialogConditions({ kind: "custom", and: false, conditions: [{ operator: "greaterThan", value }] }, "date", false, EN)
			).toEqual({ conditions: [{ operator: "greater", value: "" }], and: false })
		}
	})

	it("names every operator and condition with a string the catalog has", () => {
		const keys = new Set(Object.keys(previewSheetSortFilter))

		for (const kind of ["text", "number", "date"] as const)
			for (const operator of TEXT_OPERATORS) expect(keys.has(operatorKey(operator, kind)), operator).toBe(true)

		for (const item of [...TEXT_CONDITIONS, ...NUMBER_CONDITIONS, ...DATE_CONDITIONS]) expect(keys.has(item.key), item.key).toBe(true)
	})
})

describe("filters on a sheet", () => {
	const layout = {
		extensions: {
			filters: {
				ranges: [
					{ table: "T", range: { startRow: 5, startCol: 4, endRow: 9, endCol: 5 }, buttons: Uint8Array.of(1, 3) },
					{ table: null, range: { startRow: 0, startCol: 0, endRow: 3, endCol: 1 }, buttons: Uint8Array.of(1, 1) }
				]
			}
		}
	} as unknown as SheetLayout

	it("finds the filter a cell is in, and the one Clear and Reapply act on", () => {
		expect(filterAt(layout, 7, 5)?.table).toBe("T")
		expect(filterAt(layout, 4, 0)).toBeNull()
		expect(clearTarget(layout, 7, 5)).toEqual({ row: 5, col: 4 })
		// Outside every filter: the sheet's own.
		expect(clearTarget(layout, 20, 20)).toEqual({ row: 0, col: 0 })
		expect(clearTarget(null, 0, 0)).toBeNull()
	})
})

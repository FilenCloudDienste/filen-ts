import { describe, expect, it } from "vitest"
import { autoFillDirection, autoFillWrites, seriesWrites } from "../core/sheet/fill/fill"
import {
	fillSeries,
	seriesLine,
	textNumber,
	type FillCalendar,
	type FillMode,
	type FillSourceCell,
	type FillValue,
	type SeriesOptions
} from "../core/sheet/fill/series"
import { dateSerial, MAX_SERIAL_1900, serialDate, type DateParts } from "../core/sheet/numfmt/date"
import { SHEET_MAX_EDIT_CELLS } from "../core/sheet/protocol"

// The fill handle's series and the Series dialog's lines. Excel's documented cases ("Fill data automatically in
// worksheet cells" and its earlier versions' AutoFill examples, "Project values in a series", "Create a list of
// sequential dates" on support.microsoft.com) are pinned as Excel gives them; the rest as LibreOffice 7.5 fills them
// (XCellSeries.fillAuto and fillSeries over UNO, en-US), Microsoft being silent there.

type Source = number | string | { readonly date: number } | { readonly time: number } | { readonly formula: true } | null

function cells(source: readonly Source[]): FillSourceCell[] {
	return source.map(value =>
		value === null
			? { kind: "empty" }
			: typeof value === "number"
				? { kind: "number", value, temporal: "none" }
				: typeof value === "string"
					? { kind: "text", text: value }
					: "date" in value
						? { kind: "number", value: value.date, temporal: "date" }
						: "time" in value
							? { kind: "number", value: value.time, temporal: "time" }
							: { kind: "formula" }
	)
}

function shown(value: FillValue, source: readonly Source[], k: number): string {
	if (value.kind === "number") return String(Math.round(value.value * 1e9) / 1e9)
	if (value.kind === "text") return value.text

	const cell = source[k % source.length]

	return cell === null || cell === undefined ? "" : typeof cell === "object" ? "copy" : String(cell)
}

function fill(source: readonly Source[], count: number, mode: FillMode = "auto", backward = false): string[] {
	const next = fillSeries(cells(source), mode, backward, CALENDAR)

	return Array.from({ length: count }, (_, k) => shown(next(k), source, k))
}

describe("the fill handle", () => {
	it("copies one number and extends two or more as a linear best-fit trend (Excel's documented examples)", () => {
		expect(fill([2], 3)).toEqual(["2", "2", "2"])
		expect(fill([1, 2], 3)).toEqual(["3", "4", "5"])
		expect(fill([1, 3], 3)).toEqual(["5", "7", "9"])
		expect(fill([100, 95], 2)).toEqual(["90", "85"])
		// 3, 5, 8: the least-squares line y = 2.5x + 2.8333.
		expect(fill([3, 5, 8], 2)).toEqual(["10.333333333", "12.833333333"])
		expect(fill([1, 1], 3)).toEqual(["1", "1", "1"])
	})

	it("swaps a copy and a series with Ctrl held", () => {
		expect(fill([2], 3, "alternate")).toEqual(["3", "4", "5"])
		expect(fill([1, 2], 2, "alternate")).toEqual(["1", "2"])
		expect(fill(["Item 1"], 2, "alternate")).toEqual(["Item 1", "Item 1"])
		expect(fill([{ date: 45306 }], 2, "alternate")).toEqual(["copy", "copy"])
	})

	it("steps a date by a day and a time by an hour (Excel's documented 9:00 → 10:00, 11:00, 12:00)", () => {
		expect(fill([{ date: 45306 }], 3)).toEqual(["45307", "45308", "45309"])
		// A date-time format shows a date: a day.
		expect(fill([{ date: 45306.375 }], 1)).toEqual(["45307.375"])
		expect(fill([{ time: 0.375 }], 3)).toEqual(["0.416666667", "0.458333333", "0.5"])
		expect(fill([{ time: 0.375 }], 1, "auto", true)).toEqual(["0.333333333"])
		// No error built up over many steps.
		expect(fill([{ time: 0 }], 48).at(-1)).toBe("2")
		expect(fill([{ time: 0.375 }], 2, "alternate")).toEqual(["copy", "copy"])
		expect(fill([{ time: 0.375 }, { time: 0.5 }], 2)).toEqual(["0.625", "0.75"])
		expect(fill([{ date: 45306 }, { date: 45313 }], 2)).toEqual(["45320", "45327"])
	})

	it("steps dates on the same day of the month by months or years (Excel's documented 15-Jan, 15-Apr → 15-Jul)", () => {
		const serial = (year: number, month: number, day: number): number => dateSerial(year, month, day, false)
		const dates = (...serials: number[]): { date: number }[] => serials.map(date => ({ date }))

		expect(fill(dates(serial(2024, 1, 15), serial(2024, 2, 15)), 3)).toEqual(
			[serial(2024, 3, 15), serial(2024, 4, 15), serial(2024, 5, 15)].map(String)
		)
		expect(fill(dates(serial(2024, 1, 15), serial(2024, 4, 15)), 2)).toEqual([serial(2024, 7, 15), serial(2024, 10, 15)].map(String))
		expect(fill(dates(serial(1999, 1, 1), serial(1999, 4, 1)), 3)).toEqual(
			[serial(1999, 7, 1), serial(1999, 10, 1), serial(2000, 1, 1)].map(String)
		)
		expect(fill(dates(serial(2020, 6, 1), serial(2021, 6, 1)), 2)).toEqual([serial(2022, 6, 1), serial(2023, 6, 1)].map(String))
		// The day of the month is kept where the month has it.
		expect(fill(dates(serial(2024, 1, 31), serial(2024, 3, 31)), 2)).toEqual([serial(2024, 5, 31), serial(2024, 7, 31)].map(String))
		// The time of day goes along.
		expect(fill(dates(serial(2024, 1, 15) + 0.5, serial(2024, 2, 15) + 0.5), 1)).toEqual([String(serial(2024, 3, 15) + 0.5)])
		// Filled up: back by months.
		expect(fill(dates(serial(2024, 3, 15), serial(2024, 2, 15)), 1, "auto", true)).toEqual([String(serial(2024, 1, 15))])
		// Uneven months, different days, plain numbers: a linear trend.
		expect(fill(dates(serial(2024, 1, 15), serial(2024, 2, 15), serial(2024, 4, 15)), 1)).not.toEqual([String(serial(2024, 5, 15))])
		expect(fill([serial(2024, 1, 15), serial(2024, 2, 15)], 1)).toEqual([String(2 * serial(2024, 2, 15) - serial(2024, 1, 15))])
	})

	it("steps the number ending text, or else starting it, keeping its padding and ordinal suffix", () => {
		expect(fill(["Item 1"], 3)).toEqual(["Item 2", "Item 3", "Item 4"])
		expect(fill(["Item 9"], 2)).toEqual(["Item 10", "Item 11"])
		expect(fill(["Item 09"], 2)).toEqual(["Item 10", "Item 11"])
		expect(fill(["Item 001"], 2)).toEqual(["Item 002", "Item 003"])
		expect(fill(["a1b2"], 1)).toEqual(["a1b3"])
		expect(fill(["1st"], 4)).toEqual(["2nd", "3rd", "4th", "5th"])
		expect(fill(["11th"], 2)).toEqual(["12th", "13th"])
		expect(fill(["1 Item"], 2)).toEqual(["2 Item", "3 Item"])
		expect(fill(["Item 1.5"], 5)).toEqual(["Item 1.6", "Item 1.7", "Item 1.8", "Item 1.9", "Item 1.10"])
		expect(fill(["Item 1", "Item 3"], 2)).toEqual(["Item 5", "Item 7"])
		// The first cell's text frames the series.
		expect(fill(["Item 1", "Thing 3"], 1)).toEqual(["Item 5"])
		expect(fill(["Item 1", "Item 1"], 2)).toEqual(["Item 1", "Item 1"])
	})

	it("steps an ordinal starting text (Excel's documented 1st Period → 2nd Period)", () => {
		expect(fill(["1st Period"], 3)).toEqual(["2nd Period", "3rd Period", "4th Period"])
		expect(fill(["11th Day"], 2)).toEqual(["12th Day", "13th Day"])
		expect(fill(["1ST Period"], 1)).toEqual(["2ND Period"])
		expect(fill(["1st, then"], 1)).toEqual(["2nd, then"])
		// Not an ordinal: a letter follows, or the suffix is not the number's own.
		expect(fill(["1sty"], 2)).toEqual(["2sty", "3sty"])
		expect(fill(["2st Period"], 1)).toEqual(["3st Period"])
	})

	it("wraps quarters after 4 (Excel's documented Qtr3 → Qtr4, Qtr1, Qtr2)", () => {
		expect(fill(["Qtr1"], 4)).toEqual(["Qtr2", "Qtr3", "Qtr4", "Qtr1"])
		expect(fill(["Qtr3"], 3)).toEqual(["Qtr4", "Qtr1", "Qtr2"])
		expect(fill(["Q3"], 3)).toEqual(["Q4", "Q1", "Q2"])
		expect(fill(["Quarter 3"], 2)).toEqual(["Quarter 4", "Quarter 1"])
		expect(fill(["quarter3"], 1)).toEqual(["quarter4"])
		expect(fill(["Q1"], 2, "auto", true)).toEqual(["Q4", "Q3"])
		expect(fill(["Q1", "Q3"], 3)).toEqual(["Q1", "Q3", "Q1"])
		expect(fill(["Q4", "Q1"], 2)).toEqual(["Q2", "Q3"])
		expect(fill(["Q1", "Q1"], 2)).toEqual(["Q1", "Q1"])
		// Uneven: position by position, each the next quarter.
		expect(fill(["Q1", "Q3", "Q2"], 6)).toEqual(["Q2", "Q4", "Q3", "Q3", "Q1", "Q4"])
		// Not a quarter: a number past 4, or more after it.
		expect(fill(["Q5"], 1)).toEqual(["Q6"])
		expect(fill(["Qtr 12"], 1)).toEqual(["Qtr 13"])
		expect(fill(["1st Quarter"], 1)).toEqual(["2nd Quarter"])
	})

	it("copies text whose number is neither at its end nor its start, and plain text", () => {
		expect(fill(["a1b"], 2)).toEqual(["a1b", "a1b"])
		expect(fill(["x 1st"], 1)).toEqual(["x 1st"])
		expect(fill(["Text"], 2)).toEqual(["Text", "Text"])
		expect(fill(["a", "b"], 3)).toEqual(["a", "b", "a"])
	})

	it("steps through the built-in day and month lists in the list's case", () => {
		expect(fill(["Mon"], 6)).toEqual(["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
		expect(fill(["Monday"], 1)).toEqual(["Tuesday"])
		expect(fill(["Jan"], 2)).toEqual(["Feb", "Mar"])
		expect(fill(["January"], 1)).toEqual(["February"])
		expect(fill(["jan"], 1)).toEqual(["Feb"])
		expect(fill(["MONDAY"], 1)).toEqual(["Tuesday"])
		expect(fill(["Sat"], 2)).toEqual(["Sun", "Mon"])
		expect(fill(["Dec"], 1)).toEqual(["Jan"])
		expect(fill(["Mon", "Wed"], 3)).toEqual(["Fri", "Sun", "Tue"])
		expect(fill(["Jan", "Mar"], 6)).toEqual(["May", "Jul", "Sep", "Nov", "Jan", "Mar"])
		expect(fill(["Mon", "Tue", "Thu"], 3)).toEqual(["Mon", "Tue", "Thu"])
		expect(fill(["January", "Jan"], 2)).toEqual(["January", "Jan"])
		expect(fill(["Sept"], 1)).toEqual(["Sept"])
	})

	it("repeats a mixed source position by position, its numbers one more each time round", () => {
		expect(fill([1, "a"], 4)).toEqual(["2", "a", "3", "a"])
		expect(fill([1, 2, "a"], 6)).toEqual(["2", "3", "a", "3", "4", "a"])
		expect(fill(["a", 1, "b", 2], 4)).toEqual(["a", "2", "b", "3"])
		expect(fill(["Item 1", "x"], 4)).toEqual(["Item 2", "x", "Item 3", "x"])
		expect(fill(["Item 1", "Item 2", "Item 4"], 3)).toEqual(["Item 2", "Item 3", "Item 5"])
		expect(fill(["Mon", "x"], 2)).toEqual(["Mon", "x"])
		expect(fill([{ formula: true }, 5], 4)).toEqual(["copy", "6", "copy", "7"])
		expect(fill([null, 5], 2)).toEqual(["", "6"])
	})

	it("runs backwards filling up or left", () => {
		// Read from the far end: 1, 2 filled up is read as 2, 1.
		expect(fill([2, 1], 3, "auto", true)).toEqual(["0", "-1", "-2"])
		expect(fill(["Item 1"], 3, "auto", true)).toEqual(["Item 0", "Item -1", "Item -2"])
		expect(fill(["Item 001"], 2, "auto", true)).toEqual(["Item 000", "Item -001"])
		expect(fill(["Mon"], 2, "auto", true)).toEqual(["Sun", "Sat"])
		expect(fill([{ date: 45306 }], 1, "auto", true)).toEqual(["45305"])
	})
})

describe("text numbers", () => {
	it("are not read past the digits a double keeps", () => {
		expect(textNumber("x1234567890123456")).toBeNull()
		expect(textNumber("x123456789012345")?.value).toBe(123456789012345)
	})
})

describe("the fill handle's target", () => {
	const source = { startRow: 2, startCol: 1, endRow: 3, endCol: 2 }

	it("is the source grown one way", () => {
		expect(autoFillDirection(source, { ...source, endRow: 9 })).toBe("down")
		expect(autoFillDirection(source, { ...source, startRow: 0 })).toBe("up")
		expect(autoFillDirection(source, { ...source, endCol: 5 })).toBe("right")
		expect(autoFillDirection(source, { ...source, startCol: 0 })).toBe("left")
		expect(autoFillDirection(source, source)).toBeNull()
		expect(autoFillDirection(source, { ...source, endRow: 9, endCol: 5 })).toBeNull()
	})

	it("takes, per column, its cells in fill order and maps each target to its source position", () => {
		const read = (row: number, col: number): FillSourceCell => ({ kind: "number", value: row * 10 + col, temporal: "none" })
		const writes = autoFillWrites(source, { ...source, startRow: 0 }, "auto", read, fillSeries)

		if (writes === null || writes === "tooLarge") throw new Error("no writes")

		// Column B: 21, 31 read upwards as 31, 21: then 11, 1.
		expect(Array.from(writes.rows)).toEqual([1, 0, 1, 0])
		expect(Array.from(writes.cols)).toEqual([1, 1, 2, 2])
		expect(Array.from(writes.sourceRows)).toEqual([3, 2, 3, 2])
		expect(writes.values).toEqual([
			{ kind: "number", value: 11 },
			{ kind: "number", value: 1 },
			{ kind: "number", value: 12 },
			{ kind: "number", value: 2 }
		])
	})

	it("refuses more cells than one edit takes", () => {
		const read = (): FillSourceCell => ({ kind: "empty" })

		expect(
			autoFillWrites(
				{ startRow: 0, startCol: 0, endRow: 0, endCol: 9 },
				{ startRow: 0, startCol: 0, endRow: SHEET_MAX_EDIT_CELLS, endCol: 9 },
				"auto",
				read,
				fillSeries
			)
		).toBe("tooLarge")
	})
})

const parts: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }
const CALENDAR: FillCalendar = {
	date: serial => ({ ...serialDate(serial, false, parts) }),
	serial: (year, month, day) => dateSerial(year, month, day, false),
	maxSerial: MAX_SERIAL_1900
}

function series(source: readonly Source[], length: number, options: Partial<SeriesOptions>): (string | null)[] {
	const line = [...source, ...Array.from({ length: length - source.length }, () => null)]

	return seriesLine(cells(line), { type: "linear", dateUnit: "day", step: 1, stop: null, trend: false, ...options }, CALENDAR).map(
		(write, i) => (write === null ? null : shown(write.value, line, i))
	)
}

describe("the Series dialog", () => {
	it("steps linear and growth series from the first cell, up to the stop value", () => {
		expect(series([1], 5, { step: 2 })).toEqual([null, "3", "5", "7", "9"])
		expect(series([1], 6, { step: 2, stop: 7 })).toEqual([null, "3", "5", "7", null, null])
		expect(series([1], 5, { type: "growth", step: 2 })).toEqual([null, "2", "4", "8", "16"])
		expect(series([1], 6, { type: "growth", step: 2, stop: 10 })).toEqual([null, "2", "4", "8", null, null])
		expect(series([10], 5, { step: -3, stop: 2 })).toEqual([null, "7", "4", null, null])
		expect(series([2], 4, { type: "growth", step: -2 })).toEqual([null, "-4", "8", "-16"])
		// A later value is overwritten.
		expect(series([1, 5], 3, { step: 2 })).toEqual([null, "3", "5"])
	})

	it("steps text with a number in a linear series and leaves other text alone", () => {
		expect(series(["Item 1"], 3, { step: 2 })).toEqual([null, "Item 3", "Item 5"])
		expect(series(["x"], 3, { step: 2 })).toEqual([null, null, null])
	})

	it("steps dates by days, weekdays, months and years", () => {
		const jan31 = dateSerial(2024, 1, 31, false)

		expect(series([jan31], 4, { type: "date", dateUnit: "month" })).toEqual([null, "45351", "45382", "45412"])
		expect(series([dateSerial(2024, 2, 29, false)], 3, { type: "date", dateUnit: "year" })).toEqual([null, "45717", "46082"])
		// From Friday 2024-01-19 by 1 and 2 weekdays, and from Saturday 2024-01-20.
		expect(series([45310], 4, { type: "date", dateUnit: "weekday" })).toEqual([null, "45313", "45314", "45315"])
		expect(series([45310], 6, { type: "date", dateUnit: "weekday", step: 2 })).toEqual([
			null,
			"45313",
			"45315",
			"45317",
			"45320",
			"45322"
		])
		expect(series([45311], 3, { type: "date", dateUnit: "weekday" })).toEqual([null, "45313", "45314"])
		expect(series([45306], 3, { type: "date", dateUnit: "day", step: 3 })).toEqual([null, "45309", "45312"])
		// The time of day is left behind stepping by months.
		expect(series([45310.25], 3, { type: "date", dateUnit: "month" })).toEqual([null, "45341", "45370"])
		expect(series([jan31], 6, { type: "date", dateUnit: "month", stop: 45400 })).toEqual([null, "45351", "45382", null, null, null])
	})

	it("fits a trend to the leading numbers, those included, ignoring the step", () => {
		expect(series([3, 5, 8], 5, { trend: true, step: 100 })).toEqual([
			"2.833333333",
			"5.333333333",
			"7.833333333",
			"10.333333333",
			"12.833333333"
		])
		expect(series([1, 2], 4, { type: "growth", trend: true })).toEqual(["1", "2", "4", "8"])
		expect(series([1, -2], 3, { type: "growth", trend: true })).toEqual([null, null, null])
	})

	it("auto-fills the blanks after the line's leading cells", () => {
		expect(series(["Mon"], 3, { type: "autoFill" })).toEqual([null, "Tue", "Wed"])
		expect(series([1, 2], 4, { type: "autoFill" })).toEqual([null, null, "3", "4"])
	})

	it("writes each row's line, or each column's", () => {
		const read = (row: number, col: number): FillSourceCell =>
			col === 0 || row === 0 ? { kind: "number", value: row + col, temporal: "none" } : { kind: "empty" }
		const options: SeriesOptions = { type: "linear", dateUnit: "day", step: 1, stop: null, trend: false }
		const writes = seriesWrites({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 }, "rows", read, line =>
			seriesLine(line, options, CALENDAR)
		)

		if (writes === null || writes === "tooLarge") throw new Error("no writes")

		expect(Array.from(writes.rows)).toEqual([0, 0, 1, 1])
		expect(Array.from(writes.cols)).toEqual([1, 2, 1, 2])
		expect(writes.values).toEqual([
			{ kind: "number", value: 1 },
			{ kind: "number", value: 2 },
			{ kind: "number", value: 2 },
			{ kind: "number", value: 3 }
		])
	})
})

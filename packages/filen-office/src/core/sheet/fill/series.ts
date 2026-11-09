// What the fill handle writes past its source, line by line (a column when filling down or up, a row when filling
// right or left), and what the Series dialog writes (Home > Fill > Series).
//
// Excel's documented rules ("Fill data automatically in worksheet cells", "Project values in a series" on
// support.microsoft.com, and the AutoFill examples of its earlier versions): one number is copied ("type 2 in first
// cell only" gives 2, 2, 2); two or more numbers extend as a linear best-fit trend (least squares, y = mx + b, as
// TREND); a date steps a day ("Create a list of sequential dates") and a time an hour (9:00 → 10:00); two or more
// dates on the same day of the month an even number of months apart step by months (15-Jan, 15-Apr → 15-Jul), or
// years; the built-in lists are the days and months, short and long ("Create or delete a custom list"); quarters
// (Q1, Qtr1, Quarter 1) wrap after 4; text starting with a number steps an English ordinal suffix ("1st Period" →
// "2nd Period"). Holding Ctrl while dragging swaps a copy and a series. Where Microsoft says nothing, LibreOffice's
// fill is followed (measured over UNO, XCellSeries.fillAuto): text ending (or else starting) with a number steps
// that number, its zero padding kept ("Item 09" → "Item 10"); text whose number is anywhere else is copied; a list
// item steps through its list in the list's own case ("jan" → "Feb"); a source of one kind whose steps are not
// even, or of mixed kinds, repeats position by position, each number (of a value or of text) one more each time
// round, a quarter the next quarter, list items, other text, booleans and errors copied, formulas moved. Filling up
// or left reads the source from its far end, so a series runs backwards (1, 2 filled up gives 0, -1).

// A number's format: plain, a date (with or without a time), or a time alone.
export type FillTemporal = "none" | "date" | "time"

export type FillSourceCell =
	| { readonly kind: "empty" }
	| { readonly kind: "number"; readonly value: number; readonly temporal: FillTemporal }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "formula" }
	// A boolean or an error: copied.
	| { readonly kind: "other" }

// What target k (0-based, counted away from the source) takes: its source cell as it is (formulas moved), or a
// value of its own, formatted as that source cell.
export type FillValue =
	{ readonly kind: "copy" } | { readonly kind: "number"; readonly value: number } | { readonly kind: "text"; readonly text: string }

export type FillMode = "auto" | "alternate"

const COPY: FillValue = { kind: "copy" }

// Excel's built-in lists ("Create or delete a custom list for sorting and filling data"), the short ones first so a
// word in both ("May") steps through its own kind.
const LISTS: readonly (readonly string[])[] = [
	["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
	["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
	["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
	["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
]

const LIST_INDEX: ReadonlyMap<string, { readonly list: number; readonly index: number }> = (() => {
	const index = new Map<string, { list: number; index: number }>()

	LISTS.forEach((list, k) =>
		list.forEach((item, i) => {
			const key = item.toLowerCase()

			if (!index.has(key)) index.set(key, { list: k, index: i })
		})
	)

	return index
})()

function listItem(text: string): { readonly list: number; readonly index: number } | undefined {
	return LIST_INDEX.get(text.toLowerCase())
}

// A quarter ("Q3", "Qtr 3", "Quarter3"): its word and spacing as written, and its number less one.
interface Quarter {
	readonly prefix: string
	readonly index: number
}

const QUARTER = /^(?:q|qtr|quarter) ?[1-4]$/i

function quarter(text: string): Quarter | null {
	return QUARTER.test(text) ? { prefix: text.slice(0, -1), index: text.charCodeAt(text.length - 1) - 49 } : null
}

// A number in text: before it `prefix`, after it `suffix`; `width` pads the digits with zeros (a source written
// with leading zeros); `ordinal` writes an English ordinal suffix of its own between the number and `suffix`, in
// lower or upper case.
export interface TextNumber {
	readonly prefix: string
	readonly value: number
	readonly suffix: string
	readonly width: number
	readonly ordinal: "lower" | "upper" | null
	// Where the number is: the end of the text, else its start.
	readonly at: "end" | "start"
}

// Beyond this many digits a number in text loses its last digits as a double: such text is copied.
const MAX_TEXT_DIGITS = 15

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57
}

function ordinalSuffix(value: number): string {
	const tens = value % 100

	if (tens >= 11 && tens <= 13) return "th"

	switch (value % 10) {
		case 1:
			return "st"
		case 2:
			return "nd"
		case 3:
			return "rd"
		default:
			return "th"
	}
}

export function textNumber(text: string): TextNumber | null {
	let end = text.length

	while (end > 0 && isDigit(text.charCodeAt(end - 1))) end--

	if (end < text.length) {
		const digits = text.slice(end)

		if (digits.length > MAX_TEXT_DIGITS) return null

		return {
			prefix: text.slice(0, end),
			value: Number(digits),
			suffix: "",
			width: digits.length > 1 && digits.startsWith("0") ? digits.length : 0,
			ordinal: null,
			at: "end"
		}
	}

	let start = 0

	while (start < text.length && isDigit(text.charCodeAt(start))) start++

	if (start === 0 || start > MAX_TEXT_DIGITS) return null

	const digits = text.slice(0, start)
	const value = Number(digits)
	// An ordinal suffix is the value's own, in either case, ending the text or followed by anything but a letter.
	const letters = text.slice(start, start + 2)
	const ordinal =
		letters.toLowerCase() === ordinalSuffix(value) && !LETTER.test(text.charAt(start + 2))
			? letters === letters.toUpperCase()
				? "upper"
				: "lower"
			: null

	return {
		prefix: "",
		value,
		suffix: text.slice(ordinal === null ? start : start + 2),
		width: digits.length > 1 && digits.startsWith("0") ? digits.length : 0,
		ordinal,
		at: "start"
	}
}

const LETTER = /\p{L}/u

// `number` written as `like` writes its own.
export function textWithNumber(like: TextNumber, value: number): string {
	const magnitude = String(Math.abs(value))
	const digits = magnitude.length < like.width ? "0".repeat(like.width - magnitude.length) + magnitude : magnitude
	const sign = value < 0 ? "-" : ""
	const ordinal = like.ordinal === null ? "" : ordinalSuffix(Math.abs(value))

	return `${like.prefix}${sign}${digits}${like.ordinal === "upper" ? ordinal.toUpperCase() : ordinal}${like.suffix}`
}

// The least-squares line through (i, values[i]), as Excel's linear trend (TREND). An even series is kept exact.
function linear(values: readonly number[]): (x: number) => number {
	const n = values.length
	const first = values[0] ?? 0
	const step = (values[1] ?? first) - first
	let even = true

	for (let i = 2; i < n && even; i++) even = (values[i] ?? 0) - (values[i - 1] ?? 0) === step

	if (even) return x => first + step * x

	let sumX = 0
	let sumY = 0

	for (let i = 0; i < n; i++) {
		sumX += i
		sumY += values[i] ?? 0
	}

	const meanX = sumX / n
	const meanY = sumY / n
	let covariance = 0
	let variance = 0

	for (let i = 0; i < n; i++) {
		covariance += (i - meanX) * ((values[i] ?? 0) - meanY)
		variance += (i - meanX) * (i - meanX)
	}

	const slope = covariance / variance

	return x => meanY + slope * (x - meanX)
}

// The steps between consecutive values when they are all the same, else null.
function evenStep(values: readonly number[]): number | null {
	const step = (values[1] ?? 0) - (values[0] ?? 0)

	for (let i = 2; i < values.length; i++) if ((values[i] ?? 0) - (values[i - 1] ?? 0) !== step) return null

	return step
}

function modulo(value: number, divisor: number): number {
	return ((value % divisor) + divisor) % divisor
}

// The months between consecutive dates when they share a day of the month and a time of day and are the same
// non-zero number of months apart, with that time of day; else null.
function monthStep(values: readonly number[], calendar: FillCalendar): { readonly months: number; readonly time: number } | null {
	let months = 0
	let day = 0
	let time = 0
	let previous = 0

	for (let i = 0; i < values.length; i++) {
		const value = values[i] ?? 0

		if (!Number.isFinite(value)) return null

		const whole = Math.floor(value)
		const parts = calendar.date(whole)
		const total = parts.year * 12 + parts.month

		if (i === 0) {
			day = parts.day
			time = value - whole
		} else {
			if (parts.day !== day || value - whole !== time) return null
			if (i === 1) months = total - previous
			else if (total - previous !== months) return null
		}

		previous = total
	}

	return months === 0 ? null : { months, time }
}

// The value for target k past `source` (in fill order: read from the far end when filling up or left, with
// `backward` set). "alternate" (Ctrl held) copies what "auto" would extend, and extends a lone number by 1.
// `calendar` reads dates, to step them by months; without one dates step as numbers.
export function fillSeries(
	source: readonly FillSourceCell[],
	mode: FillMode,
	backward: boolean,
	calendar?: FillCalendar
): (k: number) => FillValue {
	const n = source.length
	const unit = backward ? -1 : 1

	if (n === 0) return () => COPY

	if (source.every(cell => cell.kind === "number")) {
		const values = source.map(cell => (cell.kind === "number" ? cell.value : 0))

		if (n === 1) {
			const temporal = source[0]?.kind === "number" ? source[0].temporal : "none"
			// A date steps a day, a time an hour; a plain number is copied.
			const extends_ = (temporal !== "none") !== (mode === "alternate")
			const first = values[0] ?? 0
			const step = temporal === "time" ? unit / 24 : unit

			return extends_ ? k => ({ kind: "number", value: first + step * (k + 1) }) : () => COPY
		}

		if (mode === "alternate") return () => COPY

		if (calendar !== undefined && source.every(cell => cell.kind === "number" && cell.temporal === "date")) {
			const months = monthStep(values, calendar)
			const last = values[n - 1] ?? 0

			if (months !== null)
				return k => ({ kind: "number", value: addMonths(calendar, last, months.months * (k + 1), "clamp") + months.time })
		}

		const line = linear(values)

		return k => ({ kind: "number", value: line(n + k) })
	}

	if (mode === "alternate") return () => COPY

	const texts = source.every(cell => cell.kind === "text") ? source.map(cell => (cell.kind === "text" ? cell.text : "")) : null

	if (texts !== null) {
		const items = texts.map(listItem)

		if (items.every(item => item !== undefined && item.list === items[0]?.list)) {
			const list = LISTS[items[0]?.list ?? 0] ?? []
			const indices = items.map(item => item?.index ?? 0)
			const length = list.length
			const steps = indices.slice(1).map((index, i) => modulo(index - (indices[i] ?? 0), length))
			const step = n === 1 ? modulo(unit, length) : steps.every(found => found === steps[0]) ? (steps[0] ?? 0) : null

			if (step === null || step === 0) return () => COPY

			const last = indices[n - 1] ?? 0

			return k => ({ kind: "text", text: list[modulo(last + step * (k + 1), length)] ?? "" })
		}

		const quarters = texts.map(quarter)
		const lead = quarters[0]

		if (lead !== null && lead !== undefined && quarters.every(found => found?.prefix.toLowerCase() === lead.prefix.toLowerCase())) {
			const steps = quarters.slice(1).map((found, i) => modulo((found?.index ?? 0) - (quarters[i]?.index ?? 0), 4))
			const step = n === 1 ? modulo(unit, 4) : steps.every(found => found === steps[0]) ? (steps[0] ?? 0) : null

			if (step === 0) return () => COPY

			if (step !== null) {
				const last = quarters[n - 1]?.index ?? 0

				return k => ({ kind: "text", text: `${lead.prefix}${modulo(last + step * (k + 1), 4) + 1}` })
			}
		}

		const numbers = texts.map(textNumber)
		const first = numbers[0]

		if (first !== null && first !== undefined && numbers.every(found => found !== null && found.at === first.at)) {
			const values = numbers.map(found => found?.value ?? 0)
			const step = n === 1 ? unit : evenStep(values)

			if (step !== null) {
				const start = values[0] ?? 0

				return k => ({ kind: "text", text: textWithNumber(first, start + step * (n + k)) })
			}
		}
	}

	// Position by position: numbers one more each time round, quarters the next quarter.
	const parsedQuarters = source.map(cell => (cell.kind === "text" ? quarter(cell.text) : null))
	const parsed = source.map((cell, i) =>
		cell.kind === "text" && parsedQuarters[i] === null && listItem(cell.text) === undefined ? textNumber(cell.text) : null
	)

	return k => {
		const position = k % n
		const round = Math.floor(k / n) + 1
		const cell = source[position]

		if (cell?.kind === "number") return { kind: "number", value: cell.value + unit * round }

		const atQuarter = parsedQuarters[position]

		if (atQuarter !== null && atQuarter !== undefined)
			return { kind: "text", text: `${atQuarter.prefix}${modulo(atQuarter.index + unit * round, 4) + 1}` }

		const number = parsed[position]

		if (cell?.kind === "text" && number !== null && number !== undefined)
			return { kind: "text", text: textWithNumber(number, number.value + unit * round) }

		return COPY
	}
}

// --- The Series dialog ---

export interface SeriesOptions {
	readonly type: "linear" | "growth" | "date" | "autoFill"
	readonly dateUnit: "day" | "weekday" | "month" | "year"
	readonly step: number
	// Where a series stops: cells past it are left as they are.
	readonly stop: number | null
	// Linear and growth: the line's leading numbers are fitted (least squares, as TREND and GROWTH) and every cell of
	// the line, those numbers included, takes the fit; the step is ignored.
	readonly trend: boolean
}

// The Series dialog's options as a command carries them: the stop value as typed (a number, or a date the session
// reads as a cell entry), or null for none.
export interface SeriesRequest extends Omit<SeriesOptions, "stop"> {
	readonly stop: string | null
}

// A workbook's dates: a whole serial's day, and back.
export interface FillCalendar {
	date(serial: number): { readonly year: number; readonly month: number; readonly day: number; readonly weekday: number }
	serial(year: number, month: number, day: number): number
	// The largest serial a date may have.
	readonly maxSerial: number
}

// A cell the dialog writes: its value and the cell of the line whose format (and, for a copy, content) it takes.
export interface SeriesCell {
	readonly value: FillValue
	readonly source: number
}

// `months` on from `serial`'s day: past the end of a shorter month, its last day ("clamp", by months) or the days
// over carried into the next (by years: LibreOffice measured 2024-02-29 plus a year as 2025-03-01).
function addMonths(calendar: FillCalendar, serial: number, months: number, overflow: "clamp" | "carry"): number {
	const parts = calendar.date(Math.floor(serial))
	const total = parts.year * 12 + (parts.month - 1) + months
	const year = Math.floor(total / 12)
	const month = total - year * 12 + 1
	const first = calendar.serial(year, month, 1)
	const days = calendar.serial(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - first
	const day = Math.max(parts.day, 1)

	return overflow === "clamp" ? first + Math.min(day, days) - 1 : first + day - 1
}

// `step` days on from `serial`, moved on past a Saturday or Sunday to the next weekday (LibreOffice's weekday unit,
// measured: from a Friday, steps of 2 give Monday, Wednesday, Friday, Monday).
function nextWeekday(calendar: FillCalendar, serial: number, step: number): number {
	const direction = step < 0 ? -1 : 1
	let day = Math.floor(serial) + step

	for (let weekday = calendar.date(day).weekday; weekday === 0 || weekday === 6; weekday = calendar.date(day).weekday) day += direction

	return day
}

// The values the Series dialog (Home > Fill > Series) writes along one line, by index; null leaves a cell as it is.
// Linear, growth and date series start from the line's first cell (a number, or for a linear series text with a
// number, as LibreOffice steps it) and stop before the first value past `stop`; a date series by months keeps the
// start's day where the month has it (as EDATE), by years carries a day the month lacks into the next, by weekdays
// steps on from the last one past weekends, and by months, years or weekdays leaves the time of day behind
// (LibreOffice measured). AutoFill extends the line's leading
// filled cells as the fill handle does.
export function seriesLine(cells: readonly FillSourceCell[], options: SeriesOptions, calendar: FillCalendar): (SeriesCell | null)[] {
	const length = cells.length
	const out: (SeriesCell | null)[] = new Array<SeriesCell | null>(length).fill(null)
	const { type, step, stop } = options

	if (type === "autoFill") {
		let lead = 0

		while (lead < length && cells[lead]?.kind !== "empty") lead++

		if (lead === 0 || lead === length) return out

		const extend = fillSeries(cells.slice(0, lead), "auto", false, calendar)

		for (let i = lead; i < length; i++) out[i] = { value: extend(i - lead), source: (i - lead) % lead }

		return out
	}

	const growth = type === "growth"
	const past = (value: number): boolean => {
		if (!Number.isFinite(value)) return true
		if (stop === null) return false
		if (growth) return Math.abs(step) >= 1 ? Math.abs(value) > Math.abs(stop) : Math.abs(value) < Math.abs(stop)

		return step > 0 ? value > stop : step < 0 ? value < stop : false
	}

	if (options.trend && type !== "date") {
		let lead = 0

		while (lead < length && cells[lead]?.kind === "number") lead++

		const values = cells.slice(0, lead).map(cell => (cell.kind === "number" ? cell.value : 0))

		if (lead >= 2) {
			if (growth && values.some(value => value <= 0)) return out

			const line = linear(growth ? values.map(Math.log) : values)
			const rising = line(1) >= line(0)

			for (let i = 0; i < length; i++) {
				const value = growth ? Math.exp(line(i)) : line(i)

				if (!Number.isFinite(value) || (i >= lead && stop !== null && (rising ? value > stop : value < stop))) break

				out[i] = { value: { kind: "number", value }, source: Math.min(i, lead - 1) }
			}

			return out
		}
	}

	const first = cells[0]

	if (first?.kind === "text" && type === "linear") {
		const number = listItem(first.text) === undefined ? textNumber(first.text) : null

		if (number === null) return out

		for (let i = 1; i < length; i++) {
			const value = number.value + step * i

			if (past(value)) break

			out[i] = { value: { kind: "text", text: textWithNumber(number, value) }, source: 0 }
		}

		return out
	}

	if (first?.kind !== "number") return out

	const start = first.value
	let previous = start

	for (let i = 1; i < length; i++) {
		let value: number

		if (type === "linear") value = start + step * i
		else if (growth) value = start * step ** i
		else if (options.dateUnit === "day") value = start + step * i
		else if (options.dateUnit === "weekday") value = nextWeekday(calendar, previous, Math.trunc(step))
		else if (options.dateUnit === "month") value = addMonths(calendar, start, Math.trunc(step) * i, "clamp")
		else value = addMonths(calendar, start, Math.trunc(step) * i * 12, "carry")

		if (past(value) || (type === "date" && (value < 0 || value > calendar.maxSerial))) break

		out[i] = { value: { kind: "number", value }, source: 0 }
		previous = value
	}

	return out
}

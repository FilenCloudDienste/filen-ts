// Compiled once: drive rows format a date per visible row. `undefined` locale defers to the runtime's own.
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" })

// Compact date, no clock time. Accepts epoch ms, a bigint ms timestamp or an ISO-8601 string.
export function formatShortDate(value: number | bigint | string): string {
	const date = new Date(typeof value === "bigint" ? Number(value) : value)

	// DateTimeFormat.format throws on an Invalid Date where toLocaleDateString returned a label.
	return Number.isNaN(date.getTime()) ? date.toLocaleDateString() : SHORT_DATE.format(date)
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

// Date with its clock time, for where the day alone cannot tell timestamps apart (versions, an item's info).
export function formatDateTime(value: number | bigint | string): string {
	const date = new Date(typeof value === "bigint" ? Number(value) : value)

	// DateTimeFormat.format throws on an Invalid Date where toLocaleString returned a label.
	return Number.isNaN(date.getTime()) ? date.toLocaleString() : DATE_TIME.format(date)
}

const CLOCK_TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })

// Clock time alone, for a list row whose section already names the day. Epoch ms.
export function formatClockTime(timestamp: number): string {
	return CLOCK_TIME.format(timestamp)
}

const SHORT_WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" })

// Abbreviated weekday, for a list row from the past week. Epoch ms.
export function formatShortWeekday(timestamp: number): string {
	return SHORT_WEEKDAY.format(timestamp)
}

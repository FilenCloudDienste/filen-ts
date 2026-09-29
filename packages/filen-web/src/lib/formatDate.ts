// Compiled once: drive rows format a date per visible row. `undefined` locale defers to the runtime's own.
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" })

// Compact date, no clock time. Accepts epoch ms, a bigint ms timestamp or an ISO-8601 string.
export function formatShortDate(value: number | bigint | string): string {
	const date = new Date(typeof value === "bigint" ? Number(value) : value)

	// DateTimeFormat.format throws on an Invalid Date where toLocaleDateString returned a label.
	return Number.isNaN(date.getTime()) ? date.toLocaleDateString() : SHORT_DATE.format(date)
}

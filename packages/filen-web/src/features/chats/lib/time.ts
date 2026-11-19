// Timestamp formatting for the chats surface. Uses the platform Intl/Date (the app ships no date lib —
// drive/lib/format.ts formats the same way). Millisecond server timestamps sit far inside f64's safe
// range, so Number() narrowing a bigint timestamp is lossless and display-only.

// Local-calendar day index (not UTC) so time headers land on the viewer's own midnight, matching how their
// label renders. Encodes Y/M/D into one comparable number.
export function dayNumber(date: Date): number {
	return date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate()
}

// Which calendar day a timestamp falls on, relative to now: drives the thread time-header label (Today /
// Yesterday / a localized date). Pure except for the `now` clock read, which is injectable for tests.
export function dayKind(timestamp: bigint, now: number = Date.now()): "today" | "yesterday" | "other" {
	const key = dayNumber(new Date(Number(timestamp)))
	const today = new Date(now)

	if (key === dayNumber(today)) {
		return "today"
	}

	// setDate, not a 24h subtraction, so DST days still land on the previous calendar day.
	today.setDate(today.getDate() - 1)

	return key === dayNumber(today) ? "yesterday" : "other"
}

// Compiled once: formatClockTime runs per message row and per list row. `undefined` locale defers to the
// runtime's own.
const CLOCK_TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })

// HH:MM in the viewer's locale — a message line's hover time, the time-header clock and the compact list-row
// time for a same-day chat.
export function formatClockTime(timestamp: bigint): string {
	const date = new Date(Number(timestamp))

	// DateTimeFormat.format throws on an Invalid Date where toLocaleTimeString returned a label.
	return Number.isNaN(date.getTime()) ? date.toLocaleTimeString() : CLOCK_TIME.format(date)
}

const FULL_DATE = new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })

// Full localized date, used for a time header that is neither today nor yesterday.
export function formatFullDate(timestamp: bigint): string {
	const date = new Date(Number(timestamp))

	// DateTimeFormat.format throws on an Invalid Date where toLocaleDateString returned a label.
	return Number.isNaN(date.getTime()) ? date.toLocaleDateString() : FULL_DATE.format(date)
}

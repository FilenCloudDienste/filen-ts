// Timestamp formatting for the chats surface. Uses the platform Intl/Date (the app ships no date lib —
// drive/lib/format.ts formats the same way). Millisecond server timestamps sit far inside f64's safe
// range, so Number() narrowing a bigint timestamp is lossless and display-only.

// Which calendar day a timestamp falls on, relative to now: drives the day-separator label (Today /
// Yesterday / a localized date). Pure except for the `now` clock read, which is injectable for tests.
export function dayKind(timestamp: bigint, now: number = Date.now()): "today" | "yesterday" | "other" {
	const then = new Date(Number(timestamp))
	const today = new Date(now)
	const yesterday = new Date(now)
	yesterday.setDate(yesterday.getDate() - 1)

	if (then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate()) {
		return "today"
	}

	if (
		then.getFullYear() === yesterday.getFullYear() &&
		then.getMonth() === yesterday.getMonth() &&
		then.getDate() === yesterday.getDate()
	) {
		return "yesterday"
	}

	return "other"
}

// HH:MM in the viewer's locale — the burst-header time and the compact list-row time for a same-day chat.
export function formatClockTime(timestamp: bigint): string {
	return new Date(Number(timestamp)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

// Full localized date, used for a day separator that is neither today nor yesterday.
export function formatFullDate(timestamp: bigint): string {
	return new Date(Number(timestamp)).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })
}

// Compact conversation-row timestamp: the clock time for a message sent today, otherwise a short date.
export function formatListTimestamp(timestamp: bigint, now: number = Date.now()): string {
	if (dayKind(timestamp, now) === "today") {
		return formatClockTime(timestamp)
	}

	return new Date(Number(timestamp)).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

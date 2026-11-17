import type { CalendarEntry, CalendarTime } from "@filen/shared/calendarFile"

// A calendar file's entries as the agenda shows them: grouped by day, each time as written in its own zone, plus the
// viewer's own time where that zone differs.

// Epoch ms of a wall time read as UTC: the fields themselves, for formatting them as written.
export function wallMs(time: CalendarTime): number {
	const [year = 0, month = 1, day = 1] = time.date.split("-").map(Number)
	const [hour = 0, minute = 0, second = 0] = (time.time ?? "00:00:00").split(":").map(Number)

	return Date.UTC(year, month - 1, day, hour, minute, second)
}

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>()

// A formatter that reads an instant's wall fields in `zone`; null for a zone the platform does not know (a Windows
// zone name, a typo).
function zoneFormat(zone: string): Intl.DateTimeFormat | null {
	let format = zoneFormats.get(zone)

	if (format === undefined) {
		try {
			format = new Intl.DateTimeFormat("en-US", {
				timeZone: zone,
				hourCycle: "h23",
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "numeric",
				minute: "numeric",
				second: "numeric"
			})
		} catch {
			format = null
		}

		zoneFormats.set(zone, format)
	}

	return format
}

// How far `zone`'s wall clock is ahead of UTC at `instant`, in ms.
function zoneOffset(format: Intl.DateTimeFormat, instant: number): number {
	const fields = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 }

	for (const part of format.formatToParts(instant)) {
		switch (part.type) {
			case "year":
			case "month":
			case "day":
			case "hour":
			case "minute":
			case "second":
				fields[part.type] = Number(part.value)
				break
			default:
				break
		}
	}

	const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second)

	return wall - Math.floor(instant / 1000) * 1000
}

// The instant a time names: UTC, or a wall time in a zone the platform knows. Null for a floating time, a whole day or
// an unknown zone, which are shown as written.
export function instantOf(time: CalendarTime): number | null {
	if (time.time === null) {
		return null
	}

	if (time.utc) {
		return wallMs(time)
	}

	const format = time.tzid === null ? null : zoneFormat(time.tzid)

	if (format === null) {
		return null
	}

	const wall = wallMs(time)
	const first = wall - zoneOffset(format, wall)
	// Once more at the first guess: the offset may differ there across a change of offset.
	const second = wall - zoneOffset(format, first)

	return second
}

export interface AgendaTime {
	// The day it is listed under, YYYY-MM-DD: its own (as written), or the viewer's for a UTC time.
	readonly day: string
	// Epoch ms whose UTC fields are the wall time shown; null for a whole day.
	readonly shownMs: number | null
	// The zone the time is written in, when it is not the viewer's own (a TZID, or the name it gave).
	readonly zone: string | null
	// The instant, when the viewer's own clock reads it differently from `shownMs`.
	readonly yourMs: number | null
	// For ordering.
	readonly sortMs: number
}

function localDay(instant: number): string {
	const date = new Date(instant)

	return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

// The local wall fields of an instant, as epoch ms read as UTC.
function localWallMs(instant: number): number {
	return instant - new Date(instant).getTimezoneOffset() * 60_000
}

export function agendaTime(time: CalendarTime): AgendaTime {
	const instant = instantOf(time)

	if (time.time === null) {
		return { day: time.date, shownMs: null, zone: null, yourMs: null, sortMs: wallMs(time) }
	}

	if (time.utc && instant !== null) {
		return { day: localDay(instant), shownMs: localWallMs(instant), zone: null, yourMs: null, sortMs: instant }
	}

	const wall = wallMs(time)
	const differs = instant !== null && localWallMs(instant) !== wall

	return { day: time.date, shownMs: wall, zone: differs ? time.tzid : null, yourMs: differs ? instant : null, sortMs: instant ?? wall }
}

export interface AgendaItem {
	readonly index: number
	readonly entry: CalendarEntry
	readonly time: AgendaTime | null
}

export interface AgendaDay {
	// YYYY-MM-DD; "" for entries without a start.
	readonly day: string
	readonly items: readonly AgendaItem[]
}

// Entries by day, days in order, entries within a day by time (whole days first); entries without a start last.
export function agendaDays(entries: readonly CalendarEntry[]): AgendaDay[] {
	const items: AgendaItem[] = entries.map((entry, index) => {
		const anchor = entry.start ?? (entry.kind === "todo" ? entry.end : null)

		return { index, entry, time: anchor === null ? null : agendaTime(anchor) }
	})

	items.sort((a, b) => {
		if (a.time === null || b.time === null) {
			return a.time === null ? (b.time === null ? a.index - b.index : 1) : -1
		}

		if (a.time.day !== b.time.day) {
			return a.time.day < b.time.day ? -1 : 1
		}

		if ((a.time.shownMs === null) !== (b.time.shownMs === null)) {
			return a.time.shownMs === null ? -1 : 1
		}

		return a.time.sortMs - b.time.sortMs || a.index - b.index
	})

	const days: { day: string; items: AgendaItem[] }[] = []

	for (const item of items) {
		const day = item.time?.day ?? ""
		const last = days.at(-1)

		if (last?.day === day) {
			last.items.push(item)
		} else {
			days.push({ day, items: [item] })
		}
	}

	return days
}

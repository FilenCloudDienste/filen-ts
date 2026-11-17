import type { CalendarEntry, CalendarObservance, CalendarTime, CalendarZone } from "@filen/shared/calendarFile"
import { WINDOWS_ZONES } from "@/features/preview/lib/windowsZones.gen"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"

// A calendar file's entries as the agenda shows them: grouped by day, each time as written in its own zone, plus the
// viewer's own time where that zone differs.

// Epoch ms of UTC fields, years 0-99 included (Date.UTC reads those as 1900-1999).
export function utcMs(year: number, monthIndex: number, day: number, hour = 0, minute = 0, second = 0): number {
	const date = new Date(0)

	date.setUTCFullYear(year, monthIndex, day)
	date.setUTCHours(hour, minute, second, 0)

	return date.getTime()
}

// Epoch ms of a wall time read as UTC: the fields themselves, for formatting them as written.
export function wallMs(time: CalendarTime): number {
	const [year = 0, month = 1, day = 1] = time.date.split("-").map(Number)
	const [hour = 0, minute = 0, second = 0] = (time.time ?? "00:00:00").split(":").map(Number)

	return utcMs(year, month - 1, day, hour, minute, second)
}

// Epoch ms of a YYYY-MM-DD day at midnight read as UTC; NaN for a malformed one.
export function dayMs(day: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)

	return match === null ? Number.NaN : utcMs(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

// Zone formatters by the names files give, bounded (a file may name thousands), dropped at sign-out.
const zoneFormats = new Map<string, Intl.DateTimeFormat | null>()
const MAX_ZONE_FORMATS = 256

// How many zone names are cached (bounded; emptied at sign-out).
export function cachedZoneCount(): number {
	return zoneFormats.size
}

// A formatter that reads an instant's wall fields in `zone`; null for a zone the platform does not know (a Windows
// zone name, a typo).
function zoneFormat(zone: string): Intl.DateTimeFormat | null {
	let format = zoneFormats.get(zone)

	if (format === undefined) {
		if (zoneFormats.size >= MAX_ZONE_FORMATS) {
			zoneFormats.clear()
		}

		if (zoneFormats.size === 0) {
			registerPreviewDisposer("calendar-zones", () => {
				zoneFormats.clear()
			})
		}

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

	const wall = utcMs(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second)

	return wall - Math.floor(instant / 1000) * 1000
}

// The time zones a file defines, by TZID.
export type ZoneTable = ReadonlyMap<string, CalendarZone>

const NO_ZONES: ZoneTable = new Map()

export function zoneTable(zones: readonly CalendarZone[]): ZoneTable {
	return new Map(zones.map(zone => [zone.tzid, zone]))
}

const DAY_MS = 86_400_000
const WEEKDAYS: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

// Day of the month of a month's `nth` `weekday` (0 Sunday; nth negative counts from the end); null when it has none.
function nthWeekday(year: number, month: number, weekday: number, nth: number): number | null {
	const days = new Date(utcMs(year, month, 0)).getUTCDate()

	if (nth > 0) {
		const first = new Date(utcMs(year, month - 1, 1)).getUTCDay()
		const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7

		return day <= days ? day : null
	}

	const last = new Date(utcMs(year, month - 1, days)).getUTCDay()
	const day = days - ((last - weekday + 7) % 7) + (nth + 1) * 7

	return day >= 1 ? day : null
}

// Where an observance's yearly rule puts its onset in `year`, as a wall time; null for a rule this does not read (only
// the yearly month-and-weekday rules zones use) or a year it does not reach.
function yearlyOnset(observance: CalendarObservance, year: number): number | null {
	const rule = observance.rule

	if (rule?.frequency !== "yearly" || rule.byMonth.length !== 1 || rule.byDay.length !== 1) {
		return null
	}

	const month = rule.byMonth[0] ?? 1

	const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(rule.byDay[0] ?? "")
	const weekday = WEEKDAYS[match?.[2] ?? ""]

	if (weekday === undefined) {
		return null
	}

	let day: number | null = null

	if (match?.[1] !== undefined) {
		day = nthWeekday(year, month, weekday, Number(match[1]))
	} else {
		// BYDAY=SU;BYMONTHDAY=8,9,…,14: the first of those days that is that weekday.
		for (const monthDay of [...rule.byMonthDay].sort((a, b) => a - b)) {
			if (monthDay > 0 && new Date(utcMs(year, month - 1, monthDay)).getUTCDay() === weekday) {
				day = monthDay
				break
			}
		}
	}

	if (day === null) {
		return null
	}

	const onset = wallMs(observance.onset)
	const at = utcMs(year, month - 1, day) + (((onset % DAY_MS) + DAY_MS) % DAY_MS)

	if (at < onset || (rule.until !== null && at > wallMs(rule.until) + DAY_MS)) {
		return null
	}

	return at
}

// The offset (seconds) a file's own zone gives a wall time: the observance whose latest onset is at or before it; before
// every onset, the earliest observance's offset before it. Onsets are local times in the offset before them, so a time
// repeated when clocks go back reads as its first occurrence; a time skipped when they go forward reads in the offset
// before the gap (RFC 5545 §3.3.5).
export function definedOffset(zone: CalendarZone, wall: number): number | null {
	const year = new Date(wall).getUTCFullYear()
	let latest = -Infinity
	let current: CalendarObservance | null = null
	let earliest: CalendarObservance | null = null

	for (const observance of zone.observances) {
		const onset = wallMs(observance.onset)
		const onsets = [onset, ...observance.dates.map(wallMs), yearlyOnset(observance, year), yearlyOnset(observance, year - 1)]

		for (const at of onsets) {
			if (at !== null && at <= wall && at > latest) {
				latest = at
				current = observance
			}
		}

		if (earliest === null || onset < wallMs(earliest.onset)) earliest = observance
	}

	if (current === null) {
		return earliest?.offsetFrom ?? null
	}

	const gap = (current.offsetTo - current.offsetFrom) * 1000

	return gap > 0 && wall < latest + gap ? current.offsetFrom : current.offsetTo
}

// Mozilla's globally unique TZIDs carry the IANA name after a prefix: /mozilla.org/20050126_1/Europe/Berlin.
const MOZILLA_TZID = /^\/mozilla\.org\/[^/]+\/(.+)$/

// The platform's zone for a TZID: an IANA name (or Mozilla's prefixed form), or a Windows name CLDR maps to one.
function platformZone(tzid: string): Intl.DateTimeFormat | null {
	const windows = WINDOWS_ZONES.get(tzid)

	if (windows !== undefined) {
		return zoneFormat(windows)
	}

	const mozilla = MOZILLA_TZID.exec(tzid)?.[1]

	return zoneFormat(mozilla ?? tzid)
}

// Whether the zone a TZID names can be converted at all: the file defines it, or the platform knows it.
export function zoneKnown(tzid: string, zones: ZoneTable = NO_ZONES): boolean {
	return zones.has(tzid) || platformZone(tzid) !== null
}

// The instant of a wall time in a platform zone. Of the offsets a day before and a day after, the one whose instant
// reads back as the wall time; both (clocks went back): the earlier instant, the first occurrence; neither (clocks went
// forward over it): the offset before the gap, so the time moves forward by the gap (RFC 5545 §3.3.5).
function platformInstant(format: Intl.DateTimeFormat, wall: number): number {
	const before = wall - zoneOffset(format, wall - DAY_MS)
	const after = wall - zoneOffset(format, wall + DAY_MS)
	const readsBack = (instant: number): boolean => instant + zoneOffset(format, instant) === wall

	if (readsBack(before) && readsBack(after)) {
		return Math.min(before, after)
	}

	if (readsBack(after)) {
		return after
	}

	return before
}

// The instant a time names: UTC, or a wall time in a zone the file defines (VTIMEZONE), the platform knows (IANA) or
// CLDR maps from a Windows name. Null for a floating time, a whole day or a zone none of them knows, which is shown as
// written.
export function instantOf(time: CalendarTime, zones: ZoneTable = NO_ZONES): number | null {
	if (time.time === null) {
		return null
	}

	if (time.utc) {
		return wallMs(time)
	}

	if (time.tzid === null) {
		return null
	}

	const wall = wallMs(time)
	const defined = zones.get(time.tzid)
	const definedSeconds = defined === undefined ? null : definedOffset(defined, wall)

	if (definedSeconds !== null) {
		return wall - definedSeconds * 1000
	}

	const format = platformZone(time.tzid)

	return format === null ? null : platformInstant(format, wall)
}

// The day before a YYYY-MM-DD day.
export function previousDay(day: string): string {
	const date = new Date(dayMs(day) - DAY_MS)

	return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}

// An event's last day as shown: a whole-day DTEND is exclusive (RFC 5545 §3.6.1), so its day before; null when that is
// the start's own day (a one-day event shows no end).
export function shownEnd(start: CalendarTime | null, end: CalendarTime): CalendarTime | null {
	if (end.time !== null || start?.time !== null) {
		return end
	}

	const last = previousDay(end.date)

	return last <= start.date ? null : { ...end, date: last }
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
	// `zone` is one neither the file nor the platform knows: the time is shown as written, not converted.
	readonly unconverted: boolean
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

export function agendaTime(time: CalendarTime, zones: ZoneTable = NO_ZONES): AgendaTime {
	const instant = instantOf(time, zones)

	if (time.time === null) {
		return { day: time.date, shownMs: null, zone: null, yourMs: null, unconverted: false, sortMs: wallMs(time) }
	}

	if (time.utc && instant !== null) {
		return { day: localDay(instant), shownMs: localWallMs(instant), zone: null, yourMs: null, unconverted: false, sortMs: instant }
	}

	const wall = wallMs(time)
	const differs = instant !== null && localWallMs(instant) !== wall
	const unconverted = instant === null && time.tzid !== null

	return {
		day: time.date,
		shownMs: wall,
		zone: differs || unconverted ? time.tzid : null,
		yourMs: differs ? instant : null,
		unconverted,
		sortMs: instant ?? wall
	}
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
export function agendaDays(entries: readonly CalendarEntry[], zones: ZoneTable = NO_ZONES): AgendaDay[] {
	const items: AgendaItem[] = entries.map((entry, index) => {
		const anchor = entry.start ?? (entry.kind === "todo" ? entry.end : null)

		return { index, entry, time: anchor === null ? null : agendaTime(anchor, zones) }
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

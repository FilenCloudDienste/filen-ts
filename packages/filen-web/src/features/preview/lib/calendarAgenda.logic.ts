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

const DAY_MS = 86_400_000
const WEEKDAYS: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
// Fixed onsets (DTSTARTs and RDATEs) kept per zone: real zones list a handful.
const MAX_ZONE_ONSETS = 256

// A yearly observance rule this reads: a month and either its nth weekday, the first of some month days that is a given
// weekday (BYDAY=SU;BYMONTHDAY=8,…,14), or one fixed day; every `interval` years from the onset's, `count` times at most,
// until `until`.
type OnsetDay =
	| { readonly weekday: number; readonly nth: number }
	| { readonly weekday: number; readonly among: readonly number[] }
	| { readonly day: number }

interface CompiledRule {
	readonly month: number
	readonly day: OnsetDay
	readonly interval: number
	readonly count: number | null
	readonly until: number | null
	readonly startYear: number
}

interface CompiledObservance {
	readonly offsetFrom: number
	readonly offsetTo: number
	readonly onset: number
	// The onset and the extra dates, ascending.
	readonly fixed: readonly number[]
	readonly rule: CompiledRule | null
	// The rule's onset by year, computed once each.
	readonly years: Map<number, number | null>
}

// A file's zone, compiled once per reading. `readable`: every observance's rule is one this reads; when not, the
// platform's zone of that name is used if it has one, and the time is otherwise not converted.
export interface CompiledZone {
	readonly observances: readonly CompiledObservance[]
	readonly readable: boolean
}

// The time zones a file defines, by TZID.
export type ZoneTable = ReadonlyMap<string, CompiledZone>

const NO_ZONES: ZoneTable = new Map()

function compileRule(observance: CalendarObservance): CompiledRule | null | undefined {
	const rule = observance.rule

	if (rule === null) {
		return null
	}

	const month = rule.byMonth[0]

	if (rule.frequency !== "yearly" || rule.custom || month === undefined || rule.byMonth.length !== 1) {
		return undefined
	}

	let day: OnsetDay

	if (rule.byDay.length === 1) {
		const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(rule.byDay[0] ?? "")
		const weekday = WEEKDAYS[match?.[2] ?? ""]

		if (weekday === undefined) {
			return undefined
		}

		if (match?.[1] !== undefined) {
			day = { weekday, nth: Number(match[1]) }
		} else if (rule.byMonthDay.length > 0 && rule.byMonthDay.every(monthDay => monthDay > 0)) {
			day = { weekday, among: [...rule.byMonthDay].sort((a, b) => a - b) }
		} else {
			return undefined
		}
	} else if (rule.byDay.length === 0 && rule.byMonthDay.length === 1 && (rule.byMonthDay[0] ?? 0) > 0) {
		day = { day: rule.byMonthDay[0] ?? 1 }
	} else {
		return undefined
	}

	return {
		month,
		day,
		interval: rule.interval,
		count: rule.count,
		until: rule.until === null ? null : wallMs(rule.until),
		startYear: Number(observance.onset.date.slice(0, 4))
	}
}

function compileZone(zone: CalendarZone): CompiledZone {
	let budget = MAX_ZONE_ONSETS
	let readable = true
	const observances: CompiledObservance[] = []

	for (const observance of zone.observances) {
		const rule = compileRule(observance)

		if (rule === undefined) readable = false

		const onset = wallMs(observance.onset)
		const fixed = [onset, ...observance.dates.slice(0, Math.max(0, budget - 1)).map(wallMs)].sort((a, b) => a - b)

		budget -= fixed.length
		observances.push({
			offsetFrom: observance.offsetFrom,
			offsetTo: observance.offsetTo,
			onset,
			fixed,
			rule: rule ?? null,
			years: new Map()
		})
	}

	return { observances, readable: readable && observances.length > 0 }
}

export function zoneTable(zones: readonly CalendarZone[]): ZoneTable {
	return new Map(zones.map(zone => [zone.tzid, compileZone(zone)]))
}

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

function onsetDay(rule: CompiledRule, year: number): number | null {
	const spec = rule.day

	if ("day" in spec) {
		return spec.day <= new Date(utcMs(year, rule.month, 0)).getUTCDate() ? spec.day : null
	}

	if ("nth" in spec) {
		return nthWeekday(year, rule.month, spec.weekday, spec.nth)
	}

	return spec.among.find(monthDay => new Date(utcMs(year, rule.month - 1, monthDay)).getUTCDay() === spec.weekday) ?? null
}

// Where an observance's rule puts its onset in `year`, as a wall time; null for a year it does not reach. Memoised.
function yearlyOnset(observance: CompiledObservance, year: number): number | null {
	const rule = observance.rule

	if (rule === null) {
		return null
	}

	const known = observance.years.get(year)

	if (known !== undefined) {
		return known
	}

	const step = year - rule.startYear
	const day =
		step >= 0 && step % rule.interval === 0 && (rule.count === null || step / rule.interval < rule.count) ? onsetDay(rule, year) : null
	const at = day === null ? null : utcMs(year, rule.month - 1, day) + (((observance.onset % DAY_MS) + DAY_MS) % DAY_MS)
	const onset = at === null || at < observance.onset || (rule.until !== null && at > rule.until + DAY_MS) ? null : at

	observance.years.set(year, onset)

	return onset
}

// The latest of ascending numbers at or before `value`; null for none.
function latestAtOrBefore(sorted: readonly number[], value: number): number | null {
	let low = 0
	let high = sorted.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((sorted[middle] ?? Infinity) <= value) low = middle + 1
		else high = middle
	}

	return low === 0 ? null : (sorted[low - 1] ?? null)
}

// The offset (seconds) a file's own zone gives a wall time: the observance whose latest onset is at or before it; before
// every onset, the earliest observance's offset before it. Onsets are local times in the offset before them, so a time
// repeated when clocks go back reads as its first occurrence; a time skipped when they go forward reads in the offset
// before the gap (RFC 5545 §3.3.5). Each observance costs a binary search and two memoised years.
export function definedOffset(zone: CompiledZone, wall: number): number | null {
	const year = new Date(wall).getUTCFullYear()
	let latest = -Infinity
	let current: CompiledObservance | null = null
	let earliest: CompiledObservance | null = null

	for (const observance of zone.observances) {
		for (const at of [latestAtOrBefore(observance.fixed, wall), yearlyOnset(observance, year), yearlyOnset(observance, year - 1)]) {
			if (at !== null && at <= wall && at > latest) {
				latest = at
				current = observance
			}
		}

		if (earliest === null || observance.onset < earliest.onset) earliest = observance
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
	return zones.get(tzid)?.readable === true || platformZone(tzid) !== null
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
	// A zone whose rules this cannot read gives way to the platform's zone of that name.
	const definedSeconds = defined?.readable === true ? definedOffset(defined, wall) : null

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

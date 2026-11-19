import { DAY_MS } from "./internal"

// Date filters the tools take as an enum or as plain days: the model names a period, code works out the
// days. Every range is whole local days in the user's time zone, inclusive at both ends, written as ISO days
// ("2025-10-08") so they read like the prompt's date line and the dates tool results carry.

export const ASSISTANT_PERIODS = [
	"today",
	"yesterday",
	// Rolling, ending today: no calendar period covers "the last 7 days".
	"last_7_days",
	"last_30_days",
	"this_week",
	"last_week",
	"this_month",
	"last_month",
	"this_year",
	"last_year"
] as const

export type AssistantPeriod = (typeof ASSISTANT_PERIODS)[number]

// What a tool's `period` argument takes. Small models fill every optional argument, so "any" (no filter)
// comes first, and explicit days count only under "custom": days filled in beside "any" change nothing.
export const ASSISTANT_PERIOD_FILTERS = ["any", ...ASSISTANT_PERIODS, "custom"] as const

export type AssistantPeriodFilter = (typeof ASSISTANT_PERIOD_FILTERS)[number]

export type AssistantCalendar = {
	now: number
	// IANA; undefined is the runtime's own zone.
	timeZone?: string | undefined
	// 1 Monday to 7 Sunday.
	weekStart?: number | undefined
}

export type AssistantDayRange = {
	from: string
	to: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

// Created once per zone: a formatter loads the zone's rules.
function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
	const key = timeZone ?? ""
	let format = formatters.get(key)

	if (format === undefined) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		})
		formatters.set(key, format)
	}

	return format
}

// A zone the runtime does not know falls back to the runtime's own.
export function knownTimeZone(timeZone: string | undefined): string | undefined {
	if (timeZone === undefined) {
		return undefined
	}

	try {
		formatter(timeZone)

		return timeZone
	} catch {
		return undefined
	}
}

// The wall clock of `timestamp` in the zone, read as if it were UTC.
function wallClockMs(timestamp: number, timeZone: string | undefined): number {
	const parts = formatter(knownTimeZone(timeZone)).formatToParts(timestamp)
	const field = (type: string) => Number(parts.find(part => part.type === type)?.value ?? "0")

	return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"))
}

export function isoDay(utcDay: number): string {
	return new Date(utcDay).toISOString().slice(0, 10)
}

// The local calendar day of `timestamp`, as a UTC midnight so day arithmetic ignores the zone.
export function localDayUtc(timestamp: number, timeZone: string | undefined): number {
	const wall = wallClockMs(timestamp, timeZone)

	return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS)
}

export function localIsoDay(timestamp: number, timeZone?: string): string {
	return Number.isFinite(timestamp) ? isoDay(localDayUtc(timestamp, timeZone)) : ""
}

// The instant a local day begins. Twice, so a day whose offset differs from the guess's (a DST change)
// lands on its own midnight.
export function localDayStartMs(day: string, timeZone?: string): number {
	const target = Date.parse(`${day}T00:00:00Z`)
	let instant = target

	for (let pass = 0; pass < 2; pass++) {
		instant = target - (wallClockMs(instant, timeZone) - instant)
	}

	const wall = wallClockMs(instant, timeZone)

	// Where DST starts at midnight, the day has no midnight and the passes land in the previous day's last
	// hour: the day begins where that hour ends.
	return wall < target ? instant + (target - wall) : instant
}

// The ends of a range given only one explicit day.
const OPEN_FROM = "0000-01-01"
const OPEN_TO = "9999-12-31"

// The half-open instant range [start, end) a day range covers.
export function dayRangeBounds(range: AssistantDayRange, timeZone?: string): { start: number; end: number } {
	return {
		start: range.from === OPEN_FROM ? -Infinity : localDayStartMs(range.from, timeZone),
		end: range.to === OPEN_TO ? Infinity : localDayStartMs(isoDay(Date.parse(`${range.to}T00:00:00Z`) + DAY_MS), timeZone)
	}
}

export function inDayRange(timestamp: number, bounds: { start: number; end: number }): boolean {
	return timestamp >= bounds.start && timestamp < bounds.end
}

export type AssistantCalendarDays = {
	today: number
	weekday: number
	year: number
	month: number
	// Offset in days from today to the first day of this week.
	weekFirst: number
}

export function calendarDays({ now, timeZone, weekStart = 1 }: AssistantCalendar): AssistantCalendarDays {
	const today = localDayUtc(now, timeZone)
	const date = new Date(today)
	const weekday = date.getUTCDay()

	return {
		today,
		weekday,
		year: date.getUTCFullYear(),
		month: date.getUTCMonth(),
		// getUTCDay counts Sunday as 0, weekStart as 7.
		weekFirst: -((weekday - (weekStart % 7) + 7) % 7)
	}
}

export function periodRange(period: AssistantPeriod, calendar: AssistantCalendar): AssistantDayRange {
	const { today, year, month, weekFirst } = calendarDays(calendar)
	const day = (offset: number) => isoDay(today + offset * DAY_MS)
	// Date.UTC rolls month -1 into the previous year.
	const months = (first: number, count: number) => ({
		from: isoDay(Date.UTC(year, first, 1)),
		to: isoDay(Date.UTC(year, first + count, 1) - DAY_MS)
	})

	switch (period) {
		case "today":
			return { from: day(0), to: day(0) }
		case "yesterday":
			return { from: day(-1), to: day(-1) }
		case "last_7_days":
			return { from: day(-6), to: day(0) }
		case "last_30_days":
			return { from: day(-29), to: day(0) }
		case "this_week":
			return { from: day(weekFirst), to: day(weekFirst + 6) }
		case "last_week":
			return { from: day(weekFirst - 7), to: day(weekFirst - 1) }
		case "this_month":
			return months(month, 1)
		case "last_month":
			return months(month - 1, 1)
		case "this_year":
			return months(0, 12)
		case "last_year":
			return months(-12, 12)
	}
}

const BOUND = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T ].*)?$/

// "2025-10-08", "2025-10" or "2025" (models also write the month or year the date line names), as its
// first day for a `from` and its last for a `to`. Null when it is no real date.
export function parseDayBound(value: string, edge: "from" | "to"): string | null {
	const match = BOUND.exec(value.trim())

	if (match === null) {
		return null
	}

	const year = Number(match[1])
	const month = match[2] === undefined ? null : Number(match[2]) - 1
	const day = match[3] === undefined ? null : Number(match[3])

	if (month !== null && (month < 0 || month > 11)) {
		return null
	}

	if (month === null) {
		return edge === "from" ? `${match[1] ?? ""}-01-01` : `${match[1] ?? ""}-12-31`
	}

	if (day === null) {
		return isoDay(edge === "from" ? Date.UTC(year, month, 1) : Date.UTC(year, month + 1, 1) - DAY_MS)
	}

	const utc = Date.UTC(year, month, day)

	// Rejects days a month does not have, which Date.UTC would roll over.
	return new Date(utc).getUTCDate() === day ? isoDay(utc) : null
}

export type AssistantDateFilterInput = {
	period?: AssistantPeriodFilter | undefined
	from?: string | undefined
	to?: string | undefined
}

export type AssistantDateFilter = { ok: true; range: AssistantDayRange | null } | { ok: false; error: string }

// The days a call's date arguments leave: a named period, or explicit days under "custom" (or with no period
// at all). Null for "any" or no date arguments.
export function resolveDateFilter(input: AssistantDateFilterInput, calendar: AssistantCalendar): AssistantDateFilter {
	const { period } = input

	if (period === "any") {
		return { ok: true, range: null }
	}

	if (period !== undefined && period !== "custom") {
		return { ok: true, range: periodRange(period, calendar) }
	}

	const blank = (value: string | undefined) => value === undefined || value.trim().length === 0
	const from = blank(input.from) ? null : parseDayBound(input.from ?? "", "from")
	const to = blank(input.to) ? null : parseDayBound(input.to ?? "", "to")

	if (!blank(input.from) && from === null) {
		return { ok: false, error: `"from" must be a day like 2025-10-08, not "${input.from ?? ""}"` }
	}

	if (!blank(input.to) && to === null) {
		return { ok: false, error: `"to" must be a day like 2025-10-08, not "${input.to ?? ""}"` }
	}

	if (from === null && to === null) {
		return period === "custom" ? { ok: false, error: 'Period "custom" needs "from" or "to"' } : { ok: true, range: null }
	}

	if (from !== null && to !== null && from > to) {
		return { ok: false, error: `"from" (${from}) is after "to" (${to})` }
	}

	return { ok: true, range: { from: from ?? OPEN_FROM, to: to ?? OPEN_TO } }
}

// For a date-filtered result that came back empty while other items exist: a model that set a period the
// user never named learns the filter, not the drive, emptied it.
export function dateFilterNote(range: string, outside: number): string {
	return `Nothing is dated ${range}; ${String(outside)} ${outside === 1 ? "item is" : "items are"} outside those dates.`
}

// How many of the newest items outside the dates a newest-first listing the filter emptied shows instead.
// Asked for the latest files, the model set "today" and, told only how many lay outside, listed that many
// made-up rows; shown them, it answers from them in the same step.
export const OUTSIDE_DATES_ITEMS = 5

// The range as a result shows it: open ends left out.
export function describeDayRange(range: AssistantDayRange): string {
	const from = range.from === OPEN_FROM ? null : range.from
	const to = range.to === OPEN_TO ? null : range.to

	return from === null ? `until ${to ?? ""}` : to === null ? `since ${from}` : from === to ? from : `${from} to ${to}`
}

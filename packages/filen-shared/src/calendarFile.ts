import { decodedValue, displayText, param, eachContentLine, type ContentLine } from "./pimLines"

// An iCalendar file (RFC 5545) read for display: its events and to-dos, their times as written (the app turns a time
// zone into the viewer's own), their recurrence as a rule, and the time zones it defines (VTIMEZONE: each observance's
// onset, offsets and yearly rule). Text only: nothing it names (ATTACH, URL, an organizer's address) is ever fetched.

// "utc": a time ending in Z; "floating": no zone (the same wall time everywhere); otherwise the TZID it names.
export interface CalendarTime {
	// YYYY-MM-DD.
	readonly date: string
	// HH:MM:SS; null for a whole day (VALUE=DATE).
	readonly time: string | null
	readonly utc: boolean
	readonly tzid: string | null
}

export type CalendarFrequency = "secondly" | "minutely" | "hourly" | "daily" | "weekly" | "monthly" | "yearly"

export interface CalendarRecurrence {
	readonly frequency: CalendarFrequency
	readonly interval: number
	readonly count: number | null
	readonly until: CalendarTime | null
	// MO..SU, each with an optional ordinal (1MO, -1FR).
	readonly byDay: readonly string[]
	readonly byMonthDay: readonly number[]
	readonly byMonth: readonly number[]
}

export interface CalendarEntry {
	readonly kind: "event" | "todo"
	readonly summary: string | null
	readonly location: string | null
	readonly description: string | null
	readonly start: CalendarTime | null
	// DTEND (an event) or DUE (a to-do).
	readonly end: CalendarTime | null
	// DURATION, when the entry has one instead of an end.
	readonly durationSeconds: number | null
	readonly recurrence: CalendarRecurrence | null
	// Extra dates (RDATE) and exceptions (EXDATE) listed beside the rule.
	readonly extraDates: number
	readonly exceptions: number
	readonly status: string | null
	readonly organizer: string | null
	readonly attendees: readonly string[]
	readonly url: string | null
}

// One STANDARD or DAYLIGHT part of a VTIMEZONE: from its onset (a local time, in the offset before it), and again by
// its rule or on its extra dates, local times are `offsetTo` seconds ahead of UTC.
export interface CalendarObservance {
	readonly onset: CalendarTime
	readonly offsetFrom: number
	readonly offsetTo: number
	readonly rule: CalendarRecurrence | null
	readonly dates: readonly CalendarTime[]
}

export interface CalendarZone {
	readonly tzid: string
	readonly observances: readonly CalendarObservance[]
}

export interface CalendarFile {
	// X-WR-CALNAME.
	readonly name: string | null
	readonly entries: readonly CalendarEntry[]
	// Entries past the cap, counted.
	readonly entriesOmitted: number
	// The file was not read to its end (past the line cap, or nested too deep): `entriesOmitted` is then a lower bound.
	readonly truncated: boolean
	readonly zones: readonly CalendarZone[]
}

const MAX_ENTRIES = 10_000
const MAX_LINES = 1_000_000
const MAX_LINE_CHARS = 64 * 1024
const MAX_DEPTH = 16
const MAX_SHORT = 512
const MAX_DESCRIPTION = 8192
const MAX_ATTENDEES = 100
const MAX_RULE_PARTS = 64
const MAX_ZONES = 64
const MAX_OBSERVANCES = 64
const MAX_ZONE_DATES = 64

const TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/

export function parseCalendarTime(value: string, tzid: string | null): CalendarTime | null {
	const match = TIME.exec(value.trim())

	if (match === null) {
		return null
	}

	const [, year, month, day, hour, minute, second, zulu] = match
	const date = `${year ?? ""}-${month ?? ""}-${day ?? ""}`
	const time = hour === undefined ? null : `${hour}:${minute ?? "00"}:${second ?? "00"}`

	if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) {
		return null
	}

	return { date, time, utc: zulu !== undefined, tzid: time === null || zulu !== undefined ? null : tzid }
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

// RFC 5545 §3.3.6, in seconds; null for none or a negative one.
export function parseCalendarDuration(value: string): number | null {
	const match = DURATION.exec(value.trim())

	if (match === null || match[1] === "-" || value.trim() === "P" || value.trim().endsWith("T")) {
		return null
	}

	const [, , weeks, days, hours, minutes, seconds] = match

	return (
		Number(weeks ?? 0) * 604_800 +
		Number(days ?? 0) * 86_400 +
		Number(hours ?? 0) * 3600 +
		Number(minutes ?? 0) * 60 +
		Number(seconds ?? 0)
	)
}

const FREQUENCIES: ReadonlyMap<string, CalendarFrequency> = new Map([
	["SECONDLY", "secondly"],
	["MINUTELY", "minutely"],
	["HOURLY", "hourly"],
	["DAILY", "daily"],
	["WEEKLY", "weekly"],
	["MONTHLY", "monthly"],
	["YEARLY", "yearly"]
])
const WEEKDAY = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/

function integers(value: string, min: number, max: number): number[] {
	return value
		.split(",")
		.slice(0, MAX_RULE_PARTS)
		.map(part => Number(part))
		.filter(number => Number.isInteger(number) && number >= min && number <= max && number !== 0)
}

// RFC 5545 §3.3.10; null for a rule without a valid FREQ.
export function parseCalendarRecurrence(value: string): CalendarRecurrence | null {
	const parts = new Map<string, string>()

	for (const part of value.split(";").slice(0, MAX_RULE_PARTS)) {
		const equals = part.indexOf("=")

		if (equals > 0) parts.set(part.slice(0, equals).trim().toUpperCase(), part.slice(equals + 1).trim())
	}

	const frequency = FREQUENCIES.get(parts.get("FREQ")?.toUpperCase() ?? "")

	if (frequency === undefined) {
		return null
	}

	const interval = Number(parts.get("INTERVAL") ?? "1")
	const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null
	const until = parts.get("UNTIL")

	return {
		frequency,
		interval: Number.isInteger(interval) && interval > 0 ? interval : 1,
		count: count !== null && Number.isInteger(count) && count > 0 ? count : null,
		until: until === undefined ? null : parseCalendarTime(until, null),
		byDay: (parts.get("BYDAY") ?? "")
			.split(",")
			.slice(0, MAX_RULE_PARTS)
			.map(day => day.trim().toUpperCase())
			.filter(day => WEEKDAY.test(day)),
		byMonthDay: integers(parts.get("BYMONTHDAY") ?? "", -31, 31),
		byMonth: integers(parts.get("BYMONTH") ?? "", 1, 12)
	}
}

interface Draft {
	kind: "event" | "todo"
	summary: string | null
	location: string | null
	description: string | null
	start: CalendarTime | null
	end: CalendarTime | null
	durationSeconds: number | null
	recurrence: CalendarRecurrence | null
	extraDates: number
	exceptions: number
	status: string | null
	organizer: string | null
	attendees: string[]
	url: string | null
}

function draft(kind: "event" | "todo"): Draft {
	return {
		kind,
		summary: null,
		location: null,
		description: null,
		start: null,
		end: null,
		durationSeconds: null,
		recurrence: null,
		extraDates: 0,
		exceptions: 0,
		status: null,
		organizer: null,
		attendees: [],
		url: null
	}
}

// An organizer or attendee: their name (CN) and address, mailto: dropped.
function person(line: ContentLine): string {
	const address = line.value.trim().replace(/^mailto:/i, "")
	const name = param(line, "CN")?.trim() ?? ""

	return displayText(name === "" || name === address ? address : `${name} <${address}>`, MAX_SHORT)
}

function listCount(value: string): number {
	return value.split(",").filter(part => part.trim() !== "").length
}

function apply(entry: Draft, line: ContentLine): void {
	switch (line.name) {
		case "SUMMARY":
			entry.summary = displayText(decodedValue(line), MAX_SHORT)
			break
		case "LOCATION":
			entry.location = displayText(decodedValue(line), MAX_SHORT)
			break
		case "DESCRIPTION":
			entry.description = displayText(decodedValue(line), MAX_DESCRIPTION)
			break
		case "DTSTART":
			entry.start = parseCalendarTime(line.value, param(line, "TZID"))
			break
		case "DTEND":
		case "DUE":
			entry.end = parseCalendarTime(line.value, param(line, "TZID"))
			break
		case "DURATION":
			entry.durationSeconds = parseCalendarDuration(line.value)
			break
		case "RRULE":
			entry.recurrence ??= parseCalendarRecurrence(line.value)
			break
		case "RDATE":
			entry.extraDates += listCount(line.value)
			break
		case "EXDATE":
			entry.exceptions += listCount(line.value)
			break
		case "STATUS":
			entry.status = displayText(line.value.trim().toUpperCase(), 32)
			break
		case "ORGANIZER":
			entry.organizer = person(line)
			break
		case "ATTENDEE":
			if (entry.attendees.length < MAX_ATTENDEES) entry.attendees.push(person(line))
			break
		case "URL":
			entry.url = displayText(line.value.trim(), MAX_SHORT)
			break
		default:
			break
	}
}

// A UTC offset, ±HHMM[SS], in seconds; null for none.
export function parseUtcOffset(value: string): number | null {
	const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim())

	if (match === null) {
		return null
	}

	const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)

	return match[1] === "-" ? -seconds : seconds
}

interface ObservanceDraft {
	onset: CalendarTime | null
	offsetFrom: number | null
	offsetTo: number | null
	rule: CalendarRecurrence | null
	dates: CalendarTime[]
}

function applyObservance(observance: ObservanceDraft, line: ContentLine): void {
	switch (line.name) {
		case "DTSTART":
			observance.onset = parseCalendarTime(line.value, null)
			break
		case "TZOFFSETFROM":
			observance.offsetFrom = parseUtcOffset(line.value)
			break
		case "TZOFFSETTO":
			observance.offsetTo = parseUtcOffset(line.value)
			break
		case "RRULE":
			observance.rule ??= parseCalendarRecurrence(line.value)
			break
		case "RDATE":
			for (const value of line.value.split(",")) {
				const date = parseCalendarTime(value, null)

				if (date !== null && observance.dates.length < MAX_ZONE_DATES) observance.dates.push(date)
			}

			break
		default:
			break
	}
}

interface ZoneDraft {
	tzid: string | null
	observances: CalendarObservance[]
}

// The events and to-dos of an iCalendar text, in the file's order.
export function readCalendar(text: string): CalendarFile {
	const entries: CalendarEntry[] = []
	const stack: string[] = []
	const open: { entry: Draft | null; zone: ZoneDraft | null; observance: ObservanceDraft | null } = {
		entry: null,
		zone: null,
		observance: null
	}
	const zones: CalendarZone[] = []
	let name: string | null = null
	let omitted = 0

	const complete = eachContentLine(text, { lines: MAX_LINES, lineChars: MAX_LINE_CHARS }, line => {
		if (line.name === "BEGIN") {
			const component = line.value.trim().toUpperCase()

			if (stack.length >= MAX_DEPTH) {
				return false
			}

			stack.push(component)

			if (stack.length === 2 && stack[0] === "VCALENDAR" && (component === "VEVENT" || component === "VTODO")) {
				if (entries.length < MAX_ENTRIES) {
					open.entry = draft(component === "VEVENT" ? "event" : "todo")
				} else {
					omitted++
				}
			} else if (stack.length === 2 && stack[0] === "VCALENDAR" && component === "VTIMEZONE" && zones.length < MAX_ZONES) {
				open.zone = { tzid: null, observances: [] }
			} else if (stack.length === 3 && open.zone !== null && (component === "STANDARD" || component === "DAYLIGHT")) {
				open.observance = { onset: null, offsetFrom: null, offsetTo: null, rule: null, dates: [] }
			}

			return true
		}

		if (line.name === "END") {
			if (stack.length === 2 && open.entry !== null) {
				entries.push(open.entry)
				open.entry = null
			} else if (stack.length === 2 && open.zone !== null) {
				if (open.zone.tzid !== null && open.zone.observances.length > 0) {
					zones.push({ tzid: open.zone.tzid, observances: open.zone.observances })
				}

				open.zone = null
			} else if (stack.length === 3 && open.zone !== null && open.observance !== null) {
				const { onset, offsetFrom, offsetTo, rule, dates } = open.observance

				if (onset !== null && offsetTo !== null && open.zone.observances.length < MAX_OBSERVANCES) {
					open.zone.observances.push({ onset, offsetFrom: offsetFrom ?? offsetTo, offsetTo, rule, dates })
				}

				open.observance = null
			}

			stack.pop()

			return true
		}

		if (stack.length === 1 && stack[0] === "VCALENDAR" && line.name === "X-WR-CALNAME") {
			name = displayText(decodedValue(line), MAX_SHORT)
		} else if (stack.length === 2 && open.entry !== null) {
			apply(open.entry, line)
		} else if (stack.length === 2 && open.zone !== null && line.name === "TZID") {
			open.zone.tzid = line.value.trim().slice(0, MAX_SHORT)
		} else if (stack.length === 3 && open.observance !== null) {
			applyObservance(open.observance, line)
		}

		return true
	})

	// An entry the file ends inside.
	if (open.entry !== null) entries.push(open.entry)

	return { name, entries, entriesOmitted: omitted, truncated: !complete, zones }
}

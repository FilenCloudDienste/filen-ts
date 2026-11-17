import { describe, expect, it } from "vitest"
import { readCalendar, type CalendarEntry, type CalendarTime } from "@filen/shared/calendarFile"
import { agendaDays, agendaTime, instantOf, wallMs, zoneTable } from "@/features/preview/lib/calendarAgenda.logic"

// Times as written in their own zone, the viewer's own where that zone differs (the test's Kiritimati time differs
// from any machine's but one at UTC+14); days in order, whole days first.

const time = (date: string, clock: string | null, zone: { utc?: boolean; tzid?: string } = {}): CalendarTime => ({
	date,
	time: clock,
	utc: zone.utc ?? false,
	tzid: zone.tzid ?? null
})

function entry(summary: string, start: CalendarTime | null): CalendarEntry {
	return {
		kind: "event",
		summary,
		location: null,
		description: null,
		start,
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

describe("instantOf", () => {
	it("reads UTC as is, a known zone by its offset on that day, and nothing for floating, whole-day or unknown zones", () => {
		expect(instantOf(time("2024-03-04", "10:00:00", { utc: true }))).toBe(Date.UTC(2024, 2, 4, 10))
		// Berlin is UTC+1 in winter and UTC+2 in summer.
		expect(instantOf(time("2024-01-15", "10:00:00", { tzid: "Europe/Berlin" }))).toBe(Date.UTC(2024, 0, 15, 9))
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "Europe/Berlin" }))).toBe(Date.UTC(2024, 6, 15, 8))
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "America/New_York" }))).toBe(Date.UTC(2024, 6, 15, 14))
		expect(instantOf(time("2024-07-15", "10:00:00"))).toBeNull()
		expect(instantOf(time("2024-07-15", null))).toBeNull()
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "Nowhere/Unknown" }))).toBeNull()
	})

	it("reads a Windows zone name through CLDR's table", () => {
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "W. Europe Standard Time" }))).toBe(Date.UTC(2024, 6, 15, 8))
		expect(instantOf(time("2024-01-15", "10:00:00", { tzid: "Eastern Standard Time" }))).toBe(Date.UTC(2024, 0, 15, 15))
	})

	// A zone only the file defines: Central European rules, the last Sunday of March and October, as Outlook writes them.
	const DEFINED = zoneTable(
		readCalendar(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VTIMEZONE",
				"TZID:Custom Central",
				"BEGIN:STANDARD",
				"DTSTART:16011028T030000",
				"TZOFFSETFROM:+0200",
				"TZOFFSETTO:+0100",
				"RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
				"END:STANDARD",
				"BEGIN:DAYLIGHT",
				"DTSTART:16010325T020000",
				"TZOFFSETFROM:+0100",
				"TZOFFSETTO:+0200",
				"RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
				"END:DAYLIGHT",
				"END:VTIMEZONE",
				"BEGIN:VTIMEZONE",
				"TZID:Old Rules",
				"BEGIN:STANDARD",
				"DTSTART:19671029T020000",
				"TZOFFSETFROM:-0400",
				"TZOFFSETTO:-0500",
				"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=SU;BYMONTHDAY=25,26,27,28,29,30,31",
				"END:STANDARD",
				"BEGIN:DAYLIGHT",
				"DTSTART:19870405T020000",
				"TZOFFSETFROM:-0500",
				"TZOFFSETTO:-0400",
				"RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=SU;BYMONTHDAY=1,2,3,4,5,6,7",
				"END:DAYLIGHT",
				"END:VTIMEZONE",
				"BEGIN:VTIMEZONE",
				"TZID:W. Europe Standard Time",
				"BEGIN:STANDARD",
				"DTSTART:16010101T000000",
				"TZOFFSETFROM:+0300",
				"TZOFFSETTO:+0300",
				"END:STANDARD",
				"END:VTIMEZONE",
				"END:VCALENDAR"
			].join("\r\n")
		).zones
	)

	it("reads a zone the file defines by its observances' yearly rules", () => {
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "Custom Central" }), DEFINED)).toBe(Date.UTC(2024, 6, 15, 8))
		expect(instantOf(time("2024-01-15", "10:00:00", { tzid: "Custom Central" }), DEFINED)).toBe(Date.UTC(2024, 0, 15, 9))
		// 2024's changes: 31 March and 27 October.
		expect(instantOf(time("2024-03-31", "01:30:00", { tzid: "Custom Central" }), DEFINED)).toBe(Date.UTC(2024, 2, 31, 0, 30))
		expect(instantOf(time("2024-03-31", "03:30:00", { tzid: "Custom Central" }), DEFINED)).toBe(Date.UTC(2024, 2, 31, 1, 30))
		expect(instantOf(time("2024-10-27", "04:00:00", { tzid: "Custom Central" }), DEFINED)).toBe(Date.UTC(2024, 9, 27, 3))
		// The older form: the weekday among a week of month days (US rules before 2007).
		expect(instantOf(time("1995-07-01", "12:00:00", { tzid: "Old Rules" }), DEFINED)).toBe(Date.UTC(1995, 6, 1, 16))
		expect(instantOf(time("1995-12-01", "12:00:00", { tzid: "Old Rules" }), DEFINED)).toBe(Date.UTC(1995, 11, 1, 17))
	})

	it("takes the file's own definition before the platform's or CLDR's", () => {
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "W. Europe Standard Time" }), DEFINED)).toBe(Date.UTC(2024, 6, 15, 7))
	})
})

describe("agendaTime", () => {
	it("shows a zoned time as written and adds the viewer's own when it differs", () => {
		const zoned = agendaTime(time("2024-07-15", "10:00:00", { tzid: "Pacific/Kiritimati" }))

		expect(zoned).toMatchObject({ day: "2024-07-15", shownMs: wallMs(time("2024-07-15", "10:00:00")), zone: "Pacific/Kiritimati" })
		expect(zoned.yourMs).toBe(Date.UTC(2024, 6, 14, 20))

		expect(agendaTime(time("2024-07-15", null))).toMatchObject({ shownMs: null, zone: null, yourMs: null })
		expect(agendaTime(time("2024-07-15", "10:00:00"))).toMatchObject({ zone: null, yourMs: null })
	})
})

describe("agendaDays", () => {
	it("orders days, whole days first within one, undated last", () => {
		const days = agendaDays([
			entry("undated", null),
			entry("late", time("2024-03-05", "18:00:00")),
			entry("allday", time("2024-03-05", null)),
			entry("early", time("2024-03-04", "09:00:00")),
			entry("morning", time("2024-03-05", "08:00:00"))
		])

		expect(days.map(day => [day.day, day.items.map(item => item.entry.summary)])).toEqual([
			["2024-03-04", ["early"]],
			["2024-03-05", ["allday", "morning", "late"]],
			["", ["undated"]]
		])
	})
})

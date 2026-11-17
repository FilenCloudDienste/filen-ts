import { describe, expect, it, vi } from "vitest"
import { readCalendar, type CalendarEntry, type CalendarTime } from "@filen/shared/calendarFile"
import { runPreviewDisposers } from "@/lib/workers/previewDisposers"
import {
	agendaDays,
	cachedZoneCount,
	agendaTime,
	dayMs,
	instantOf,
	previousDay,
	shownEnd,
	wallMs,
	zoneKnown,
	zoneTable
} from "@/features/preview/lib/calendarAgenda.logic"

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

	// RFC 5545 §3.3.5: a time clocks skip moves forward by the gap; a time they repeat is its first occurrence.
	it("reads times at a change of offset as RFC 5545 says, east and west of UTC", () => {
		expect(instantOf(time("2025-03-09", "02:30:00", { tzid: "America/New_York" }))).toBe(Date.UTC(2025, 2, 9, 7, 30))
		expect(instantOf(time("2025-11-02", "01:30:00", { tzid: "America/New_York" }))).toBe(Date.UTC(2025, 10, 2, 5, 30))
		expect(instantOf(time("2025-03-30", "02:30:00", { tzid: "Europe/Berlin" }))).toBe(Date.UTC(2025, 2, 30, 1, 30))
		expect(instantOf(time("2025-10-26", "02:30:00", { tzid: "Europe/Berlin" }))).toBe(Date.UTC(2025, 9, 26, 0, 30))
		// Lord Howe moves its clocks by half an hour.
		expect(instantOf(time("2025-10-05", "02:15:00", { tzid: "Australia/Lord_Howe" }))).toBe(Date.UTC(2025, 9, 4, 15, 45))
	})

	it("reads Mozilla's prefixed TZIDs, and knows which zones it cannot convert", () => {
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "/mozilla.org/20050126_1/Europe/Berlin" }))).toBe(Date.UTC(2024, 6, 15, 8))
		expect(zoneKnown("/mozilla.org/20070129_1/America/Argentina/Buenos_Aires")).toBe(true)
		expect(zoneKnown("Nowhere/Unknown")).toBe(false)
		expect(agendaTime(time("2024-07-15", "10:00:00", { tzid: "Nowhere/Unknown" }))).toMatchObject({
			zone: "Nowhere/Unknown",
			yourMs: null,
			unconverted: true
		})
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
		// Skipped: read in the offset before the gap. Repeated: the first occurrence.
		expect(instantOf(time("2024-03-31", "02:30:00", { tzid: "Custom Central" }), DEFINED)).toBe(Date.UTC(2024, 2, 31, 1, 30))
		expect(instantOf(time("2024-10-27", "02:30:00", { tzid: "Custom Central" }), DEFINED)).toBe(Date.UTC(2024, 9, 27, 0, 30))
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

describe("days and ends", () => {
	it("reads years 0-99 as written, and gives a malformed day no date", () => {
		expect(new Date(wallMs(time("0050-03-01", "12:00:00"))).getUTCFullYear()).toBe(50)
		expect(new Date(dayMs("0099-12-31")).getUTCFullYear()).toBe(99)
		expect(dayMs("2025-2-3")).toBeNaN()
		expect(previousDay("2024-03-01")).toBe("2024-02-29")
		expect(previousDay("0001-01-01")).toBe("0000-12-31")
	})

	// A whole-day DTEND is exclusive: a one-day event shows no end, a longer one its last day.
	it("shows a whole-day event's last day, not its exclusive end", () => {
		expect(shownEnd(time("2024-01-01", null), time("2024-01-02", null))).toBeNull()
		expect(shownEnd(time("2024-01-01", null), time("2024-01-04", null))).toMatchObject({ date: "2024-01-03" })
		expect(shownEnd(time("2024-01-01", "10:00:00"), time("2024-01-01", "11:00:00"))).toMatchObject({
			date: "2024-01-01",
			time: "11:00:00"
		})
	})
})

describe("the zone cache", () => {
	it("registers its sign-out disposer once, however often the cache refills", async () => {
		const disposers = await import("@/lib/workers/previewDisposers")
		const register = vi.spyOn(disposers, "registerPreviewDisposer")

		runPreviewDisposers()

		for (let index = 0; index < 2000; index++) instantOf(time("2024-07-15", "10:00:00", { tzid: `Other/Zone${String(index)}` }))

		expect(register).toHaveBeenCalledTimes(1)
		register.mockRestore()
	})

	it("keeps at most 256 zone names, and none past sign-out", () => {
		for (let index = 0; index < 600; index++) instantOf(time("2024-07-15", "10:00:00", { tzid: `Fake/Zone${String(index)}` }))

		expect(cachedZoneCount()).toBeLessThanOrEqual(256)

		runPreviewDisposers()

		expect(cachedZoneCount()).toBe(0)
	})
})

describe("zones a file defines, compiled", () => {
	const zones = (lines: string[]) => zoneTable(readCalendar(["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n")).zones)

	// Iran's rules as fixed dates (BYMONTHDAY, no BYDAY).
	it("reads fixed-date yearly rules", () => {
		const table = zones([
			"BEGIN:VTIMEZONE",
			"TZID:Custom Tehran",
			"BEGIN:STANDARD",
			"DTSTART:19700922T000000",
			"TZOFFSETFROM:+0430",
			"TZOFFSETTO:+0330",
			"RRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=22",
			"END:STANDARD",
			"BEGIN:DAYLIGHT",
			"DTSTART:19700322T000000",
			"TZOFFSETFROM:+0330",
			"TZOFFSETTO:+0430",
			"RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=22",
			"END:DAYLIGHT",
			"END:VTIMEZONE"
		])

		expect(instantOf(time("2021-06-01", "12:00:00", { tzid: "Custom Tehran" }), table)).toBe(Date.UTC(2021, 5, 1, 7, 30))
		expect(instantOf(time("2021-12-01", "12:00:00", { tzid: "Custom Tehran" }), table)).toBe(Date.UTC(2021, 11, 1, 8, 30))
	})

	it("honours COUNT and INTERVAL", () => {
		const table = zones([
			"BEGIN:VTIMEZONE",
			"TZID:Counted",
			"BEGIN:STANDARD",
			"DTSTART:20000101T000000",
			"TZOFFSETFROM:+0000",
			"TZOFFSETTO:+0000",
			"END:STANDARD",
			"BEGIN:DAYLIGHT",
			"DTSTART:20200601T000000",
			"TZOFFSETFROM:+0000",
			"TZOFFSETTO:+0100",
			"RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=6;BYMONTHDAY=1;COUNT=2",
			"END:DAYLIGHT",
			"BEGIN:STANDARD",
			"DTSTART:20200901T000000",
			"TZOFFSETFROM:+0100",
			"TZOFFSETTO:+0000",
			"RRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=1",
			"END:STANDARD",
			"END:VTIMEZONE"
		])
		const offset = (date: string) =>
			(wallMs(time(date, "12:00:00")) - (instantOf(time(date, "12:00:00", { tzid: "Counted" }), table) ?? 0)) / 3_600_000

		// 2020 and 2022 only: every second year, twice.
		expect(["2020-07-01", "2021-07-01", "2022-07-01", "2024-07-01"].map(offset)).toEqual([1, 0, 1, 0])
	})

	it("gives way to the platform's zone when a rule cannot be read, and converts nothing when neither can", () => {
		const unreadable = (tzid: string) => [
			"BEGIN:VTIMEZONE",
			`TZID:${tzid}`,
			"BEGIN:STANDARD",
			"DTSTART:19700101T000000",
			"TZOFFSETFROM:+0300",
			"TZOFFSETTO:+0300",
			"RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
			"END:STANDARD",
			"END:VTIMEZONE"
		]
		const table = zones([...unreadable("Europe/Berlin"), ...unreadable("Nowhere/Odd")])

		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "Europe/Berlin" }), table)).toBe(Date.UTC(2024, 6, 15, 8))
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "Nowhere/Odd" }), table)).toBeNull()
		expect(agendaTime(time("2024-07-15", "10:00:00", { tzid: "Nowhere/Odd" }), table)).toMatchObject({ unconverted: true })
	})

	// 64 observances × 64 extra dates, 10k events in the zone: compiled once, a binary search per observance per event.
	it("builds the agenda of a hostile zone's 10k events in bounded time", () => {
		const lines = ["BEGIN:VTIMEZONE", "TZID:Hostile"]

		for (let observance = 0; observance < 64; observance++) {
			const dates = Array.from({ length: 64 }, (_, index) => `${String(1950 + index)}0${String(1 + (observance % 9))}15T020000`).join(
				","
			)

			lines.push(
				"BEGIN:STANDARD",
				`DTSTART:19${String(10 + (observance % 80)).padStart(2, "0")}0101T000000`,
				"TZOFFSETFROM:+0100",
				`TZOFFSETTO:+0${String(observance % 10)}00`,
				"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
				`RDATE:${dates}`,
				"END:STANDARD"
			)
		}

		lines.push("END:VTIMEZONE")

		for (let index = 0; index < 10_000; index++) {
			lines.push(
				"BEGIN:VEVENT",
				`SUMMARY:E${String(index)}`,
				`DTSTART;TZID=Hostile:${String(2000 + (index % 30))}0601T100000`,
				"END:VEVENT"
			)
		}

		const calendar = readCalendar(["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n"))
		const started = Date.now()
		const days = agendaDays(calendar.entries, zoneTable(calendar.zones))

		expect(Date.now() - started).toBeLessThan(1500)
		expect(days.reduce((sum, day) => sum + day.items.length, 0)).toBe(10_000)
	})
})

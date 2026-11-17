import { describe, expect, it } from "vitest"
import type { CalendarEntry, CalendarTime } from "@filen/shared/calendarFile"
import { agendaDays, agendaTime, instantOf, wallMs } from "@/features/preview/lib/calendarAgenda.logic"

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
		expect(instantOf(time("2024-07-15", "10:00:00", { tzid: "W. Europe Standard Time" }))).toBeNull()
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

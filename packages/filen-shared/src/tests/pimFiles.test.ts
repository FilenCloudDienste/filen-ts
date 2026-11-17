import { describe, expect, it } from "vitest"
import { parseCalendarDuration, parseCalendarRecurrence, parseCalendarTime, parseUtcOffset, readCalendar } from "@filen/shared/calendarFile"
import { readContacts, startsVcard } from "@filen/shared/contactFile"

const CRLF = (lines: string[]): string => lines.join("\r\n")

describe("readCalendar", () => {
	it("reads events and to-dos with folded, escaped text, zones, durations and rules", () => {
		const calendar = readCalendar(
			CRLF([
				"BEGIN:VCALENDAR",
				"X-WR-CALNAME:Team",
				"BEGIN:VTIMEZONE",
				"TZID:Europe/Berlin",
				"BEGIN:STANDARD",
				"DTSTART:19701025T030000",
				"TZOFFSETFROM:+0200",
				"TZOFFSETTO:+0100",
				"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
				"END:STANDARD",
				"END:VTIMEZONE",
				"BEGIN:VEVENT",
				"SUMMARY:Planning\\, weekly",
				"DESCRIPTION:Line one\\nline two that is folded",
				"  onto the next line",
				"DTSTART;TZID=Europe/Berlin:20240304T100000",
				"DTEND;TZID=Europe/Berlin:20240304T110000",
				"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10",
				"EXDATE;TZID=Europe/Berlin:20240318T100000,20240401T100000",
				"ORGANIZER;CN=\"Ada L\":mailto:ada@example.com",
				"ATTENDEE;CN=Bob:mailto:bob@example.com",
				"ATTENDEE:mailto:eve@example.com",
				"URL:https://example.com/meet",
				"BEGIN:VALARM",
				"DESCRIPTION:Alarm text",
				"END:VALARM",
				"END:VEVENT",
				"BEGIN:VTODO",
				"SUMMARY:File taxes",
				"DUE;VALUE=DATE:20240415",
				"END:VTODO",
				"BEGIN:VEVENT",
				"SUMMARY:Lunch",
				"DTSTART:20240305T120000Z",
				"DURATION:PT1H30M",
				"END:VEVENT",
				"END:VCALENDAR"
			])
		)

		expect(calendar.name).toBe("Team")
		expect(calendar.entries).toHaveLength(3)
		expect(calendar.truncated).toBe(false)
		expect(calendar.zones).toEqual([
			{
				tzid: "Europe/Berlin",
				observances: [
					{
						onset: { date: "1970-10-25", time: "03:00:00", utc: false, tzid: null },
						offsetFrom: 7200,
						offsetTo: 3600,
						rule: expect.objectContaining({ frequency: "yearly", byMonth: [10], byDay: ["-1SU"] }),
						dates: []
					}
				]
			}
		])
		expect(calendar.entries[0]).toMatchObject({
			kind: "event",
			summary: "Planning, weekly",
			description: "Line one\nline two that is folded onto the next line",
			start: { date: "2024-03-04", time: "10:00:00", utc: false, tzid: "Europe/Berlin" },
			end: { date: "2024-03-04", time: "11:00:00", utc: false, tzid: "Europe/Berlin" },
			recurrence: { frequency: "weekly", interval: 2, count: 10, until: null, byDay: ["MO", "WE"] },
			exceptions: 2,
			organizer: "Ada L <ada@example.com>",
			attendees: ["Bob <bob@example.com>", "eve@example.com"],
			url: "https://example.com/meet"
		})
		expect(calendar.entries[1]).toMatchObject({ kind: "todo", summary: "File taxes", end: { date: "2024-04-15", time: null } })
		expect(calendar.entries[2]).toMatchObject({ start: { utc: true, tzid: null }, durationSeconds: 5400 })
	})

	it("reads UTC offsets with and without seconds", () => {
		expect([
			parseUtcOffset("+0100"),
			parseUtcOffset("-0530"),
			parseUtcOffset("+053045"),
			parseUtcOffset("0100"),
			parseUtcOffset("+1")
		]).toEqual([3600, -19_800, 19_845, null, null])
	})

	it("parses times, durations and rules strictly", () => {
		expect(parseCalendarTime("20241301T000000", null)).toBeNull()
		expect(parseCalendarTime("2024-03-01", null)).toBeNull()
		expect(parseCalendarTime("20240301T090000Z", "Europe/Berlin")).toEqual({
			date: "2024-03-01",
			time: "09:00:00",
			utc: true,
			tzid: null
		})
		expect(parseCalendarDuration("P1W2DT3H")).toBe(604_800 + 2 * 86_400 + 3 * 3600)
		expect(parseCalendarDuration("-PT5M")).toBeNull()
		expect(parseCalendarDuration("PT")).toBeNull()
		expect(parseCalendarRecurrence("INTERVAL=2")).toBeNull()
		expect(parseCalendarRecurrence("FREQ=MONTHLY;BYDAY=-1FR,XX;BYMONTHDAY=0,15,40;UNTIL=20241231")).toMatchObject({
			frequency: "monthly",
			interval: 1,
			byDay: ["-1FR"],
			byMonthDay: [15],
			until: { date: "2024-12-31", time: null }
		})
	})

	it("caps entries and text, strips format controls, and survives a file that ends inside an event", () => {
		const many = ["BEGIN:VCALENDAR"]

		for (let index = 0; index < 10_005; index++) many.push("BEGIN:VEVENT", `SUMMARY:E${String(index)}`, "END:VEVENT")

		const capped = readCalendar(CRLF(many))

		expect(capped.entries).toHaveLength(10_000)
		expect(capped.entriesOmitted).toBe(5)

		const odd = readCalendar(
			CRLF(["BEGIN:VCALENDAR", "BEGIN:VEVENT", `SUMMARY:invoice‮fdp.exe ${"x".repeat(2000)}`, `DESCRIPTION:${"d".repeat(20_000)}`])
		)

		expect(odd.entries[0]?.summary?.startsWith("invoicefdp.exe")).toBe(true)
		expect(odd.entries[0]?.summary?.length).toBe(513)
		expect(odd.entries[0]?.description?.length).toBe(8193)
	})

	// Lines are read one at a time and nothing past the caps is kept.
	it("reads a 24 MiB calendar in bounded time and heap", () => {
		const event = "BEGIN:VEVENT\r\nSUMMARY:Standup\r\nDTSTART:20240304T090000Z\r\nEND:VEVENT\r\n"
		const text = `BEGIN:VCALENDAR\r\n${event.repeat(Math.floor((24 * 1024 * 1024) / event.length))}END:VCALENDAR`
		const before = process.memoryUsage().heapUsed
		const started = Date.now()
		const calendar = readCalendar(text)

		expect(Date.now() - started).toBeLessThan(5000)
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(96 * 1024 * 1024)
		expect(calendar.entries).toHaveLength(10_000)
		expect(calendar.entriesOmitted).toBeGreaterThan(0)
		// Read only as far as the line cap: the count is a lower bound.
		expect(calendar.truncated).toBe(true)
	})

	it("stops at nesting past its depth instead of growing a stack", () => {
		const deep = CRLF(["BEGIN:VCALENDAR", ...Array.from({ length: 100_000 }, () => "BEGIN:X"), "BEGIN:VEVENT", "SUMMARY:x"])

		expect(readCalendar(deep).entries).toEqual([])
	})
})

describe("readContacts", () => {
	it("reads vCard 3/4 cards: name, organization, typed phones and emails, addresses", () => {
		const file = readContacts(
			CRLF([
				"BEGIN:VCARD",
				"VERSION:4.0",
				"FN:Ada Lovelace",
				"N:Lovelace;Ada;;Countess;",
				"ORG:Analytical Engines;Research",
				"TITLE:Programmer",
				"TEL;TYPE=work,voice;VALUE=uri:tel:+44-20-1234",
				"TEL;TYPE=cell:+44 7700 900123",
				"EMAIL;TYPE=home:ada@example.com",
				"ADR;TYPE=home:;;12 St James\\, Square;London;;SW1Y;United Kingdom",
				"URL:https://example.com/ada",
				"PHOTO;MEDIATYPE=image/jpeg:https://example.com/ada.jpg",
				"BDAY:18151210",
				"NOTE:First line\\nsecond line",
				"END:VCARD",
				"BEGIN:VCARD",
				"VERSION:3.0",
				"N:Babbage;Charles;;;",
				"EMAIL:charles@example.com",
				"END:VCARD"
			])
		)

		expect(file.contacts).toHaveLength(2)
		expect(file.contacts[0]).toEqual({
			name: "Ada Lovelace",
			nickname: null,
			organization: "Analytical Engines, Research",
			title: "Programmer",
			phones: [
				{ value: "+44-20-1234", types: ["work", "voice"] },
				{ value: "+44 7700 900123", types: ["cell"] }
			],
			emails: [{ value: "ada@example.com", types: ["home"] }],
			addresses: [{ value: "12 St James, Square\nLondon SW1Y\nUnited Kingdom", types: ["home"] }],
			urls: [{ value: "https://example.com/ada", types: [] }],
			birthday: "18151210",
			note: "First line\nsecond line"
		})
		expect(file.contacts[1]?.name).toBe("Charles Babbage")
	})

	it("reads vCard 2.1: bare types and quoted-printable in its charset, soft breaks included", () => {
		const file = readContacts(
			CRLF([
				"BEGIN:VCARD",
				"VERSION:2.1",
				"N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen",
				"TEL;HOME;VOICE:555-0100",
				"NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:Gr=FC=DFe aus =",
				"K=F6ln",
				"END:VCARD"
			])
		)

		expect(file.contacts[0]).toMatchObject({
			name: "Jürgen Müller",
			phones: [{ value: "555-0100", types: ["home", "voice"] }],
			note: "Grüße aus Köln"
		})
	})

	it("tells a vCard from other .vcf text by its first line", () => {
		expect(startsVcard("﻿\r\n  BEGIN:VCARD\r\nVERSION:4.0")).toBe(true)
		expect(startsVcard("begin:vcard")).toBe(true)
		expect(startsVcard("##fileformat=VCFv4.2\n#CHROM\tPOS")).toBe(false)
		expect(startsVcard("BEGIN:VCARDS")).toBe(false)
	})

	it("caps cards and their values", () => {
		const cards = Array.from({ length: 10_002 }, (_, index) => `BEGIN:VCARD\nFN:C${String(index)}\nEND:VCARD`).join("\n")
		const phones = `BEGIN:VCARD\n${Array.from({ length: 80 }, (_, index) => `TEL:${String(index)}`).join("\n")}\nEND:VCARD`

		expect(readContacts(cards)).toMatchObject({ contactsOmitted: 2 })
		expect(readContacts(cards).contacts).toHaveLength(10_000)
		expect(readContacts(phones).contacts[0]?.phones).toHaveLength(50)
	})
})

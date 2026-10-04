import { describe, expect, it } from "vitest"
import type { UserEventKind } from "@filen/sdk-rs"
import { createEventDescriber, groupEventsByDay } from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import {
	DAY_HEADER_HEIGHT,
	EVENT_ROW_HEIGHT,
	FILTER_FILL_PAGES,
	dayHeaderLayout,
	entryTimeKnown,
	eventEntryUuid,
	eventSecondaryText,
	eventTitleSegments,
	filterEvents,
	findEventEntry,
	isEventsFilterActive,
	isFillCapped,
	newDeviceBadgeKeys,
	stickyDayHeaderAt
} from "@/features/settings/components/events/eventsList.logic"
import { i18n } from "@/lib/i18n"
import { testEventModelContext } from "@/tests/support/eventModelContext"
import { testUuid } from "@/tests/support/uuid"

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"
const DAY = 24 * 60 * 60 * 1000
// Local noon, so a few hours either way stays on the same day.
const NOON = new Date(2026, 9, 4, 12).getTime()

let nextId = 1n

function entry(kind: UserEventKind, at: number): EventEntry {
	const id = nextId++
	const timestamp = BigInt(at)

	return { type: "ok", key: id.toString(), timestamp, event: { type: "ok", id, timestamp, uuid: testUuid(`evt${id.toString()}`), kind } }
}

function login(userAgent: string, at: number, type: "login" | "failedLogin" = "login"): EventEntry {
	return entry({ type, ip: "203.0.113.7", userAgent }, at)
}

function upload(name: string, at: number): EventEntry {
	return entry(
		{
			type: "fileUploaded",
			ip: "203.0.113.7",
			userAgent: CHROME_MAC,
			metadata: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } },
			uuid: undefined,
			stableUuid: undefined,
			newUuid: undefined,
			parent: undefined,
			bucket: undefined,
			region: undefined,
			rm: undefined,
			chunks: 1n,
			version: 2,
			favorited: undefined,
			timestamp: 0n,
			currentUuid: undefined
		},
		at
	)
}

const t = i18n.getFixedT<"events">("en", "events")

describe("filterEvents", () => {
	const describer = createEventDescriber(testEventModelContext())
	const entries = [upload("report.pdf", NOON), login(CHROME_MAC, NOON - 1000), upload("notes.txt", NOON - 2000)]

	it("returns the entries themselves when nothing filters", () => {
		expect(filterEvents(entries, { category: "all", query: "  " }, describer.searchText)).toBe(entries)
		expect(isEventsFilterActive({ category: "all", query: "  " })).toBe(false)
	})

	it("filters by category and by every search term", () => {
		expect(filterEvents(entries, { category: "security", query: "" }, describer.searchText)).toEqual([entries[1]])
		expect(filterEvents(entries, { category: "files", query: "REPORT uploaded" }, describer.searchText)).toEqual([entries[0]])
		expect(filterEvents(entries, { category: "all", query: "report missing" }, describer.searchText)).toEqual([])
	})

	it("keeps an uncategorized event under all only", () => {
		const unknown: EventEntry = {
			type: "unknown",
			key: "raw:1",
			timestamp: BigInt(NOON),
			event: { type: "err", message: "x", raw: "{}" },
			raw: { type: "newKind" }
		}

		for (const category of ["files", "directories", "sharing", "security", "account"] as const) {
			expect(filterEvents([unknown], { category, query: "" }, describer.searchText)).toEqual([])
		}

		expect(filterEvents([unknown], { category: "all", query: "newkind" }, describer.searchText)).toEqual([unknown])
	})
})

describe("newDeviceBadgeKeys", () => {
	it("badges a sign-in from a browser and OS first seen after the oldest loaded day, once the whole window is loaded", () => {
		const firstFirefox = login(FIREFOX_LINUX, NOON, "failedLogin")
		const entries = [login(FIREFOX_LINUX, NOON + 1000), firstFirefox, upload("a.txt", NOON - DAY), login(CHROME_MAC, NOON - 2 * DAY)]

		expect([...newDeviceBadgeKeys(entries, true)]).toEqual([firstFirefox.key])
	})

	it("badges from partial history only when it reaches a week before the sign-in", () => {
		const firstFirefox = login(FIREFOX_LINUX, NOON)
		const short = [firstFirefox, login(CHROME_MAC, NOON - 6 * DAY)]
		const week = [firstFirefox, login(CHROME_MAC, NOON - 7 * DAY)]

		expect(newDeviceBadgeKeys(short, false).size).toBe(0)
		expect([...newDeviceBadgeKeys(week, false)]).toEqual([firstFirefox.key])
	})

	it("never badges the oldest loaded day, nor an event that is not a sign-in", () => {
		const entries = [upload("a.txt", NOON), login(FIREFOX_LINUX, NOON - DAY + 1000), login(CHROME_MAC, NOON - DAY)]

		expect(newDeviceBadgeKeys(entries, true).size).toBe(0)
		expect(newDeviceBadgeKeys([], true).size).toBe(0)
	})
})

describe("isFillCapped", () => {
	it("stops filling a filtered panel after FILTER_FILL_PAGES pages while history goes on", () => {
		expect(isFillCapped({ filterActive: true, hasMore: true, fillPages: FILTER_FILL_PAGES - 1 })).toBe(false)
		expect(isFillCapped({ filterActive: true, hasMore: true, fillPages: FILTER_FILL_PAGES })).toBe(true)
		expect(isFillCapped({ filterActive: false, hasMore: true, fillPages: FILTER_FILL_PAGES })).toBe(false)
		expect(isFillCapped({ filterActive: true, hasMore: false, fillPages: FILTER_FILL_PAGES })).toBe(false)
	})
})

describe("eventSecondaryText", () => {
	const describer = createEventDescriber(testEventModelContext())

	it("shows an undecodable security event's IP once", () => {
		const unknown: EventEntry = {
			type: "unknown",
			key: "raw:2",
			timestamp: BigInt(NOON),
			event: { type: "err", message: "x", raw: "{}" },
			raw: { type: "failedLogin", ip: "198.51.100.4" }
		}

		expect(eventSecondaryText(describer.describe(unknown))).toBe("Unknown device · 198.51.100.4")
	})
})

describe("entryTimeKnown", () => {
	it("is false only for an undecodable event without a timestamp of its own", () => {
		const timeless: EventEntry = {
			type: "unknown",
			key: "raw:3",
			timestamp: BigInt(NOON),
			event: { type: "err", message: "x", raw: "{}" },
			raw: {}
		}

		expect(entryTimeKnown(timeless)).toBe(false)
		expect(entryTimeKnown({ ...timeless, raw: { timestamp: BigInt(NOON) } })).toBe(true)
		expect(entryTimeKnown(upload("a", NOON))).toBe(true)
	})
})

describe("day header layout", () => {
	const entries = [upload("a", NOON), upload("b", NOON - 1000), upload("c", NOON - DAY), upload("d", NOON - 2 * DAY)]
	const rows = groupEventsByDay(entries, NOON)
	const layout = dayHeaderLayout(rows)

	it("places each header after the fixed-height rows above it", () => {
		expect(layout.rows).toEqual([0, 3, 5])
		expect(layout.starts).toEqual([0, DAY_HEADER_HEIGHT + 2 * EVENT_ROW_HEIGHT, 2 * DAY_HEADER_HEIGHT + 3 * EVENT_ROW_HEIGHT])
	})

	it("pins the header of the day at the top and lets the next push it up", () => {
		const second = layout.starts[1] ?? 0

		expect(stickyDayHeaderAt(layout, 0)).toEqual({ index: 0, push: 0 })
		expect(stickyDayHeaderAt(layout, second - DAY_HEADER_HEIGHT - 10)).toEqual({ index: 0, push: 0 })
		expect(stickyDayHeaderAt(layout, second - 10)).toEqual({ index: 0, push: -(DAY_HEADER_HEIGHT - 10) })
		expect(stickyDayHeaderAt(layout, second)).toEqual({ index: 1, push: 0 })
		expect(stickyDayHeaderAt(layout, 100_000)).toEqual({ index: 2, push: 0 })
		expect(stickyDayHeaderAt(dayHeaderLayout([]), 50)).toEqual({ index: 0, push: 0 })
	})
})

describe("eventTitleSegments", () => {
	const ctx = testEventModelContext()
	const describer = createEventDescriber(ctx)

	it("sets the readable name apart, even when it also occurs in the sentence's words", () => {
		const segments = eventTitleSegments(describer.describe(upload("Up", NOON)), t)

		expect(segments).toEqual([
			{ text: "Uploaded ", strong: false },
			{ text: "Up", strong: true }
		])
	})

	it("shortens a long name from the middle", () => {
		const name = `${"a".repeat(40)}.pdf`
		const segments = eventTitleSegments(describer.describe(upload(name, NOON)), t)

		expect(segments[1]?.text).toBe(`${"a".repeat(28)}…${"a".repeat(10)}.pdf`)
		expect(eventTitleSegments(describer.describe(upload(name, NOON)), t, true)[1]?.text).toBe(name)
	})

	it("leaves a fallback name and a nameless sentence plain", () => {
		const unreadable = entry(
			{
				type: "folderTrash",
				ip: "1.2.3.4",
				userAgent: "ua",
				name: { type: "rSAEncrypted", data: "x" },
				uuid: undefined,
				parent: undefined,
				timestamp: 0n
			},
			NOON
		)

		expect(eventTitleSegments(describer.describe(unreadable), t)).toEqual([{ text: "Moved a directory to the trash", strong: false }])
		expect(eventTitleSegments(describer.describe(login(CHROME_MAC, NOON)), t)).toEqual([{ text: "Signed in", strong: false }])
	})
})

describe("deep link lookup", () => {
	it("finds an entry by its event uuid", () => {
		const target = login(CHROME_MAC, NOON)
		const uuid = eventEntryUuid(target) ?? ""

		expect(findEventEntry([upload("a", NOON), target], uuid)).toBe(target)
		expect(findEventEntry([target], testUuid("missing"))).toBeNull()
		expect(findEventEntry([target], null)).toBeNull()
	})
})

// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { readCalendar } from "@filen/shared/calendarFile"
import { readContacts } from "@filen/shared/contactFile"
import { narrowItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// A calendar opens on its agenda (rows expand to their details) and a contact file on its cards (a list beside the
// selected card when there are several); both read in the worker from the text the page decoded, source a toggle away.

const { text } = vi.hoisted(() => ({ text: { current: "" } }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new TextEncoder().encode(text.current), refetch: vi.fn() })
}))
vi.mock("@/features/preview/lib/textFamilyClient", () => ({
	// A file read only as far as the line cap, as the worker reports one.
	readCalendarFile: (value: string) =>
		Promise.resolve(
			value === "TRUNCATED"
				? { ...readCalendar("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:One\r\nEND:VEVENT"), entriesOmitted: 3, truncated: true }
				: readCalendar(value)
		),
	readContactFile: (value: string) => Promise.resolve(readContacts(value))
}))

const { CalendarViewer } = await import("@/features/preview/components/calendarViewer")
const { ContactViewer } = await import("@/features/preview/components/contactViewer")

registerAllActions()

// The virtualizers size their viewport off its height; without one they render no rows.
const STUBBED = ["offsetHeight", "clientHeight"] as const
const originals = STUBBED.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))

beforeAll(() => {
	for (const name of STUBBED) {
		Object.defineProperty(HTMLElement.prototype, name, {
			configurable: true,
			get(this: HTMLElement) {
				return this.classList.contains("overflow-y-auto") ? 600 : 0
			}
		})
	}
})

afterAll(() => {
	STUBBED.forEach((name, index) => {
		const original = originals[index]

		if (original === undefined) {
			Reflect.deleteProperty(HTMLElement.prototype, name)
		} else {
			Object.defineProperty(HTMLElement.prototype, name, original)
		}
	})
})

afterEach(() => {
	cleanup()
})

function itemNamed(name: string) {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000",
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 100n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 100n, key: "k", version: 2 } }
	} satisfies File)
}

const wrapper = queryClientWrapper(createTestQueryClient())

describe("CalendarViewer", () => {
	it("lists entries with their recurrence in words and expands one to its details", async () => {
		text.current = [
			"BEGIN:VCALENDAR",
			"X-WR-CALNAME:Team",
			"BEGIN:VEVENT",
			"SUMMARY:Planning",
			"LOCATION:Room 4",
			"DTSTART:20240304",
			"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10",
			"URL:https://example.com/meet",
			"END:VEVENT",
			"END:VCALENDAR"
		].join("\r\n")

		render(
			<CalendarViewer
				item={itemNamed("team.ics")}
				alt="team.ics"
			/>,
			{ wrapper }
		)

		expect(await screen.findByText(/1 entry/)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Agenda" }).getAttribute("aria-pressed")).toBe("true")
		expect(screen.getAllByText("Every 2 weeks on Monday and Wednesday, 10 times")).toHaveLength(1)

		const row = screen.getByRole("button", { expanded: false })

		fireEvent.click(row)

		expect(row.getAttribute("aria-expanded")).toBe("true")
		expect(screen.getByText("https://example.com/meet")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Copy Link" })).toBeTruthy()
	})

	it("gives a count past the cap as a lower bound when reading stopped before the file's end", async () => {
		text.current = "TRUNCATED"

		render(
			<CalendarViewer
				item={itemNamed("long.ics")}
				alt="long.ics"
			/>,
			{ wrapper }
		)

		expect(await screen.findByText(/1 entry · at least 3 more not shown/u)).toBeTruthy()
	})

	it("calls a rule with parts it does not describe a custom rule", async () => {
		text.current = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"SUMMARY:Close the books",
			"DTSTART:20240131",
			"RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=12",
			"END:VEVENT",
			"END:VCALENDAR"
		].join("\r\n")

		render(
			<CalendarViewer
				item={itemNamed("books.ics")}
				alt="books.ics"
			/>,
			{ wrapper }
		)

		expect(await screen.findByText("Every month, custom rule, 12 times")).toBeTruthy()
	})

	it("says when the calendar has no events", async () => {
		text.current = "BEGIN:VCALENDAR\r\nEND:VCALENDAR"

		render(
			<CalendarViewer
				item={itemNamed("empty.ics")}
				alt="empty.ics"
			/>,
			{ wrapper }
		)

		expect(await screen.findByText("This calendar has no events.")).toBeTruthy()
	})
})

describe("ContactViewer", () => {
	it("shows one contact as a card, its phone and email with Copy", async () => {
		text.current =
			"BEGIN:VCARD\r\nFN:Ada Lovelace\r\nORG:Engines\r\nTEL;TYPE=cell:+44 7700 900123\r\nEMAIL:ada@example.com\r\nEND:VCARD"

		render(
			<ContactViewer
				item={itemNamed("ada.vcf")}
				alt="ada.vcf"
			/>,
			{ wrapper }
		)

		expect(await screen.findByText("Ada Lovelace")).toBeTruthy()
		expect(screen.getByText("Engines")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Copy Phone (cell)" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Copy Email" })).toBeTruthy()
		expect(screen.queryByRole("listbox")).toBeNull()
	})

	it("lists several contacts beside the selected card", async () => {
		text.current = ["Ada", "Charles"].map(name => `BEGIN:VCARD\r\nFN:${name}\r\nNOTE:About ${name}\r\nEND:VCARD`).join("\r\n")

		render(
			<ContactViewer
				item={itemNamed("people.vcf")}
				alt="people.vcf"
			/>,
			{ wrapper }
		)

		expect(await screen.findByRole("listbox", { name: "2 contacts" })).toBeTruthy()
		expect(screen.getByText("About Ada")).toBeTruthy()
	})

	it("keeps a card selected when a new reading has fewer cards", async () => {
		text.current = ["Ada", "Charles", "Grace"].map(name => `BEGIN:VCARD\r\nFN:${name}\r\nNOTE:About ${name}\r\nEND:VCARD`).join("\r\n")

		const view = render(
			<ContactViewer
				item={itemNamed("people.vcf")}
				alt="people.vcf"
			/>,
			{ wrapper }
		)

		fireEvent.click(await screen.findByRole("option", { name: /Grace/u }))
		expect(screen.getByText("About Grace")).toBeTruthy()

		text.current = ["Ada", "Charles"].map(name => `BEGIN:VCARD\r\nFN:${name}\r\nNOTE:About ${name}\r\nEND:VCARD`).join("\r\n")
		view.rerender(
			<ContactViewer
				item={itemNamed("people.vcf")}
				alt="people.vcf"
			/>
		)

		expect(await screen.findByText("About Charles")).toBeTruthy()
		expect(screen.queryByText("This file has no contacts.")).toBeNull()
	})
})

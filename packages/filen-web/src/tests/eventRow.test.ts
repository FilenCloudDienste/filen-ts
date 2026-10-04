// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { createElement } from "react"
import type { UserEventKind } from "@filen/sdk-rs"
import { EventRow } from "@/features/settings/components/events/eventRow"
import { describeEvent } from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import { testEventModelContext } from "@/tests/support/eventModelContext"

afterEach(() => {
	cleanup()
})

const NOW = 1_700_000_040_000

function entry(kind: UserEventKind, timestamp = BigInt(NOW - 5 * 60 * 1000)): EventEntry {
	return { type: "ok", key: "1", timestamp, event: { type: "ok", id: 1n, timestamp, uuid: "11111111-1111-1111-1111-111111111111", kind } }
}

function renderRow(rowEntry: EventEntry, newDevice = false, historyComplete = false) {
	const onOpen = vi.fn()

	render(
		createElement(EventRow, {
			entry: rowEntry,
			description: describeEvent(rowEntry, testEventModelContext()),
			newDevice,
			historyComplete,
			now: NOW,
			onOpen
		})
	)

	return onOpen
}

const login: UserEventKind = { type: "login", ip: "1.2.3.4", userAgent: "ua" }

describe("EventRow", () => {
	it("shows the time of day, with the relative time as its title", () => {
		const timestamp = BigInt(NOW - 5 * 60 * 1000)

		renderRow(entry(login, timestamp))

		const time = screen.getByText(
			new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(Number(timestamp)))
		)

		expect(time.tagName).toBe("TIME")
		expect(time.getAttribute("title")).toBe("5 minutes ago")
	})

	it("sets the item name apart from the sentence", () => {
		renderRow(
			entry({
				type: "folderTrash",
				ip: "1.2.3.4",
				userAgent: "ua",
				name: { type: "decoded", data: { name: "a" } },
				uuid: undefined,
				parent: undefined,
				timestamp: 0n
			})
		)

		const name = screen.getByText("a", { selector: "bdi" })

		expect(name.parentElement?.tagName).toBe("STRONG")
		expect(name.parentElement?.parentElement?.textContent).toBe("Moved a to the trash")
	})

	it("warns about a name with invisible or direction-changing characters", () => {
		renderRow(
			entry({
				type: "folderTrash",
				ip: "1.2.3.4",
				userAgent: "ua",
				name: { type: "decoded", data: { name: "invoice\u202Efdp.exe" } },
				uuid: undefined,
				parent: undefined,
				timestamp: 0n
			})
		)

		expect(
			screen.getByLabelText("This name has invisible or direction-changing characters; it may not be what it looks like.")
		).toBeTruthy()
	})

	it("badges a new device and opens the event on click", () => {
		const rowEntry = entry(login)
		const onOpen = renderRow(rowEntry, true)

		expect(screen.getByText("New device").getAttribute("title")).toBe("Not seen in the 7 days before this sign-in")

		screen.getByRole("button").click()

		expect(onOpen).toHaveBeenCalledWith(rowEntry)
	})

	it("shows an undecodable event's type, device and IP", () => {
		const timestamp = BigInt(NOW)
		const unknown: EventEntry = {
			type: "unknown",
			key: "raw:1",
			timestamp,
			event: { type: "err", message: "unknown kind", raw: "{}" },
			raw: { type: "newKind", ip: "198.51.100.4" }
		}

		renderRow(unknown)

		expect(screen.getByText("Unknown event (newKind)")).toBeTruthy()
		expect(screen.getByText("Unknown device · 198.51.100.4")).toBeTruthy()
		// Its time is its neighbour's, kept for order only.
		expect(screen.getByText("Unknown time")).toBeTruthy()
		expect(document.querySelector("time")).toBeNull()
	})

	it("says how far the new-device claim reaches once the whole window is loaded", () => {
		renderRow(entry(login), true, true)

		expect(screen.getByText("New device").getAttribute("title")).toBe("Not seen earlier in the last 30 days")
	})
})

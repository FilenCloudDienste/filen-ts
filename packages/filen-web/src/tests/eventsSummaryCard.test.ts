// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { UserEventKind } from "@filen/sdk-rs"
import { EventsSummaryCard } from "@/features/settings/components/events/eventsSummaryCard"
import { createEventDescriber } from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import { testEventModelContext } from "@/tests/support/eventModelContext"

afterEach(() => {
	cleanup()
})

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
const NOW = 1_700_000_040_000
const HOUR = 60 * 60 * 1000

let nextId = 1n

function entry(kind: UserEventKind, at: number): EventEntry {
	const id = nextId++
	const timestamp = BigInt(at)

	return {
		type: "ok",
		key: id.toString(),
		timestamp,
		event: { type: "ok", id, timestamp, uuid: "11111111-1111-1111-1111-111111111111", kind }
	}
}

const describer = createEventDescriber(testEventModelContext())

function renderCard(entries: EventEntry[], complete: boolean) {
	render(createElement(EventsSummaryCard, { entries, oldest: entries.at(-1)?.timestamp, complete, describer, now: NOW }))
}

describe("EventsSummaryCard", () => {
	const entries = [
		entry({ type: "failedLogin", ip: "198.51.100.4", userAgent: CHROME_MAC }, NOW - HOUR),
		entry({ type: "login", ip: "203.0.113.7", userAgent: CHROME_MAC }, NOW - 2 * HOUR)
	]

	it("reads the latest sign-in and warns about failed ones", () => {
		renderCard(entries, false)

		expect(screen.getByText("Chrome on macOS")).toBeTruthy()
		expect(screen.getByText("203.0.113.7 · 2 hours ago")).toBeTruthy()
		expect(screen.getByText("1 in the last 7 days").className).toContain("text-warning-foreground")
	})

	it("claims no change only once the whole window is loaded", () => {
		renderCard(entries, false)

		expect(screen.queryByText("Not changed in the last 30 days")).toBeNull()
		expect(screen.getAllByText("—")).toHaveLength(2)

		cleanup()
		renderCard(entries, true)

		expect(screen.getAllByText("Not changed in the last 30 days")).toHaveLength(2)
	})

	it("reads the latest password and two-factor changes", () => {
		renderCard(
			[
				entry({ type: "twoFaDisabled", ip: "203.0.113.7", userAgent: CHROME_MAC }, NOW - 5 * 60 * 1000),
				entry({ type: "passwordChanged", ip: "203.0.113.7", userAgent: CHROME_MAC }, NOW - HOUR)
			],
			false
		)

		expect(screen.getByText("Turned off · 5 minutes ago")).toBeTruthy()
		expect(screen.getByText("Changed · 1 hour ago")).toBeTruthy()
		expect(screen.getAllByText("—")).toHaveLength(2)
	})
})

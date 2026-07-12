// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { createElement } from "react"
import type { UserEvent } from "@filen/sdk-rs"
import "@/lib/i18n"
import { EventRow } from "@/features/settings/components/events/eventRow"

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

function event(timestamp: bigint): UserEvent {
	return { id: 1n, timestamp, uuid: "11111111-1111-1111-1111-111111111111", kind: { type: "login", ip: "1.2.3.4", userAgent: "ua" } }
}

// The row used to render an absolute `toLocaleString` timestamp; it now goes through the same
// shared lib/relativeTime.ts helper as the note/chat rows, so a recent event reads as a relative
// label instead of a fixed date/time.
describe("EventRow — relative timestamp", () => {
	it("renders a relative label for a recent event, not an absolute date/time", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_000_000)

		render(
			createElement(EventRow, {
				event: event(1_700_000_000_000n - BigInt(5 * 60 * 1000)),
				onOpen: vi.fn()
			})
		)

		expect(screen.getByText("5 minutes ago")).toBeTruthy()
	})

	it("falls back to an absolute date once the event is older than the relative cutoff", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_000_000)

		const tenDaysMs = 10 * 24 * 60 * 60 * 1000
		const timestamp = 1_700_000_000_000n - BigInt(tenDaysMs)

		render(
			createElement(EventRow, {
				event: event(timestamp),
				onOpen: vi.fn()
			})
		)

		expect(screen.queryByText("5 minutes ago")).toBeNull()
		expect(
			screen.getByText(new Date(Number(timestamp)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))
		).toBeTruthy()
	})
})

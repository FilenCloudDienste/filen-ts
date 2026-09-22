import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { formatRelativeTimeCore, RELATIVE_TIME_CUTOFF_DAYS } from "@filen/shared"

// Echoes the key and, for the plural keys, the resolved count — a single assertion pins down
// both which branch fired and the number it carried.
const t = (key: string, options?: { count: number }): string => (options === undefined ? key : `${key}:${String(options.count)}`)

const keys = {
	justNow: "justNow",
	minutesAgo: "minutesAgo",
	hoursAgo: "hoursAgo",
	daysAgo: "daysAgo"
}

const NOW = new Date("2026-07-12T12:00:00.000Z").getTime()
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(NOW)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("formatRelativeTimeCore", () => {
	it("collapses sub-minute and future/skewed timestamps to justNow", () => {
		expect(formatRelativeTimeCore(NOW, t, keys, String)).toBe("justNow")
		expect(formatRelativeTimeCore(NOW - 59 * SECOND, t, keys, String)).toBe("justNow")
		// A future timestamp (clock skew) is a negative diff — still "just now", never a negative count.
		expect(formatRelativeTimeCore(NOW + 5 * MINUTE, t, keys, String)).toBe("justNow")
	})

	it("reports whole minutes below the hour boundary", () => {
		expect(formatRelativeTimeCore(NOW - MINUTE, t, keys, String)).toBe("minutesAgo:1")
		expect(formatRelativeTimeCore(NOW - 59 * MINUTE, t, keys, String)).toBe("minutesAgo:59")
	})

	it("reports whole hours below the day boundary", () => {
		expect(formatRelativeTimeCore(NOW - HOUR, t, keys, String)).toBe("hoursAgo:1")
		expect(formatRelativeTimeCore(NOW - 23 * HOUR, t, keys, String)).toBe("hoursAgo:23")
	})

	it("reports whole days below the cutoff", () => {
		expect(formatRelativeTimeCore(NOW - DAY, t, keys, String)).toBe("daysAgo:1")
		expect(formatRelativeTimeCore(NOW - (RELATIVE_TIME_CUTOFF_DAYS - 1) * DAY, t, keys, String)).toBe(
			`daysAgo:${String(RELATIVE_TIME_CUTOFF_DAYS - 1)}`
		)
	})

	it("falls back to the absolute formatter at and beyond the cutoff", () => {
		const absolute = vi.fn((timestampMs: number) => `abs:${String(timestampMs)}`)
		const old = NOW - RELATIVE_TIME_CUTOFF_DAYS * DAY

		expect(formatRelativeTimeCore(old, t, keys, absolute)).toBe(`abs:${String(old)}`)
		expect(absolute).toHaveBeenCalledWith(old)
	})

	it("passes the raw timestamp through to the absolute formatter untouched", () => {
		const old = NOW - 30 * DAY

		expect(formatRelativeTimeCore(old, t, keys, timestampMs => `abs:${String(timestampMs)}`)).toBe(`abs:${String(old)}`)
	})
})

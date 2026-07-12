import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TFunction } from "i18next"
import { formatRelativeTime } from "@/lib/relativeTime"

// A stand-in for the i18next t: echoes the key and, for the plural keys, the resolved count — so a
// single assertion pins down BOTH which branch fired and the number it carried.
const t = ((key: string, options?: { count?: number }): string =>
	options?.count === undefined ? key : `${key}:${String(options.count)}`) as unknown as TFunction

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

describe("formatRelativeTime", () => {
	it("collapses sub-minute and future/skewed timestamps to 'just now'", () => {
		expect(formatRelativeTime(NOW, t)).toBe("relativeJustNow")
		expect(formatRelativeTime(NOW - 59 * SECOND, t)).toBe("relativeJustNow")
		// A future timestamp (clock skew) is a negative diff — still "just now", never a negative count.
		expect(formatRelativeTime(NOW + 5 * MINUTE, t)).toBe("relativeJustNow")
	})

	it("reports whole minutes below the hour boundary", () => {
		expect(formatRelativeTime(NOW - MINUTE, t)).toBe("relativeMinutesAgo:1")
		expect(formatRelativeTime(NOW - 59 * MINUTE, t)).toBe("relativeMinutesAgo:59")
	})

	it("reports whole hours below the day boundary", () => {
		expect(formatRelativeTime(NOW - HOUR, t)).toBe("relativeHoursAgo:1")
		expect(formatRelativeTime(NOW - 23 * HOUR, t)).toBe("relativeHoursAgo:23")
	})

	it("reports whole days below the 7-day cutoff", () => {
		expect(formatRelativeTime(NOW - DAY, t)).toBe("relativeDaysAgo:1")
		expect(formatRelativeTime(NOW - 6 * DAY, t)).toBe("relativeDaysAgo:6")
	})

	it("falls back to the absolute formatter at and beyond the 7-day cutoff", () => {
		const absolute = vi.fn((timestamp: number) => `abs:${String(timestamp)}`)
		const old = NOW - 7 * DAY

		expect(formatRelativeTime(old, t, { absolute })).toBe(`abs:${String(old)}`)
		expect(absolute).toHaveBeenCalledWith(old)
	})

	it("uses a built-in locale date when no absolute formatter is provided", () => {
		const old = NOW - 30 * DAY
		const result = formatRelativeTime(old, t)

		// Not one of the relative keys — the default absolute branch produced a real date string.
		expect(result).not.toContain("relative")
		expect(result.length).toBeGreaterThan(0)
	})
})

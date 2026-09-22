import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TFunction } from "i18next"
import { formatRelativeTime } from "@/lib/relativeTime"

// A stand-in for the i18next t: echoes the key and, for the plural keys, the resolved count — so a
// single assertion pins down BOTH which branch fired and the number it carried.
const t = ((key: string, options?: { count?: number }): string =>
	options?.count === undefined ? key : `${key}:${String(options.count)}`) as unknown as TFunction

const NOW = new Date("2026-07-12T12:00:00.000Z").getTime()
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(NOW)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("formatRelativeTime", () => {
	it("uses web's camelCase keys", () => {
		expect(formatRelativeTime(NOW, t)).toBe("relativeJustNow")
		expect(formatRelativeTime(NOW - 5 * 60 * 1000, t)).toBe("relativeMinutesAgo:5")
		expect(formatRelativeTime(NOW - 3 * 60 * 60 * 1000, t)).toBe("relativeHoursAgo:3")
		expect(formatRelativeTime(NOW - 2 * DAY, t)).toBe("relativeDaysAgo:2")
	})

	it("falls back to a custom absolute formatter at and beyond the cutoff", () => {
		const absolute = vi.fn((timestamp: number) => `abs:${String(timestamp)}`)
		const old = NOW - 7 * DAY

		expect(formatRelativeTime(old, t, { absolute })).toBe(`abs:${String(old)}`)
		expect(absolute).toHaveBeenCalledWith(old)
	})

	it("uses the built-in locale date (no time) when no absolute formatter is provided", () => {
		const old = NOW - 30 * DAY
		const result = formatRelativeTime(old, t)

		// Not one of the relative keys — the default absolute branch produced a real date string.
		expect(result).not.toContain("relative")
		expect(result).toBe(new Date(old).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))
	})
})

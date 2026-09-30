import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import type { TFunction } from "i18next"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

vi.mock("expo-localization", () => ({
	getLocales: () => [{ languageTag: "en-US" }]
}))

async function loadTime(languageTag: string): Promise<typeof import("@/lib/time")> {
	vi.resetModules()

	vi.doMock("expo-localization", () => ({
		getLocales: () => [{ languageTag }]
	}))

	return await import("@/lib/time")
}

describe("time", () => {
	// Use a fixed date: 2025-03-15 13:05:09 local time
	const fixedDate = new Date(2025, 2, 15, 13, 5, 9)
	const fixedMs = fixedDate.getTime()
	const fixedSec = fixedMs / 1000
	const sample = new Date(2025, 0, 15, 14, 30, 45)

	describe("en-US locale (12-hour, MDY)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime

		beforeEach(async () => {
			const mod = await loadTime("en-US")

			simpleDate = mod.simpleDate
			simpleDateNoTime = mod.simpleDateNoTime
		})
		it("converts seconds timestamp (< 10000000000) by multiplying by 1000", () => {
			const result = simpleDate(fixedSec)
			const resultMs = simpleDate(fixedMs)

			expect(result).toBe(resultMs)
		})

		it("uses milliseconds timestamp directly when >= 10000000000", () => {
			// fixedMs is already in the milliseconds range (>= 10000000000)
			const result = simpleDate(fixedMs)
			const month = String(fixedDate.getMonth() + 1).padStart(2, "0")
			const day = String(fixedDate.getDate()).padStart(2, "0")
			const year = fixedDate.getFullYear()

			expect(result).toContain(`${month}/${day}/${year}`)
			expect(result).toMatch(/\d{2}:\d{2}:\d{2} (AM|PM)/)
		})

		it("accepts a Date object", () => {
			const result = simpleDate(fixedDate)
			const resultMs = simpleDate(fixedMs)

			expect(result).toBe(resultMs)
		})

		it("simpleDateNoTime returns date only (no comma, no time)", () => {
			const result = simpleDateNoTime(fixedDate)

			expect(result).not.toContain(",")
			expect(result).not.toContain("AM")
			expect(result).not.toContain("PM")

			const month = String(fixedDate.getMonth() + 1).padStart(2, "0")
			const day = String(fixedDate.getDate()).padStart(2, "0")
			const year = fixedDate.getFullYear()

			expect(result).toBe(`${month}/${day}/${year}`)
		})

		it("12-hour format: hour 0 → 12:XX:XX AM", () => {
			const midnight = new Date(2025, 0, 1, 0, 7, 3)
			const result = simpleDate(midnight)

			expect(result).toContain("12:07:03 AM")
		})

		it("12-hour format: hour 12 → 12:XX:XX PM", () => {
			const noon = new Date(2025, 0, 1, 12, 7, 3)
			const result = simpleDate(noon)

			expect(result).toContain("12:07:03 PM")
		})

		it("12-hour format: hour 13 → 01:XX:XX PM", () => {
			const afternoon = new Date(2025, 0, 1, 13, 7, 3)
			const result = simpleDate(afternoon)

			expect(result).toContain("01:07:03 PM")
		})

		it("pad2: single digit gets leading zero, double digit stays", () => {
			// Tested indirectly through date formatting
			const d = new Date(2025, 0, 5, 3, 2, 1)
			const result = simpleDate(d)

			expect(result).toContain("01/05/2025")
			expect(result).toContain("03:02:01")
		})
	})

	it.each([
		["de-DE", "15.01.2025, 14:30:45", "15.01.2025"],
		["nb", "15.01.2025, 14:30:45", "15.01.2025"],
		["en-GB", "15/01/2025, 02:30:45 PM", "15/01/2025"],
		["en-AU", "15/01/2025, 02:30:45 PM", "15/01/2025"],
		["en-CA", "01/15/2025, 02:30:45 PM", "01/15/2025"]
	])("%s formats as %s", async (tag, expectedDateTime, expectedDate) => {
		const { simpleDate, simpleDateNoTime } = await loadTime(tag)

		expect(simpleDate(sample)).toBe(expectedDateTime)
		expect(simpleDateNoTime(sample)).toBe(expectedDate)
	})

	it("24-hour format: hour 0 → 00:XX:XX (de-DE)", async () => {
		const { simpleDate } = await loadTime("de-DE")

		expect(simpleDate(new Date(2025, 0, 1, 0, 7, 3))).toBe("01.01.2025, 00:07:03")
	})

	describe("edge cases", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate

		beforeEach(async () => {
			simpleDate = (await loadTime("en-US")).simpleDate
		})

		it("midnight (hour 0) shows 12:xx:xx AM in 12-hour format", () => {
			const midnight = new Date(2025, 0, 1, 0, 0, 0)
			const result = simpleDate(midnight)

			expect(result).toContain("12:00:00 AM")
		})

		it("noon (hour 12) shows 12:xx:xx PM in 12-hour format", () => {
			const noon = new Date(2025, 0, 1, 12, 0, 0)
			const result = simpleDate(noon)

			expect(result).toContain("12:00:00 PM")
		})

		it("epoch 0 timestamp (treated as seconds) formats the resulting local date without asserting on a specific year", () => {
			// 0 < 10000000000, so toDate(0) returns new Date(0 * 1000) = new Date(0)
			// new Date(0) is UTC midnight Jan 1 1970, but local date depends on timezone.
			// We only verify the output is a well-formed MDY 12-hour string.
			const result = simpleDate(0)

			const expected = new Date(0)
			const month = String(expected.getMonth() + 1).padStart(2, "0")
			const day = String(expected.getDate()).padStart(2, "0")
			const year = expected.getFullYear()

			expect(result).toContain(`${month}/${day}/${year}`)
			expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} (AM|PM)/)
		})

		it("timestamp at boundary (10000000000) is treated as milliseconds", () => {
			const result = simpleDate(10000000000)

			// new Date(10000000000) is in 1970 — confirms the ms path is taken (not *1000)
			const expected = new Date(10000000000)
			const month = String(expected.getMonth() + 1).padStart(2, "0")
			const day = String(expected.getDate()).padStart(2, "0")
			const year = expected.getFullYear()

			expect(result).toContain(`${month}/${day}/${year}`)
		})

		it("timestamp just below boundary (9999999999) is treated as seconds", () => {
			const result = simpleDate(9999999999)

			// 9999999999 < 10000000000 → treated as seconds → new Date(9999999999 * 1000), in 2286
			const expected = new Date(9999999999 * 1000)

			expect(result).toContain(String(expected.getFullYear()))
		})

		it("fractional seconds timestamp floors to a valid date (sub-second shift)", () => {
			// 1742043909.5 < 10000000000, so treated as seconds; *1000 gives a half-millisecond offset
			// The result must still be a well-formed MDY 12-hour string
			const result = simpleDate(1742043909.5)
			const expected = new Date(1742043909.5 * 1000)
			const month = String(expected.getMonth() + 1).padStart(2, "0")
			const day = String(expected.getDate()).padStart(2, "0")
			const year = expected.getFullYear()

			expect(result).toContain(`${month}/${day}/${year}`)
			expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} (AM|PM)/)
		})
	})

	// Each YMD prefix is checked independently; a missing one (hu, sv) silently falls through to DMY.
	it.each(["zh-CN", "ko-KR", "hu-HU", "sv-SE", "fa-IR", "lt-LT", "mn-MN", "ja-JP"])(
		"%s formats as YMD with dash separator and 24-hour time",
		async tag => {
			const { simpleDate, simpleDateNoTime } = await loadTime(tag)

			expect(simpleDate(sample)).toBe("2025-01-15, 14:30:45")
			expect(simpleDateNoTime(sample)).toBe("2025-01-15")
		}
	)

	describe("setIntlLanguage — live locale switch", () => {
		it("a format call after setIntlLanguage picks up the new locale without a module reload", async () => {
			const mod = await loadTime("en-US")

			// Baseline: en-US → MDY, 12-hour
			const before = mod.simpleDate(sample)
			expect(before).toBe("01/15/2025, 02:30:45 PM")

			// Switch to de-DE at runtime
			mod.setIntlLanguage("de-DE")

			// cachedLocaleInfo is null now; next call must re-derive from intlLanguage
			const after = mod.simpleDate(sample)
			expect(after).toBe("15.01.2025, 14:30:45")
		})

		it("setIntlLanguage updates the exported intlLanguage binding", async () => {
			const mod = await loadTime("en-US")

			mod.setIntlLanguage("fr-FR")

			expect(mod.intlLanguage).toBe("fr-FR")
		})
	})

	describe("intlLanguage fallback — getLocales() throws", () => {
		it("falls back to en-US when getLocales() throws at module load", async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => {
					throw new Error("locale unavailable")
				}
			}))

			const mod = await import("@/lib/time")

			// intlLanguage stays at the default 'en-US' initialiser since the try block threw
			expect(mod.intlLanguage).toBe("en-US")

			// The formatters must still work (fallback MDY, 12-hour)
			const result = mod.simpleDate(sample)

			expect(result).toBe("01/15/2025, 02:30:45 PM")
		})
	})

	describe("detectLocaleInfo — unknown locale falls back to DMY/slash/24h", () => {
		it("an unmapped locale tag (xx-XX) produces DMY slash-separated 24-hour output", async () => {
			const mod = await loadTime("xx-XX")

			// Falls into the else branch: DMY, slash, 24-hour
			const result = mod.simpleDate(sample)

			expect(result).toBe("15/01/2025, 14:30:45")
		})

		it("a bare unknown language code (zz) produces DMY slash-separated 24-hour output", async () => {
			const mod = await loadTime("zz")
			const d = new Date(2025, 0, 15, 9, 5, 3)

			const result = mod.simpleDate(d)

			expect(result).toBe("15/01/2025, 09:05:03")
		})
	})

	describe("formatRelativeTime", () => {
		const NOW = new Date(2026, 6, 12, 12, 0, 0).getTime()
		const SECOND = 1000
		const MINUTE = 60 * SECOND
		const HOUR = 60 * MINUTE
		const DAY = 24 * HOUR

		// Echoes the key and, for the plural keys, the resolved count — pins down both which
		// branch fired and the number it carried.
		const t = ((key: string, options?: { count?: number }): string =>
			options?.count === undefined ? key : `${key}:${String(options.count)}`) as unknown as TFunction

		let formatRelativeTime: typeof import("@/lib/time").formatRelativeTime
		let simpleDate: typeof import("@/lib/time").simpleDate

		beforeEach(async () => {
			vi.useFakeTimers()
			vi.setSystemTime(NOW)

			const mod = await loadTime("en-US")

			formatRelativeTime = mod.formatRelativeTime
			simpleDate = mod.simpleDate
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("uses mobile's snake_case keys", () => {
			expect(formatRelativeTime(NOW, t)).toBe("relative_just_now")
			expect(formatRelativeTime(NOW - MINUTE, t)).toBe("relative_minutes_ago:1")
			expect(formatRelativeTime(NOW - HOUR, t)).toBe("relative_hours_ago:1")
			expect(formatRelativeTime(NOW - DAY, t)).toBe("relative_days_ago:1")
		})

		it("falls back to simpleDate past the cutoff by default", () => {
			const old = NOW - 7 * DAY

			expect(formatRelativeTime(old, t)).toBe(simpleDate(old))
		})

		it("uses a custom absolute formatter when provided", () => {
			const old = NOW - 7 * DAY
			const absolute = vi.fn(() => "custom")

			expect(formatRelativeTime(old, t, { absolute })).toBe("custom")
			expect(absolute).toHaveBeenCalledWith(old)
		})

		it("normalizes a seconds-range numeric timestamp the same as milliseconds", () => {
			expect(formatRelativeTime(NOW / 1000, t)).toBe("relative_just_now")
		})

		it("accepts a Date object, normalized through toDate() like simpleDate", () => {
			expect(formatRelativeTime(new Date(NOW), t)).toBe("relative_just_now")
			expect(formatRelativeTime(new Date(NOW - HOUR), t)).toBe("relative_hours_ago:1")
		})
	})
})

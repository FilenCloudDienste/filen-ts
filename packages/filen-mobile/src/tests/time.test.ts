import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-localization", () => ({
	getLocales: () => [{ languageTag: "en-US" }]
}))

describe("time", () => {
	// Use a fixed date: 2025-03-15 13:05:09 local time
	const fixedDate = new Date(2025, 2, 15, 13, 5, 9)
	const fixedMs = fixedDate.getTime()
	const fixedSec = fixedMs / 1000

	describe("en-US locale (12-hour, MDY)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "en-US" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoTime = mod.simpleDateNoTime
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("converts seconds timestamp (< 4102444800) by multiplying by 1000", () => {
			const result = simpleDate(fixedSec)
			const resultMs = simpleDate(fixedMs)

			expect(result).toBe(resultMs)
		})

		it("uses milliseconds timestamp directly when >= 4102444800", () => {
			// fixedMs is already in the milliseconds range (>= 4102444800)
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

		it("simpleDateNoDate returns time only (no date)", () => {
			const result = simpleDateNoDate(fixedDate)
			const year = String(fixedDate.getFullYear())

			expect(result).not.toContain(year)
			expect(result).toMatch(/\d{2}:\d{2}:\d{2} (AM|PM)/)
		})

		it("12-hour format: hour 0 → 12:XX:XX AM", () => {
			const midnight = new Date(2025, 0, 1, 0, 7, 3)
			const result = simpleDateNoDate(midnight)

			expect(result).toBe("12:07:03 AM")
		})

		it("12-hour format: hour 12 → 12:XX:XX PM", () => {
			const noon = new Date(2025, 0, 1, 12, 7, 3)
			const result = simpleDateNoDate(noon)

			expect(result).toBe("12:07:03 PM")
		})

		it("12-hour format: hour 13 → 01:XX:XX PM", () => {
			const afternoon = new Date(2025, 0, 1, 13, 7, 3)
			const result = simpleDateNoDate(afternoon)

			expect(result).toBe("01:07:03 PM")
		})

		it("pad2: single digit gets leading zero, double digit stays", () => {
			// Tested indirectly through date formatting
			const d = new Date(2025, 0, 5, 3, 2, 1)
			const result = simpleDate(d)

			expect(result).toContain("01/05/2025")
			expect(result).toContain("03:02:01")
		})
	})

	describe("de-DE locale (24-hour, DMY, dot separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "de-DE" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as DMY with dot separator", () => {
			const result = simpleDate(fixedDate)
			const month = String(fixedDate.getMonth() + 1).padStart(2, "0")
			const day = String(fixedDate.getDate()).padStart(2, "0")
			const year = fixedDate.getFullYear()

			expect(result).toContain(`${day}.${month}.${year}`)
		})

		it("24-hour format: hour 0 → 00:XX:XX", () => {
			const midnight = new Date(2025, 0, 1, 0, 7, 3)
			const result = simpleDateNoDate(midnight)

			expect(result).toBe("00:07:03")
		})

		it("24-hour format: hour 13 → 13:XX:XX", () => {
			const afternoon = new Date(2025, 0, 1, 13, 7, 3)
			const result = simpleDateNoDate(afternoon)

			expect(result).toBe("13:07:03")
		})
	})

	describe("en-GB locale (12-hour, DMY, slash separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "en-GB" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoTime = mod.simpleDateNoTime
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as DMY with slash separator", () => {
			const result = simpleDate(fixedDate)
			const month = String(fixedDate.getMonth() + 1).padStart(2, "0")
			const day = String(fixedDate.getDate()).padStart(2, "0")
			const year = fixedDate.getFullYear()

			expect(result).toContain(`${day}/${month}/${year}`)
		})

		it("uses 12-hour time with AM/PM", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDate(d)

			expect(result).toContain("02:30:45 PM")
		})

		it("simpleDateNoTime returns DMY date only", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("15/01/2025")
		})

		it("simpleDateNoDate returns 12-hour time only", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoDate(d)

			expect(result).toBe("02:30:45 PM")
		})
	})

	describe("en-AU locale (12-hour, DMY, slash separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "en-AU" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as DMY with slash separator", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDate(d)

			expect(result).toContain("15/01/2025")
		})

		it("uses 12-hour time with AM/PM", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoDate(d)

			expect(result).toBe("02:30:45 PM")
		})
	})

	describe("en-CA locale (12-hour, MDY, slash separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "en-CA" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as MDY with slash separator", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDate(d)

			expect(result).toContain("01/15/2025")
		})

		it("uses 12-hour time with AM/PM", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoDate(d)

			expect(result).toBe("02:30:45 PM")
		})
	})

	describe("nb locale (24-hour, DMY, dot separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "nb" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as DMY with dot separator and 24-hour time", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDate(d)

			expect(result).toBe("15.01.2025, 14:30:45")
		})

		it("24-hour format in time-only output", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoDate(d)

			expect(result).toBe("14:30:45")
		})
	})

	describe("edge cases", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "en-US" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("midnight (hour 0) shows 12:xx:xx AM in 12-hour format", () => {
			const midnight = new Date(2025, 0, 1, 0, 0, 0)
			const result = simpleDateNoDate(midnight)

			expect(result).toBe("12:00:00 AM")
		})

		it("noon (hour 12) shows 12:xx:xx PM in 12-hour format", () => {
			const noon = new Date(2025, 0, 1, 12, 0, 0)
			const result = simpleDateNoDate(noon)

			expect(result).toBe("12:00:00 PM")
		})

		it("epoch 0 timestamp (treated as seconds) formats the resulting local date without asserting on a specific year", () => {
			// 0 < 4102444800, so toDate(0) returns new Date(0 * 1000) = new Date(0)
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

		it("timestamp at boundary (4102444800) is treated as milliseconds", () => {
			const result = simpleDate(4102444800)

			// new Date(4102444800) is in 1970 — confirms the ms path is taken (not *1000)
			const expected = new Date(4102444800)
			const month = String(expected.getMonth() + 1).padStart(2, "0")
			const day = String(expected.getDate()).padStart(2, "0")
			const year = expected.getFullYear()

			expect(result).toContain(`${month}/${day}/${year}`)
		})

		it("timestamp just below boundary (4102444799) is treated as seconds", () => {
			const result = simpleDate(4102444799)

			// 4102444799 < 4102444800 → treated as seconds → new Date(4102444799 * 1000)
			// 4102444799 seconds = Dec 31, 2099 23:59:59 UTC (may show as Jan 1, 2100 in local tz)
			const expected = new Date(4102444799 * 1000)

			expect(result).toContain(String(expected.getFullYear()))
		})

		it("fractional seconds timestamp floors to a valid date (sub-second shift)", () => {
			// 1742043909.5 < 4102444800, so treated as seconds; *1000 gives a half-millisecond offset
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

	// --- Item #7: YMD locale branches zh/ko/hu/fa/lt/mn ---
	// Only ja-JP was previously tested. Each prefix is independently evaluated in the
	// if-chain; a typo (e.g. "zh" → "zh-cn") would break zh-TW silently. hu (Hungarian)
	// is in SUPPORTED_LANGUAGES and would otherwise fall through to DMY.

	describe("zh-CN locale (24-hour, YMD, dash separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "zh-CN" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoTime = mod.simpleDateNoTime
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as YMD with dash separator", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDate(d)

			expect(result).toContain("2025-01-15")
		})

		it("simpleDateNoTime returns YMD date only", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("2025-01-15")
		})

		it("24-hour time in time-only output", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoDate(d)

			expect(result).toBe("14:30:45")
		})

		it("output is distinct from de-DE DMY format", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			// de-DE would be "15.01.2025"; zh-CN must be "2025-01-15"
			expect(result).not.toBe("15.01.2025")
			expect(result).toBe("2025-01-15")
		})
	})

	describe("ko-KR locale (24-hour, YMD, dash separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "ko-KR" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoTime = mod.simpleDateNoTime
		})

		it("formats as YMD with dash separator", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDate(d)

			expect(result).toContain("2025-01-15")
		})

		it("simpleDateNoTime returns YMD date only", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("2025-01-15")
		})

		it("output is distinct from de-DE DMY format", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).not.toBe("15.01.2025")
			expect(result).toBe("2025-01-15")
		})
	})

	describe("hu-HU locale (24-hour, YMD, dash separator) — in SUPPORTED_LANGUAGES", () => {
		// hu is in SUPPORTED_LANGUAGES; without the startsWith("hu") check it would
		// silently fall through to DMY and display the wrong date order.
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "hu-HU" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoTime = mod.simpleDateNoTime
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as YMD with dash separator (not DMY)", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDate(d)

			expect(result).toContain("2025-01-15")
			// Explicitly guard against the DMY fallback that would occur if "hu" prefix were missing
			expect(result).not.toContain("15/01/2025")
			expect(result).not.toContain("15.01.2025")
		})

		it("simpleDateNoTime returns YMD date only", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("2025-01-15")
		})

		it("24-hour time in time-only output", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoDate(d)

			expect(result).toBe("14:30:45")
		})
	})

	describe("fa-IR locale (24-hour, YMD, dash separator)", () => {
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "fa-IR" }]
			}))

			const mod = await import("@/lib/time")

			simpleDateNoTime = mod.simpleDateNoTime
		})

		it("formats as YMD with dash separator", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("2025-01-15")
		})
	})

	describe("lt-LT locale (24-hour, YMD, dash separator)", () => {
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "lt-LT" }]
			}))

			const mod = await import("@/lib/time")

			simpleDateNoTime = mod.simpleDateNoTime
		})

		it("formats as YMD with dash separator", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("2025-01-15")
		})
	})

	describe("mn-MN locale (24-hour, YMD, dash separator)", () => {
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "mn-MN" }]
			}))

			const mod = await import("@/lib/time")

			simpleDateNoTime = mod.simpleDateNoTime
		})

		it("formats as YMD with dash separator", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("2025-01-15")
		})
	})

	describe("ja-JP locale (24-hour, YMD, dash separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate
		let simpleDateNoTime: typeof import("@/lib/time").simpleDateNoTime
		let simpleDateNoDate: typeof import("@/lib/time").simpleDateNoDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "ja-JP" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
			simpleDateNoTime = mod.simpleDateNoTime
			simpleDateNoDate = mod.simpleDateNoDate
		})

		it("formats as YMD with dash separator", () => {
			const result = simpleDate(fixedDate)
			const month = String(fixedDate.getMonth() + 1).padStart(2, "0")
			const day = String(fixedDate.getDate()).padStart(2, "0")
			const year = fixedDate.getFullYear()

			expect(result).toContain(`${year}-${month}-${day}`)
		})

		it("simpleDateNoTime returns YMD date only", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoTime(d)

			expect(result).toBe("2025-01-15")
		})

		it("24-hour format in time-only output", () => {
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = simpleDateNoDate(d)

			expect(result).toBe("14:30:45")
		})
	})

	describe("setIntlLanguage — live locale switch", () => {
		it("a format call after setIntlLanguage picks up the new locale without a module reload", async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "en-US" }]
			}))

			const mod = await import("@/lib/time")
			const d = new Date(2025, 0, 15, 14, 30, 45)

			// Baseline: en-US → MDY, 12-hour
			const before = mod.simpleDate(d)
			expect(before).toBe("01/15/2025, 02:30:45 PM")

			// Switch to de-DE at runtime
			mod.setIntlLanguage("de-DE")

			// cachedLocaleInfo is null now; next call must re-derive from intlLanguage
			const after = mod.simpleDate(d)
			expect(after).toBe("15.01.2025, 14:30:45")
		})

		it("setIntlLanguage updates the exported intlLanguage binding", async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "en-US" }]
			}))

			const mod = await import("@/lib/time")

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
			const d = new Date(2025, 0, 15, 14, 30, 45)
			const result = mod.simpleDate(d)

			expect(result).toBe("01/15/2025, 02:30:45 PM")
		})
	})

	describe("detectLocaleInfo — unknown locale falls back to DMY/slash/24h", () => {
		it("an unmapped locale tag (xx-XX) produces DMY slash-separated 24-hour output", async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "xx-XX" }]
			}))

			const mod = await import("@/lib/time")
			const d = new Date(2025, 0, 15, 14, 30, 45)

			// Falls into the else branch: DMY, slash, 24-hour
			const result = mod.simpleDate(d)

			expect(result).toBe("15/01/2025, 14:30:45")
		})

		it("a bare unknown language code (zz) produces DMY slash-separated 24-hour output", async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "zz" }]
			}))

			const mod = await import("@/lib/time")
			const d = new Date(2025, 0, 15, 9, 5, 3)

			const result = mod.simpleDate(d)

			expect(result).toBe("15/01/2025, 09:05:03")
		})
	})
})

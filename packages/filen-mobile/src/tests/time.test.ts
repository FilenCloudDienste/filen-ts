import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-localization", () => ({
	getLocales: () => [{ languageTag: "en-US" }]
}))

describe("time", () => {
	// Use a fixed date: 2025-03-15 13:05:09 UTC
	const fixedDate = new Date(Date.UTC(2025, 2, 15, 13, 5, 9))
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
			const result = simpleDate(fixedMs)

			expect(result).toContain("2025")
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

	describe("ja-JP locale (24-hour, YMD, dash separator)", () => {
		let simpleDate: typeof import("@/lib/time").simpleDate

		beforeEach(async () => {
			vi.resetModules()

			vi.doMock("expo-localization", () => ({
				getLocales: () => [{ languageTag: "ja-JP" }]
			}))

			const mod = await import("@/lib/time")

			simpleDate = mod.simpleDate
		})

		it("formats as YMD with dash separator", () => {
			const result = simpleDate(fixedDate)
			const month = String(fixedDate.getMonth() + 1).padStart(2, "0")
			const day = String(fixedDate.getDate()).padStart(2, "0")
			const year = fixedDate.getFullYear()

			expect(result).toContain(`${year}-${month}-${day}`)
		})
	})
})

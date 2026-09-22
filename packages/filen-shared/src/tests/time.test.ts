import { describe, it, expect } from "vitest"
import {
	isTimestampSameDay,
	isTimestampSameMinute,
	formatSecondsToHHMM,
	formatSecondsToMMSS,
	formatSecondsToMediaClock,
	getTimeRemaining
} from "@filen/shared"

describe("isTimestampSameDay", () => {
	it("should return true for same timestamp", () => {
		const ts = Date.now()

		expect(isTimestampSameDay(ts, ts)).toBe(true)
	})

	it("should return true for timestamps on the same day", () => {
		const date = new Date(2024, 0, 15, 10, 0, 0)
		const date2 = new Date(2024, 0, 15, 22, 0, 0)

		expect(isTimestampSameDay(date.getTime(), date2.getTime())).toBe(true)
	})

	it("should return false for timestamps on different days", () => {
		const date1 = new Date(2024, 0, 15, 10, 0, 0)
		const date2 = new Date(2024, 0, 16, 10, 0, 0)

		expect(isTimestampSameDay(date1.getTime(), date2.getTime())).toBe(false)
	})

	it("should return false for timestamps in different months", () => {
		const date1 = new Date(2024, 0, 31, 23, 0, 0)
		const date2 = new Date(2024, 1, 1, 1, 0, 0)

		expect(isTimestampSameDay(date1.getTime(), date2.getTime())).toBe(false)
	})

	it("should return false for timestamps in different years", () => {
		const date1 = new Date(2023, 11, 31).getTime()
		const date2 = new Date(2024, 0, 1).getTime()

		expect(isTimestampSameDay(date1, date2)).toBe(false)
	})
})

describe("isTimestampSameMinute", () => {
	it("should return true for same timestamp", () => {
		const ts = Date.now()

		expect(isTimestampSameMinute(ts, ts)).toBe(true)
	})

	it("should return true for timestamps within 2 minutes", () => {
		const date1 = new Date(2024, 0, 15, 10, 30, 0)
		const date2 = new Date(2024, 0, 15, 10, 31, 0)

		expect(isTimestampSameMinute(date1.getTime(), date2.getTime())).toBe(true)
	})

	it("should return false for timestamps more than 2 minutes apart", () => {
		const date1 = new Date(2024, 0, 15, 10, 30, 0)
		const date2 = new Date(2024, 0, 15, 10, 35, 0)

		expect(isTimestampSameMinute(date1.getTime(), date2.getTime())).toBe(false)
	})

	it("should return false for timestamps on different days", () => {
		const date1 = new Date(2024, 0, 15, 10, 30, 0)
		const date2 = new Date(2024, 0, 16, 10, 30, 0)

		expect(isTimestampSameMinute(date1.getTime(), date2.getTime())).toBe(false)
	})

	it("should return false when diff > 120000ms", () => {
		const ts1 = 1000000
		const ts2 = 1200001

		expect(isTimestampSameMinute(ts1, ts2)).toBe(false)
	})
})

describe("formatSecondsToHHMM", () => {
	it("should format 0 seconds", () => {
		expect(formatSecondsToHHMM(0)).toBe("00:00")
	})

	it("should format minutes only", () => {
		expect(formatSecondsToHHMM(300)).toBe("00:05")
	})

	it("should format hours and minutes", () => {
		expect(formatSecondsToHHMM(3661)).toBe("01:01")
	})

	it("should handle large values", () => {
		expect(formatSecondsToHHMM(36000)).toBe("10:00")
	})

	it("should return 00:00 for negative values", () => {
		expect(formatSecondsToHHMM(-1)).toBe("00:00")
	})

	it("should return 00:00 for NaN", () => {
		expect(formatSecondsToHHMM(NaN)).toBe("00:00")
	})
})

describe("formatSecondsToMMSS", () => {
	it("should format 0 seconds", () => {
		expect(formatSecondsToMMSS(0)).toBe("00:00")
	})

	it("should format seconds only", () => {
		expect(formatSecondsToMMSS(45)).toBe("00:45")
	})

	it("should format minutes and seconds", () => {
		expect(formatSecondsToMMSS(125)).toBe("02:05")
	})

	it("should return 00:00 for negative values", () => {
		expect(formatSecondsToMMSS(-1)).toBe("00:00")
	})

	it("should return 00:00 for NaN", () => {
		expect(formatSecondsToMMSS(NaN)).toBe("00:00")
	})
})

describe("formatSecondsToMediaClock", () => {
	it("should return 0:00 for 0 seconds", () => {
		expect(formatSecondsToMediaClock(0)).toBe("0:00")
	})

	it("should return 0:00 for negative values", () => {
		expect(formatSecondsToMediaClock(-1)).toBe("0:00")
	})

	it("should return 0:00 for NaN", () => {
		expect(formatSecondsToMediaClock(NaN)).toBe("0:00")
	})

	it("should return 0:00 for non-finite values", () => {
		expect(formatSecondsToMediaClock(Infinity)).toBe("0:00")
	})

	it("should format seconds only with an unpadded leading minute", () => {
		expect(formatSecondsToMediaClock(5)).toBe("0:05")
	})

	it("should leave minutes unpadded below 10", () => {
		expect(formatSecondsToMediaClock(65)).toBe("1:05")
	})

	it("should zero-pad seconds under 10", () => {
		expect(formatSecondsToMediaClock(125)).toBe("2:05")
	})

	it("should leave minutes unpadded at 2 digits", () => {
		expect(formatSecondsToMediaClock(754)).toBe("12:34")
	})

	it("should floor fractional seconds", () => {
		expect(formatSecondsToMediaClock(65.9)).toBe("1:05")
	})

	it("should roll over into h:mm:ss past an hour, unpadded hour", () => {
		expect(formatSecondsToMediaClock(3661)).toBe("1:01:01")
	})

	it("should format a >=60min track with the hour digit mobile used to lack", () => {
		expect(formatSecondsToMediaClock(4530)).toBe("1:15:30")
	})

	it("should zero-pad minutes and seconds once hours are present", () => {
		expect(formatSecondsToMediaClock(3605)).toBe("1:00:05")
	})

	it("should leave a 2-digit hour unpadded", () => {
		expect(formatSecondsToMediaClock(36000)).toBe("10:00:00")
	})
})

describe("getTimeRemaining", () => {
	it("should return positive values for future timestamp", () => {
		const future = Date.now() + 90061000

		const result = getTimeRemaining(future)

		expect(result.total).toBeGreaterThan(0)
		expect(result.days).toBe(1)
		expect(result.hours).toBe(1)
		expect(result.minutes).toBe(1)
		expect(result.seconds).toBe(1)
	})

	it("should return negative total for past timestamp", () => {
		const past = Date.now() - 1000

		const result = getTimeRemaining(past)

		expect(result.total).toBeLessThan(0)
	})

	it("should break down days, hours, minutes, seconds correctly", () => {
		const now = Date.now()
		const future = now + (2 * 86400 + 3 * 3600 + 4 * 60 + 30) * 1000

		const result = getTimeRemaining(future)

		expect(result.days).toBe(2)
		expect(result.hours).toBe(3)
		expect(result.minutes).toBe(4)
		expect(result.seconds).toBeGreaterThanOrEqual(28)
		expect(result.seconds).toBeLessThanOrEqual(30)
	})
})

import { describe, it, expect } from "vitest"
import { formatSecondsToMediaClock } from "@filen/shared"

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

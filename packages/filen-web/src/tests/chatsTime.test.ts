import { afterEach, describe, expect, it, vi } from "vitest"
import { dayKind, formatClockTime, formatFullDate } from "@/features/chats/lib/time"

const SAMPLES = [0n, 1_700_000_000_000n, 1_783_771_200_000n, 1_790_000_000_123n]

// Past Date's ±8.64e15 ms range: an Invalid Date.
const INVALID = BigInt(Number.MAX_SAFE_INTEGER)

afterEach(() => {
	vi.restoreAllMocks()
})

describe("formatClockTime", () => {
	it("matches toLocaleTimeString with the same options", () => {
		for (const timestamp of SAMPLES) {
			expect(formatClockTime(timestamp)).toBe(
				new Date(Number(timestamp)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
			)
		}
	})

	it("formats through the shared formatter, not a per-call locale lookup", () => {
		const spy = vi.spyOn(Date.prototype, "toLocaleTimeString")

		formatClockTime(SAMPLES[1] ?? 0n)

		expect(spy).not.toHaveBeenCalled()
	})

	it("labels an invalid date instead of throwing", () => {
		expect(formatClockTime(INVALID)).toBe(new Date(Number(INVALID)).toLocaleTimeString())
	})
})

describe("formatFullDate", () => {
	it("matches toLocaleDateString with the same options", () => {
		for (const timestamp of SAMPLES) {
			expect(formatFullDate(timestamp)).toBe(
				new Date(Number(timestamp)).toLocaleDateString(undefined, {
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric"
				})
			)
		}
	})

	it("formats through the shared formatter, not a per-call locale lookup", () => {
		const spy = vi.spyOn(Date.prototype, "toLocaleDateString")

		formatFullDate(SAMPLES[1] ?? 0n)

		expect(spy).not.toHaveBeenCalled()
	})

	it("labels an invalid date instead of throwing", () => {
		expect(formatFullDate(INVALID)).toBe(new Date(Number(INVALID)).toLocaleDateString())
	})
})

describe("dayKind", () => {
	// Local-time constructors, in a zone with DST so the previous-day case crosses a clock change.
	const at = (month: number, day: number, hours: number, minutes = 0, seconds = 0, ms = 0): number =>
		new Date(2026, month - 1, day, hours, minutes, seconds, ms).getTime()

	it("reads today, yesterday and older by the local calendar", () => {
		vi.stubEnv("TZ", "Europe/Berlin")

		const now = at(6, 15, 12)

		expect(dayKind(BigInt(at(6, 15, 0, 0, 0, 1)), now)).toBe("today")
		expect(dayKind(BigInt(at(6, 14, 8)), now)).toBe("yesterday")
		expect(dayKind(BigInt(at(6, 13, 23, 59)), now)).toBe("other")
	})

	it("lands on the previous calendar day across a DST change", () => {
		vi.stubEnv("TZ", "Europe/Berlin")

		// 29 March 2026 is 23 hours long in Berlin: 24 hours before 00:30 on the 30th is still the 28th.
		expect(dayKind(BigInt(at(3, 29, 12)), at(3, 30, 0, 30))).toBe("yesterday")
		expect(dayKind(BigInt(at(3, 28, 23, 45)), at(3, 30, 0, 30))).toBe("other")
	})

	it("splits days at local midnight", () => {
		vi.stubEnv("TZ", "Europe/Berlin")

		const beforeMidnight = at(6, 14, 23, 59, 59, 999)

		expect(dayKind(BigInt(beforeMidnight), at(6, 14, 23, 59, 59, 999))).toBe("today")
		expect(dayKind(BigInt(beforeMidnight), at(6, 15, 0))).toBe("yesterday")
		expect(dayKind(BigInt(beforeMidnight), at(6, 16, 0))).toBe("other")
	})
})

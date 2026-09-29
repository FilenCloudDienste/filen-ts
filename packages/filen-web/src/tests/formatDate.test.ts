import { describe, expect, it } from "vitest"
import { formatShortDate } from "@/lib/formatDate"

const OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" }

describe("formatShortDate", () => {
	it("formats epoch ms as a short locale date", () => {
		expect(formatShortDate(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toLocaleDateString(undefined, OPTIONS))
	})

	it("accepts a bigint ms timestamp", () => {
		expect(formatShortDate(1_700_000_000_000n)).toBe(formatShortDate(1_700_000_000_000))
	})

	it("accepts an ISO-8601 string", () => {
		expect(formatShortDate("2026-01-15T12:00:00Z")).toBe(new Date("2026-01-15T12:00:00Z").toLocaleDateString(undefined, OPTIONS))
	})

	it("returns the Invalid Date label instead of throwing", () => {
		expect(formatShortDate("not a date")).toBe("Invalid Date")
	})
})

import { describe, expect, it } from "vitest"
import { formatPageRanges, normalizePageRanges, pageRangesCount, pageRangesPages, parsePageRanges } from "../core/pdfedit/pageRanges"

function ranges(text: string, count: number) {
	const result = parsePageRanges(text, count)

	return result.ok ? result.ranges : result.error
}

describe("page ranges", () => {
	it("reads pages, closed and open ranges", () => {
		expect(ranges("1-3, 7, 10-", 12)).toEqual([
			{ first: 1, last: 3 },
			{ first: 7, last: 7 },
			{ first: 10, last: 12 }
		])
		expect(ranges("-2", 5)).toEqual([{ first: 1, last: 2 }])
		expect(ranges(" 4 ", 5)).toEqual([{ first: 4, last: 4 }])
	})

	it("accepts semicolons, en dashes and spaces inside parts", () => {
		expect(ranges("1 – 2; 4 - 5", 5)).toEqual([
			{ first: 1, last: 2 },
			{ first: 4, last: 5 }
		])
	})

	it("sorts and merges overlapping and adjacent ranges", () => {
		expect(ranges("7, 1-3, 2-5, 6", 9)).toEqual([{ first: 1, last: 7 }])
		expect(
			normalizePageRanges([
				{ first: 5, last: 6 },
				{ first: 1, last: 1 }
			])
		).toEqual([
			{ first: 1, last: 1 },
			{ first: 5, last: 6 }
		])
	})

	it("refuses empty, malformed, reversed and out-of-range input", () => {
		expect(ranges(" , ;", 5)).toEqual({ kind: "empty" })
		expect(ranges("1-2-3", 5)).toEqual({ kind: "syntax", part: "1-2-3" })
		expect(ranges("a", 5)).toEqual({ kind: "syntax", part: "a" })
		expect(ranges("-", 5)).toEqual({ kind: "syntax", part: "-" })
		expect(ranges("1.5", 5)).toEqual({ kind: "syntax", part: "1.5" })
		expect(ranges("9999999999", 5)).toEqual({ kind: "syntax", part: "9999999999" })
		expect(ranges("5-3", 5)).toEqual({ kind: "reversed", part: "5-3" })
		expect(ranges("0", 5)).toEqual({ kind: "outOfRange", part: "0" })
		expect(ranges("2-6", 5)).toEqual({ kind: "outOfRange", part: "2-6" })
		expect(ranges("6-", 5)).toEqual({ kind: "outOfRange", part: "6-" })
		expect(ranges("1", 0)).toEqual({ kind: "outOfRange", part: "1" })
	})

	it("counts, lists and formats", () => {
		const parsed = parsePageRanges("10-12, 1-3, 7", 12)

		expect(parsed.ok).toBe(true)

		if (!parsed.ok) return

		expect(pageRangesCount(parsed.ranges)).toBe(7)
		expect([...pageRangesPages(parsed.ranges)]).toEqual([1, 2, 3, 7, 10, 11, 12])
		expect(formatPageRanges(parsed.ranges)).toBe("1-3, 7, 10-12")
	})
})

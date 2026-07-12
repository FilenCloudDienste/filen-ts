import { describe, expect, it } from "vitest"
import { middleEllipsis } from "@/lib/middleEllipsis"

describe("middleEllipsis", () => {
	it("keeps a short value untouched", () => {
		expect(middleEllipsis("1.2.3.4")).toBe("1.2.3.4")
	})

	it("keeps the start and end of a long uuid, dropping only the middle", () => {
		const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

		expect(middleEllipsis(uuid, { start: 8, end: 8 })).toBe("a1b2c3d4…34567890")
	})

	it("preserves a distinguishing tail a plain end-truncate would eat, for a long user agent", () => {
		const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

		const result = middleEllipsis(ua, { start: 10, end: 12 })

		expect(result.startsWith(ua.slice(0, 10))).toBe(true)
		expect(result.endsWith(ua.slice(-12))).toBe(true)
		expect(result).toContain("…")
		expect(result.length).toBeLessThan(ua.length)
	})

	it("does not truncate a value exactly at the kept-character budget", () => {
		const value = "0123456789" // 10 chars, start=6 + end=4 = 10, budget is start+end+1=11

		expect(middleEllipsis(value, { start: 6, end: 4 })).toBe(value)
	})

	it("uses sane defaults when no options are passed", () => {
		const value = "x".repeat(50)
		const result = middleEllipsis(value)

		expect(result).toContain("…")
		expect(result.length).toBeLessThan(value.length)
	})
})

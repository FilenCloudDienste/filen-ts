import { describe, expect, it } from "vitest"
import { keptCss } from "@filen/shared/dom/cssLoads"

// The CSS judge streams: no token is kept past its chunk, and no value is built a character at a time.
describe("keptCss budget", () => {
	it("judges 8 MiB of rules, and one 8 MiB token, in bounded time and heap", () => {
		const before = process.memoryUsage().heapUsed
		const started = Date.now()
		const rules = keptCss("a{b:c}".repeat(1_398_101), "sheet", () => null)
		const token = keptCss(`a{b:${"x".repeat(8 * 1024 * 1024)}}`, "sheet", () => null)
		const string = keptCss(`a{b:"${"x".repeat(8 * 1024 * 1024)}"}`, "sheet", () => null)

		expect(rules.dropped + token.dropped + string.dropped).toBe(0)
		expect(Date.now() - started).toBeLessThan(5000)
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(160 * 1024 * 1024)
	})
})
